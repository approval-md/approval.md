/**
 * The gate: request lifecycle and write-boundary transition enforcement
 * (SPEC.md §6.3, §7, §10.1).
 *
 * This is the module that decides whether a side effect may be authorized, and
 * it is the only module that appends approval lifecycle events. Everything it
 * knows it derives from the append-only log; everything it decides it decides
 * before a byte is written.
 *
 * ## Four rules this module exists to enforce
 *
 * 1. **State is derived, never stored.** {@link requestState} rebuilds one
 *    action's approval state from the log alone. There is no status field, no
 *    cache, no in-memory session. The envelope's `state:` key is a projection
 *    written by the daemon *after* the event lands (SPEC.md §6.3), never a
 *    source this module reads.
 * 2. **Illegal transitions are refused before append.** A second grant, a grant
 *    on a rejected request, a revoke of an executed action, a decision after the
 *    TTL — each is refused with its own machine-readable code and **nothing is
 *    appended**. The one deliberate exception is a failed budget check, which
 *    appends `budget.exceeded` *and then* refuses: a budget refusal is a fact
 *    about the world that an operator must be able to see afterwards, and a
 *    refusal nobody can audit is how quiet budget creep starts.
 * 3. **No approval events off the manual path** (amended SPEC.md §6.3). An
 *    action whose class resolves to `supervised` or `autonomous` produces *no*
 *    `approval.*` record at all — {@link request} returns `proceed: true` and
 *    appends nothing. Its authorization is recorded by `execution.started`,
 *    which APRV-18 appends, and which is also where its budget is charged (see
 *    the consumption contract in `core/budgets.ts`).
 * 4. **Time is assigned by the runtime, not by the caller** (amended SPEC.md
 *    §8, A2). No public function here takes a `ts`. TTL lapse, budget windows,
 *    and the timestamp stamped on every append all come from one read of
 *    {@link GateOptions.clock} — the real clock unless a caller injects one —
 *    made once per operation, so a gate decision is still replayable from its
 *    inputs while the party being judged no longer authors the clock it is
 *    judged by. Tests inject a fixed clock; production passes none.
 *
 * ## Lazy expiry — the named requirement
 *
 * A request expires when `ts > requestTs + defaults.approval_ttl`, **whether or
 * not** an `approval.expired` event exists. Nothing may depend on a daemon
 * having run: if the expiry sweep is asleep, a late grant must still be refused.
 * {@link requestState} therefore computes expiry two ways — from the event, and
 * lazily from the arithmetic — and treats them as equivalent.
 *
 * When {@link decide} refuses a decision because the TTL has lapsed and no
 * `approval.expired` event exists yet, it **first appends that event** (actor
 * {@link EXPIRY_ACTOR}) and then refuses. The alternative — refuse silently and
 * leave the log claiming the request is still live — was rejected: the log is
 * the truth, and a state every reader can derive but no reader can see recorded
 * makes the log disagree with itself. The append is the same one
 * {@link expire} would have made, so a later sweep is a no-op rather than a
 * duplicate.
 *
 * ## `defaults.on_expiry`
 *
 * SPEC.md §5 defines exactly one value, `reject`. An expired request is
 * terminal here under either setting: no grant, no reject, no revoke ever
 * follows it. `on_expiry` is recorded in the `approval.expired` payload so the
 * projection layer (M5) can render the envelope's `state:` as `rejected` rather
 * than `expired` when the policy asks for it. Re-requesting the same action key
 * after expiry is a *new* request and is allowed — the key has not executed, and
 * refusing forever would make a lapsed TTL more punishing than a human's "no".
 *
 * ## The budgets contract (`core/budgets.ts`)
 *
 * That module obligates this one: every `approval.granted` this module appends
 * carries `payload.est_cost_usd` (number, USD) and `payload.class` (the dotted
 * class). `approval.requested` carries them too, so the grant can copy them from
 * the request rather than re-derive them from a file that may have changed. An
 * action that declared no cost is recorded as `0` — an authorization with no
 * declared cost is still an authorization, and still counts as one action.
 *
 * ## Reads are verified, writes are compare-and-append (APRV-20)
 *
 * The gate no longer trusts the bytes it reads. {@link readGateRecords}
 * delegates to `core/state.ts`, which runs the *same* chain verification
 * `approval log verify` runs — one walk, one vocabulary — and refuses
 * `log-corrupt` on anything that does not verify. The gate still does not
 * *diagnose* corruption: it reports that the log is untrustworthy and points at
 * `approval log verify` for the detail, because two modules with two opinions
 * about what "corrupt" means is worse than one.
 *
 * Every append this module makes is authorized by something it read, so every
 * append passes `expectedHead` — the `(seq, hash)` observed at that read. If any
 * record landed in between, `appendEvent` refuses `head-moved` under its lock
 * and nothing is written. The gate does **not** retry: re-deriving a decision
 * against a log that changed is the caller's judgment call, not this module's.
 *
 * It does not define execution tokens — `core/token.ts` does. {@link decide}'s
 * grant path calls that module's `mintToken` at the seam APRV-17 documented,
 * records only the digest in the `approval.granted` payload, and returns the raw
 * token to its caller. {@link decide} still appends no `execution.*` event:
 * spending a token is `core/token.ts`'s `consumeToken`.
 *
 * The one place this module writes an execution event is
 * {@link consumeHarnessGrant} (APRV-117), and it is the exception that proves
 * the rule: a harness grant mints no token, so nothing else in the system could
 * record that it had been spent, and an authorization with no record of its
 * spending is an authorization that never runs out. See that function for why
 * the marker is `execution.started` and why no completion ever follows it.
 */

import { existsSync } from "node:fs";
import { basename, join } from "node:path";

import {
  ATTESTATION_REFUSAL,
  attestationRefusal,
  checkAttestation,
  POLICY_HASH_FIELD,
  type AttestationRefusalDetail,
} from "./attest.js";
import { evaluateBudgetsWithTask, type BudgetScope, type BudgetVerdict } from "./budgets.js";
import { tick, type ClockOptions } from "./clock.js";
import { readTaskFile } from "./frontmatter.js";
import {
  appendEvent,
  type AppendError,
  type AppendOptions,
  type EventInput,
  type EventRecord,
  type LogHead,
} from "./log.js";
import { isLoopEscalated } from "./loop.js";
import { isPayloadHash, payloadHash as hashOfPayload } from "./payload.js";
import { payloadStoreDirFor, storePayload } from "./payload-store.js";
import {
  loadPolicy,
  POLICY_FILENAMES,
  type Autonomy,
  type LoadPolicyOptions,
  type PolicyLoadResult,
} from "./policy-load.js";
import { resolve, type Resolution } from "./policy-match.js";
import {
  payloadOf,
  readVerifiedRecords,
  requestState,
  type Decision,
  type LogReadRefusal,
  type RequestDerivation,
  type RequestState,
  type WithdrawReason,
} from "./state.js";
import { mintToken, tokenHash, TOKEN_HASH_FIELD } from "./token.js";
import { validate, type ValidationError } from "./validate.js";

/**
 * The approval-state derivation moved to `core/state.ts` in APRV-20 (finding
 * S4: `gate.ts` and `token.ts` imported each other). It is re-exported here, its
 * documented home, so every existing importer — the CLI, the tests — is
 * unaffected by the move.
 */
export {
  requestState,
  type Decision,
  type DeclaredAction,
  type ExecutionFacts,
  type RequestDerivation,
  type RequestState,
  WITHDRAW_REASONS,
  isWithdrawReason,
  type WithdrawReason,
} from "./state.js";

/** Actor stamped on runtime-originated expiry events (SPEC.md §8 `system:`). */
export const EXPIRY_ACTOR = "system:gate";

/** Actors permitted to request or register: a person or an agent, never the runtime. */
const PRINCIPAL_ACTOR = /^(human|agent):.+/u;

/** Actors permitted to decide. Human-only, in code (SPEC.md §10.1). */
const HUMAN_ACTOR = /^human:.+/u;

/**
 * The closed set of gate refusal codes. Agents branch on these, so the union is
 * frozen public API in the same sense the exit codes are: adding a code is a
 * spec change, redefining one is a breaking change.
 */
export const GATE_REFUSAL_CODES = [
  /** Policy is unattested or its bytes changed (`core/attest.ts`). */
  "policy-not-attested",
  /**
   * The policy attested now is not the policy the request was routed under
   * (APRV-118, amended SPEC.md §5.2): the hash pinned on `approval.requested`
   * differs from the hash in force at the moment of the grant.
   *
   * Distinct from `policy-not-attested`, and the distinction is the whole point.
   * That code says the live file is unverified; this one says the file is
   * perfectly verified and is a DIFFERENT file from the one that decided this
   * action's autonomy, its limits, and its TTL. A human re-attested in between,
   * so the routing that put the question in front of an approver was computed
   * from rules nobody is enforcing any more, and a grant recorded here would
   * claim a decision under rules the approver never saw. The pending request is
   * void: nothing is appended, and the action is requested again so that it is
   * routed, budgeted, and displayed under the policy actually in force.
   */
  "policy-drift",
  /** The envelope failed `envelope.schema.json`, or the task file has none. */
  "envelope-invalid",
  /** The task file could not be read. */
  "task-file-unreadable",
  /** This task id already has a `task.registered` record. */
  "task-already-registered",
  /**
   * The task has log history and the file no longer carries an envelope
   * (APRV-63).
   *
   * Observed live in APRV-60: a third-party rewrite of a task file dropped the
   * `approval:` key it did not recognize. Without this code the file reads as an
   * ordinary envelope-less task, and a re-registration from a stripped file
   * would narrow the record silently — declaring fewer actions, or none, for a
   * task the log already says declared them. The loss is named instead, and the
   * envelope is restored by a human from the log; nothing here repairs a file.
   */
  "envelope-missing",
  /** No `task.registered` record for this task id. */
  "not-registered",
  /** The task is registered but declares no action with this key (SPEC.md §7). */
  "action-not-registered",
  /** A live `approval.requested` for this action key already exists. */
  "duplicate-request",
  /** The action key already has an `execution.*` record (idempotency). */
  "already-executed",
  /**
   * APRV-14 verdicts failed; a `budget.exceeded` event was appended. Covers
   * class limits, `policy.budgets`, and — since S2 — the registered envelope's
   * own `budget.max_cost_usd`, which appears as a `task`-scoped verdict in
   * `verdicts` and in the appended event's payload.
   */
  "budget-exceeded",
  /**
   * The action resolves to `manual` and its registered declaration carries no
   * `payload_hash` (amended SPEC.md §6.2: MUST for `manual` actions).
   *
   * Enforced here rather than in `envelope.schema.json` because the schema
   * cannot know an action's resolved autonomy — that answer depends on the
   * policy, the irreversibility floor, and the class, none of which the
   * envelope alone determines. A manual action with nothing to bind to would
   * give a human a decision about bytes nobody committed to, so intake refuses
   * and nothing is appended.
   */
  "payload-hash-required",
  /**
   * Payload material was supplied at intake and does not hash to the
   * `payload_hash` the registration declared (APRV-28).
   *
   * The same code, and the same reason, as `core/token.ts`'s refusal at spend
   * time: a grant approves specific bytes, so material that hashes to something
   * else is not the payload this request is about. Refused before anything is
   * stored and before anything is appended.
   */
  "payload-mismatch",
  /**
   * The declared payload material could not be stored (APRV-28): it cannot be
   * canonicalized, or the store directory could not be written.
   *
   * Fails closed rather than requesting anyway. A manual request whose bytes no
   * channel can display is a request no human can answer — SPEC.md §10.4 —
   * so intake refuses and the log is left untouched.
   */
  "payload-store-failed",
  /**
   * A grant was attempted on a request whose payload carries no usable `class`.
   *
   * Its own code since APRV-20 pass two: the previous behavior substituted the
   * empty string and granted anyway, which recorded an authorization that no
   * class-scoped budget could ever charge and no policy rule could ever match.
   * Fail closed and say which fact was missing.
   */
  "grant-classless-request",
  /**
   * Loop safety escalated the task to manual (SPEC.md §10.2, APRV-18): three
   * consecutive `execution.failed` events. Only the non-manual paths are
   * refused — see {@link request}.
   */
  "loop-escalated",
  /** No request to decide. */
  "not-requested",
  /** The request already has a terminal decision. */
  "already-decided",
  /** Revoke was attempted on a request that is not granted. */
  "not-granted",
  /**
   * A decision was attempted on a request the requester had already withdrawn
   * (APRV-106, amended SPEC.md §6.3).
   *
   * Distinct from `already-decided` because the facts and the repairs are
   * distinct. `already-decided` says a human answered and the answer stands;
   * this one says nobody answered and nobody can — the party that asked has
   * stopped listening, so a grant here would authorize an action no process is
   * waiting to perform. The repair is to request the action again, which is a
   * new request with a new decision, not to try the decision a second time.
   */
  "request-withdrawn",
  /**
   * A withdrawal was attempted by an actor other than the one that appended the
   * matching `approval.requested` (APRV-106).
   *
   * Withdrawal is the requester's own retraction, and nothing more. If any
   * actor could withdraw, then any actor could clear an approver's queue — the
   * queue would become deniable by whoever reached the log first, which is the
   * one property the gate exists to deny. A human who wants a pending request
   * gone rejects it, on the record, as themselves.
   */
  "not-requester",
  /** The TTL lapsed — judged from the request's own ts, event or no event. */
  "expired",
  /** `expire` was called on a request whose TTL has not lapsed. */
  "not-expired",
  /** The actor is not a well-formed `human:`/`agent:` identity. */
  "actor-invalid",
  /** A human-only verb was attempted by a non-human actor. */
  "actor-not-human",
  /** The log could not be read, or holds a line that is not a record. */
  "log-unreadable",
  /** The log's final line is unterminated (a crashed write). */
  "log-torn-tail",
  /**
   * The chain does not verify (APRV-20 finding S1). Distinct from
   * `log-unreadable`, which is a filesystem fact: this one says the log's own
   * contents contradict each other, so nothing may be authorized from it.
   */
  "log-corrupt",
  /**
   * The append itself failed; `append` carries the underlying error. Its
   * `code` is `head-moved` when the log grew between this module's read and its
   * append: every check that authorized the write was made against an older log,
   * so nothing was written and nothing is retried here.
   */
  "append-failed",
] as const;

export type GateRefusalCode = (typeof GATE_REFUSAL_CODES)[number];

/** Every gate failure is one of these. Nothing here throws. */
export interface GateRefusal {
  ok: false;
  code: GateRefusalCode;
  message: string;
  /** Attestation discriminator, when `code` is `policy-not-attested`. */
  detail?: AttestationRefusalDetail;
  /** The derived state at refusal time, for transition refusals. */
  state?: RequestState;
  /** The failing verdicts, when `code` is `budget-exceeded`. */
  verdicts?: BudgetVerdict[];
  /** Schema errors, when `code` is `envelope-invalid`. */
  errors?: ValidationError[];
  /** The underlying append error, when `code` is `append-failed`. */
  append?: AppendError;
  /**
   * An event appended *alongside* the refusal: the `budget.exceeded` record, or
   * the lazily-materialised `approval.expired` record. Never an authorization.
   */
  record?: EventRecord;
}

/**
 * Options shared by every gate operation.
 *
 * Note what is **not** here and no longer a parameter anywhere in this module:
 * `ts`. Under amended SPEC.md §8 a gate-typed event's timestamp is assigned by
 * the runtime at the write boundary, so it is read from {@link ClockOptions
 * clock} (defaulting to the real clock) rather than accepted from the caller.
 * The refusal the spec asks for is structural: there is no parameter to pass.
 */
export interface GateOptions extends ClockOptions {
  /** Schema directory, passed to both envelope validation and the append. */
  schemaDir?: string;
  /** Where to find `APPROVAL.md`. Same semantics as `loadPolicy`. */
  policy?: { dir?: string; file?: string };
  /** Lock tuning for the append path. */
  append?: AppendOptions;
  /**
   * Where payload material is stored (APRV-28). Defaults to the convention
   * `core/payload-store.ts` defines: `.approval/payloads/`, beside the log.
   */
  payloadStoreDir?: string;
}

// ---------------------------------------------------------------------------
// Log reading
// ---------------------------------------------------------------------------

type ReadOutcome = { ok: true; records: EventRecord[]; head: LogHead | null } | GateRefusal;

function refuse(
  code: GateRefusalCode,
  message: string,
  extra: Omit<GateRefusal, "ok" | "code" | "message"> = {},
): GateRefusal {
  return { ok: false, code, message, ...extra };
}

/** A read refusal is already one of this module's codes; widen it in place. */
function fromReadRefusal(refusal: LogReadRefusal): GateRefusal {
  return refuse(refusal.code, refusal.message);
}

/**
 * Read the log's records, refusing unless the whole chain verifies.
 *
 * Delegates to `core/state.ts`'s {@link readVerifiedRecords}: since APRV-20
 * (finding S1) the gate does not merely parse the log, it verifies it. A
 * corrupt log refuses `log-corrupt` and authorizes nothing; a torn tail refuses
 * `log-torn-tail`, unchanged, because the repair is a human decision and never a
 * gate's; an unopenable file refuses `log-unreadable`, an I/O fact rather than an
 * accusation.
 *
 * The returned `head` is what every append site here passes as `expectedHead`,
 * so a decision derived from these records cannot land on a log that moved
 * underneath it.
 */
export function readGateRecords(logPath: string, schemaDir?: string): ReadOutcome {
  const read = readVerifiedRecords(
    logPath,
    schemaDir === undefined ? {} : { schemaDir },
  );
  return read.ok ? read : fromReadRefusal(read);
}

// ---------------------------------------------------------------------------
// Policy plumbing
// ---------------------------------------------------------------------------

/**
 * The policy file the gate will hash for attestation.
 *
 * `file` wins; otherwise discovery walks `POLICY_FILENAMES` in `dir` exactly as
 * `loadPolicy` does, so the attested file and the enforced file are the same
 * file. When neither exists the first candidate is returned anyway, so
 * `checkAttestation` reports `unreadable` and the gate refuses — a missing
 * policy is never a pass.
 */
function policyPathOf(options: GateOptions): string {
  const policy = options.policy ?? {};
  if (policy.file !== undefined) return policy.file;
  const dir = policy.dir ?? process.cwd();
  for (const filename of POLICY_FILENAMES) {
    const candidate = join(dir, filename);
    if (existsSync(candidate)) return candidate;
  }
  return join(dir, POLICY_FILENAMES[0] ?? "APPROVAL.md");
}

function loadOptionsOf(options: GateOptions): LoadPolicyOptions {
  const policy = options.policy ?? {};
  const load: LoadPolicyOptions = {};
  if (policy.file !== undefined) load.file = policy.file;
  else load.dir = policy.dir ?? process.cwd();
  if (options.schemaDir !== undefined) load.schemaDir = options.schemaDir;
  return load;
}

function appendOptionsOf(options: GateOptions): AppendOptions {
  const append: AppendOptions = { ...options.append };
  if (options.schemaDir !== undefined) append.schemaDir = options.schemaDir;
  return append;
}

/**
 * Refuse unless the live policy bytes match the latest attestation, and return
 * the hash they matched (APRV-118).
 *
 * The hash is the same value `approval policy attest` recorded and the same
 * bytes `loadPolicy` is about to parse, so it names the exact rules this
 * operation is being decided under. Callers pin it onto the event they write:
 * an operation that could not be authorized without an attested policy should
 * say, on the record, which attested policy authorized it.
 */
function requireAttestation(
  records: EventRecord[],
  options: GateOptions,
): { ok: true; sha256: string } | GateRefusal {
  const status = checkAttestation(records, policyPathOf(options));
  const refusal = attestationRefusal(status);
  if (refusal !== null) {
    return refuse(ATTESTATION_REFUSAL, refusal.message, { detail: refusal.detail });
  }
  // `attestationRefusal` returns null for exactly one status, and that status
  // is the one carrying the hash.
  return { ok: true, sha256: (status as { status: "attested"; sha256: string }).sha256 };
}

/** The TTL in force, or `null` when the policy declares (or can declare) none. */
function ttlOf(load: PolicyLoadResult): number | null {
  return load.ok ? load.durations.approvalTtlMs : null;
}

function budgetScopeOf(load: PolicyLoadResult, resolution: Resolution): BudgetScope {
  return {
    classLimits: resolution.limits,
    classPattern: resolution.matched === null ? null : resolution.matched.pattern,
    globalBudgets: load.ok ? load.policy.budgets ?? null : null,
  };
}

/**
 * Append one event, with the compare-and-append precondition (APRV-20).
 *
 * `expectedHead` is the head observed at the read that authorized this write.
 * Passing it is not optional at any site here: every gate append is authorized
 * by something read from the log, and an append that skipped the precondition
 * would be exactly the check-then-act race the option exists to close.
 */
function append(
  logPath: string,
  input: EventInput,
  options: GateOptions,
  expectedHead: LogHead | null,
): { ok: true; record: EventRecord } | GateRefusal {
  const result = appendEvent(logPath, input, { ...appendOptionsOf(options), expectedHead });
  if (result.ok) return { ok: true, record: result.record };
  return refuse(
    "append-failed",
    `${input.event} could not be appended: ${result.error.message}`,
    { append: result.error },
  );
}

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

/** One declared action of an envelope (SPEC.md §6.2 `actions[]`). */
export interface RegisteredAction {
  class: string;
  idempotency_key: string;
  summary?: string;
  reversible?: boolean;
  est_cost_usd?: number;
  /**
   * The content binding of amended SPEC.md §6.2. MUST be present for an action
   * that resolves to `manual`; the enforcement point is {@link request}, not
   * registration, because autonomy is not known until policy is consulted and
   * refusing at registration would make an envelope unregisterable for a
   * property of a policy file it never mentions.
   */
  payload_hash?: string;
}

/**
 * What to register: a task file to read, or an already-in-hand envelope.
 *
 * The task **id** is not part of the envelope — `envelope.schema.json` governs
 * the value of the `approval:` key only, and `id:` is a sibling board key owned
 * by Backlog.md (SPEC.md §6). So the file form reads it from the frontmatter's
 * `id`, and the in-memory form takes it explicitly.
 */
export type RegisterSource = { file: string } | { task: string; envelope: unknown };

export type RegisterResult =
  | { ok: true; record: EventRecord; task: string; actions: RegisteredAction[] }
  | GateRefusal;

function actionsOf(envelope: unknown): RegisteredAction[] {
  const value = (envelope as { actions?: unknown }).actions;
  if (!Array.isArray(value)) return [];
  const actions: RegisteredAction[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const cls = item["class"];
    const key = item["idempotency_key"];
    if (typeof cls !== "string" || typeof key !== "string") continue;
    const action: RegisteredAction = { class: cls, idempotency_key: key };
    if (typeof item["summary"] === "string") action.summary = item["summary"];
    if (typeof item["reversible"] === "boolean") action.reversible = item["reversible"];
    if (typeof item["est_cost_usd"] === "number") action.est_cost_usd = item["est_cost_usd"];
    if (isPayloadHash(item["payload_hash"])) action.payload_hash = item["payload_hash"];
    actions.push(action);
  }
  return actions;
}

/**
 * The envelope's own `budget` block (SPEC.md §6.2), as registered.
 *
 * Copied into the `task.registered` payload so the task cap is enforced from
 * the log rather than from a file an agent can edit after the fact (S2; see
 * `core/budgets.ts`'s `taskMaxCostUsd`). Only `max_cost_usd` is enforced at
 * v0.1 — `max_latency` is recorded and does nothing yet — so the whole block is
 * copied verbatim rather than a single field cherry-picked, and the enforcement
 * that arrives later reads a log that already carries what it needs.
 */
function budgetOf(envelope: unknown): Record<string, unknown> | null {
  const value = (envelope as { budget?: unknown }).budget;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * A file that carries no envelope, and the id to ask the log about (APRV-63).
 *
 * `kind` records which of the two shapes of loss the file has, because the
 * message a human reads should say what they are looking at. `loose` marks the
 * id as *derived from the file name* rather than read out of frontmatter, which
 * is the only handle a file with no frontmatter at all leaves behind; it is
 * matched case-insensitively and never used as the registered id.
 */
interface NoEnvelope {
  task: string;
  kind: "no-approval-key" | "no-frontmatter";
  loose: boolean;
}

type Resolved =
  | { ok: true; task: string; envelope: unknown }
  | { ok: false; refusal: GateRefusal; missing?: NoEnvelope };

/**
 * The Backlog.md board key a task file's name begins with (`task-3 - Slug.md`).
 *
 * A hint and nothing more: it is used only to *ask the log a question*, and the
 * answer, when there is one, comes from the log's own record.
 */
function taskIdFromFileName(path: string): string | null {
  const match = /^([A-Za-z][A-Za-z0-9_]*-\d+)/u.exec(basename(path));
  return match?.[1] ?? null;
}

function resolveSource(source: RegisterSource): Resolved {
  if (!("file" in source)) {
    if (typeof source.task !== "string" || source.task.length === 0) {
      return { ok: false, refusal: refuse("envelope-invalid", "register requires a non-empty task id") };
    }
    return { ok: true, task: source.task, envelope: source.envelope };
  }
  return readTaskFileSource(source.file);
}

function readTaskFileSource(path: string): Resolved {
  const read = readTaskFile(path);
  if (!read.ok) {
    if (read.code === "io") {
      return { ok: false, refusal: refuse("task-file-unreadable", read.message) };
    }
    const refusal = refuse("envelope-invalid", `${path}: ${read.message}`);
    // A file with no frontmatter at all has lost more than the envelope, and
    // leaves no id behind. Its name is the only handle; whether it means
    // anything is the log's answer, not this file's.
    const hint = read.code === "no-frontmatter" ? taskIdFromFileName(path) : null;
    if (hint === null) return { ok: false, refusal };
    return {
      ok: false,
      refusal,
      missing: { task: hint, kind: "no-frontmatter", loose: true },
    };
  }
  const id = read.data["id"];
  if (typeof id !== "string" || id.length === 0) {
    return {
      ok: false,
      refusal: refuse(
        "envelope-invalid",
        `${path}: frontmatter has no usable \`id\`; the task id is a Backlog.md board key and the gate needs it to key the registration`,
      ),
    };
  }
  const envelope = read.data["approval"];
  if (envelope === undefined) {
    return {
      ok: false,
      refusal: refuse(
        "envelope-invalid",
        `${path}: frontmatter has no \`approval:\` key. SPEC.md §6 tolerates a task with no envelope — it simply cannot request side-effecting execution — so there is nothing to register.`,
      ),
      missing: { task: id, kind: "no-approval-key", loose: false },
    };
  }
  return { ok: true, task: id, envelope };
}

/**
 * Was this envelope-less file's task registered? Then the envelope was lost
 * (APRV-63), and saying so is the whole job.
 *
 * Log-derived on both sides: the question is asked of the verified records, the
 * task id in the answer is the log's, and the file's own (absent) claim is
 * trusted for nothing. Returns `null` when the log has never heard of the task,
 * which is the ordinary "a task with no envelope" case SPEC.md §6 tolerates and
 * this function must leave exactly as it found it.
 */
function envelopeLost(
  logPath: string,
  path: string,
  missing: NoEnvelope,
  options: GateOptions,
): GateRefusal | null {
  const read = readGateRecords(logPath, options.schemaDir);
  // The log could not be read or does not verify. That refusal outranks any
  // reading of the file: nothing is concluded from a log nobody can trust.
  if (!read.ok) return read;

  const wanted = missing.loose ? missing.task.toLowerCase() : missing.task;
  let registration: EventRecord | null = null;
  for (const record of read.records) {
    if (record.event !== "task.registered") continue;
    const id = record.task;
    if (typeof id !== "string") continue;
    if ((missing.loose ? id.toLowerCase() : id) !== wanted) continue;
    registration = record;
  }
  if (registration === null) return null;

  const declared = payloadOf(registration)["actions"];
  const count = Array.isArray(declared) ? declared.length : 0;
  const shape =
    missing.kind === "no-frontmatter"
      ? "has no frontmatter at all"
      : "has frontmatter but no `approval:` key";
  return refuse(
    "envelope-missing",
    `${path} ${shape}, yet task ${String(registration.task)} was registered at seq ${String(
      registration.seq,
    )} with ${String(count)} declared action(s). The envelope was removed after registration — an external rewrite is the observed cause (APRV-60) — and re-registering a stripped file would silently narrow the record to what survives in the file. Nothing was appended: restore the \`approval:\` block by hand from the log (\`approval log tail\`), then re-run. The runtime never rewrites a task file to repair this.`,
  );
}

/**
 * Validate an envelope and append `task.registered`.
 *
 * Fail closed: the envelope is validated against `envelope.schema.json` **before
 * anything is read from it and before any byte is written**. A schema-invalid
 * envelope leaves the log untouched.
 *
 * Double registration is refused. Re-registering a task id would give the same
 * id two different declared action sets in one log, and every later lookup
 * ("what class is this key?") would have to pick one — silently. Envelope
 * *changes* are `envelope.drift` (SPEC.md §6.3, M5), not a second registration.
 *
 * `actor` is a `human:` or `agent:` identity; registration is an ordinary
 * proposal, not a privileged act, so an agent may perform it. `system:` is
 * refused: the runtime does not author tasks.
 *
 * The registration payload carries the envelope's `actions` and — since S2 —
 * its `budget` block, so the task's own `max_cost_usd` cap is enforced from the
 * log rather than from a task file that may be edited afterwards.
 */
export function register(
  logPath: string,
  source: RegisterSource,
  actor: string,
  options: GateOptions = {},
): RegisterResult {
  if (!PRINCIPAL_ACTOR.test(actor)) {
    return refuse(
      "actor-invalid",
      `register requires a human: or agent: actor, got ${JSON.stringify(actor)}`,
    );
  }

  const resolved = resolveSource(source);
  if (!resolved.ok) {
    // A file with no envelope is ordinary (SPEC.md §6) unless the log says this
    // task once had one. That question is asked here, of the log, and only when
    // the file gave the gate nothing to register (APRV-63).
    if (resolved.missing !== undefined && "file" in source) {
      const lost = envelopeLost(logPath, source.file, resolved.missing, options);
      if (lost !== null) return lost;
    }
    return resolved.refusal;
  }

  const validation = validate(
    "envelope",
    resolved.envelope,
    options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir },
  );
  if (!validation.ok) {
    return refuse(
      "envelope-invalid",
      `the envelope failed schema validation; nothing was appended`,
      { errors: validation.errors },
    );
  }

  const read = readGateRecords(logPath);
  if (!read.ok) return read;

  const envelope = resolved.envelope as { state?: unknown };
  const actions = actionsOf(resolved.envelope);
  const incomingKeys = new Set(actions.map((action) => action.idempotency_key));

  for (const record of read.records) {
    if (record.event !== "task.registered") continue;
    if (record.task === resolved.task) {
      return refuse(
        "task-already-registered",
        `task ${resolved.task} was already registered at seq ${record.seq}; an envelope change is envelope.drift, not a second registration`,
      );
    }
    // Cross-task idempotency_key collision (APRV-138). An idempotency_key is the
    // global identity of one side effect (SPEC.md §7); it is owned by exactly one
    // task. A second declaration under a different task would let a later, weaker
    // registration shadow the first at execute time — `findDeclaration` resolves
    // by key alone — disabling the irreversibility floor. Refuse at the write
    // boundary before anything is appended.
    const declaredActions = payloadOf(record)["actions"];
    if (!Array.isArray(declaredActions)) continue;
    for (const entry of declaredActions) {
      if (typeof entry !== "object" || entry === null) continue;
      const key = (entry as Record<string, unknown>)["idempotency_key"];
      if (typeof key === "string" && incomingKeys.has(key)) {
        return refuse(
          "task-already-registered",
          `action key ${JSON.stringify(key)} was already registered under task ${record.task} at seq ${record.seq}; an idempotency key is the global identity of one side effect and cannot be re-declared under a second task`,
        );
      }
    }
  }

  const payload: Record<string, unknown> = { actions };
  if (typeof envelope.state === "string") payload["state"] = envelope.state;
  const budget = budgetOf(resolved.envelope);
  if (budget !== null) payload["budget"] = budget;

  const appended = append(
    logPath,
    { ts: tick(options), event: "task.registered", actor, task: resolved.task, payload },
    options,
    // The head read above, when the double-registration check was made.
    read.head,
  );
  if (!appended.ok) return appended;

  return { ok: true, record: appended.record, task: resolved.task, actions };
}

/**
 * The declared action for `(task, actionKey)`, as registered in the log.
 *
 * SPEC.md §7: "an action's class MUST be declared before an execution token can
 * be requested for it". The declaration lives in `task.registered`, so the log —
 * not the file, which may have been edited since — is what the gate reads back.
 */
export function registeredAction(
  records: EventRecord[],
  task: string,
  actionKey: string,
): { ok: true; action: RegisteredAction } | GateRefusal {
  let registration: EventRecord | null = null;
  for (const record of records) {
    if (record.event === "task.registered" && record.task === task) registration = record;
  }
  if (registration === null) {
    return refuse(
      "not-registered",
      `task ${task} has no task.registered record; run \`approval register <task-file>\` first`,
    );
  }
  const declared = payloadOf(registration)["actions"];
  const actions = Array.isArray(declared) ? declared : [];
  for (const entry of actions) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    if (item["idempotency_key"] !== actionKey) continue;
    const cls = item["class"];
    if (typeof cls !== "string") break;
    const action: RegisteredAction = { class: cls, idempotency_key: actionKey };
    if (typeof item["summary"] === "string") action.summary = item["summary"];
    if (typeof item["reversible"] === "boolean") action.reversible = item["reversible"];
    if (typeof item["est_cost_usd"] === "number") action.est_cost_usd = item["est_cost_usd"];
    if (isPayloadHash(item["payload_hash"])) action.payload_hash = item["payload_hash"];
    return { ok: true, action };
  }
  return refuse(
    "action-not-registered",
    `task ${task} declares no action with idempotency_key ${JSON.stringify(actionKey)}; SPEC.md §7 requires a class to be declared before it can be requested`,
  );
}

// ---------------------------------------------------------------------------
// request
// ---------------------------------------------------------------------------

/** The action being submitted to the gate. */
export interface RequestInput {
  task: string;
  actionKey: string;
  /** The dotted side-effect class (SPEC.md §7). */
  cls: string;
  est_cost_usd?: number;
  reversible?: boolean;
  summary?: string;
  /**
   * The content binding (amended SPEC.md §6.2). A fallback only: {@link request}
   * prefers the value on the `task.registered` record, because the log is what
   * the human's policy was attested against and a caller-supplied hash could
   * name bytes the registration never declared.
   */
  payload_hash?: string;
  /**
   * The concrete payload material, to be filed in the payload store (APRV-28).
   *
   * Wrapped in an object so that "supplied, and the material happens to be
   * `undefined`" is distinguishable from "not supplied at all" — the first is a
   * payload that cannot be bound to and is refused, the second is the ordinary
   * case of a caller that stored the bytes some other way (or holds none).
   *
   * Its hash MUST equal the declared `payload_hash`; a difference refuses
   * `payload-mismatch` and stores nothing. Material supplied for an action that
   * resolves to `supervised` or `autonomous` is ignored: that path records no
   * request, so there is no binding a stored payload could belong to.
   */
  payload?: { value: unknown };
  /**
   * `"harness"` when this request will never be executed through
   * `approval run` (APRV-106).
   *
   * The Claude Code hook is the case it exists for: the hook asks the gate a
   * permission question and the *harness* runs the command, so a grant here has
   * nothing to hand a token to. Recorded on `approval.requested` and copied by
   * {@link decide} onto the grant, where it suppresses the mint. See
   * `DeclaredAction.execution` in `core/state.ts` for why a false claim can
   * only remove the claimant's own capability.
   */
  execution?: "harness";
  /**
   * ISO-8601 instant after which the requester stops waiting (APRV-106).
   *
   * Recorded for CHANNELS TO DISPLAY and for nothing else: an approver seeing
   * "requester waits until 09:23 UTC" knows that an answer at 09:40 reaches
   * nobody. It bounds no TTL, charges no budget, and gates nothing — the
   * policy's `defaults.approval_ttl` remains the only deadline with authority.
   */
  wait_until?: string;
}

/**
 * The `payload_hash` the log says was declared for `(task, actionKey)`, or
 * `null`.
 *
 * Deliberately narrower than {@link registeredAction}: this answers one
 * question and refuses nothing, so {@link request} can distinguish "declared no
 * hash" from "declared no action" and report each in its own words. The last
 * registration wins, matching every other declaration read in this codebase.
 */
function declaredPayloadHash(
  records: EventRecord[],
  task: string,
  actionKey: string,
): string | null {
  let found: string | null = null;
  for (const record of records) {
    if (record.event !== "task.registered" || record.task !== task) continue;
    const declared = payloadOf(record)["actions"];
    if (!Array.isArray(declared)) continue;
    for (const entry of declared) {
      if (typeof entry !== "object" || entry === null) continue;
      const item = entry as Record<string, unknown>;
      if (item["idempotency_key"] !== actionKey) continue;
      found = isPayloadHash(item["payload_hash"]) ? item["payload_hash"] : null;
    }
  }
  return found;
}

export type RequestResult =
  | {
      ok: true;
      autonomy: Autonomy;
      /** True when execution may start now: the supervised/autonomous path. */
      proceed: boolean;
      resolution: Resolution;
      /** The `approval.requested` record, or `null` off the manual path. */
      record: EventRecord | null;
    }
  | GateRefusal;

/** `est_cost_usd` as the budgets contract wants it recorded: always a number. */
function costOf(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Gate intake.
 *
 * Check order, and why it is this order:
 *
 * 1. **Actor.** A malformed identity is a bad call, not a policy question.
 * 2. **Attestation.** An unverified policy cannot answer anything, so it is
 *    checked before the policy is consulted rather than after.
 * 3. **Policy resolution** (`loadPolicy` + `resolve`, including the §7
 *    irreversibility floor). A failed load resolves everything to `manual` —
 *    that is `policy-match.ts`'s contract, and this module does not soften it.
 * 4. **Off the manual path, stop.** `supervised`/`autonomous` append **no
 *    event** (amended SPEC.md §6.3) and return `proceed: true`. Their budget is
 *    charged at `execution.started`, which APRV-18 appends — checking budgets
 *    here as well would charge them twice or, worse, pass here and fail there.
 * 5. **Content binding** (amended SPEC.md §6.2, A1). A manual action whose
 *    registered declaration carries no `payload_hash` is refused
 *    `payload-hash-required` and nothing is appended. This is the first check
 *    after the manual path is known, because a request with nothing to bind to
 *    should never reach a human's queue at all.
 * 5b. **Payload material**, when the caller supplied any (APRV-28). Its hash is
 *    checked against the declaration here — before legality, before budgets,
 *    before any file — and the bytes are written to the payload store in the
 *    step immediately before the append, so a refused request stores nothing.
 *    See the two comments in the body for the ordering and the one orphan it
 *    permits.
 * 6. **Request legality**, then **budgets**, then the append. Legality first
 *    because a duplicate request is a caller bug that no budget outcome should
 *    obscure, and because refusing it must leave the log untouched.
 *
 * The `approval.requested` payload carries `class`, `est_cost_usd`, and (on the
 * manual path, always) `payload_hash` — the budgets contract requires the first
 * two on the grant and the token binding requires the third, and the grant
 * copies all of them from here rather than re-deriving them from a file that
 * may have changed.
 */
export function request(
  logPath: string,
  input: RequestInput,
  actor: string,
  options: GateOptions = {},
): RequestResult {
  const ts = tick(options);
  if (!PRINCIPAL_ACTOR.test(actor)) {
    return refuse(
      "actor-invalid",
      `request requires a human: or agent: actor, got ${JSON.stringify(actor)}`,
    );
  }

  const read = readGateRecords(logPath);
  if (!read.ok) return read;

  const attested = requireAttestation(read.records, options);
  if (!attested.ok) return attested;

  const load = loadPolicy(loadOptionsOf(options));
  const resolution = resolve(
    load,
    input.cls,
    input.reversible === undefined ? {} : { reversible: input.reversible },
  );

  if (resolution.autonomy !== "manual") {
    // SPEC.md §10.2 loop safety, the gate's half (APRV-18). Three consecutive
    // execution.failed events for a task escalate it to manual "regardless of
    // policy", so an escalated task may not be told to proceed unsupervised.
    // The refusal is deliberately narrow: it fires only where the answer would
    // otherwise have been `proceed: true`. A class that resolves manual anyway
    // is unaffected, because escalation escalates TO manual — putting a human in
    // the loop is the remedy, and refusing the manual request too would leave an
    // escalated task with no way back. `core/execute.ts` enforces the matching
    // half at start time, for an executor that never asks the gate first.
    if (isLoopEscalated(read.records, input.task)) {
      return refuse(
        "loop-escalated",
        `task ${input.task} has three consecutive execution.failed events and is escalated to manual (SPEC.md §10.2); its ${resolution.autonomy} action ${input.actionKey} may not proceed unsupervised. The task's manual actions are unaffected — escalation puts a human in the loop, it does not close the task — and the streak clears when an execution.completed for the task lands.`,
      );
    }
    // Amended SPEC.md §6.3: no approval.* event exists off the manual path.
    return { ok: true, autonomy: resolution.autonomy, proceed: true, resolution, record: null };
  }

  // Amended SPEC.md §6.2/§10 (A1): a manual grant binds to bytes. The log's
  // declaration wins over anything the caller passed — `register` wrote it from
  // the envelope, and a request that could name its own hash could approve one
  // payload and execute another, which is the property this exists to remove.
  const payloadHash =
    declaredPayloadHash(read.records, input.task, input.actionKey) ??
    (isPayloadHash(input.payload_hash) ? input.payload_hash : null);
  if (payloadHash === null) {
    return refuse(
      "payload-hash-required",
      `action ${input.actionKey} resolves to manual and its registered declaration carries no payload_hash. Amended SPEC.md §6.2 makes the hash MUST for manual actions: an approval binds to the exact bytes it approves, so a request with nothing to bind to would ask a human to authorize a payload that could still change afterwards. Declare payload_hash (SHA-256 over the RFC 8785 canonical serialization of the concrete payload) on the action and register the task again.`,
    );
  }

  // APRV-28, phase one of two: the material is *checked* here, cheaply and
  // purely, and written later. Checking early means a request whose bytes do
  // not match its declaration is refused before a duplicate-request or budget
  // outcome can obscure why, and before any file exists.
  if (input.payload !== undefined) {
    let materialHash: string;
    try {
      materialHash = hashOfPayload(input.payload.value);
    } catch (cause) {
      return refuse(
        "payload-store-failed",
        `the payload material for ${input.actionKey} could not be canonicalized: ${
          cause instanceof Error ? cause.message : String(cause)
        }. A payload that cannot be serialized cannot be bound to, so nothing was stored and nothing was appended.`,
      );
    }
    if (materialHash !== payloadHash) {
      return refuse(
        "payload-mismatch",
        `the payload material supplied for ${input.actionKey} hashes to ${materialHash} but the action declares ${payloadHash} (amended SPEC.md §6.2/§10). A grant approves specific bytes, so material that hashes to something else is not this request's payload: nothing was stored and nothing was appended.`,
      );
    }
  }

  const derivation = requestState(read.records, input.actionKey, ts, ttlOf(load));
  if (derivation.state === "requested") {
    return refuse(
      "duplicate-request",
      `action ${input.actionKey} already has a live request at seq ${String(derivation.requestSeq)} awaiting a decision`,
      { state: derivation.state },
    );
  }
  if (derivation.execution.started !== null) {
    return refuse(
      "already-executed",
      `action ${input.actionKey} already executed (execution.started at seq ${String(derivation.execution.started)}); an idempotency key is single-use`,
      { state: derivation.state },
    );
  }

  const budget = evaluateBudgetsWithTask(
    read.records,
    budgetScopeOf(load, resolution),
    { class: input.cls, est_cost_usd: costOf(input.est_cost_usd) },
    ts,
    // S2: the registered envelope's own `budget.max_cost_usd`, conjunctive with
    // policy budgets and enforced at all three of intake, grant, and start.
    input.task,
  );
  if (!budget.pass) {
    const failed = budget.verdicts.filter((verdict) => !verdict.pass);
    const logged = append(
      logPath,
      {
        ts,
        event: "budget.exceeded",
        actor,
        task: input.task,
        action_key: input.actionKey,
        payload: {
          class: input.cls,
          est_cost_usd: costOf(input.est_cost_usd),
          stage: "request",
          verdicts: budget.verdicts,
        },
      },
      options,
      read.head,
    );
    const message = `budget refused the request: ${failed
      .map((verdict) => `${verdict.limit} (${verdict.scope})`)
      .join(", ")}`;
    return logged.ok
      ? refuse("budget-exceeded", message, { verdicts: failed, record: logged.record })
      : refuse("budget-exceeded", `${message}; the budget.exceeded event could not be appended: ${logged.message}`, {
          verdicts: failed,
        });
  }

  // APRV-28, phase two: the write, after every check has passed and immediately
  // before the append. A refused request therefore stores nothing. The one
  // residue this ordering permits is an orphan: if the append then fails
  // `head-moved`, a `<hash>.json` file remains for a request that was never
  // recorded. That is accepted deliberately — the file is content-addressed, so
  // it is either exactly the bytes some later request will bind to or bytes
  // nothing will ever ask for, and in neither case can it authorize, alter or
  // be mistaken for anything. The reverse ordering (append, then store) trades
  // this harmless file for a recorded manual request whose bytes no channel can
  // display, which is a request no human can answer.
  if (input.payload !== undefined) {
    const stored = storePayload(
      options.payloadStoreDir ?? payloadStoreDirFor(logPath),
      input.payload.value,
    );
    if (!stored.ok) {
      return refuse(
        "payload-store-failed",
        `${stored.message} Nothing was appended: a manual request whose payload no channel can display is a request no human can answer (SPEC.md §10.4).`,
      );
    }
  }

  const payload: Record<string, unknown> = {
    class: input.cls,
    est_cost_usd: costOf(input.est_cost_usd),
    payload_hash: payloadHash,
    // APRV-118. The attested policy this request was routed by, assigned here
    // at the write boundary from the runtime's own attestation check — the same
    // read that authorized the request, one line of code from the append.
    // {@link RequestInput} carries no field for it, exactly as it carries no
    // `ts`: the refusal of a caller-supplied value is structural, so a requester
    // cannot name the rules it claims to have been routed by.
    [POLICY_HASH_FIELD]: attested.sha256,
  };
  if (input.summary !== undefined) payload["summary"] = input.summary;
  if (input.reversible !== undefined) payload["reversible"] = input.reversible;
  // APRV-106. Both are recorded here rather than derived later because the log
  // is the only place a channel or a grant can read them from, and neither
  // reduces scrutiny: `execution: "harness"` removes the requester's own
  // ability to spend a token, and `wait_until` is display text.
  if (input.execution !== undefined) payload["execution"] = input.execution;
  if (input.wait_until !== undefined) payload["wait_until"] = input.wait_until;

  const appended = append(
    logPath,
    {
      ts,
      event: "approval.requested",
      actor,
      task: input.task,
      action_key: input.actionKey,
      payload,
    },
    options,
    // The head read at the top of `request`: the duplicate-request, execution
    // and budget checks were all made against exactly that log.
    read.head,
  );
  if (!appended.ok) return appended;

  return {
    ok: true,
    autonomy: "manual",
    proceed: false,
    resolution,
    record: appended.record,
  };
}

// ---------------------------------------------------------------------------
// decide
// ---------------------------------------------------------------------------

export interface DecideOptions extends GateOptions {
  /** Free-text note recorded in the event payload (SPEC.md §8's example). */
  note?: string;
  /**
   * The channel delivery id of the batch this decision answered (amended
   * SPEC.md §10.3, APRV-38), recorded as `payload.batch_delivery_id` on
   * `approval.granted` / `approval.rejected`.
   *
   * The log never batches: one gesture over five requests is five events, and
   * this is the only thing tying them back together for audit. It is recorded
   * on grant and reject alone, the two decisions a channel can collect;
   * `revoke` is a considered act performed against the log through the CLI and
   * never arrives as part of a batch gesture, so a value supplied with it is
   * ignored rather than written.
   *
   * Empty strings are ignored for the same reason the schema requires
   * `minLength: 1`: a batch id that identifies no batch is worse than none,
   * since audit would read it as a grouping that never existed.
   */
  batchDeliveryId?: string;
}

export type DecideResult =
  | {
      ok: true;
      decision: Decision;
      state: RequestState;
      record: EventRecord;
      /**
       * The raw single-use execution token, on `grant` only (APRV-17). Returned
       * here and nowhere else: the log carries only its SHA-256, so this value
       * is unrecoverable once the caller drops it.
       */
      token?: string;
    }
  | GateRefusal;

const DECISION_EVENT: Readonly<Record<Decision, "approval.granted" | "approval.rejected" | "approval.revoked">> = {
  grant: "approval.granted",
  reject: "approval.rejected",
  revoke: "approval.revoked",
};

const DECISION_STATE: Readonly<Record<Decision, RequestState>> = {
  grant: "granted",
  reject: "rejected",
  revoke: "revoked",
};

/**
 * Record a human decision on a request.
 *
 * **Human-only**, enforced here in code and again by the event schema for
 * grant/reject. `revoke` is human-only too: withdrawing an authorization is a
 * decision about an authorization, and an agent that could revoke could also
 * churn the queue.
 *
 * Attestation is required **for `grant` only**. Grant is the authorizing
 * decision, so an unverified policy must not be able to produce one. Reject and
 * revoke *withdraw* authority, and refusing them on an unattested policy would
 * leave a live grant standing because a file changed — the strict direction and
 * the safe direction point the same way, and it is not "refuse everything".
 *
 * Attestation also answers a question it could not answer before APRV-118:
 * *which* policy. The hash the live file matched is compared against the hash
 * `approval.requested` pinned, and a difference refuses `policy-drift` with
 * nothing appended. Attestation alone catches an unattested edit; this catches
 * an attested one, which is the case where every check still passes and the
 * rules have nonetheless changed underneath a pending question. The hash in
 * force is then recorded on the grant, so the log states the rules the approver
 * decided under rather than leaving a reader to assume they were the
 * requester's.
 *
 * Budgets are re-evaluated at grant time. A request may have sat in the queue
 * while other actions consumed the window, and the moment that matters for a
 * commitment is the moment the human commits.
 *
 * On `grant` a single-use execution token is minted (`core/token.ts`) and its
 * SHA-256 recorded in the payload as `token_sha256`, **alongside the request's
 * `payload_hash`** (amended SPEC.md §10, A1). The token is therefore bound to
 * three things — the request, its `idempotency_key`, and the bytes — and
 * `core/token.ts` refuses `payload-mismatch` for anything else. The raw token
 * is returned in `token` and is written nowhere: whoever calls this is the only
 * party that will ever hold it, and a lost token is unrecoverable by design —
 * revoke and request again.
 */
export function decide(
  logPath: string,
  actionKey: string,
  decision: Decision,
  actor: string,
  options: DecideOptions = {},
): DecideResult {
  const ts = tick(options);
  if (!HUMAN_ACTOR.test(actor)) {
    return refuse(
      "actor-not-human",
      `${decision} is a human-only verb; the actor must match human:<id>, got ${JSON.stringify(actor)}`,
    );
  }

  const read = readGateRecords(logPath);
  if (!read.ok) return read;

  let attestedSha256: string | null = null;
  if (decision === "grant") {
    const attested = requireAttestation(read.records, options);
    if (!attested.ok) return attested;
    attestedSha256 = attested.sha256;
  }

  const load = loadPolicy(loadOptionsOf(options));
  const ttlMs = ttlOf(load);
  const derivation = requestState(read.records, actionKey, ts, ttlMs);

  if (derivation.state === "none") {
    return refuse(
      "not-requested",
      `action ${actionKey} has no approval.requested record to decide`,
      { state: derivation.state },
    );
  }

  if (derivation.state === "expired") {
    // Lazy expiry: materialise the event we just derived, then refuse. See the
    // module header for why the log must carry the state a reader can derive.
    let materialised: EventRecord | undefined;
    if (derivation.expiredLazily) {
      const logged = appendExpiry(logPath, derivation, load, ts, options, read.head);
      if (logged.ok) materialised = logged.record;
    }
    const message = derivation.expiredLazily
      ? `action ${actionKey} expired: the request at ${String(derivation.requestTs)} lapsed its ${String(ttlMs)}ms TTL before ${ts}. The lapse is judged from the request's own timestamp, so a decision is refused whether or not an approval.expired event had been observed.`
      : `action ${actionKey} expired at ${String(derivation.decisionTs)} (approval.expired, seq ${String(derivation.decisionSeq)}); an expired request is terminal`;
    return refuse(
      "expired",
      message,
      materialised === undefined
        ? { state: derivation.state }
        : { state: derivation.state, record: materialised },
    );
  }

  if (derivation.state === "withdrawn") {
    // APRV-106. Its own code, not `already-decided`: nobody decided. The
    // requester stopped waiting, so a grant recorded here would be an
    // authorization with no process left to consume it — which is precisely the
    // decision SPEC.md §11 says must not be solicited, arriving too late.
    return refuse(
      "request-withdrawn",
      `action ${actionKey} was withdrawn by its requester at seq ${String(derivation.decisionSeq)}; a withdrawn request is terminal and nothing can be decided about it. If the action is still wanted, request it again — that is a new request, and it gets its own decision.`,
      { state: derivation.state },
    );
  }

  if (derivation.state === "rejected" || derivation.state === "revoked") {
    return refuse(
      "already-decided",
      `action ${actionKey} was already ${derivation.state} at seq ${String(derivation.decisionSeq)}; a decided request is terminal`,
      { state: derivation.state },
    );
  }

  if (derivation.state === "granted") {
    if (decision !== "revoke") {
      return refuse(
        "already-decided",
        `action ${actionKey} was already granted at seq ${String(derivation.decisionSeq)}; a second decision would rewrite a human's answer`,
        { state: derivation.state },
      );
    }
    if (derivation.execution.started !== null) {
      return refuse(
        "already-executed",
        `action ${actionKey} already executed (execution.started at seq ${String(derivation.execution.started)}); revocation is only meaningful before execution`,
        { state: derivation.state },
      );
    }
  } else if (decision === "revoke") {
    // state === "requested"
    return refuse(
      "not-granted",
      `action ${actionKey} is awaiting a decision, not granted; reject it rather than revoking it`,
      { state: derivation.state },
    );
  }

  const payload: Record<string, unknown> = {};
  if (decision === "grant") {
    // APRV-118, and first among the grant's checks because it decides whether
    // the request in front of this approver is still a request at all. A pinned
    // hash that differs from the hash in force now means a human re-attested a
    // policy between the routing and the decision, so the autonomy, limits and
    // TTL that produced this question are gone. The request is void; nothing is
    // appended, and the action is requested again under the policy that now
    // governs it. A request written before the field existed carries `null` and
    // is decided as it always was — the field is additive, and reading its
    // absence as drift would void every pending request in an older log.
    if (
      derivation.declared.policy_sha256 !== null &&
      attestedSha256 !== null &&
      derivation.declared.policy_sha256 !== attestedSha256
    ) {
      return refuse(
        "policy-drift",
        `action ${actionKey} was requested under policy ${derivation.declared.policy_sha256} and the attested policy is now ${attestedSha256}; the rules that routed this request to a human are no longer the rules in force, so a grant recorded here would claim a decision under a policy the approver was never shown. Nothing was appended: the pending request is void and the action must be requested again, which re-resolves its autonomy, limits and TTL under the current policy.`,
        { state: derivation.state },
      );
    }
    // A grant with no class is refused rather than recorded with an empty one.
    // The empty-string substitution this replaces produced an authorization
    // that no class rule could match and no class-scoped budget could charge —
    // a hole shaped exactly like a permitted action. Reject and revoke are
    // unaffected: withdrawing authority needs no class.
    if (derivation.declared.class === null || derivation.declared.class.length === 0) {
      return refuse(
        "grant-classless-request",
        `the approval.requested record for ${actionKey} at seq ${String(derivation.requestSeq)} carries no usable payload.class; a grant is scoped by class — policy matching, the irreversibility floor, and every class-scoped budget read it — so an authorization that names none cannot be recorded. Request the action again through \`approval request\`, which copies the class from the task.registered declaration.`,
        { state: derivation.state },
      );
    }
    // The budgets contract: class and est_cost_usd on every approval.granted,
    // copied from the request rather than re-derived from a file. A1 adds the
    // content binding on the same terms: copied, never recomputed.
    payload["class"] = derivation.declared.class;
    payload["est_cost_usd"] = derivation.declared.est_cost_usd ?? 0;
    if (derivation.declared.payload_hash !== null) {
      payload["payload_hash"] = derivation.declared.payload_hash;
    }
    // APRV-118. The one field on this payload that is NOT copied from the
    // request: it is the hash the runtime just checked the live policy against,
    // assigned here at the write boundary like `ts`. Copying the request's value
    // would record what the requester was routed by rather than what the
    // approver decided under, and the two agreeing is the check above, not an
    // assumption this line may make. `DecideOptions` carries no field for it, so
    // a caller-supplied value is refused structurally.
    if (attestedSha256 !== null) payload[POLICY_HASH_FIELD] = attestedSha256;
  }
  if (options.note !== undefined) payload["note"] = options.note;
  if (
    decision !== "revoke" &&
    options.batchDeliveryId !== undefined &&
    options.batchDeliveryId.length > 0
  ) {
    payload["batch_delivery_id"] = options.batchDeliveryId;
  }

  if (decision === "grant") {
    const cls = derivation.declared.class ?? "";
    const resolution = resolve(
      load,
      cls,
      derivation.declared.reversible === null ? {} : { reversible: derivation.declared.reversible },
    );
    const budget = evaluateBudgetsWithTask(
      read.records,
      budgetScopeOf(load, resolution),
      { class: cls, est_cost_usd: derivation.declared.est_cost_usd ?? 0 },
      ts,
      // S2: the envelope's own cap, re-checked at the moment of commitment for
      // the same reason the policy budgets are — the queue may have moved.
      derivation.task,
    );
    if (!budget.pass) {
      const failed = budget.verdicts.filter((verdict) => !verdict.pass);
      const logged = append(
        logPath,
        {
          ts,
          event: "budget.exceeded",
          actor,
          ...(derivation.task === null ? {} : { task: derivation.task }),
          action_key: actionKey,
          payload: {
            class: cls,
            est_cost_usd: derivation.declared.est_cost_usd ?? 0,
            stage: "grant",
            verdicts: budget.verdicts,
          },
        },
        options,
        read.head,
      );
      const message = `budget refused the grant: ${failed
        .map((verdict) => `${verdict.limit} (${verdict.scope})`)
        .join(", ")}`;
      return logged.ok
        ? refuse("budget-exceeded", message, {
            verdicts: failed,
            record: logged.record,
            state: derivation.state,
          })
        : refuse("budget-exceeded", `${message}; the budget.exceeded event could not be appended: ${logged.message}`, {
            verdicts: failed,
            state: derivation.state,
          });
    }
  }

  // APRV-17, the token seam. Minted here — after every check has passed and
  // immediately before the append — so a refused grant mints nothing. Only the
  // digest enters the payload; the raw token is returned to this caller alone.
  //
  // APRV-106 adds the one grant that mints nothing: a request the requester
  // declared `execution: "harness"`. Such a request is a permission question
  // asked by a process that will run the command itself, so there is no
  // `approval run` to hold a key and a minted token would be a live credential
  // with no owner and no spender. The grant is still a complete grant — class,
  // cost and payload binding are all recorded — and the marker is copied onto
  // it so a reader of the grant alone can see why there is no digest, rather
  // than reading the absence as a grant minted by something that predates
  // tokens. `core/token.ts` refuses the key as `harness-executed`.
  let token: string | undefined;
  if (decision === "grant") {
    if (derivation.declared.execution === "harness") {
      payload["execution"] = "harness";
    } else {
      token = mintToken();
      payload[TOKEN_HASH_FIELD] = tokenHash(token);
    }
  }

  const appended = append(
    logPath,
    {
      ts,
      event: DECISION_EVENT[decision],
      actor,
      ...(derivation.task === null ? {} : { task: derivation.task }),
      action_key: actionKey,
      payload,
    },
    options,
    // The head read at the top of `decide`: transition legality and the budget
    // re-check were both judged against exactly that log.
    read.head,
  );
  if (!appended.ok) return appended;

  return {
    ok: true,
    decision,
    state: DECISION_STATE[decision],
    record: appended.record,
    ...(token === undefined ? {} : { token }),
  };
}

// ---------------------------------------------------------------------------
// withdraw
// ---------------------------------------------------------------------------

export interface WithdrawOptions extends GateOptions {
  /** Why the requester is retracting. Defaults to `cancelled`. */
  reason?: WithdrawReason;
  /** The requester's free-text elaboration, recorded in the payload. */
  note?: string;
}

export type WithdrawResult =
  | { ok: true; state: RequestState; record: EventRecord }
  | GateRefusal;

/**
 * Retract a pending request, as the party that opened it (amended SPEC.md §6.3,
 * APRV-106).
 *
 * ## Why the verb exists
 *
 * Observed live on 2026-08-19. A builder's `git commit --amend` went through the
 * Claude Code hook, which classified it manual and appended
 * `approval.requested`. The hook waited nine minutes, got nothing, denied the
 * tool call and moved on — but the request stayed pending for the policy's 24h
 * TTL. Half an hour later the human was pinged on their phone and approved it,
 * and the grant authorized nothing at all: the hook had long since answered,
 * and a retried tool call is a new request with a new key. A person spent
 * attention on a question whose asker had left. SPEC.md §11 makes human
 * attention the audit budget, and a decision nobody can consume must not be
 * solicited; so the asker takes the question back.
 *
 * ## The four rules
 *
 * 1. **Requester-only.** The actor MUST equal the actor of the
 *    `approval.requested` that opened the current cycle, else `not-requester`.
 *    Anything looser would make the approver's queue clearable by whoever
 *    reached the log first. A human who wants a pending request gone rejects
 *    it, on the record, as themselves.
 * 2. **Pending-only.** `not-requested` when there is nothing to withdraw,
 *    `already-decided` when a human has answered, `request-withdrawn` for a
 *    second withdrawal, `expired` when the TTL has lapsed — and expiry is
 *    judged here exactly as {@link decide} judges it, from the request's own
 *    timestamp, with the same lazy materialisation of the `approval.expired`
 *    record. A lapse is a lapse whether or not an event says so, and a
 *    withdrawal that pretended otherwise would rewrite the reason a request
 *    ended.
 * 3. **No attestation, no budget.** Withdrawal removes a question; it authorizes
 *    nothing and commits nothing. Refusing it on an unattested policy would
 *    leave requests standing in a human's queue because a file changed, which
 *    is the strict direction pointing the wrong way.
 * 4. **Compare-and-append, like everything else here.** The legality check and
 *    the write are made against the same head (SPEC.md §11.1(5)), so a grant
 *    that lands in between wins and this withdrawal is refused `head-moved`
 *    rather than overwriting it. `tests/concurrency.test.ts` races the two.
 *
 * `ts` is assigned at the write boundary from the injected clock, like every
 * other gate-typed event (SPEC.md §8, A2): there is no parameter to pass one.
 */
export function withdraw(
  logPath: string,
  actionKey: string,
  actor: string,
  options: WithdrawOptions = {},
): WithdrawResult {
  const ts = tick(options);
  if (!PRINCIPAL_ACTOR.test(actor)) {
    return refuse(
      "actor-invalid",
      `withdraw requires a human: or agent: actor, got ${JSON.stringify(actor)}; system: is refused because the runtime's way of ending a request it was not asked to end is the TTL, not a withdrawal`,
    );
  }

  const read = readGateRecords(logPath);
  if (!read.ok) return read;

  const load = loadPolicy(loadOptionsOf(options));
  const ttlMs = ttlOf(load);
  const derivation = requestState(read.records, actionKey, ts, ttlMs);

  if (derivation.state === "none") {
    return refuse(
      "not-requested",
      `action ${actionKey} has no approval.requested record to withdraw`,
      { state: derivation.state },
    );
  }

  if (derivation.state === "withdrawn") {
    return refuse(
      "request-withdrawn",
      `action ${actionKey} was already withdrawn at seq ${String(derivation.decisionSeq)}; a withdrawn request is terminal`,
      { state: derivation.state },
    );
  }

  if (derivation.state === "expired") {
    // The same lazy materialisation `decide` performs, for the same reason: the
    // log must carry the state a reader can already derive from it.
    let materialised: EventRecord | undefined;
    if (derivation.expiredLazily) {
      const logged = appendExpiry(logPath, derivation, load, ts, options, read.head);
      if (logged.ok) materialised = logged.record;
    }
    return refuse(
      "expired",
      `action ${actionKey} expired: the request at ${String(derivation.requestTs)} lapsed its ${String(ttlMs)}ms TTL before ${ts}. A lapsed request has already ended; there is nothing left to withdraw.`,
      materialised === undefined
        ? { state: derivation.state }
        : { state: derivation.state, record: materialised },
    );
  }

  if (derivation.state !== "requested") {
    return refuse(
      "already-decided",
      `action ${actionKey} was already ${derivation.state} at seq ${String(derivation.decisionSeq)}; a human's answer stands, and withdrawing a question that has been answered would erase the answer`,
      { state: derivation.state },
    );
  }

  if (derivation.requestActor !== actor) {
    return refuse(
      "not-requester",
      `action ${actionKey} was requested by ${JSON.stringify(derivation.requestActor)} and cannot be withdrawn by ${JSON.stringify(actor)}; only the party that asked may take the question back. To end a pending request as someone else, reject it — that is a decision, and it is recorded as one.`,
      { state: derivation.state },
    );
  }

  const reason: WithdrawReason = options.reason ?? "cancelled";
  const payload: Record<string, unknown> = { action_key: actionKey, reason };
  if (options.note !== undefined) payload["note"] = options.note;

  const appended = append(
    logPath,
    {
      ts,
      event: "approval.withdrawn",
      actor,
      ...(derivation.task === null ? {} : { task: derivation.task }),
      action_key: actionKey,
      payload,
    },
    options,
    // The head read at the top: requester identity and pending-ness were both
    // judged against exactly that log, so a decision appended since refuses
    // this write rather than being overwritten by it.
    read.head,
  );
  if (!appended.ok) return appended;

  return { ok: true, state: "withdrawn", record: appended.record };
}

// ---------------------------------------------------------------------------
// harness grant carryover (APRV-117)
// ---------------------------------------------------------------------------

/**
 * What a harness invocation may do with a request some earlier invocation
 * opened for the very same bytes.
 *
 * `pending` — the question is still in front of a human. A retry ADOPTS it and
 * waits out the remainder, rather than opening a second one: two prompts for
 * one command spend a human's attention twice on a single question, and
 * attention is the audit budget (SPEC.md §11).
 *
 * `granted` — a human answered, the TTL has not lapsed, and nothing has spent
 * the grant yet. A retry proceeds on it, once, through
 * {@link consumeHarnessGrant}.
 */
export type HarnessCarryKind = "pending" | "granted";

/** A request an identical harness invocation may adopt or spend (APRV-117). */
export interface HarnessCarry {
  actionKey: string;
  task: string | null;
  kind: HarnessCarryKind;
  /** `seq` of the `approval.requested` that opened the current cycle. */
  requestSeq: number | null;
  /** `seq` of the `approval.granted`, on `granted` only. */
  decisionSeq: number | null;
}

/**
 * The request an identical harness command may carry over, or `null`.
 *
 * ## The replay bounds, in one place
 *
 * A harness grant authorizes **the same bytes, in the same cwd, once, within
 * the TTL** — and nothing else. Each clause is a line of this function:
 *
 *  - *the same bytes, in the same cwd*: the candidate's declared
 *    `payload_hash` must equal `payloadHash`, which the caller computes over
 *    the concrete payload (for the Claude Code hook, `{command, cwd}`). A
 *    different command, a different directory, a different byte of either:
 *    different hash, no carry, a new question for a human.
 *  - *harness only*: the candidate must have declared `execution: "harness"`.
 *    A grant that minted an execution token belongs to `approval run`, and a
 *    harness invocation must never spend it by proceeding on it — the token
 *    would still be live, and one authorization would have authorized two
 *    different executions.
 *  - *the same class*: an action key covers one class, and a command that
 *    resolves to three classes asks three questions. Carrying a `deps.add`
 *    grant into a `network.call` check would answer a question nobody asked.
 *  - *once*: a candidate with any `execution.*` record is skipped here and
 *    refused at the append in {@link consumeHarnessGrant}. The single-use rule
 *    is the gate's existing one; this only stops the caller from queueing up a
 *    write that would be refused.
 *  - *within the TTL*: state is derived at `ts` with `ttlMs`, so a lapsed
 *    request reads `expired` and carries nothing, whether or not the daemon has
 *    materialised an `approval.expired` record.
 *
 * PURE, and reads only records the caller verified — the enforcement path never
 * touches an unverified log (SPEC.md §11.1). The latest candidate wins: a key
 * whose earlier cycle was rejected, withdrawn or expired is superseded by the
 * request that came after it, exactly as {@link requestState} treats cycles.
 */
/**
 * Has a GRANTED request outlived `defaults.approval_ttl`?
 *
 * `requestState` reports a decided request by its decision forever: the TTL
 * bounds the window in which a human may answer, not the answer's shelf life.
 * The shelf life is a separate, settled rule and it already exists — `tokenStatus`
 * in `core/token.ts` re-applies `requestTs + approval_ttl` to a granted request
 * and refuses `token-expired` past it, so a token minted yesterday cannot be
 * spent today. This is the same arithmetic for the grant that mints no token: a
 * harness approval must not be the one kind that never goes stale.
 *
 * Unparseable instants read as lapsed, and a policy with no TTL declares no
 * lapse at all — both exactly as `core/token.ts` reads them.
 */
function grantLapsed(derivation: RequestDerivation, ts: string, ttlMs: number | null): boolean {
  if (ttlMs === null) return false;
  const requestedAt = Date.parse(derivation.requestTs ?? "");
  const asked = Date.parse(ts);
  if (Number.isNaN(requestedAt) || Number.isNaN(asked)) return true;
  return asked > requestedAt + ttlMs;
}

export function findHarnessCarry(
  records: EventRecord[],
  payloadHash: string,
  cls: string,
  ts: string,
  ttlMs: number | null,
): HarnessCarry | null {
  if (!isPayloadHash(payloadHash)) return null;

  // Distinct keys, latest request first: a later question about the same bytes
  // is the live one, and an older key that was consumed or lapsed must not
  // shadow it.
  const keys: string[] = [];
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record === undefined) continue;
    if (record.event !== "approval.requested") continue;
    if (record.action_key === undefined) continue;
    if (keys.includes(record.action_key)) continue;
    const payload = payloadOf(record);
    if (payload["execution"] !== "harness") continue;
    if (payload["payload_hash"] !== payloadHash) continue;
    if (payload["class"] !== cls) continue;
    keys.push(record.action_key);
  }

  let pending: HarnessCarry | null = null;
  for (const actionKey of keys) {
    const derivation = requestState(records, actionKey, ts, ttlMs);
    // The declaration is re-read from the derivation rather than from the
    // record matched above: `requestState` resets on every `approval.requested`,
    // so this is the cycle whose state was just derived.
    if (derivation.declared.payload_hash !== payloadHash) continue;
    if (derivation.declared.execution !== "harness") continue;
    if (derivation.execution.started !== null) continue;
    if (derivation.state === "granted") {
      // An answer has a shelf life, and it is its request's TTL.
      if (grantLapsed(derivation, ts, ttlMs)) continue;
      return {
        actionKey,
        task: derivation.task,
        kind: "granted",
        requestSeq: derivation.requestSeq,
        decisionSeq: derivation.decisionSeq,
      };
    }
    if (derivation.state === "requested" && pending === null) {
      pending = {
        actionKey,
        task: derivation.task,
        kind: "pending",
        requestSeq: derivation.requestSeq,
        decisionSeq: null,
      };
    }
  }
  // A grant beats a pending question: proceeding on an answer that already
  // exists asks nobody anything.
  return pending;
}

export type ConsumeHarnessResult = { ok: true; record: EventRecord } | GateRefusal;

/**
 * Spend a harness grant, exactly once (APRV-117).
 *
 * ## Why this is `execution.started`, and why it is alone
 *
 * A harness grant mints no token (APRV-106), so nothing in `core/token.ts`
 * records that it was used, and without such a record a grant could authorize
 * an unbounded number of identical retries for the whole TTL. The consumption
 * marker has to be a real event through compare-and-append (SPEC.md §11.1(5)),
 * and it has to be one the gate already reads as terminal for an idempotency
 * key. `execution.started` is exactly that: {@link request} refuses a key that
 * has one as `already-executed`, and {@link decide} refuses to revoke past it.
 * Reusing it means the single-use rule is the gate's existing rule rather than
 * a second one written next to it.
 *
 * **No `execution.completed` or `execution.failed` follows, ever.** The harness
 * runs the command; this runtime hands over permission and never observes an
 * exit status. Appending a completion would fabricate an outcome, and in this
 * vocabulary it would also assert something with consequences — an
 * `execution.completed` clears a task's loop-escalation streak (SPEC.md §10.2).
 * A harness execution is therefore recorded as begun and never as finished,
 * which is precisely what the runtime knows. The `execution: "harness"` marker
 * on the payload says so on the record itself, so a reader of the start event
 * alone can see why no outcome ever lands.
 *
 * ## What it refuses
 *
 * Attestation is checked here, and not as a formality: this is the one
 * enforcement path that reaches a harness `allow` without passing through
 * {@link request} (that happened in an earlier process, possibly against
 * earlier policy bytes). A policy that changed since the human attested it
 * cannot answer anything, so it answers nothing.
 *
 * Everything else follows the derivation: `not-requested` when the key has no
 * request, `expired` when the TTL lapsed (judged from the request's own `ts`,
 * event or no event, exactly as {@link decide} judges it), `already-executed`
 * when something already spent it, `not-granted` for every other state and for
 * a grant that is not harness-executed. Budgets are not re-evaluated: the
 * authorization was charged at `approval.granted`, and `core/budgets.ts`'s
 * consumption contract already dedupes a start event against a grant carrying
 * the same `action_key`.
 */
export function consumeHarnessGrant(
  logPath: string,
  actionKey: string,
  actor: string,
  options: GateOptions = {},
): ConsumeHarnessResult {
  const ts = tick(options);
  if (!PRINCIPAL_ACTOR.test(actor)) {
    return refuse(
      "actor-invalid",
      `consuming a harness grant requires a human: or agent: actor, got ${JSON.stringify(actor)}`,
    );
  }

  const read = readGateRecords(logPath);
  if (!read.ok) return read;

  const attested = requireAttestation(read.records, options);
  if (!attested.ok) return attested;

  const load = loadPolicy(loadOptionsOf(options));
  const derivation = requestState(read.records, actionKey, ts, ttlOf(load));

  if (derivation.state === "none") {
    return refuse(
      "not-requested",
      `action ${actionKey} has no approval.requested record, so there is no grant to proceed on`,
      { state: derivation.state },
    );
  }
  if (derivation.execution.started !== null) {
    return refuse(
      "already-executed",
      `action ${actionKey} was already spent (execution.started at seq ${String(derivation.execution.started)}); a harness grant authorizes one execution of the bytes it approved, and a further identical command is a new question`,
      { state: derivation.state },
    );
  }
  if (derivation.state === "expired") {
    return refuse(
      "expired",
      `action ${actionKey} expired: the request at ${String(derivation.requestTs)} lapsed its TTL before ${ts}. A grant authorizes only inside the approval window.`,
      { state: derivation.state },
    );
  }
  if (derivation.state !== "granted") {
    return refuse(
      "not-granted",
      `action ${actionKey} is ${derivation.state}, not granted; nothing authorizes proceeding on it`,
      { state: derivation.state },
    );
  }
  if (derivation.declared.execution !== "harness") {
    return refuse(
      "not-granted",
      `action ${actionKey} was granted as an ordinary request and minted an execution token; it is spent by presenting that token to \`approval run\`, not by a harness proceeding on it. Two spenders of one authorization is the property this refuses.`,
      { state: derivation.state },
    );
  }
  if (grantLapsed(derivation, ts, ttlOf(load))) {
    return refuse(
      "expired",
      `action ${actionKey}'s grant expired: the request at ${String(derivation.requestTs)} lapsed its TTL before ${ts}. There is no separate grant TTL — an approval lives exactly as long as its parent request, which is the rule \`core/token.ts\` applies to a token-bearing grant.`,
      { state: derivation.state },
    );
  }
  if (derivation.task === null) {
    return refuse(
      "not-registered",
      `action ${actionKey} has a grant but no task on its request record; an execution event names both (SPEC.md §8) and nothing here invents one`,
      { state: derivation.state },
    );
  }

  const payload: Record<string, unknown> = {
    // The budgets contract: class and est_cost_usd on every start event.
    class: derivation.declared.class ?? "",
    est_cost_usd: derivation.declared.est_cost_usd ?? 0,
    // Why no completion will ever follow (see the doc comment).
    execution: "harness",
  };
  if (derivation.declared.payload_hash !== null) {
    payload["payload_hash"] = derivation.declared.payload_hash;
  }
  if (derivation.decisionSeq !== null) payload["grant_seq"] = derivation.decisionSeq;

  const appended = append(
    logPath,
    {
      ts,
      event: "execution.started",
      actor,
      task: derivation.task,
      action_key: actionKey,
      payload,
    },
    options,
    // The head read at the top: single-use, liveness and the harness marker
    // were all judged against exactly that log, so a competing consumer that
    // landed in between wins and this one is refused `head-moved`.
    read.head,
  );
  if (!appended.ok) return appended;
  return { ok: true, record: appended.record };
}

// ---------------------------------------------------------------------------
// expire
// ---------------------------------------------------------------------------

export type ExpireResult = { ok: true; record: EventRecord } | GateRefusal;

/** The shared append used by both `expire` and `decide`'s lazy materialisation. */
function appendExpiry(
  logPath: string,
  derivation: RequestDerivation,
  load: PolicyLoadResult,
  ts: string,
  options: GateOptions,
  expectedHead: LogHead | null,
): { ok: true; record: EventRecord } | GateRefusal {
  const payload: Record<string, unknown> = {};
  if (derivation.requestTs !== null) payload["requested_ts"] = derivation.requestTs;
  const ttlMs = ttlOf(load);
  if (ttlMs !== null) payload["ttl_ms"] = ttlMs;
  const onExpiry = load.ok ? load.policy.defaults?.on_expiry : undefined;
  if (onExpiry !== undefined) payload["on_expiry"] = onExpiry;
  if (derivation.declared.class !== null) payload["class"] = derivation.declared.class;

  return append(
    logPath,
    {
      ts,
      event: "approval.expired",
      // SPEC.md §8: `system:` is for runtime-originated events, and expiry is
      // the example the spec itself gives. No human acted; the clock did.
      actor: EXPIRY_ACTOR,
      ...(derivation.task === null ? {} : { task: derivation.task }),
      action_key: derivation.actionKey,
      payload,
    },
    options,
    expectedHead,
  );
}

/**
 * Append `approval.expired` for a live request whose TTL has lapsed.
 *
 * The system verb: no human decides an expiry, so the actor is
 * {@link EXPIRY_ACTOR} and there is no identity to resolve. Used by the daemon's
 * sweep (M5) and by tests; `decide` performs the same append itself when it
 * discovers a lapse first.
 *
 * Refuses when the request is not live (`not-requested`, `already-decided`) or
 * when the TTL has not lapsed (`not-expired`, which also covers a policy that
 * declares no `defaults.approval_ttl` — no TTL means no lapse, and expiring a
 * request the policy never bounded would be the runtime inventing a deadline).
 *
 * `defaults.on_expiry` is recorded in the payload. Its only v0.1 value,
 * `reject`, does not change the mechanics here — an expired request is terminal
 * either way — it tells the projection layer to render the envelope's `state:`
 * as `rejected`.
 */
export function expire(
  logPath: string,
  actionKey: string,
  options: GateOptions = {},
): ExpireResult {
  const ts = tick(options);
  const read = readGateRecords(logPath);
  if (!read.ok) return read;

  const load = loadPolicy(loadOptionsOf(options));
  const ttlMs = ttlOf(load);
  const derivation = requestState(read.records, actionKey, ts, ttlMs);

  if (derivation.state === "none") {
    return refuse(
      "not-requested",
      `action ${actionKey} has no approval.requested record to expire`,
      { state: derivation.state },
    );
  }
  if (derivation.expiredByEvent) {
    return refuse(
      "already-decided",
      `action ${actionKey} already has an approval.expired record at seq ${String(derivation.decisionSeq)}`,
      { state: derivation.state },
    );
  }
  if (derivation.state !== "expired") {
    if (derivation.state !== "requested") {
      return refuse(
        "already-decided",
        `action ${actionKey} was already ${derivation.state} at seq ${String(derivation.decisionSeq)}; only a live request can expire`,
        { state: derivation.state },
      );
    }
    return refuse(
      "not-expired",
      ttlMs === null
        ? `action ${actionKey} cannot expire: the policy declares no defaults.approval_ttl, so the request is not bounded by a TTL`
        : `action ${actionKey} has not expired: the request at ${String(derivation.requestTs)} has not lapsed its ${String(ttlMs)}ms TTL as of ${ts}`,
      { state: derivation.state },
    );
  }

  return appendExpiry(logPath, derivation, load, ts, options, read.head);
}
