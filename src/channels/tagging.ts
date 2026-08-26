/**
 * The runtime-side tagger: log + policy in, render-ready request out
 * (SPEC.md §9, §10.3, §10.4).
 *
 * This is the only place a {@link ChannelRequest} is built, and it is on the
 * runtime side of the boundary on purpose. Every `computed` field here is
 * derived by the same modules the gate itself uses — `core/state.ts` for the
 * verified read and the approval derivation, `core/policy-match.ts` /
 * `policy-explain.ts` for autonomy, `core/budgets.ts` for the verdicts,
 * `core/attest.ts` for the attestation status, `core/payload.ts` for the
 * content binding — so what a channel displays as "computed" is the same answer
 * the gate would give, not a second implementation that could disagree with it.
 * Every `claimed` field is copied out of a log record and stamped with the actor
 * who authored that record.
 *
 * ## Why this takes a log *path*, not records
 *
 * SPEC.md §11.1(1): enforcement paths read only verified records. A channel
 * request is what a human's decision is made from, so it is an enforcement
 * surface in the sense that matters — a request built from a spliced log would
 * put a fabricated action in front of an approver. Accepting an
 * `EventRecord[]` would let a caller hand over anything; taking the path and
 * calling {@link readVerifiedRecords} here means the chain is walked, the hashes
 * recomputed and the schemas checked before a single field is tagged, and a log
 * that does not verify produces a refusal rather than a queue entry.
 *
 * ## Where the full payload comes from — flagged for human review
 *
 * v0.1's log records a `payload_hash`, never the payload bytes: the binding is
 * a commitment, and putting the bytes in an append-only log would make every
 * approved payload permanent and world-readable to anyone with the log. So the
 * material to render comes from the payload store beside the log
 * (`core/payload-store.ts`, APRV-28), or from a caller-supplied override
 * ({@link TagOptions.payload}) where an operator holds the bytes somewhere else,
 * and this module **verifies it against the recorded hash** before tagging it
 * `computed` — material that does not hash to the bound value is refused
 * `payload-mismatch` and never reaches a channel. That verification is what
 * makes `fullPayload` a computed field rather than one more agent claim, and it
 * is the same check `core/token.ts` makes at spend time.
 *
 * Determinism: no clock. `now` is a parameter, so a queue rendering is
 * replayable exactly as it was rendered.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { checkAttestation, type AttestationStatus } from "../core/attest.js";
import {
  evaluateBudgetsWithTask,
  type BudgetScope,
  type BudgetVerdict,
} from "../core/budgets.js";
import type { EventRecord } from "../core/log.js";
import { usdNumber } from "../core/money.js";
import { payloadHash } from "../core/payload.js";
import { loadPayload, payloadStoreDirFor } from "../core/payload-store.js";
import { explain } from "../core/policy-explain.js";
import {
  loadPolicy,
  POLICY_FILENAMES,
  type LoadPolicyOptions,
  type PolicyLoadResult,
} from "../core/policy-load.js";
import { resolve, type Resolution } from "../core/policy-match.js";
import {
  payloadOf,
  readVerifiedRecords,
  requestState,
  type RequestDerivation,
} from "../core/state.js";
import {
  claimed,
  computed,
  createChannelRequest,
  type ChannelRequest,
  type PayloadRendering,
} from "./contract.js";
import { commandBreakdown, commandPayloadView, protectedPathView } from "./payload-view.js";

// ---------------------------------------------------------------------------
// Options and refusals
// ---------------------------------------------------------------------------

/**
 * Where the payload material for an action comes from.
 *
 * Returns `undefined` when the caller holds no material for that key — which
 * falls back to the payload store, and then, if that holds nothing either, is a
 * refusal for a manual request (§10.4) and merely a missing field otherwise.
 * Never throws: an adapter that cannot produce material says so by returning
 * `undefined`.
 *
 * The bound `payload_hash` is passed as a second argument for sources that are
 * addressed by content rather than by key; sources that key on the action alone
 * ignore it.
 */
export type PayloadSource = (actionKey: string, payloadHash: string) => unknown;

export interface TagOptions {
  /** Where `APPROVAL.md` lives. Same semantics as `core/gate.ts`'s option. */
  policy?: { dir?: string; file?: string };
  /** Schema directory, passed to the verified read and the policy load. */
  schemaDir?: string;
  /**
   * The payload bytes to render, checked against the recorded binding.
   *
   * An **override**: when it is absent, or returns `undefined` for a key, the
   * payload store beside the log answers instead (APRV-28). An operator with a
   * `--payload-dir` therefore still wins for the keys it covers, and gets the
   * store for the rest.
   */
  payload?: PayloadSource;
  /**
   * Where the payload store lives. Defaults to `.approval/payloads/` beside the
   * log, resolved by `core/payload-store.ts` from the log path the caller
   * already passed. `null` disables the fallback entirely, which is what a
   * caller that wants to prove the store is not answering asks for.
   */
  payloadStoreDir?: string | null;
  /**
   * Truncate the rendered payload text at this many characters. Unset means no
   * truncation. A truncated rendering is legal for a unit request and is what
   * `channels/batch.ts` refuses to fold into a batch (SPEC.md §10.3, B7).
   */
  maxPayloadChars?: number;
}

/** Why the tagger refused. Frozen per SPEC.md §11.1(6). */
export const CHANNEL_TAG_REFUSAL_CODES = [
  /** The log could not be opened. */
  "log-unreadable",
  /** The log's final line is unterminated (a crashed write). */
  "log-torn-tail",
  /** The chain does not verify; nothing may be rendered from it. */
  "log-corrupt",
  /** No `approval.requested` record for this action key. */
  "not-requested",
  /** There is a request, but it is decided or expired — nothing to approve. */
  "not-awaiting",
  /** The request carries no usable `payload.class`; policy cannot be resolved. */
  "class-missing",
  /** The request carries no `payload_hash`; there is no binding to display. */
  "payload-hash-missing",
  /** No payload material was supplied for a manual request (§10.4). */
  "payload-unavailable",
  /** The supplied material does not hash to the bound `payload_hash`. */
  "payload-mismatch",
  /** The supplied material cannot be canonicalized (a cycle, a NaN, …). */
  "payload-unrenderable",
  /** {@link createChannelRequest} refused the assembled request. */
  "request-invalid",
] as const;

export type ChannelTagRefusalCode = (typeof CHANNEL_TAG_REFUSAL_CODES)[number];

export interface ChannelTagRefusal {
  ok: false;
  code: ChannelTagRefusalCode;
  message: string;
}

export type BuildChannelRequestResult =
  | { ok: true; request: ChannelRequest }
  | ChannelTagRefusal;

function refuse(code: ChannelTagRefusalCode, message: string): ChannelTagRefusal {
  return { ok: false, code, message };
}

// ---------------------------------------------------------------------------
// Policy plumbing (mirrors `core/gate.ts`, deliberately)
// ---------------------------------------------------------------------------

/**
 * The policy file that will be hashed for attestation.
 *
 * Same discovery order as `core/gate.ts` and `loadPolicy`, so the file the
 * channel reports as attested is the file the gate will enforce. Duplicated
 * rather than imported because the gate's copy is private; the alternative —
 * widening the gate's API for a display path — trades a nine-line function for
 * a new public surface on the module that decides things.
 */
function policyPathOf(options: TagOptions): string {
  const policy = options.policy ?? {};
  if (policy.file !== undefined) return policy.file;
  const dir = policy.dir ?? process.cwd();
  for (const filename of POLICY_FILENAMES) {
    const candidate = join(dir, filename);
    if (existsSync(candidate)) return candidate;
  }
  return join(dir, POLICY_FILENAMES[0] ?? "APPROVAL.md");
}

function loadOptionsOf(options: TagOptions): LoadPolicyOptions {
  const policy = options.policy ?? {};
  const load: LoadPolicyOptions = {};
  if (policy.file !== undefined) load.file = policy.file;
  else load.dir = policy.dir ?? process.cwd();
  if (options.schemaDir !== undefined) load.schemaDir = options.schemaDir;
  return load;
}

function budgetScopeOf(load: PolicyLoadResult, resolution: Resolution): BudgetScope {
  return {
    classLimits: resolution.limits,
    classPattern: resolution.matched === null ? null : resolution.matched.pattern,
    globalBudgets: load.ok ? load.policy.budgets ?? null : null,
  };
}

function ttlOf(load: PolicyLoadResult): number | null {
  return load.ok ? load.durations.approvalTtlMs : null;
}

// ---------------------------------------------------------------------------
// Log lookups
// ---------------------------------------------------------------------------

/** The `approval.requested` record at `seq`, or `null`. */
function recordAt(records: EventRecord[], seq: number | null): EventRecord | null {
  if (seq === null) return null;
  for (const record of records) {
    if (record.seq === seq) return record;
  }
  return null;
}

/**
 * The latest `task.registered` payload for `task`, or `{}`.
 *
 * Read for `route.rationale` / `route.confidence` only. v0.1's `register`
 * copies `actions`, `state` and `budget` onto the record and *not* `route`, so
 * these are usually absent — the fields are wired anyway, tagged claimed with
 * the registering actor, so a log that carries them (a later register, an
 * imported log) renders them on the correct side of the boundary rather than
 * being quietly dropped or, worse, shown as fact.
 */
function registrationOf(records: EventRecord[], task: string | null): EventRecord | null {
  if (task === null) return null;
  let found: EventRecord | null = null;
  for (const record of records) {
    if (record.event === "task.registered" && record.task === task) found = record;
  }
  return found;
}

function routeOf(registration: EventRecord | null): Record<string, unknown> {
  if (registration === null) return {};
  const route = payloadOf(registration)["route"];
  return typeof route === "object" && route !== null && !Array.isArray(route)
    ? (route as Record<string, unknown>)
    : {};
}

// ---------------------------------------------------------------------------
// Payload rendering
// ---------------------------------------------------------------------------

/**
 * Render the payload material and check it against the recorded binding.
 *
 * The hash is recomputed here, never taken on trust: `payload-mismatch` is the
 * same refusal `core/token.ts` raises at spend time, raised earlier, so a human
 * is never shown bytes that the token would later refuse to execute.
 */
function renderPayload(
  material: unknown,
  boundHash: string,
  maxChars: number | undefined,
): { ok: true; rendering: PayloadRendering } | ChannelTagRefusal {
  let hash: string;
  let text: string;
  try {
    hash = payloadHash(material);
    text = JSON.stringify(material, null, 2) ?? String(material);
  } catch (cause) {
    return refuse(
      "payload-unrenderable",
      `the payload material could not be canonicalized: ${
        cause instanceof Error ? cause.message : String(cause)
      }. A payload that cannot be serialized cannot be bound to, so it cannot be approved.`,
    );
  }

  if (hash !== boundHash) {
    return refuse(
      "payload-mismatch",
      `the supplied payload material hashes to ${hash} but the request is bound to ${boundHash} (amended SPEC.md §6.2/§10). A grant approves specific bytes; showing a human different bytes than the token will execute is the exact failure the binding exists to prevent.`,
    );
  }

  const truncated = maxChars !== undefined && text.length > maxChars;
  return {
    ok: true,
    rendering: {
      value: material,
      text: truncated ? text.slice(0, maxChars) : text,
      hash,
      truncated,
    },
  };
}

/**
 * The material for one action: the caller's override, else the payload store.
 *
 * Three outcomes, and the middle one is the point of the whole store. `none`
 * means nobody holds the bytes — the caller passed no source (or it returned
 * nothing) and the store has no file — which is `payload-unavailable` for a
 * manual request. `refusal` means the store *does* hold a file and it does not
 * verify: a tampered `<hash>.json` is reported as `payload-mismatch` and its
 * contents are never returned, let alone rendered. `material` is the ordinary
 * case, and it is still hash-checked downstream by {@link renderPayload}, so the
 * store is verified twice on the path to a human and trusted at neither step.
 *
 * A stored external reference is `none` with a reason: the pointer is reported
 * in the refusal message, and no bytes are invented for it.
 */
function materialFor(
  options: TagOptions,
  actionKey: string,
  boundHash: string,
):
  | { kind: "material"; value: unknown }
  | { kind: "none"; reason: string | null }
  | { kind: "refusal"; refusal: ChannelTagRefusal } {
  const supplied = options.payload === undefined ? undefined : options.payload(actionKey, boundHash);
  if (supplied !== undefined) return { kind: "material", value: supplied };

  const storeDir = options.payloadStoreDir;
  if (storeDir === undefined || storeDir === null) return { kind: "none", reason: null };

  const loaded = loadPayload(storeDir, boundHash);
  if (loaded.ok) return { kind: "material", value: loaded.value };
  if (loaded.code === "hash-mismatch") {
    return { kind: "refusal", refusal: refuse("payload-mismatch", loaded.message) };
  }
  return { kind: "none", reason: loaded.code === "absent" ? null : loaded.message };
}

// ---------------------------------------------------------------------------
// buildChannelRequest
// ---------------------------------------------------------------------------

/**
 * The options a build runs with: the caller's, plus the store convention.
 *
 * Resolved from the log path the caller already passes, so every surface —
 * `approval render`, the CLI channel, web, Telegram — reads the same store
 * without a flag, and a caller that wants no store at all says
 * `payloadStoreDir: null` rather than being unable to say it.
 */
function withStore(options: TagOptions, logPath: string): TagOptions {
  return options.payloadStoreDir === undefined
    ? { ...options, payloadStoreDir: payloadStoreDirFor(logPath) }
    : options;
}

/**
 * Build the render-ready request for one action key.
 *
 * Computed, and what derives each:
 *
 * | field | derivation | `source` |
 * | --- | --- | --- |
 * | `class`, `task`, `payload_hash`, `requested_ts`, `chain`, `state` | the verified log | `log` |
 * | `autonomy`, `provenance` | `explain()` over the attested policy | `policy-match` |
 * | `budgets` | `evaluateBudgetsWithTask()` at `now` | `budgets` |
 * | `attestation` | `checkAttestation()` against the live policy file | `attestation` |
 * | `fullPayload` | supplied material, hash-checked | `payload-binding` |
 * | `command_breakdown`, `protected_path` | the classifier, re-run over the hash-checked material | `classifier` |
 * | `ttl_remaining_ms`, `waiting` | arithmetic on `now` | `clock` |
 *
 * Claimed, and who authored each: `summary` and `est_cost_usd` carry the actor
 * of the `approval.requested` record — the party that submitted the declaration
 * — and `rationale` / `confidence` carry the registering actor.
 *
 * Refuses an unknown or undecidable key rather than rendering a partial one:
 * `not-requested` (no such request), `not-awaiting` (already granted, rejected,
 * revoked or expired), and the payload codes above. An unverifiable log refuses
 * `log-corrupt` before anything is derived.
 */
export function buildChannelRequest(
  logPath: string,
  actionKey: string,
  options: TagOptions,
  now: string,
): BuildChannelRequestResult {
  const read = readVerifiedRecords(
    logPath,
    options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir },
  );
  if (!read.ok) return refuse(read.code, read.message);

  const load = loadPolicy(loadOptionsOf(options));
  const derivation = requestState(read.records, actionKey, now, ttlOf(load));
  return tagDerivation(
    read.records,
    read.head?.seq ?? 0,
    derivation,
    load,
    withStore(options, logPath),
    now,
  );
}

/** Month names for the dated form of {@link clockText}. UTC, like everything here. */
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** Whole UTC days since the epoch. The day boundary is the displayed zone's. */
function utcDay(ms: number): number {
  return Math.floor(ms / 86_400_000);
}

/**
 * A deadline, said the way a reader on a phone can act on it (APRV-143).
 *
 * ```
 * 13:09 UTC            the deadline is later today
 * tomorrow 13:09 UTC   the deadline is the next UTC day
 * 27 Aug 13:09 UTC     anything further out, and anything already past
 * ```
 *
 * The observed failure is a 24h TTL rendering as `expires 13:09 UTC` beside
 * `requested 1 min ago`: a reader does the arithmetic, gets "nine minutes ago",
 * and concludes the question is dead. Time of day alone can only be read
 * against a day the line never states.
 *
 * Day boundaries are computed in UTC because the clock is printed in UTC, and a
 * "tomorrow" measured in one zone against a time printed in another is worse
 * than no word at all. `now` unreadable degrades to the time-only form: a
 * renderer that cannot place today must not name a relative day.
 */
function clockText(ms: number, nowMs: number): string {
  const at = new Date(ms);
  const hh = String(at.getUTCHours()).padStart(2, "0");
  const mm = String(at.getUTCMinutes()).padStart(2, "0");
  const clock = `${hh}:${mm} UTC`;
  if (Number.isNaN(nowMs)) return clock;
  const days = utcDay(ms) - utcDay(nowMs);
  if (days === 0) return clock;
  if (days === 1) return `tomorrow ${clock}`;
  return `${String(at.getUTCDate())} ${MONTHS[at.getUTCMonth()] ?? "?"} ${clock}`;
}

/** `just now`, `4 min ago`, `2h 05m ago` — how long the question has waited. */
function ageText(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${String(minutes)} min ago`;
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60).padStart(2, "0")}m ago`;
}

/**
 * The age/deadline line of APRV-106. See `ChannelRequest.waiting` for why it is
 * computed and why the requester's own `wait_until` cannot lower scrutiny.
 *
 * Determinism: `now` is the parameter every other field here is derived
 * against, so a queue rendered twice at the same instant produces the same
 * line. Unparseable instants degrade to the honest half rather than to a
 * guess — a channel that cannot say when a request was made must not imply it
 * was made recently.
 */
function waitingLine(
  requestTs: string,
  waitUntil: string | null,
  ttlRemainingMs: number | null,
  now: string,
): string {
  const requestedAt = Date.parse(requestTs);
  const nowMs = Date.parse(now);
  const age =
    Number.isNaN(requestedAt) || Number.isNaN(nowMs)
      ? `requested at ${requestTs}`
      : `requested ${ageText(Math.max(0, nowMs - requestedAt))}`;

  const waitMs = waitUntil === null ? Number.NaN : Date.parse(waitUntil);
  if (!Number.isNaN(waitMs)) {
    return `${age} · requester waits until ${clockText(waitMs, nowMs)}`;
  }
  if (ttlRemainingMs !== null && !Number.isNaN(nowMs)) {
    return `${age} · expires ${clockText(nowMs + ttlRemainingMs, nowMs)}`;
  }
  // No TTL and no declared wait: the policy bounded nothing, and inventing a
  // deadline here would be the renderer stating a fact the log does not carry.
  return `${age} · no deadline (the policy declares no approval_ttl)`;
}

/**
 * `policy.protected_paths`, or nothing when the policy did not load.
 *
 * Narrower on a failed load, never wider: an unreadable policy under-reports
 * which paths are protected rather than inventing a protection, and autonomy
 * has already failed closed to `manual` by the time this is read.
 */
function protectedPathsOf(load: PolicyLoadResult): readonly string[] {
  return load.ok ? (load.policy.protected_paths ?? []) : [];
}

/**
 * The two payload-derived computed lines: what the command does (APRV-144 #1)
 * and which protected path selected the class (APRV-143 #3).
 *
 * Both are derived from the payload material this function was already handed —
 * material that {@link renderPayload} has hash-checked against the recorded
 * binding — and both go through `core/command-class.ts` rather than reading a
 * claim off the bytes. A payload nobody holds, or one of a shape neither
 * derivation recognises, produces neither line: an aid that cannot be derived
 * is absent, never guessed.
 */
function payloadDerivations(
  rendering: PayloadRendering | null,
  load: PolicyLoadResult,
): Partial<Pick<ChannelRequest, "command_breakdown" | "protected_path">> {
  if (rendering === null) return {};
  const fields: Partial<Pick<ChannelRequest, "command_breakdown" | "protected_path">> = {};

  const command = commandPayloadView(rendering.value);
  if (command !== null) {
    const breakdown = commandBreakdown(command.command);
    if (breakdown !== null) fields.command_breakdown = computed(breakdown, "classifier");
  }

  const guarded = protectedPathView(rendering.value, protectedPathsOf(load));
  if (guarded !== null) {
    fields.protected_path = computed(`${guarded.path} (rule ${guarded.rule})`, "classifier");
  }

  return fields;
}

/** The shared body of {@link buildChannelRequest} and {@link buildPendingQueue}. */
function tagDerivation(
  records: EventRecord[],
  headSeq: number,
  derivation: RequestDerivation,
  load: PolicyLoadResult,
  options: TagOptions,
  now: string,
): BuildChannelRequestResult {
  const actionKey = derivation.actionKey;

  if (derivation.state === "none") {
    return refuse(
      "not-requested",
      `action ${actionKey} has no approval.requested record; there is nothing pending to render`,
    );
  }
  if (derivation.state !== "requested") {
    return refuse(
      "not-awaiting",
      `action ${actionKey} is ${derivation.state}, not awaiting a decision; a channel may only collect a gesture on a live request`,
    );
  }

  const cls = derivation.declared.class;
  if (cls === null || cls.length === 0) {
    return refuse(
      "class-missing",
      `the approval.requested record for ${actionKey} carries no usable payload.class; autonomy and every class-scoped budget are resolved from it, so nothing can be shown as computed`,
    );
  }

  const boundHash = derivation.declared.payload_hash;
  if (boundHash === null) {
    return refuse(
      "payload-hash-missing",
      `the approval.requested record for ${actionKey} carries no payload_hash; amended SPEC.md §6.2 makes the binding mandatory for manual actions, so a request without one cannot be presented for decision`,
    );
  }

  const requestRecord = recordAt(records, derivation.requestSeq);
  if (requestRecord === null || derivation.requestTs === null) {
    return refuse(
      "not-requested",
      `the approval.requested record for ${actionKey} could not be located in the verified log`,
    );
  }

  const reversible = derivation.declared.reversible;
  const explanation = explain(load, cls, reversible === null ? {} : { reversible });
  const resolution = resolve(load, cls, reversible === null ? {} : { reversible });

  // The declared amount in its canonical decimal form (APRV-121) for the
  // budget evaluation, and as a number for the card. A channel card is a
  // display surface: nothing it renders is hashed, so the float lives here and
  // goes no further.
  const cost = derivation.declared.est_cost_usd ?? "0";
  const budgets: BudgetVerdict[] = evaluateBudgetsWithTask(
    records,
    budgetScopeOf(load, resolution),
    { class: cls, est_cost_usd: cost },
    now,
    derivation.task,
  ).verdicts;

  const attestation: AttestationStatus = checkAttestation(records, policyPathOf(options));

  const material = materialFor(options, actionKey, boundHash);
  if (material.kind === "refusal") return material.refusal;
  let rendering: PayloadRendering | null = null;
  if (material.kind === "material") {
    const rendered = renderPayload(material.value, boundHash, options.maxPayloadChars);
    if (!rendered.ok) return rendered;
    rendering = rendered.rendering;
  } else if (explanation.outcome.autonomy === "manual") {
    return refuse(
      "payload-unavailable",
      `no payload material is held for manual action ${actionKey}: the caller supplied none and the payload store has none${
        material.reason === null ? "" : ` (${material.reason})`
      }. SPEC.md §10.4 requires a channel to present the full payload or a faithful rendering of it before collecting a decision, so the request is refused here rather than delivered as a summary alone.`,
    );
  }

  const ttlMs = ttlOf(load);
  const requestedAt = Date.parse(derivation.requestTs);
  const nowMs = Date.parse(now);
  const ttlRemaining =
    ttlMs === null || Number.isNaN(requestedAt) || Number.isNaN(nowMs)
      ? null
      : Math.max(0, requestedAt + ttlMs - nowMs);

  const route = routeOf(registrationOf(records, derivation.task));
  const registrationActor = registrationOf(records, derivation.task)?.actor ?? requestRecord.actor;

  const fields: ChannelRequest = {
    action_key: computed(actionKey, "log"),
    task: computed(derivation.task, "log"),
    class: computed(cls, "log"),
    autonomy: computed(explanation.outcome.autonomy, "policy-match"),
    provenance: computed(explanation.provenance, "policy-match"),
    est_cost_usd: claimed(usdNumber(cost), requestRecord.actor),
    summary: claimed(derivation.declared.summary, requestRecord.actor),
    ...payloadDerivations(rendering, load),
    payload_hash: computed(boundHash, "log"),
    fullPayload: computed(rendering, "payload-binding"),
    budgets: computed(budgets, "budgets"),
    attestation: computed(attestation, "attestation"),
    requested_ts: computed(derivation.requestTs, "log"),
    ttl_remaining_ms: computed(ttlRemaining, "clock"),
    waiting: computed(
      waitingLine(derivation.requestTs, derivation.declared.wait_until, ttlRemaining, now),
      "clock",
    ),
    chain: computed(
      { seq: requestRecord.seq, hash: requestRecord.hash, head_seq: headSeq },
      "log",
    ),
    state: computed(derivation.state, "log"),
    ...(typeof route["rationale"] === "string"
      ? { rationale: claimed(route["rationale"], registrationActor) }
      : {}),
    ...(typeof route["confidence"] === "number"
      ? { confidence: claimed(route["confidence"], registrationActor) }
      : {}),
  };

  const created = createChannelRequest(fields);
  if (!created.ok) return refuse("request-invalid", created.message);
  return { ok: true, request: created.request };
}

// ---------------------------------------------------------------------------
// buildPendingQueue
// ---------------------------------------------------------------------------

/** One key the queue could not render, and why. */
export interface SkippedRequest {
  action_key: string;
  code: ChannelTagRefusalCode;
  message: string;
}

export type PendingQueueResult =
  | {
      ok: true;
      /** Every live request awaiting a human decision, in log order. */
      requests: ChannelRequest[];
      /**
       * Keys that are live but could not be rendered — most often a manual
       * request whose payload material the caller does not hold. Surfaced
       * rather than silently dropped: a request missing from a queue is a
       * request nobody will approve, and an operator must be able to see why.
       */
      skipped: SkippedRequest[];
    }
  | ChannelTagRefusal;

/**
 * Build the pending queue: every action key with a live `approval.requested`.
 *
 * Order is log order (oldest request first), which is the order SPEC.md §9's
 * queue projection asks for. One verified read serves the whole queue, and one
 * policy load serves every entry, so an entry cannot disagree with its
 * neighbour about what the policy says.
 */
export function buildPendingQueue(
  logPath: string,
  options: TagOptions,
  now: string,
): PendingQueueResult {
  const read = readVerifiedRecords(
    logPath,
    options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir },
  );
  if (!read.ok) return refuse(read.code, read.message);

  const load = loadPolicy(loadOptionsOf(options));
  const ttlMs = ttlOf(load);
  const headSeq = read.head?.seq ?? 0;
  const withStoreOptions = withStore(options, logPath);

  const keys: string[] = [];
  for (const record of read.records) {
    if (record.event !== "approval.requested") continue;
    const key = record.action_key;
    if (key === undefined || keys.includes(key)) continue;
    keys.push(key);
  }

  const requests: ChannelRequest[] = [];
  const skipped: SkippedRequest[] = [];
  for (const key of keys) {
    const derivation = requestState(read.records, key, now, ttlMs);
    if (derivation.state !== "requested") continue;
    const built = tagDerivation(read.records, headSeq, derivation, load, withStoreOptions, now);
    if (built.ok) requests.push(built.request);
    else skipped.push({ action_key: key, code: built.code, message: built.message });
  }

  return { ok: true, requests, skipped };
}
