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
 * 4. **Time is a parameter.** No function here reads the clock. TTL lapse,
 *    budget windows, and event timestamps all come from a `ts` argument, so a
 *    gate decision can be replayed from the log exactly as it was made.
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
 * token to its caller. It still appends no `execution.*` event: spending a token
 * is `core/token.ts`'s `consumeToken`.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  ATTESTATION_REFUSAL,
  attestationRefusal,
  checkAttestation,
  type AttestationRefusalDetail,
} from "./attest.js";
import { evaluateBudgets, type BudgetScope, type BudgetVerdict } from "./budgets.js";
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
  /** The envelope failed `envelope.schema.json`, or the task file has none. */
  "envelope-invalid",
  /** The task file could not be read. */
  "task-file-unreadable",
  /** This task id already has a `task.registered` record. */
  "task-already-registered",
  /** No `task.registered` record for this task id. */
  "not-registered",
  /** The task is registered but declares no action with this key (SPEC.md §7). */
  "action-not-registered",
  /** A live `approval.requested` for this action key already exists. */
  "duplicate-request",
  /** The action key already has an `execution.*` record (idempotency). */
  "already-executed",
  /** APRV-14 verdicts failed; a `budget.exceeded` event was appended. */
  "budget-exceeded",
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

/** Options shared by every gate operation. */
export interface GateOptions {
  /** Schema directory, passed to both envelope validation and the append. */
  schemaDir?: string;
  /** Where to find `APPROVAL.md`. Same semantics as `loadPolicy`. */
  policy?: { dir?: string; file?: string };
  /** Lock tuning for the append path. */
  append?: AppendOptions;
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

/** Refuse unless the live policy bytes match the latest attestation. */
function requireAttestation(records: EventRecord[], options: GateOptions): GateRefusal | null {
  const status = checkAttestation(records, policyPathOf(options));
  const refusal = attestationRefusal(status);
  if (refusal === null) return null;
  return refuse(ATTESTATION_REFUSAL, refusal.message, { detail: refusal.detail });
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
    actions.push(action);
  }
  return actions;
}

type Resolved = { ok: true; task: string; envelope: unknown } | GateRefusal;

function resolveSource(source: RegisterSource): Resolved {
  if (!("file" in source)) {
    if (typeof source.task !== "string" || source.task.length === 0) {
      return refuse("envelope-invalid", "register requires a non-empty task id");
    }
    return { ok: true, task: source.task, envelope: source.envelope };
  }
  return readTaskFileSource(source.file);
}

function readTaskFileSource(path: string): Resolved {
  const read = readTaskFile(path);
  if (!read.ok) {
    if (read.code === "io") return refuse("task-file-unreadable", read.message);
    return refuse("envelope-invalid", `${path}: ${read.message}`);
  }
  const id = read.data["id"];
  if (typeof id !== "string" || id.length === 0) {
    return refuse(
      "envelope-invalid",
      `${path}: frontmatter has no usable \`id\`; the task id is a Backlog.md board key and the gate needs it to key the registration`,
    );
  }
  const envelope = read.data["approval"];
  if (envelope === undefined) {
    return refuse(
      "envelope-invalid",
      `${path}: frontmatter has no \`approval:\` key. SPEC.md §6 tolerates a task with no envelope — it simply cannot request side-effecting execution — so there is nothing to register.`,
    );
  }
  return { ok: true, task: id, envelope };
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
 */
export function register(
  logPath: string,
  source: RegisterSource,
  ts: string,
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
  if (!resolved.ok) return resolved;

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

  for (const record of read.records) {
    if (record.event === "task.registered" && record.task === resolved.task) {
      return refuse(
        "task-already-registered",
        `task ${resolved.task} was already registered at seq ${record.seq}; an envelope change is envelope.drift, not a second registration`,
      );
    }
  }

  const envelope = resolved.envelope as { state?: unknown };
  const actions = actionsOf(resolved.envelope);
  const payload: Record<string, unknown> = { actions };
  if (typeof envelope.state === "string") payload["state"] = envelope.state;

  const appended = append(
    logPath,
    { ts, event: "task.registered", actor, task: resolved.task, payload },
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
 * 5. **Request legality**, then **budgets**, then the append. Legality first
 *    because a duplicate request is a caller bug that no budget outcome should
 *    obscure, and because refusing it must leave the log untouched.
 *
 * The `approval.requested` payload carries `class` and `est_cost_usd`
 * unconditionally — the budgets contract requires them on the grant, and the
 * grant copies them from here.
 */
export function request(
  logPath: string,
  input: RequestInput,
  ts: string,
  actor: string,
  options: GateOptions = {},
): RequestResult {
  if (!PRINCIPAL_ACTOR.test(actor)) {
    return refuse(
      "actor-invalid",
      `request requires a human: or agent: actor, got ${JSON.stringify(actor)}`,
    );
  }

  const read = readGateRecords(logPath);
  if (!read.ok) return read;

  const attested = requireAttestation(read.records, options);
  if (attested !== null) return attested;

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

  const budget = evaluateBudgets(
    read.records,
    budgetScopeOf(load, resolution),
    { class: input.cls, est_cost_usd: costOf(input.est_cost_usd) },
    ts,
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

  const payload: Record<string, unknown> = {
    class: input.cls,
    est_cost_usd: costOf(input.est_cost_usd),
  };
  if (input.summary !== undefined) payload["summary"] = input.summary;
  if (input.reversible !== undefined) payload["reversible"] = input.reversible;

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
 * Budgets are re-evaluated at grant time. A request may have sat in the queue
 * while other actions consumed the window, and the moment that matters for a
 * commitment is the moment the human commits.
 *
 * On `grant` a single-use execution token is minted (`core/token.ts`) and its
 * SHA-256 recorded in the payload as `token_sha256`. The raw token is returned
 * in `token` and is written nowhere: whoever calls this is the only party that
 * will ever hold it, and a lost token is unrecoverable by design — revoke and
 * request again.
 */
export function decide(
  logPath: string,
  actionKey: string,
  decision: Decision,
  actor: string,
  ts: string,
  options: DecideOptions = {},
): DecideResult {
  if (!HUMAN_ACTOR.test(actor)) {
    return refuse(
      "actor-not-human",
      `${decision} is a human-only verb; the actor must match human:<id>, got ${JSON.stringify(actor)}`,
    );
  }

  const read = readGateRecords(logPath);
  if (!read.ok) return read;

  if (decision === "grant") {
    const attested = requireAttestation(read.records, options);
    if (attested !== null) return attested;
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
    // The budgets contract: class and est_cost_usd on every approval.granted,
    // copied from the request rather than re-derived from a file.
    payload["class"] = derivation.declared.class ?? "";
    payload["est_cost_usd"] = derivation.declared.est_cost_usd ?? 0;
  }
  if (options.note !== undefined) payload["note"] = options.note;

  if (decision === "grant") {
    const cls = derivation.declared.class ?? "";
    const resolution = resolve(
      load,
      cls,
      derivation.declared.reversible === null ? {} : { reversible: derivation.declared.reversible },
    );
    const budget = evaluateBudgets(
      read.records,
      budgetScopeOf(load, resolution),
      { class: cls, est_cost_usd: derivation.declared.est_cost_usd ?? 0 },
      ts,
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
  let token: string | undefined;
  if (decision === "grant") {
    token = mintToken();
    payload[TOKEN_HASH_FIELD] = tokenHash(token);
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
  ts: string,
  options: GateOptions = {},
): ExpireResult {
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
