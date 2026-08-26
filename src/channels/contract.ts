/**
 * The channel plugin contract (SPEC.md §9, §10.3, §10.4, §11).
 *
 * A channel is **transport**. It takes a render-ready request from the runtime,
 * puts it in front of a human, and hands back the gesture the human made. It
 * holds no state (§10.3: "Decisions become log events; channels hold no state"),
 * it never reads the log, it never writes the log, and it never decides
 * anything. Everything a channel could get wrong about *authority* is therefore
 * removed from a channel by construction:
 *
 * - **It cannot invent a field.** Every displayable datum on {@link
 *   ChannelRequest} is a {@link TaggedField}: either `computed` (the runtime
 *   derived it, and `source` names the derivation) or `claimed` (the party under
 *   oversight authored it, and `author` names them). There is no untagged
 *   member, so "render this string" is not a thing a channel can do without
 *   first knowing which side of the verification boundary the string came from.
 *   SPEC.md §9 and §10.3 both say the same sentence twice: rendering claimed
 *   fields with the visual authority of computed fields is a conformance
 *   failure. This type makes the mistake require deliberate effort.
 * - **It cannot approve anything.** {@link ChannelDecision} is a *report* of a
 *   human gesture. Turning it into an `approval.granted` is
 *   {@link recordChannelDecision}'s job, and that function does exactly one
 *   thing: call `core/gate.ts`'s human-only `decide()`. Every gate rule — human
 *   actor, attestation on grant, TTL lapse, budget re-check, compare-and-append,
 *   idempotency — applies unchanged, because there is no second path.
 * - **It cannot hold a secret.** A grant mints a single-use execution token.
 *   {@link recordChannelDecision} returns it to *its caller* (the runtime) in a
 *   field that is deliberately not part of {@link DecisionOutcome}, which is the
 *   only value handed back to the channel. A channel that logged its own
 *   outcomes would log nothing sensitive.
 *
 * ## Manual requests and the full payload (SPEC.md §10.4)
 *
 * > For `manual` actions, channels MUST present the full payload or a faithful
 * > rendering of it, clearly delineated from any agent-written summary, before
 * > collecting a decision.
 *
 * {@link createChannelRequest} refuses to build a `manual` request whose
 * `fullPayload` is null. A channel therefore cannot be handed a manual request
 * that has nothing to show; the failure surfaces at construction, inside the
 * runtime, rather than as a channel silently rendering a summary alone.
 *
 * ## What is deliberately not here
 *
 * No I/O beyond {@link recordChannelDecision}'s delegation to the gate; no
 * clock; no rendering. Building a {@link ChannelRequest} from a log is
 * `channels/tagging.ts`, batching is `channels/batch.ts`, and the shared
 * pass/fail suite every channel implementation must survive is
 * `channels/conformance.ts`.
 */

import type { AttestationStatus } from "../core/attest.js";
import type { BudgetVerdict } from "../core/budgets.js";
import { decide, type DecideOptions, type GateRefusal } from "../core/gate.js";
import type { EventRecord } from "../core/log.js";
import type { Autonomy } from "../core/policy-load.js";
import type { Provenance } from "../core/policy-match.js";
import type { RequestState } from "../core/state.js";

// ---------------------------------------------------------------------------
// Truth labelling
// ---------------------------------------------------------------------------

/**
 * The canonical `source` values the runtime tagger stamps on computed fields.
 *
 * `TaggedField`'s `source` is typed `string` rather than this union on purpose:
 * an adapter or a satellite runtime may derive a field from a derivation this
 * repo has not named, and forcing it to lie about the provenance would be worse
 * than admitting a name we do not recognize. These are the names
 * `channels/tagging.ts` uses, and the ones a reviewer should expect to see.
 */
export const COMPUTED_SOURCES = [
  /** Read from a verified log record (`core/state.ts`). */
  "log",
  /** Resolved against the attested policy (`core/policy-match.ts`, `policy-explain.ts`). */
  "policy-match",
  /** Evaluated by `core/budgets.ts` at display time. */
  "budgets",
  /** Compared against the latest attestation (`core/attest.ts`). */
  "attestation",
  /** Recomputed from the payload bytes and checked against the bound hash. */
  "payload-binding",
  /**
   * Re-derived from the hash-checked payload bytes by `core/command-class.ts`
   * — the same module whose answer selected the class (APRV-143).
   *
   * Distinct from `payload-binding`, which names the hash agreement itself.
   * This names the classifier's reading OF those bytes, which is a second
   * derivation over the same material and can be wrong in ways the hash cannot
   * catch: a channel that labelled it `payload-binding` would be borrowing the
   * binding's authority for an answer the binding does not cover.
   */
  "classifier",
  /** Arithmetic on the display-time instant (TTL remaining). */
  "clock",
] as const;

export type ComputedSource = (typeof COMPUTED_SOURCES)[number];

/**
 * One displayable datum, labelled with which side of the verification boundary
 * it came from (SPEC.md §9).
 *
 * `computed`: the runtime derived it from the log, the policy, or the payload
 * bytes. `source` names *which* derivation, so a channel can say "class:
 * financial.spend (policy)" rather than implying the runtime vouches for a
 * string an agent typed.
 *
 * `claimed`: the party under oversight authored it. `author` is their actor id.
 * SPEC.md §11's ratchet applies to every one of these: they may raise scrutiny
 * and never lower it, so a channel may render them prominently, but never as
 * fact.
 */
export type TaggedField<T> =
  | { kind: "computed"; value: T; source: string }
  | { kind: "claimed"; value: T; author: string };

/** Tag `value` as runtime-derived, naming the derivation that produced it. */
export function computed<T>(value: T, source: ComputedSource | string): TaggedField<T> {
  return { kind: "computed", value, source };
}

/** Tag `value` as authored by `author`, the party under oversight. */
export function claimed<T>(value: T, author: string): TaggedField<T> {
  return { kind: "claimed", value, author };
}

/** Is `value` a well-formed {@link TaggedField}? Used by the conformance suite. */
export function isTaggedField(value: unknown): value is TaggedField<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const field = value as Record<string, unknown>;
  if (!("value" in field)) return false;
  if (field["kind"] === "computed") return typeof field["source"] === "string";
  if (field["kind"] === "claimed") return typeof field["author"] === "string";
  return false;
}

// ---------------------------------------------------------------------------
// The render-ready request
// ---------------------------------------------------------------------------

/**
 * The payload bytes a manual approval binds to, plus a faithful rendering of
 * them (SPEC.md §10.4).
 *
 * `hash` is recomputed here from `value` by `core/payload.ts` and checked
 * against the `payload_hash` the log recorded, which is what makes this a
 * *computed* field rather than one more agent claim: material that does not
 * hash to the bound value never reaches a channel at all.
 *
 * `truncated` is the honest admission that `text` is shorter than `value`. A
 * truncated rendering is still legal for a single request (a channel may offer
 * "show more"), but it is what {@link ../channels/batch.js assembleBatch}
 * refuses to fold into a batch — see the B7 operationalization there.
 */
export interface PayloadRendering {
  /** The concrete payload value, exactly as it will be executed. */
  value: unknown;
  /** A faithful text rendering of `value`, for channels that display text. */
  text: string;
  /** SHA-256/JCS of `value`, recomputed; equal to the log's `payload_hash`. */
  hash: string;
  /** `text` omits part of `value`. */
  truncated: boolean;
}

/** Where the request sits in the hash chain (SPEC.md §8, §9 "chain position"). */
export interface ChainPosition {
  /** `seq` of the `approval.requested` record. */
  seq: number;
  /** That record's hash. */
  hash: string;
  /** `seq` of the log head at the moment this request was built. */
  head_seq: number;
}

/**
 * A pending manual request, ready to render — and nothing else.
 *
 * Every member is a {@link TaggedField}. That is the point of the type: a
 * channel iterating this object cannot reach a bare value, so the question
 * "computed or claimed?" is answered before the question "how do I display it?"
 * can be asked. Adding an untagged member to this interface would be the defect
 * this whole module exists to prevent.
 */
export interface ChannelRequest {
  /** The action's idempotency key (`core/gate.ts`). */
  action_key: TaggedField<string>;
  /** The Backlog.md task id, or `null` when the log records none. */
  task: TaggedField<string | null>;
  /** The declared side-effect class, as the log records it (SPEC.md §7). */
  class: TaggedField<string>;
  /** Autonomy resolved against the attested policy at display time. */
  autonomy: TaggedField<Autonomy>;
  /** How that resolution was reached (`rule`, `default`, `fail-closed`, …). */
  provenance: TaggedField<Provenance>;
  /** The agent's cost estimate. Claimed: it is a promise, not a measurement. */
  est_cost_usd: TaggedField<number>;
  /** The agent's one-line description of the effect. Claimed. */
  summary: TaggedField<string | null>;
  /** `route.rationale`, when the log carries one. Claimed. */
  rationale?: TaggedField<string>;
  /** `route.confidence`, when the log carries one. Claimed, and never a gate. */
  confidence?: TaggedField<number>;
  /**
   * The protected path that selected `policy.edit`, and the rule that matched
   * it (APRV-143): `.github/workflows/ci.yml (rule protected-path)`.
   *
   * **Computed.** For a shell payload the classifier is re-run over the bound
   * command; for a file-tool payload `isProtectedPath` is re-run over the bound
   * target. Either way the answer is recomputed from the bytes the approval
   * binds to rather than read off a claim, which is what puts it on this side
   * of the boundary. Absent when no protected path selected the class.
   */
  protected_path?: TaggedField<string>;
  /** The content binding recorded on `approval.requested` (SPEC.md §6.2). */
  payload_hash: TaggedField<string>;
  /**
   * The bytes the approval binds to (SPEC.md §10.4). Non-null is enforced at
   * construction for `manual` autonomy: see {@link createChannelRequest}.
   */
  fullPayload: TaggedField<PayloadRendering | null>;
  /** Budget verdicts as of the display instant (`core/budgets.ts`). */
  budgets: TaggedField<BudgetVerdict[]>;
  /** Whether the live policy still matches the attestation (`core/attest.ts`). */
  attestation: TaggedField<AttestationStatus>;
  /** The `approval.requested` timestamp, assigned by the runtime (SPEC.md §8). */
  requested_ts: TaggedField<string>;
  /** Milliseconds of TTL left, or `null` when the policy declares no TTL. */
  ttl_remaining_ms: TaggedField<number | null>;
  /**
   * One line telling the approver how old this question is and how long an
   * answer will still reach anyone (APRV-106):
   *
   * ```
   * requested 32 min ago · requester waits until 09:23 UTC
   * requested 32 min ago · expires 09:23 UTC
   * ```
   *
   * **Computed.** Both halves are arithmetic on instants read from the
   * verified log against the display instant: the age from the
   * `approval.requested` record's runtime-assigned `ts`, and the deadline from
   * either the policy's TTL or, for a request that declared one, the
   * requester's own `wait_until`.
   *
   * That second source is the only place a requester-authored value reaches
   * this line, and it is safe in the direction that matters. `wait_until` is
   * always EARLIER than the TTL (a process that waits longer than the TTL is
   * waiting for something that has already lapsed), so it can only make the
   * question look more urgent, never less. It bounds nothing, charges nothing
   * and gates nothing — SPEC.md §11.1's ratchet holds, because the only
   * scrutiny it can move is upward.
   *
   * The line exists because the incident behind APRV-106 was a human answering
   * a question thirty minutes after its asker had stopped listening. The
   * withdrawal removes that question from the queue; this tells an approver who
   * is looking at the message right now how much time is actually left.
   */
  waiting: TaggedField<string>;
  /** Position in the hash chain. */
  chain: TaggedField<ChainPosition>;
  /** The derived approval state; always `requested` for a live pending item. */
  state: TaggedField<RequestState>;
}

/** Refusals {@link createChannelRequest} can return. Frozen, per §11.1(6). */
export const CHANNEL_REQUEST_REFUSAL_CODES = [
  /** A `manual` request was built with no full payload to present (§10.4). */
  "manual-payload-required",
  /** A member arrived that is not a {@link TaggedField}. */
  "untagged-field",
] as const;

export type ChannelRequestRefusalCode = (typeof CHANNEL_REQUEST_REFUSAL_CODES)[number];

export interface ChannelRequestRefusal {
  ok: false;
  code: ChannelRequestRefusalCode;
  message: string;
}

export type CreateChannelRequestResult =
  | { ok: true; request: ChannelRequest }
  | ChannelRequestRefusal;

/**
 * Build a {@link ChannelRequest}, enforcing the two invariants a type alone
 * cannot.
 *
 * 1. **§10.4**: a `manual` request MUST carry a full payload. A manual request
 *    with `fullPayload.value === null` is refused `manual-payload-required` and
 *    no object is produced, so no channel can be handed one.
 * 2. **§9**: every member is tagged. The interface says so, but a JavaScript
 *    caller (a satellite runtime, a test, an adapter compiled from looser
 *    sources) can still hand over a bare value; that is refused
 *    `untagged-field` rather than passed through to a renderer that would
 *    display it with unearned authority.
 */
export function createChannelRequest(fields: ChannelRequest): CreateChannelRequestResult {
  for (const [name, field] of Object.entries(fields)) {
    if (field === undefined) continue;
    if (!isTaggedField(field)) {
      return {
        ok: false,
        code: "untagged-field",
        message: `channel request field ${JSON.stringify(name)} is not a tagged field. SPEC.md §9 requires every displayed field to be visibly computed or claimed; an untagged value would be rendered with whatever authority the channel's stylesheet happens to give it.`,
      };
    }
  }

  if (fields.autonomy.value === "manual" && fields.fullPayload.value === null) {
    return {
      ok: false,
      code: "manual-payload-required",
      message: `action ${fields.action_key.value} resolves to manual and carries no full payload. SPEC.md §10.4: for manual actions a channel MUST present the full payload or a faithful rendering of it, clearly delineated from any agent-written summary, before collecting a decision. A request with nothing to present would put a human's decision behind an agent's summary alone, so it is refused here rather than rendered.`,
    };
  }

  return { ok: true, request: fields };
}

/**
 * Every displayable member of `request` is a {@link TaggedField}.
 *
 * The runtime half of "untagged fields are unrepresentable": the type says it
 * at compile time, this says it at run time, and `channels/conformance.ts`
 * calls it on both the request handed to a channel and the split the channel
 * reports having rendered. Throws (rather than returning) because it is an
 * assertion helper used inside test suites.
 */
export function assertTagged(request: ChannelRequest): void {
  for (const [name, field] of Object.entries(request)) {
    if (field === undefined) continue;
    if (!isTaggedField(field)) {
      throw new Error(
        `channel request field ${JSON.stringify(name)} is not tagged computed/claimed (SPEC.md §9)`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Batching, as far as the contract needs to know about it
// ---------------------------------------------------------------------------

/**
 * A set of pending requests presented under one human gesture (SPEC.md §10.3).
 *
 * The log never batches: each member gets its own `approval.granted` /
 * `approval.rejected`. `deliveryId` is assigned by the channel at `notify` and
 * is what ties those separate events back to the one gesture.
 */
export interface ChannelBatch {
  requests: ChannelRequest[];
  /** Assigned by the channel at `notify`; absent until then. */
  deliveryId?: DeliveryId;
}

/** A channel's identifier for one delivery (message id, prompt id, …). */
export type DeliveryId = string;

/**
 * The event payload field carrying a batch's channel delivery id (SPEC.md
 * §10.3: each event carries "the batch's channel delivery id in its payload").
 *
 * First-class since APRV-38: `decide()` takes `batchDeliveryId` and writes this
 * field on `approval.granted` / `approval.rejected`, and the event schema
 * constrains it. What it replaced is described at
 * {@link BATCH_DELIVERY_NOTE_PREFIX}.
 */
export const BATCH_DELIVERY_ID_FIELD = "batch_delivery_id";

/**
 * The legacy `note` prefix that carried a batch delivery id before APRV-38.
 *
 * ## The dual-read window (amended SPEC.md §10.3)
 *
 * APRV-22 had no gate parameter and no schema entry to work with, so the id
 * rode inside the one caller-controlled payload field there was: `note`, whose
 * first line read `batch_delivery_id=<id>`, optionally followed by a newline
 * and the human's own words. Logs written by those builds exist and are
 * append-only, so the encoding cannot be migrated away: it can only stop being
 * written. That is exactly what happens now. {@link recordChannelDecision}
 * writes the first-class field and leaves `note` to the human, while
 * {@link batchDeliveryIdOf} reads both and prefers the field. Readers MUST
 * accept both encodings for the life of v0.1.
 *
 * {@link batchNote} is retained so a caller with a v0.1-era log to reproduce
 * can still produce the old shape. Nothing in this repository calls it on the
 * write path.
 */
export const BATCH_DELIVERY_NOTE_PREFIX = "batch_delivery_id=";

/**
 * Encode `batchDeliveryId` (and an optional human note) into a `note` string.
 *
 * The pre-APRV-38 encoding, kept for round-trip fidelity with logs that carry
 * it. New decisions use the first-class payload field instead.
 */
export function batchNote(batchDeliveryId: DeliveryId, note?: string): string {
  const head = `${BATCH_DELIVERY_NOTE_PREFIX}${batchDeliveryId}`;
  return note === undefined ? head : `${head}\n${note}`;
}

/**
 * The batch delivery id recorded on `record`, or `null` for a unit decision.
 *
 * Reads both encodings (see {@link BATCH_DELIVERY_NOTE_PREFIX}), preferring the
 * first-class `batch_delivery_id` field. The fallback is what keeps audit
 * granularity intact across a log that spans the change: a batch grant written
 * last month and one written today resolve to the same id here.
 */
export function batchDeliveryIdOf(record: EventRecord): DeliveryId | null {
  const payload = record.payload;
  if (typeof payload !== "object" || payload === null) return null;

  const field = payload[BATCH_DELIVERY_ID_FIELD];
  if (typeof field === "string" && field.length > 0) return field;

  const note = payload["note"];
  if (typeof note !== "string") return null;
  const first = note.split("\n", 1)[0] ?? "";
  if (!first.startsWith(BATCH_DELIVERY_NOTE_PREFIX)) return null;
  const id = first.slice(BATCH_DELIVERY_NOTE_PREFIX.length);
  return id.length === 0 ? null : id;
}

// ---------------------------------------------------------------------------
// The plugin interface
// ---------------------------------------------------------------------------

/** A human gesture, as reported by a channel. Never an authorization. */
export interface ChannelDecision {
  action_key: string;
  /**
   * What the human did. `revoke` is deliberately absent: withdrawing a standing
   * authorization is a considered act performed against the log through the
   * CLI, not something to collect from an inline button next to "Approve".
   */
  decision: "grant" | "reject";
  /** The human's free-text note, if the channel collected one. */
  note?: string;
  /** The delivery this gesture answered. */
  deliveryId: DeliveryId;
  /** Set when the delivery was a batch (SPEC.md §10.3). */
  batchDeliveryId?: DeliveryId;
}

/**
 * What the runtime tells the channel became of a reported decision.
 *
 * Note what is *not* here: the raw execution token. A grant mints one
 * (`core/token.ts`), and it is returned to the runtime by
 * {@link recordChannelDecision} in {@link ChannelDecisionResult.token}, never in
 * this value. A channel learns that a grant landed, not how to spend it.
 */
export type DecisionOutcome =
  | {
      ok: true;
      action_key: string;
      decision: "grant" | "reject";
      state: RequestState;
      /** The appended `approval.granted` / `approval.rejected` record. */
      record: EventRecord;
      /** A single-use execution token was minted (grant only). Never its value. */
      tokenIssued: boolean;
    }
  | GateRefusal;

/** A channel's self-report. `detail` explains a `false`; SPEC.md §10.2 polls it. */
export interface ChannelHealth {
  ok: boolean;
  detail?: string;
}

/**
 * The plugin interface every channel implements (SPEC.md §10.3's
 * `notify(request) -> delivery_id`, `poll()/webhook() -> decision`).
 *
 * `onDecision` is the poll/webhook half inverted: the channel discovers the
 * gesture however it likes (a prompt returning, an HTTP callback, a Telegram
 * button) and calls the registered handler. The handler is the runtime's, and
 * what it does is call {@link recordChannelDecision}. A channel that wanted to
 * write the log itself would have to import the gate, and the conformance suite
 * would not care — but the review would.
 */
export interface Channel {
  /** Stable identifier: `cli`, `web`, `telegram`. Recorded for audit. */
  name: string;
  /** Present a request (or a batch) to a human. Returns the delivery id. */
  notify(request: ChannelRequest | ChannelBatch): Promise<DeliveryId> | DeliveryId;
  /** Register the runtime's decision handler. Called once, before `notify`. */
  onDecision(handler: (decision: ChannelDecision) => DecisionOutcome): void;
  /** Liveness/config self-report. */
  health(): ChannelHealth;
  /**
   * Annotate a delivery whose request is no longer answerable, and take away
   * whatever gesture it offered (APRV-106). Optional.
   *
   * A withdrawn request leaves every queue by derivation — it is no longer
   * `requested`, and that one predicate is what every channel builds its queue
   * from — so a channel that implements nothing here is still correct: it will
   * never present the request again. What it will not do is fix the message
   * ALREADY on the approver's phone, which still shows two buttons for a
   * question nobody is waiting on. Push channels should implement this;
   * pull channels (`cli`, `web`) re-render from the queue every time and have
   * nothing to retract.
   *
   * Best effort by contract: the runtime calls it and carries on. It collects
   * no gesture, returns no decision, and touches no log.
   */
  retract?(deliveryId: DeliveryId, reason: string): Promise<void> | void;
}

/** One field as a channel actually rendered it. */
export interface RenderedField {
  /** The {@link ChannelRequest} member this came from. */
  field: string;
  /** How the channel presented it. Must equal the field's own `kind`. */
  kind: "computed" | "claimed";
  /** What the human saw. */
  text: string;
}

/** What a channel says it put in front of a human, for one request. */
export interface RenderedRequest {
  action_key: string;
  fields: RenderedField[];
  /**
   * The full-payload region, verbatim and delineated from the summary
   * (SPEC.md §10.4). `null` means the channel rendered no payload — legal only
   * off the manual path.
   */
  fullPayloadText: string | null;
  /** Set when this request was rendered as part of a batch. */
  batchDeliveryId?: DeliveryId;
}

/**
 * A channel that can be asked what it rendered, for tests only.
 *
 * Conformance cannot read a Telegram message or a terminal's scrollback, so a
 * channel under test reports its own rendering split and the suite checks it
 * against the tagged request. That is an honesty-assuming check — a channel
 * could lie about what it rendered — and it is worth having anyway: the failure
 * mode it catches is a channel that *believes* a claimed field is computed,
 * which is a code path, not a lie. Implementations should build
 * {@link lastRendered} from the same function that builds the real output, not
 * from a parallel description of it.
 */
export interface TestableChannel extends Channel {
  /** The most recent rendering: one entry per request, batch members included. */
  lastRendered(): RenderedRequest[];
}

/** Is this channel introspectable by the conformance suite? */
export function isTestableChannel(channel: Channel): channel is TestableChannel {
  return typeof (channel as TestableChannel).lastRendered === "function";
}

// ---------------------------------------------------------------------------
// Recording a decision — the runtime's job, never the channel's
// ---------------------------------------------------------------------------

/** Who is recording. A `human:` id; the gate refuses anything else. */
export interface ChannelActorOptions {
  /** The approver's identity (`human:<id>`; SPEC.md §11 — config-declared). */
  actor: string;
  /** The channel that collected the gesture, for audit context in the note. */
  channel?: string;
}

/**
 * {@link recordChannelDecision}'s result: the channel-safe outcome, plus the
 * secret the channel must never see.
 */
export interface ChannelDecisionResult {
  /** Hand this back to the channel. Carries no token. */
  outcome: DecisionOutcome;
  /**
   * The raw single-use execution token, on a successful grant only (APRV-17).
   * The runtime keeps it; the log holds only its SHA-256. Splitting it out of
   * `outcome` is what lets a channel's `onDecision` handler return the outcome
   * without ever holding the token.
   */
  token?: string;
}

/**
 * Turn a reported gesture into a log event — by calling the gate, and by doing
 * nothing else.
 *
 * There is no second decision path in this codebase and this function is not
 * one: it is a translation from {@link ChannelDecision} to `decide()`'s
 * arguments. Every gate rule therefore still holds, and every gate refusal code
 * still surfaces verbatim in {@link DecisionOutcome}:
 *
 * - `actor-not-human` — the configured actor is not `human:…`. A channel cannot
 *   escalate itself by claiming to be one, because the actor comes from the
 *   runtime's configuration, not from the {@link ChannelDecision}.
 * - `already-decided` — the duplicate-callback case every push channel has
 *   (a Telegram button pressed twice, a webhook redelivered). It refuses, and
 *   the log keeps the first human answer.
 * - `expired`, `budget-exceeded`, `policy-not-attested`, `append-failed`
 *   (`head-moved`) — unchanged, all of them.
 *
 * `batchDeliveryId`, when present, is passed to the gate as such and lands in
 * the event payload as `batch_delivery_id` (amended SPEC.md §10.3). The human's
 * `note` is left carrying the human's words alone. See
 * {@link BATCH_DELIVERY_NOTE_PREFIX} for the encoding this replaced and for the
 * dual-read window readers stay inside for the life of v0.1.
 */
export function recordChannelDecision(
  logPath: string,
  decision: ChannelDecision,
  actorOptions: ChannelActorOptions,
  gateOptions: DecideOptions = {},
): ChannelDecisionResult {
  const options: DecideOptions = { ...gateOptions };
  if (decision.note !== undefined) options.note = decision.note;
  if (decision.batchDeliveryId !== undefined) {
    options.batchDeliveryId = decision.batchDeliveryId;
  }

  const result = decide(
    logPath,
    decision.action_key,
    decision.decision,
    actorOptions.actor,
    options,
  );

  if (!result.ok) return { outcome: result };

  const outcome: DecisionOutcome = {
    ok: true,
    action_key: decision.action_key,
    decision: decision.decision,
    state: result.state,
    record: result.record,
    tokenIssued: result.token !== undefined,
  };
  return result.token === undefined ? { outcome } : { outcome, token: result.token };
}
