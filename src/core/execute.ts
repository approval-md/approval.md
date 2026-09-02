/**
 * Execution: the events that say a side effect actually happened (SPEC.md §8,
 * §10.1, and the human-settled execution points of 2026-08-06).
 *
 * `core/gate.ts` decides whether an action *may* run and appends no
 * `execution.*` event. `core/token.ts` spends a manual action's token. This
 * module is the single door between those two facts and the world: it is where
 * `execution.started` is appended before a command is spawned, and where
 * `execution.completed` / `execution.failed` are appended after it exits.
 *
 * ## The five properties this module exists to hold
 *
 * 1. **Nothing starts without authorization.** On the manual path a valid token
 *    is REQUIRED; absent it, {@link startExecution} refuses `token-required` and
 *    appends nothing at all. On the supervised/autonomous paths no token exists
 *    (amended SPEC.md §6.3 gives them no grant), so authorization is proven
 *    differently and in this order: the action must be declared in a
 *    `task.registered` record, the policy must be attested, loop safety must not
 *    have escalated the task, no execution may already have started for the key,
 *    the executor's recomputed `payload_hash` must equal the one the declaration
 *    bound to (APRV-140), and the budget must pass. Only then is
 *    `execution.started` appended.
 * 2. **`started` precedes the side effect.** The CLI's `approval run` appends
 *    the start event *before* it spawns the child, never after. A log that
 *    records an execution only once it succeeded is a log that cannot tell you
 *    about the one that did not.
 * 3. **A crash therefore leaves a dangling execution, and that is correct.**
 *    Between `started` and its outcome the log honestly says "this began and we
 *    do not know how it ended". {@link danglingExecutions} surfaces that state
 *    distinctly — `approval status` reports it, `approval queue` does not,
 *    because a dangling execution is not a pending decision. It is one of five
 *    custody states {@link executionCustody} distinguishes (APRV-120), and the
 *    other four matter for the same reason: a harness execution is terminal by
 *    design rather than debris, and an attempt whose outcome is unknown is
 *    neither a failure nor a thing to retry.
 * 4. **Nothing auto-repairs.** No function here closes a dangling execution as a
 *    side effect of anything else. A second `approval run` for the same key does
 *    not "recover" the first; it refuses (`token-consumed` on the manual path,
 *    `already-executed` off it). Recovery is a human calling
 *    {@link resolveExecution} with the outcome they actually observed and a
 *    mandatory note saying how they know — the same append path, no fabricated
 *    exit code, `attested_by_human: true` so no reader mistakes it for a
 *    machine's report. ({@link finishExecution} is the mechanical sibling, used
 *    by `approval run`, which watched the child exit.) An automatic
 *    reconciliation would have to *guess* whether the email went out, and a
 *    guess written into an append-only log is indistinguishable from a fact.
 *    The same rule governs an INDETERMINATE outcome, more strictly:
 *    {@link reconcileExecution} is human-only, appends beside the record rather
 *    than over it, and nothing anywhere converts one into completed or failed.
 * 5. **The budgets contract is honored at the documented charge point.**
 *    `core/budgets.ts` charges the manual path at `approval.granted` and the
 *    supervised/autonomous paths at `execution.started`. This module is that
 *    second charge point: it evaluates budgets at the start timestamp, appends
 *    `budget.exceeded` and refuses when they fail, and records
 *    `payload.class` + `payload.est_cost_usd` on every start event it writes.
 *    The manual path is charged at grant and is deliberately NOT charged again
 *    here — `consumeToken` writes that start event, and the evaluator already
 *    ignores a start whose window holds a matching grant.
 *
 * ## Loop safety (SPEC.md §10.2), from this side
 *
 * Three consecutive `execution.failed` events for one task escalate it to
 * manual. `core/loop.ts` computes that; this module enforces it on the
 * execution side: an escalated task's supervised/autonomous action refuses with
 * `loop-escalated`, which is not a ban but a redirection — request the action,
 * have a human grant it, and run it with the token. `core/gate.ts` enforces the
 * matching half at intake so the redirection is visible one step earlier.
 *
 * ## Time (amended SPEC.md §8, A2)
 *
 * `execution.*` events are gate-typed, so their timestamps are assigned by the
 * runtime at the write boundary: no public function here takes a `ts`, each
 * reads {@link ExecuteOptions.clock} once, and the party whose budget window
 * and TTL are being judged does not author the clock. Replay is preserved by
 * injection — a test hands in a fixed clock, production hands in nothing.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { attestationRefusal, checkAttestation, type AttestationRefusalDetail } from "./attest.js";
import { evaluateBudgetsWithTask, type BudgetVerdict } from "./budgets.js";
import { tick, type ClockOptions } from "./clock.js";
import {
  appendEvent,
  type AppendError,
  type AppendOptions,
  type EventInput,
  type EventRecord,
  type LogHead,
} from "./log.js";
import { isLoopEscalated } from "./loop.js";
import { usdOrZero } from "./money.js";
import { isPayloadHash } from "./payload.js";
import { loadPolicy, POLICY_FILENAMES, type Autonomy, type LoadPolicyOptions } from "./policy-load.js";
import { humanOnlyRefusal, resolve } from "./policy-match.js";
import { readVerifiedRecords, type LogReadRefusal } from "./state.js";
import { forgetPrivateKey, keyStoreDirFor } from "./seal.js";
import { consumeToken, deliveredToken, type TokenRefusal } from "./token.js";

export {
  isLoopEscalated,
  loopEscalation,
  LOOP_ESCALATION_THRESHOLD,
  type TaskLoopState,
} from "./loop.js";

/**
 * The closed set of execution refusal codes. Frozen public API in the same sense
 * the gate's and the token module's are: an agent branches on these to decide
 * whether to fix itself, ask a human, or stop.
 *
 * The five token codes are re-exposed verbatim rather than collapsed into one:
 * `approval run` on the manual path is a token spend, and "you presented no
 * token" (`token-required`), "you presented the wrong one" (`token-mismatch`),
 * and "it was already spent" (`token-consumed`) call for three different
 * responses.
 */
export const EXECUTE_REFUSAL_CODES = [
  /** No `task.registered` record declares this action key (SPEC.md §7). */
  "action-not-registered",
  /**
   * The action's class resolves to `human-only` (APRV-185, amended SPEC.md
   * §5.2): the policy reserves it to human hands, and a person performs it
   * outside agent execution entirely.
   *
   * Refused on BOTH paths, before either is chosen, which is what separates it
   * from `token-required`. That code is a redirection — get a token and come
   * back — and this one is not: there is no token to get and no grant that
   * could mint one, because `core/gate.ts` refuses the request that would open
   * one under the same code. Nothing is appended on either path, and no retry
   * of any shape changes the answer.
   *
   * Surfaced verbatim from `core/token.ts` as well, for a manual-path spend of
   * a token whose class a policy amendment raised after the grant, so an
   * executor meets one spelling of one fact.
   */
  "class-human-only",
  /** The class resolves manual and no token was presented. Nothing appended. */
  "token-required",
  /** Loop safety escalated the task to manual (SPEC.md §10.2). */
  "loop-escalated",
  /** Policy is unattested or its bytes changed (`core/attest.ts`). */
  "policy-not-attested",
  /** An `execution.started` already exists for this key (idempotency). */
  "already-executed",
  /** Budgets refused the start; a `budget.exceeded` event WAS appended. */
  "budget-exceeded",
  /** `finishExecution` found no unfinished `execution.started`. */
  "not-started",
  /** `finishExecution` found the started execution already closed. */
  "already-finished",
  /** No grant governs this manual action key. */
  "not-granted",
  /** A grant exists, but the presented token is not its preimage. */
  "token-mismatch",
  /** The token was already spent. */
  "token-consumed",
  /** The parent request's TTL lapsed. */
  "token-expired",
  /** A human withdrew the grant. */
  "token-revoked",
  /**
   * The grant was harness-executed and minted no token (APRV-106). Surfaced
   * verbatim from `core/token.ts` so the executor's vocabulary stays that
   * module's vocabulary: an agent that reads this has not lost a token, it is
   * holding a grant that authorized a process which runs the command itself.
   */
  "harness-executed",
  /**
   * The payload presented does not hash to the bytes the grant approved
   * (amended SPEC.md §10, A1). Nothing was appended and the token is still live.
   */
  "payload-mismatch",
  /**
   * `resolveExecution` was called without the mandatory human observation, or
   * by an actor that is not a `human:`. Recorded here rather than reusing
   * `not-started` because the log is unchanged for a different reason: the
   * caller, not the state.
   */
  "actor-not-human",
  /**
   * The key's latest `execution.started` is a DELEGATED record (APRV-117,
   * APRV-120): it carries `payload.execution: "harness"`, so the harness ran the
   * command and this runtime never observed an exit status. The record is
   * complete as written and terminal by design, and no outcome may be placed
   * over it.
   *
   * Distinct from the two refusals it sits between, and the distinctions are the
   * point. `not-started` says nothing began; `already-finished` says something
   * began and an outcome already exists. This one says the thing that began is
   * not this runtime's to close: a `completed` or `failed` written here would
   * report an exit code nobody watched, and an `execution.completed` would
   * additionally clear the task's loop-escalation streak (SPEC.md §10.2) on the
   * strength of it. {@link executionCustody} reports these as `delegated` and
   * {@link danglingExecutions} deliberately leaves them out, so this code is the
   * enforcement half of a custody state the projections already draw.
   */
  "execution-delegated",
  /**
   * The key's execution ended in an unknown outcome (APRV-120) and has not been
   * reconciled. INDETERMINATE IS A CUSTODY STATE: the token stays spent, the
   * idempotency key stays burned, and a re-run is refused here rather than
   * anywhere else, because "we do not know whether this happened" is a
   * different fact from "this already happened" and calls for a different
   * repair — a person establishing which it was, with `execution reconcile`.
   */
  "execution-indeterminate",
  /**
   * `reconcileExecution` found no unreconciled `execution.indeterminate` for
   * the key. There is nothing whose outcome is in doubt, so there is nothing to
   * resolve; a dangling execution is closed with `execution resolve` instead.
   */
  "not-indeterminate",
  /**
   * The indeterminate outcome already carries a resolution. A second one would
   * be a second answer to a question a person already answered, and the first
   * record is never rewritten.
   */
  "already-reconciled",
  /** The log could not be read, or holds a line that is not a record. */
  "log-unreadable",
  /** The log's final line is unterminated (a crashed write). */
  "log-torn-tail",
  /** The chain does not verify; nothing may execute on an untrustworthy log. */
  "log-corrupt",
  /**
   * The append itself failed; `append` carries the underlying error. Its `code`
   * is `head-moved` when a record landed between this module's read and its
   * append, so the idempotency and budget checks that authorized the write were
   * made against an older log. Nothing was written and nothing is retried here.
   */
  "append-failed",
] as const;

export type ExecuteRefusalCode = (typeof EXECUTE_REFUSAL_CODES)[number];

/** Every execution failure is one of these. Nothing here throws. */
export interface ExecuteRefusal {
  ok: false;
  code: ExecuteRefusalCode;
  message: string;
  /** Attestation discriminator, when `code` is `policy-not-attested`. */
  detail?: AttestationRefusalDetail;
  /** The failing verdicts, when `code` is `budget-exceeded`. */
  verdicts?: BudgetVerdict[];
  /** The seq of the record that produced the refusal, when there is one. */
  seq?: number;
  /** An event appended alongside the refusal: only ever `budget.exceeded`. */
  record?: EventRecord;
  /** The underlying append error, when `code` is `append-failed`. */
  append?: AppendError;
}

/**
 * Options shared by the execution verbs.
 *
 * No `ts`: `execution.*` events are gate-typed, so amended SPEC.md §8 (A2)
 * assigns their timestamps at the write boundary from {@link ClockOptions}.
 */
export interface ExecuteOptions extends ClockOptions {
  /**
   * The raw single-use token printed by `approval grant`. REQUIRED for an
   * action whose class resolves to `manual`; meaningless off that path, where no
   * token was ever minted.
   */
  token?: string;
  /**
   * The hash of the payload about to be executed (amended SPEC.md §10, A1),
   * forwarded to `core/token.ts` on the manual path and checked against the
   * registered declaration off it (APRV-140). `approval run` computes it with
   * `runPayloadHash(argv, cwd)`; an adapter with a different payload computes
   * its own. REQUIRED on every path: under A1 every manual grant binds to
   * bytes, and under APRV-140 so does every declaration that executes.
   *
   * It is never read from the log. A value read from the log would prove
   * nothing: the point is that the executor states, independently, what it
   * holds, and the runtime compares.
   */
  presentedPayloadHash?: string;
  /** Where to find `APPROVAL.md`. Same semantics as `loadPolicy`. */
  policy?: { dir?: string; file?: string };
  /** Schema directory, passed to the append's write-boundary validation. */
  schemaDir?: string;
  /** Lock tuning for the append path. */
  append?: AppendOptions;
  /**
   * How many credential-bearing variables the executor withheld from the child
   * it is about to spawn (APRV-205), recorded on `execution.started` as
   * `env_stripped`.
   *
   * A COUNT, never a name and never a value: a name is half of a credential,
   * and SPEC.md §11.1's raw-secrets invariant is not satisfied by leaking the
   * other half slowly. It is informational — nothing in the gate reads it back
   * and no decision turns on it, which is what keeps it clear of §11.1's
   * "self-reported fields never reduce scrutiny". No CLI flag sets it: it is
   * computed by `core/child-env.ts` at the spawn site, in the same process that
   * spawns.
   */
  envStripped?: number;
  /**
   * Where per-request private keys live (APRV-105). Defaults to `.approval/keys/`
   * beside the log. Read when no `token` is passed and a grant carries a
   * `token_sealed`; unlinked once the token is spent.
   */
  keyStoreDir?: string;
}

function refuse(
  code: ExecuteRefusalCode,
  message: string,
  extra: Omit<ExecuteRefusal, "ok" | "code" | "message"> = {},
): ExecuteRefusal {
  return { ok: false, code, message, ...extra };
}

/** Narrow a verified-read refusal onto this module's codes, unchanged. */
function fromReadRefusal(refusal: LogReadRefusal): ExecuteRefusal {
  return refuse(refusal.code, refusal.message);
}

/**
 * Narrow a token refusal onto this module's codes.
 *
 * The names are identical on purpose — `core/token.ts` chose them so the CLI
 * could map both modules onto the frozen exit table with one function.
 */
function fromTokenRefusal(refusal: TokenRefusal): ExecuteRefusal {
  const extra: Omit<ExecuteRefusal, "ok" | "code" | "message"> = {};
  if (refusal.seq !== undefined) extra.seq = refusal.seq;
  if (refusal.append !== undefined) extra.append = refusal.append;
  return refuse(refusal.code, refusal.message, extra);
}

function payloadOf(record: EventRecord): Record<string, unknown> {
  const payload = record.payload;
  return typeof payload === "object" && payload !== null ? payload : {};
}

function loadOptionsOf(options: ExecuteOptions): LoadPolicyOptions {
  const policy = options.policy ?? {};
  const load: LoadPolicyOptions = {};
  if (policy.file !== undefined) load.file = policy.file;
  else load.dir = policy.dir ?? process.cwd();
  if (options.schemaDir !== undefined) load.schemaDir = options.schemaDir;
  return load;
}

/**
 * The policy file whose bytes are attested — discovered exactly as
 * `core/gate.ts` discovers it, so the attested file and the enforced file are
 * the same file. A missing policy returns the first candidate anyway, so
 * `checkAttestation` reports `unreadable` and the start is refused: a missing
 * policy is never a pass.
 */
function policyPathOf(options: ExecuteOptions): string {
  const policy = options.policy ?? {};
  if (policy.file !== undefined) return policy.file;
  const dir = policy.dir ?? process.cwd();
  for (const filename of POLICY_FILENAMES) {
    const candidate = join(dir, filename);
    if (existsSync(candidate)) return candidate;
  }
  return join(dir, POLICY_FILENAMES[0] ?? "APPROVAL.md");
}

function appendOptionsOf(options: ExecuteOptions): AppendOptions {
  const append: AppendOptions = { ...options.append };
  if (options.schemaDir !== undefined) append.schemaDir = options.schemaDir;
  return append;
}

/**
 * Append one event under the compare-and-append precondition (APRV-20).
 *
 * `expectedHead` is the head observed at the read that authorized this write:
 * the already-executed check, the loop-safety check, and the budget evaluation
 * were all made against a log ending exactly there.
 */
function append(
  logPath: string,
  input: EventInput,
  options: ExecuteOptions,
  expectedHead: LogHead | null,
): { ok: true; record: EventRecord } | ExecuteRefusal {
  const result = appendEvent(logPath, input, { ...appendOptionsOf(options), expectedHead });
  if (result.ok) return { ok: true, record: result.record };
  return refuse(
    "append-failed",
    `${input.event} could not be appended: ${result.error.message}`,
    { append: result.error },
  );
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

/** What a `task.registered` record declared about one action key. */
export interface Declaration {
  task: string;
  class: string;
  /**
   * The declared cost as a canonical decimal USD string (APRV-121), `"0"` when
   * the declaration named none. A `task.registered` record written before that
   * change carries a JSON number and normalizes to the same string here.
   */
  est_cost_usd: string;
  reversible: boolean | null;
  summary: string | null;
  /**
   * The content binding the registration declared (amended SPEC.md §6.2,
   * APRV-140), or `null` when it declared none. Off the manual path this is the
   * ONLY thing an execution can be checked against: there is no grant, so the
   * declaration is the whole of what was authorized.
   */
  payload_hash: string | null;
}

/**
 * Find the declaration for `actionKey` across every `task.registered` record.
 *
 * The log — not the task file, which may have been edited since — is the
 * authority, exactly as it is for `approval request`. The search is by action
 * key alone because an execution names a key, not a task: SPEC.md §7 makes the
 * `idempotency_key` the identity of a side effect, and an undeclared key is the
 * one thing that must never execute.
 *
 * A key must be declared by exactly one task. If a log somehow carries the same
 * key under two tasks, this returns the last, but callers on an enforcement path
 * MUST first fail closed via {@link declaringTasks}: the collision is refused at
 * registration (`core/gate.ts`, APRV-138), so a log that still holds one is
 * untrustworthy and nothing may execute from the guess.
 */
export function findDeclaration(
  records: EventRecord[],
  actionKey: string,
): Declaration | null {
  let found: Declaration | null = null;
  for (const record of records) {
    if (record.event !== "task.registered") continue;
    const task = record.task;
    if (typeof task !== "string" || task.length === 0) continue;
    const actions = payloadOf(record)["actions"];
    if (!Array.isArray(actions)) continue;
    for (const entry of actions) {
      if (typeof entry !== "object" || entry === null) continue;
      const item = entry as Record<string, unknown>;
      if (item["idempotency_key"] !== actionKey) continue;
      const cls = item["class"];
      if (typeof cls !== "string") continue;
      const cost = item["est_cost_usd"];
      const reversible = item["reversible"];
      const summary = item["summary"];
      const binding = item["payload_hash"];
      found = {
        task,
        class: cls,
        est_cost_usd: usdOrZero(cost),
        reversible: typeof reversible === "boolean" ? reversible : null,
        summary: typeof summary === "string" ? summary : null,
        payload_hash: isPayloadHash(binding) ? binding : null,
      };
    }
  }
  return found;
}

/**
 * The distinct tasks that declare `actionKey`. More than one is a cross-task
 * collision (APRV-138): the registration boundary refuses these, so a log that
 * still holds one cannot be trusted to say which declaration governs. Every
 * enforcement caller of {@link findDeclaration} guards on this and fails closed
 * rather than executing the last-registered (possibly weaker) declaration.
 */
export function declaringTasks(records: EventRecord[], actionKey: string): string[] {
  const tasks = new Set<string>();
  for (const record of records) {
    if (record.event !== "task.registered") continue;
    const task = record.task;
    if (typeof task !== "string" || task.length === 0) continue;
    const actions = payloadOf(record)["actions"];
    if (!Array.isArray(actions)) continue;
    for (const entry of actions) {
      if (typeof entry !== "object" || entry === null) continue;
      if ((entry as Record<string, unknown>)["idempotency_key"] === actionKey) {
        tasks.add(task);
      }
    }
  }
  return [...tasks];
}

/**
 * Has a human ever been asked about this action key (amended SPEC.md §6.3,
 * APRV-127)?
 *
 * True as soon as the log holds one `approval.requested` for the key, and it
 * stays true: a rejected, expired or withdrawn cycle is still a cycle, and an
 * action that could shed its gate by being refused would be an action that
 * profits from a "no".
 *
 * Pure, and derived from the log alone — never from a payload field a requester
 * wrote about itself. Two callers: {@link startExecution}, which requires the
 * token of any action that went through the gate, and `core/audit.ts`, which
 * leaves such actions out of the retrospective pool because a human already
 * looked.
 */
export function hasApprovalCycle(records: readonly EventRecord[], actionKey: string): boolean {
  return records.some(
    (record) => record.event === "approval.requested" && record.action_key === actionKey,
  );
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

export type StartResult =
  | {
      ok: true;
      /** The appended `execution.started` record. */
      record: EventRecord;
      /** The autonomy that admitted it — `manual` means a token was spent. */
      autonomy: Autonomy;
      task: string;
      class: string;
      /** Canonical decimal USD string (APRV-121). */
      est_cost_usd: string;
      /** The digest of the spent token, on the manual path only. */
      tokenSha256?: string;
    }
  | ExecuteRefusal;

/**
 * Begin an execution: the single entry point for appending `execution.started`.
 *
 * Check order, and why it is this order:
 *
 * 1. **The log reads**, so a torn or unreadable log stops everything before a
 *    policy question is asked.
 * 2. **The declaration.** An action key no `task.registered` record declares is
 *    `action-not-registered` — SPEC.md §7's "an action's class MUST be declared
 *    before an execution token can be requested for it", enforced at the last
 *    possible moment as well as the first.
 * 3. **Policy resolution**, including SPEC.md §7's irreversibility floor (the
 *    declared `reversible: false` forces `manual`, which forces a token). A
 *    failed policy load resolves everything to `manual` — `policy-match.ts`'s
 *    contract, not softened here — so an unparseable policy makes every action
 *    require a human's token.
 * 4. **Manual path: the token, or nothing.** No token → `token-required`, and
 *    the log is untouched. With one, `consumeToken` verifies it and appends the
 *    start event; a class that resolves manual but was never granted refuses
 *    `not-granted` from that layer. Attestation is not re-checked here: the
 *    grant that minted the token could only have happened under an attested
 *    policy, and re-checking would refuse an execution a human already
 *    authorized because a file changed afterwards.
 * 5. **Non-manual path**, in order: attestation → loop escalation → idempotency
 *    → content binding → budgets → append. Attestation first because an
 *    unverified policy cannot answer the autonomy question it was just asked to
 *    answer; the binding (APRV-140) after the free checks and before the
 *    charging one; budgets last because a budget refusal *writes*
 *    (`budget.exceeded`), and the cheaper refusals must leave the log
 *    untouched.
 *
 * `actor` is not pre-validated: the event schema is the authority on actor
 * shape, and a malformed one is refused at the write boundary as
 * `append-failed`, with the schema's own error attached. One rule about actors,
 * enforced in one place.
 */
export function startExecution(
  logPath: string,
  actionKey: string,
  options: ExecuteOptions,
  actor: string,
): StartResult {
  const ts = tick(options);
  const read = readVerifiedRecords(
    logPath,
    options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir },
  );
  if (!read.ok) return fromReadRefusal(read);
  const records = read.records;

  const declaring = declaringTasks(records, actionKey);
  if (declaring.length > 1) {
    return refuse(
      "action-not-registered",
      `action key ${JSON.stringify(actionKey)} is declared by more than one task (${declaring.join(", ")}); the runtime will not guess which governs and refuses rather than execute the later declaration. Registration refuses such collisions (APRV-138); a log that holds one is untrustworthy.`,
    );
  }
  const declared = findDeclaration(records, actionKey);
  if (declared === null) {
    return refuse(
      "action-not-registered",
      `no task.registered record declares an action with idempotency_key ${JSON.stringify(actionKey)}; SPEC.md §7 requires a class to be declared before the action can execute. Run \`approval register <task-file>\` first.`,
    );
  }

  // Custody before authorization (APRV-120). A key whose execution ended in an
  // unknown outcome is BURNED, and it is burned on both paths: the manual one
  // would otherwise say `token-consumed`, which is true and unhelpful, and the
  // non-manual one `already-executed`, which is the assertion nobody can make.
  // Checked before the policy is even read, because the fact is about the key
  // rather than about its autonomy, and a blind retry is what the state exists
  // to refuse.
  const custody = executionCustody(records).find((entry) => entry.actionKey === actionKey);
  if (custody?.state === "indeterminate") {
    return refuse(
      "execution-indeterminate",
      `action ${actionKey}'s execution ended in an unknown outcome (execution.indeterminate at seq ${String(custody.indeterminateSeq)}${custody.reason === null ? "" : `, ${custody.reason}`}): the side effect was attempted and nobody knows whether it committed. Running it again would be a blind double-execution, so it is refused, and the token and the idempotency key stay spent. Establish what actually happened and record it with \`approval execution reconcile\`; if it did not happen, declare a fresh action and request that.`,
      { seq: custody.indeterminateSeq ?? custody.seq },
    );
  }

  const load = loadPolicy(loadOptionsOf(options));
  const resolution = resolve(
    load,
    declared.class,
    declared.reversible === null ? {} : { reversible: declared.reversible },
  );

  // APRV-185, amended SPEC.md §5.2, and the first question asked of the
  // resolution: a class reserved to human hands has no execution path here at
  // all. Above the manual/supervised fork deliberately — the fork is a question
  // about HOW this action is authorized, and this one says nothing authorizes it
  // in this process. Above the `gatedByCycle` test for the same reason: an
  // approval cycle opened before a policy amendment raised the class does not
  // survive the amendment as a licence to run.
  if (resolution.autonomy === "human-only") {
    return refuse(
      "class-human-only",
      humanOnlyRefusal(
        declared.class,
        `action ${actionKey} may not be executed and no execution.started was written`,
      ),
    );
  }

  // APRV-127. An action that went through the gate is spent through the gate,
  // whatever its class resolves to now.
  //
  // The case this exists for is a `supervised-live` action the live draw
  // selected: `core/gate.ts` sent it down the manual path and recorded an
  // `approval.requested`, but its CLASS still resolves `supervised`, so without
  // this line `approval run` would take the unsupervised branch and start it
  // without spending the token a human minted. The rule is stated as a property
  // of the log rather than of the class deliberately — this process cannot
  // recompute the live draw (the secret is the operator's, and deliberately not
  // an agent's to read), so it asks the one question it can answer from the
  // records it already holds: was a human asked about this action?
  //
  // It is also strictly scrutiny-raising in every other case it can fire. A
  // class relaxed from `manual` to `supervised` after a request was opened would
  // otherwise let the pending question be bypassed by simply running the action;
  // now the token is still required, and `core/token.ts` answers `not-granted`
  // until a human decides. Nothing here can make an ungated action gated: an
  // action with no `approval.requested` never reaches this branch.
  const gatedByCycle = hasApprovalCycle(records, actionKey);
  if (resolution.autonomy === "manual" || gatedByCycle) {
    // APRV-105. With no token in hand, look for one delivered to this machine:
    // the grant sealed it to the ephemeral public key this action's request
    // published, and the private half is in the key store beside the log. Under
    // the default `token_delivery: manual` nothing was sealed and this returns
    // null, so the refusal below is exactly the one it always was.
    //
    // An explicitly passed token always wins. A caller that names a token is
    // making a claim this runtime then checks against the grant's digest, and
    // silently substituting a different one would answer a question nobody
    // asked.
    const keyDir = options.keyStoreDir ?? keyStoreDirFor(logPath);
    const token =
      options.token !== undefined && options.token.length > 0
        ? options.token
        : (deliveredToken(records, actionKey, keyDir) ?? undefined);
    if (token === undefined || token.length === 0) {
      return refuse(
        "token-required",
        resolution.autonomy === "manual"
          ? `action ${actionKey} resolves to manual (${resolution.provenance}${resolution.floorApplied ? ", irreversibility floor" : ""}) and cannot execute without the single-use token minted at grant. Request the action, have a human grant it, and pass the token that grant printed.`
          : `action ${actionKey} resolves to ${resolution.autonomy} but the log already carries an approval.requested for it, so a human was asked about this action and it executes on their answer. This is what a supervised-live draw looks like from the executor's side: the gate selected this action into the live fraction and it now follows the manual path. Wait for the decision and pass the token the grant printed.`,
      );
    }
    const consumed = consumeToken(logPath, actionKey, token, actor, {
      ...(options.policy?.file === undefined ? {} : { policyFile: options.policy.file }),
      ...(options.policy?.file === undefined
        ? { policyDir: options.policy?.dir ?? process.cwd() }
        : {}),
      ...(options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir }),
      ...(options.append === undefined ? {} : { append: options.append }),
      ...(options.presentedPayloadHash === undefined
        ? {}
        : { presentedPayloadHash: options.presentedPayloadHash }),
      // APRV-205: the manual path's `execution.started` is appended by
      // `consumeToken`, so the count travels with the spend.
      ...(options.envStripped === undefined ? {} : { envStripped: options.envStripped }),
      // One moment for the whole operation: the timestamp already read above is
      // the one the spend records, so `startExecution` and the `execution.started`
      // it produces cannot disagree about when this happened.
      clock: () => ts,
    });
    if (!consumed.ok) return fromTokenRefusal(consumed);
    // APRV-105. The token is spent, so its delivery address is finished. Done
    // AFTER the append rather than before: an unlink before a failed spend would
    // destroy the only local copy of a token that is still live.
    forgetPrivateKey(keyDir, actionKey);
    const payload = payloadOf(consumed.record);
    const cost = payload["est_cost_usd"];
    return {
      ok: true,
      record: consumed.record,
      autonomy: "manual",
      task: declared.task,
      class: typeof payload["class"] === "string" ? payload["class"] : declared.class,
      est_cost_usd: usdOrZero(cost),
      tokenSha256: consumed.tokenSha256,
    };
  }

  // --- supervised / autonomous: no grant exists, so no token exists ---------
  const attestation = attestationRefusal(checkAttestation(records, policyPathOf(options)));
  if (attestation !== null) {
    return refuse("policy-not-attested", attestation.message, { detail: attestation.detail });
  }

  if (isLoopEscalated(records, declared.task)) {
    return refuse(
      "loop-escalated",
      `task ${declared.task} has three consecutive execution.failed events and is escalated to manual (SPEC.md §10.2), so its ${resolution.autonomy} actions may not start unsupervised. This is a redirection, not a ban: request ${actionKey}, have a human grant it, and run it with the token. The escalation clears only when an execution.completed for the task lands.`,
    );
  }

  for (const record of records) {
    if (record.action_key !== actionKey) continue;
    if (record.event !== "execution.started") continue;
    return refuse(
      "already-executed",
      `action ${actionKey} already started at seq ${record.seq}; an idempotency key is single-use and nothing here reconciles or reruns it. If that execution is dangling, close it with the outcome you observed.`,
      { seq: record.seq },
    );
  }

  // Content binding off the manual path (amended SPEC.md §6.2/§10.4, APRV-140).
  //
  // Until this, a supervised or autonomous action executed whatever bytes the
  // executor happened to hold: no grant exists on this path, so nothing was
  // compared, and `approval run <key> -- <anything>` under an autonomous class
  // was unauthenticated arbitrary execution (the residual APRV-138 left open).
  // The declaration is what authorizes here, so the declaration is what the
  // executor is checked against: it states its bytes, and they must be the ones
  // the registered action named.
  //
  // A declaration carrying NO binding is refused rather than waved through, for
  // the reason `core/token.ts` refuses an unbound grant: an action that can
  // execute without stating its bytes makes the binding optional in practice,
  // and ambiguity resolves to the stricter path. The repair is to declare
  // `payload_hash` on the action and register the task again.
  //
  // Checked before budgets, because a budget refusal WRITES and this one must
  // leave the log exactly as it found it.
  const presented = options.presentedPayloadHash;
  if (declared.payload_hash === null) {
    return refuse(
      "payload-mismatch",
      `action ${actionKey} resolves to ${resolution.autonomy} and its registered declaration carries no payload_hash. Off the manual path there is no grant, so the declaration is the only statement of what was authorized: amended SPEC.md §6.2 (APRV-140) makes the hash MUST for every action that executes, and an execution that cannot be checked against anything is not an authorized execution. Declare payload_hash (SHA-256 over the RFC 8785 canonical serialization of the concrete payload) on the action and register the task again.`,
    );
  }
  if (!isPayloadHash(presented) || presented !== declared.payload_hash) {
    return refuse(
      "payload-mismatch",
      presented === undefined
        ? `action ${actionKey} is declared with payload_hash ${declared.payload_hash} and this executor presented none. Amended SPEC.md §10.4: an executor MUST recompute the hash of the payload it is about to execute; a start that cannot state its bytes cannot be shown to be executing the declared ones. Nothing was appended.`
        : `the payload presented for ${actionKey} is not the one declared: the registration binds to ${declared.payload_hash}, this executor presented ${JSON.stringify(presented)}. A declaration authorizes specific bytes; changing them requires registering the action again. Nothing was appended.`,
    );
  }

  const budget = evaluateBudgetsWithTask(
    records,
    {
      classLimits: resolution.limits,
      classPattern: resolution.matched === null ? null : resolution.matched.pattern,
      globalBudgets: load.ok ? load.policy.budgets ?? null : null,
    },
    { class: declared.class, est_cost_usd: declared.est_cost_usd },
    ts,
    // S2: the registered envelope's own `budget.max_cost_usd`. This is the
    // supervised/autonomous charge point, so it is where the task cap binds for
    // actions that never pass through a grant.
    declared.task,
  );
  if (!budget.pass) {
    const failed = budget.verdicts.filter((entry) => !entry.pass);
    const logged = append(
      logPath,
      {
        ts,
        event: "budget.exceeded",
        actor,
        task: declared.task,
        action_key: actionKey,
        payload: {
          class: declared.class,
          est_cost_usd: declared.est_cost_usd,
          stage: "execution",
          verdicts: budget.verdicts,
        },
      },
      options,
      read.head,
    );
    const message = `budget refused the execution: ${failed
      .map((entry) => `${entry.limit} (${entry.scope})`)
      .join(", ")}`;
    return logged.ok
      ? refuse("budget-exceeded", message, { verdicts: failed, record: logged.record })
      : refuse(
          "budget-exceeded",
          `${message}; the budget.exceeded event could not be appended: ${logged.message}`,
          { verdicts: failed },
        );
  }

  const appended = append(
    logPath,
    {
      ts,
      event: "execution.started",
      actor,
      task: declared.task,
      action_key: actionKey,
      // The budgets contract: class and est_cost_usd on every start event. This
      // is the charge point for supervised/autonomous actions.
      //
      // APRV-140 adds the third field: the hash of the bytes that are about to
      // run, recomputed by the executor and checked against the declaration
      // just above. It is what makes the log say WHAT ran rather than only that
      // something did — for `approval run` it is `runPayloadHash(argv, cwd)`,
      // which an operator holding the command can reproduce exactly. The argv
      // itself is deliberately NOT recorded: a command line carries whatever an
      // agent put on it, secrets included, and §11.1's third invariant says the
      // log holds hashes of such material rather than the material.
      payload: {
        class: declared.class,
        est_cost_usd: declared.est_cost_usd,
        payload_hash: declared.payload_hash,
        // APRV-205: how many credential-bearing variables the child was starved
        // of. Additive and optional — an execution that spawns nothing (an
        // adapter's `act`, which runs in this process) records no count at all,
        // because "none withheld" and "no child" are different facts.
        ...(options.envStripped === undefined ? {} : { env_stripped: options.envStripped }),
      },
    },
    options,
    read.head,
  );
  if (!appended.ok) return appended;

  return {
    ok: true,
    record: appended.record,
    autonomy: resolution.autonomy,
    task: declared.task,
    class: declared.class,
    est_cost_usd: declared.est_cost_usd,
  };
}

// ---------------------------------------------------------------------------
// finish
// ---------------------------------------------------------------------------

export type FinishResult =
  | { ok: true; record: EventRecord; event: "execution.completed" | "execution.failed"; exitCode: number; task: string }
  | ExecuteRefusal;

/**
 * Close an execution with the outcome that actually happened.
 *
 * Exit `0` appends `execution.completed`; anything else appends
 * `execution.failed`. Both carry `payload.exit_code` — the number, unmapped and
 * uninterpreted, so a reader can tell exit 1 from exit 127 from a signal death
 * (which `approval run` records as `128 + signal`, the shell convention).
 * Neither event consumes budget: the commitment was charged at authorization
 * time and charging it again would double-count (`core/budgets.ts`).
 *
 * Refuses `not-started` when the key has no `execution.started`,
 * `already-finished` when the most recent start already has an outcome after
 * it, and `execution-delegated` when that start was the harness's rather than
 * this runtime's (APRV-146). All three leave the log untouched.
 *
 * **This is the human recovery path for a dangling execution**, and it is
 * deliberately the only one. Nothing in this codebase closes a dangling
 * execution automatically: an operator who knows the email went out records
 * `0`, an operator who knows it did not records the failure, and either way the
 * log holds an observation rather than a runtime's guess.
 */
export function finishExecution(
  logPath: string,
  actionKey: string,
  exitCode: number,
  actor: string,
  options: ExecuteOptions = {},
): FinishResult {
  const open = openExecution(logPath, actionKey, options);
  if (!open.ok) return open;

  const event = exitCode === 0 ? "execution.completed" : "execution.failed";
  const appended = append(
    logPath,
    {
      ts: tick(options),
      event,
      actor,
      task: open.task,
      action_key: actionKey,
      payload: { exit_code: exitCode },
    },
    options,
    // The head read above, when the not-started / already-finished checks ran.
    open.head,
  );
  if (!appended.ok) return appended;

  return { ok: true, record: appended.record, event, exitCode, task: open.task };
}

/**
 * The one dangling execution for `actionKey`, or a refusal explaining why there
 * is none to close.
 *
 * Shared by {@link finishExecution}, {@link resolveExecution} and
 * {@link indeterminateExecution} so the three verbs cannot drift about what
 * "still open" means. Returns the head observed at the read, which the caller
 * passes as `expectedHead`: the not-started, delegated and already-finished
 * checks were made against a log ending exactly there.
 *
 * A DELEGATED start is refused `execution-delegated` (APRV-146). The three verbs
 * that share this function all write an outcome, and a harness start has none to
 * write: the record says so on its face (`payload.execution: "harness"`), and
 * {@link executionCustody} has reported it terminal by design since APRV-120.
 * Enforcing it in this one place is what keeps the three verbs from disagreeing
 * about it, which is the reason this function exists.
 *
 * EXCEPT BY THE MARKED COUNTERPART (APRV-145). One surface may close a delegated
 * start, and it is not one of these three: `core/gate.ts`'s
 * `finishHarnessExecution`, which appends the outcome a harness REPORTED, marked
 * `execution: "harness"` with a closed `reported_by` code naming which untrusted
 * reporter asserted it. The refusal here is unchanged and deliberately so: these
 * three write an outcome the runtime observed or a person did, and neither exists
 * for a harness start. The counterpart writes a third thing and says so on the
 * record, which is what makes it a carve-out rather than a hole. Amended
 * SPEC.md §10.2 states the rule; the reconciliation recorded on APRV-145 is that
 * these three keep refusing exactly as APRV-146 merged them.
 *
 * An `execution.indeterminate` closes a cycle here like any other outcome
 * (APRV-120). It is not an invitation to try again: a second outcome for a key
 * whose effect may already have happened is exactly the blind double-execution
 * the state exists to refuse, and the repair is `execution reconcile`, which
 * appends beside the record rather than closing it a second time.
 */
function openExecution(
  logPath: string,
  actionKey: string,
  options: ExecuteOptions,
): { ok: true; task: string; startedSeq: number; head: LogHead | null } | ExecuteRefusal {
  const read = readVerifiedRecords(
    logPath,
    options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir },
  );
  if (!read.ok) return fromReadRefusal(read);

  let started: EventRecord | null = null;
  let finished: EventRecord | null = null;
  for (const record of read.records) {
    if (record.action_key !== actionKey) continue;
    if (record.event === "execution.started") {
      started = record;
      finished = null;
      continue;
    }
    if (
      record.event === "execution.completed" ||
      record.event === "execution.failed" ||
      record.event === "execution.indeterminate"
    ) {
      if (started !== null) finished = record;
    }
  }

  if (started === null) {
    return refuse(
      "not-started",
      `action ${actionKey} has no execution.started record; an outcome cannot be recorded for an execution that never began`,
    );
  }

  // APRV-146. A delegated start is terminal by design, so there is no open
  // execution here to close. Checked BEFORE the already-finished branch because
  // the fact is about this record's custody rather than about what else the log
  // holds: a harness execution was never going to gain an outcome, whether or
  // not something has since written one over it.
  if (isDelegatedStart(started)) {
    return refuse(
      "execution-delegated",
      `action ${actionKey}'s execution.started at seq ${started.seq} carries execution: "harness" (APRV-117): the harness ran the command and this runtime never observed an exit status, so the record is complete as written and terminal by design. No outcome may be written over it — a completed or failed recorded here would report an exit code nobody watched, and an execution.completed would additionally clear the task's loop-escalation streak (SPEC.md §10.2). \`approval status\` lists such a record as delegated rather than dangling for the same reason.`,
      { seq: started.seq },
    );
  }

  if (finished !== null) {
    return refuse(
      "already-finished",
      finished.event === "execution.indeterminate"
        ? `action ${actionKey} ended in an unknown outcome (execution.indeterminate at seq ${finished.seq}); its side effect was attempted and nobody knows whether it committed, so no outcome may be written over it. Establish what happened and record it with \`approval execution reconcile\`, which appends beside that record and never rewrites it.`
        : `action ${actionKey} was already closed by ${finished.event} at seq ${finished.seq}; an execution has exactly one outcome`,
      { seq: finished.seq },
    );
  }

  const task = started.task;
  if (typeof task !== "string" || task.length === 0) {
    // Unreachable through the real append path: event.schema.json requires
    // `task` on every execution event. Kept as a fail-closed backstop.
    return refuse(
      "not-started",
      `the execution.started record for ${actionKey} at seq ${started.seq} names no task; the outcome event requires one`,
      { seq: started.seq },
    );
  }

  return { ok: true, task, startedSeq: started.seq, head: read.head };
}

// ---------------------------------------------------------------------------
// resolve — the human recovery verb
// ---------------------------------------------------------------------------

/** What a human observed about a dangling execution. */
export type ResolveOutcome = "completed" | "failed";

export type ResolveResult =
  | {
      ok: true;
      record: EventRecord;
      event: "execution.completed" | "execution.failed";
      outcome: ResolveOutcome;
      task: string;
    }
  | ExecuteRefusal;

/** Actors permitted to resolve. A fact nobody observed is not an observation. */
const HUMAN_ACTOR = /^human:.+/u;

/**
 * Close a dangling execution with what a human actually observed.
 *
 * {@link finishExecution} is the mechanical path: `approval run` knows the
 * child's exit code because it waited for it. This is the path for the case
 * that code cannot cover — the runtime died between `execution.started` and its
 * outcome, so the log honestly says "this began and we do not know how it
 * ended", and only a person who went and looked can say more.
 *
 * Five properties, all deliberate:
 *
 * 1. **The note is mandatory and non-empty.** The whole value of this event is
 *    the observation behind it; an unexplained human-attested outcome is
 *    indistinguishable from a guess, and a guess written into an append-only
 *    log is indistinguishable from a fact. The CLI refuses an empty note as a
 *    usage error before reaching here, and this refuses it again.
 * 2. **Human-only.** An agent closing its own dangling execution is the agent
 *    reporting on itself, which is the one thing the log exists not to accept.
 * 3. **`exit_code: null`.** Not `0`, not `127`: nobody ran anything and there
 *    is no code to report. A fabricated exit code would read exactly like an
 *    observed one, and `payload.attested_by_human: true` marks the difference
 *    for every reader and every projection.
 * 4. **A harness execution is out of reach** (APRV-146). A delegated start is
 *    refused `execution-delegated` here as it is in {@link finishExecution}: the
 *    record is terminal by design, and a person attesting an outcome for a
 *    command this runtime never watched would be attesting to the one thing the
 *    log already says nobody observed.
 * 5. **No attestation requirement.** Resolve records a fact a human observed;
 *    it exercises no policy authority — it authorizes nothing, spends no
 *    budget, mints no token — so it does not require an attested policy. A
 *    dangling execution left unclosable because a policy file was edited would
 *    be a repair blocked by an unrelated fact.
 */
export function resolveExecution(
  logPath: string,
  actionKey: string,
  outcome: ResolveOutcome,
  note: string,
  actor: string,
  options: ExecuteOptions = {},
): ResolveResult {
  if (!HUMAN_ACTOR.test(actor)) {
    return refuse(
      "actor-not-human",
      `resolve is human-only: it records what a person observed about an execution nobody watched finish, and an agent-attested outcome would be the executing party reporting on itself. The actor must match human:<id>, got ${JSON.stringify(actor)}.`,
    );
  }
  if (note.trim().length === 0) {
    return refuse(
      "actor-not-human",
      `resolve requires a non-empty --note: the event's value is the observation behind it, and an unexplained human-attested outcome cannot be told apart from a guess`,
    );
  }

  const open = openExecution(logPath, actionKey, options);
  if (!open.ok) return open;

  const event = outcome === "completed" ? "execution.completed" : "execution.failed";
  const appended = append(
    logPath,
    {
      ts: tick(options),
      event,
      actor,
      task: open.task,
      action_key: actionKey,
      payload: { note, attested_by_human: true, exit_code: null },
    },
    options,
    open.head,
  );
  if (!appended.ok) return appended;

  return { ok: true, record: appended.record, event, outcome, task: open.task };
}

// ---------------------------------------------------------------------------
// indeterminate — the outcome nobody knows
// ---------------------------------------------------------------------------

export type IndeterminateResult =
  | { ok: true; record: EventRecord; reason: IndeterminateReason; task: string }
  | ExecuteRefusal;

/**
 * Close an execution as INDETERMINATE: the side effect was attempted and
 * nobody knows whether it committed (APRV-120).
 *
 * `execution.failed` used to carry this case, and conflating the two is what
 * made a retry look safe. An adapter that times out mid-send reads, in a log
 * that only knows `failed`, exactly like one that never opened a socket; a
 * caller reading the second reasonably tries again, and against the first that
 * is a double send. So the runtime writes down which it is, and the difference
 * is positional rather than a judgment: the adapter contract records
 * `execution.failed` for everything that goes wrong BEFORE `act` is entered
 * (provably not committed) and this for anything after (provably nothing).
 *
 * Three properties, all deliberate:
 *
 * 1. **The consumption is burned.** The token was spent at
 *    `execution.started` and stays spent; the idempotency key stays used; the
 *    budget stays charged. Refunding an attempt whose outcome is unknown would
 *    be the runtime deciding the effect did not happen, which is the one thing
 *    nobody here knows.
 * 2. **No exception text.** `reason` is a closed code and nothing else is
 *    recorded. An error message is where a credential rides into the log with
 *    a plausible excuse, and §11.1's third invariant does not have an
 *    exception for diagnostics. The caller still receives the message, redacted,
 *    from the adapter contract.
 * 3. **Nothing auto-resolves.** No function here, and nothing in the daemon,
 *    ever converts this into completed or failed. Only
 *    {@link reconcileExecution} does, on a person's evidence.
 */
export function indeterminateExecution(
  logPath: string,
  actionKey: string,
  reason: IndeterminateReason,
  actor: string,
  options: ExecuteOptions = {},
): IndeterminateResult {
  const open = openExecution(logPath, actionKey, options);
  if (!open.ok) return open;

  const appended = append(
    logPath,
    {
      ts: tick(options),
      event: "execution.indeterminate",
      actor,
      task: open.task,
      action_key: actionKey,
      // `exit_code: null` for the reason `resolve` writes it: nobody watched a
      // process exit, and a fabricated number would read like a measured one.
      payload: { reason, exit_code: null },
    },
    options,
    // The head read above, when the not-started / already-finished checks ran.
    open.head,
  );
  if (!appended.ok) return appended;

  return { ok: true, record: appended.record, reason, task: open.task };
}

// ---------------------------------------------------------------------------
// reconcile — the explicit resolution of an unknown outcome
// ---------------------------------------------------------------------------

export type ReconcileResult =
  | {
      ok: true;
      record: EventRecord;
      resolution: ReconcileResolution;
      task: string;
      /** The `execution.indeterminate` record this resolves. */
      indeterminateSeq: number;
    }
  | ExecuteRefusal;

/**
 * Record what a person established about an indeterminate execution.
 *
 * The counterpart of {@link resolveExecution}, and deliberately a separate verb
 * with separate refusals: `resolve` closes an execution nobody watched finish,
 * and this resolves one whose effect may or may not have landed. The questions
 * are different ("what did the runtime do?" against "did the far side commit?"),
 * the evidence is different (this repo's log against the relying party's), and
 * an operator who reached for the wrong one should be told so rather than
 * quietly write the wrong record.
 *
 * Four properties:
 *
 * 1. **The original is never rewritten.** This appends a record that NAMES the
 *    indeterminate one by seq. The observation "we did not know" survives its
 *    own resolution, which is the whole reason the log is append-only, and an
 *    auditor can see both the doubt and its answer.
 * 2. **Human-only, and never the daemon.** An agent reconciling its own unknown
 *    outcome is the executing party reporting on itself; a daemon doing it on a
 *    schedule is a guess with a cron entry. The mandatory note is the evidence,
 *    in the reconciler's own words.
 * 3. **The two resolutions are distinct in the log.** `executed` and
 *    `not-executed` are separate closed values, not two readings of one
 *    sentence, because everything downstream of the record turns on which.
 * 4. **The key stays burned either way.** Resolving `not-executed` re-opens the
 *    possibility of the EFFECT, not of this action: an `idempotency_key` is the
 *    global identity of one side effect (§6.2) and a used one is used. The
 *    repair is to declare a fresh action and request it, which is a new
 *    question with a new answer, and the reconciliation is what makes asking it
 *    honest.
 */
export function reconcileExecution(
  logPath: string,
  actionKey: string,
  resolution: ReconcileResolution,
  note: string,
  actor: string,
  options: ExecuteOptions = {},
): ReconcileResult {
  if (!HUMAN_ACTOR.test(actor)) {
    return refuse(
      "actor-not-human",
      `reconcile is human-only: it records what a person established about an execution whose outcome the runtime could not observe, and an agent-attested resolution would be the executing party reporting on itself. The actor must match human:<id>, got ${JSON.stringify(actor)}.`,
    );
  }
  if (note.trim().length === 0) {
    return refuse(
      "actor-not-human",
      `reconcile requires a non-empty note: the record's value is the evidence behind it, and an unexplained resolution of an unknown outcome cannot be told apart from a guess`,
    );
  }

  const read = readVerifiedRecords(
    logPath,
    options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir },
  );
  if (!read.ok) return fromReadRefusal(read);

  const cycle = executionCustody(read.records).find((entry) => entry.actionKey === actionKey);
  if (cycle === undefined || cycle.indeterminateSeq === null) {
    return refuse(
      "not-indeterminate",
      `action ${actionKey} has no execution.indeterminate record, so there is no unknown outcome to resolve. A started execution with no outcome at all is a dangling execution and is closed with \`approval execution resolve\`.`,
    );
  }
  if (cycle.state === "reconciled") {
    return refuse(
      "already-reconciled",
      `action ${actionKey}'s indeterminate outcome at seq ${cycle.indeterminateSeq} was already reconciled at seq ${String(cycle.closedSeq)}; a second resolution would be a second answer to a question a person already answered, and neither record is rewritten`,
      { seq: cycle.closedSeq ?? cycle.indeterminateSeq },
    );
  }

  const task = cycle.task;
  if (task === null || task.length === 0) {
    // Unreachable through the real append path: event.schema.json requires
    // `task` on every execution event. Kept as a fail-closed backstop.
    return refuse(
      "not-indeterminate",
      `the execution.started record for ${actionKey} at seq ${cycle.seq} names no task; the reconciliation event requires one`,
      { seq: cycle.seq },
    );
  }

  const appended = append(
    logPath,
    {
      ts: tick(options),
      event: "execution.reconciled",
      actor,
      task,
      action_key: actionKey,
      payload: {
        indeterminate_seq: cycle.indeterminateSeq,
        resolution,
        note,
        attested_by_human: true,
      },
    },
    options,
    // Compare-and-append: the "is there an unreconciled indeterminate here"
    // check above was made against the log ending exactly at this head, so two
    // reconcilers of one record cannot both land.
    read.head,
  );
  if (!appended.ok) return appended;

  return {
    ok: true,
    record: appended.record,
    resolution,
    task,
    indeterminateSeq: cycle.indeterminateSeq,
  };
}

// ---------------------------------------------------------------------------
// custody
// ---------------------------------------------------------------------------

/**
 * What the log knows about one started execution (APRV-120).
 *
 * The word is custody rather than status because the question is not "did it
 * work" but "who is holding this, and what may still be done with it". Five
 * states, and the two that are easy to confuse are the reason the vocabulary
 * exists:
 *
 * - `settled` — an `execution.completed` or `execution.failed` closed it. The
 *   runtime watched the outcome and wrote down what it saw.
 * - `open` — a start with no outcome, written by a runtime that MEANT to watch
 *   one. This is the dangling execution: a crash between `execution.started`
 *   and its outcome, repairable by a person with `execution resolve`. It is
 *   debris, and `approval status` says so.
 * - `delegated` — a start carrying `payload.execution: "harness"` (APRV-117,
 *   APRV-141). **Terminal by design, and never debris.** The harness runs the
 *   command and this runtime never observes an exit status, so no outcome event
 *   will ever follow; the record is complete as written. Reporting these as
 *   dangling — which is what happened before this state existed, to every
 *   harness execution in the reference repository's own log — trains operators
 *   to ignore the one list that is supposed to mean something.
 * - `indeterminate` — an `execution.indeterminate`: the side effect was
 *   attempted and nobody knows whether it committed. The token is spent and the
 *   key is burned, and a re-run is refused, because a retry against an unknown
 *   outcome is a blind double-execution.
 * - `reconciled` — a person established which it was, and said so in an
 *   `execution.reconciled` that sits beside the indeterminate record rather
 *   than over it.
 */
export const CUSTODY_STATES = [
  "settled",
  "open",
  "delegated",
  "indeterminate",
  "reconciled",
] as const;

export type CustodyState = (typeof CUSTODY_STATES)[number];

/** Where an indeterminate outcome's unknowing began. Closed (schema §8). */
export const INDETERMINATE_REASONS = ["act-threw"] as const;
export type IndeterminateReason = (typeof INDETERMINATE_REASONS)[number];

/** What a reconciliation established. Closed, and the two are distinct. */
export const RECONCILE_RESOLUTIONS = ["executed", "not-executed"] as const;
export type ReconcileResolution = (typeof RECONCILE_RESOLUTIONS)[number];

export function isIndeterminateReason(value: unknown): value is IndeterminateReason {
  return typeof value === "string" && (INDETERMINATE_REASONS as readonly string[]).includes(value);
}

export function isReconcileResolution(value: unknown): value is ReconcileResolution {
  return typeof value === "string" && (RECONCILE_RESOLUTIONS as readonly string[]).includes(value);
}

/** One action key's latest execution cycle, and what may still be done with it. */
export interface ExecutionCustody {
  actionKey: string;
  task: string | null;
  state: CustodyState;
  /** The `execution.started` record's timestamp, position and actor. */
  ts: string;
  seq: number;
  actor: string;
  /** The closing record's position: the outcome, or the reconciliation. */
  closedSeq: number | null;
  /** The `execution.indeterminate` record's position, when there is one. */
  indeterminateSeq: number | null;
  /** Its closed reason, when there is one. */
  reason: IndeterminateReason | null;
  /** What a reconciliation established, when `state` is `reconciled`. */
  resolution: ReconcileResolution | null;
}

/** An execution that began and whose outcome the log does not know. */
export interface DanglingExecution {
  actionKey: string;
  task: string | null;
  /** The `execution.started` record's timestamp and position. */
  ts: string;
  seq: number;
  actor: string;
}

/** Does this `execution.started` record say the harness ran the command? */
function isDelegatedStart(record: EventRecord): boolean {
  return payloadOf(record)["execution"] === "harness";
}

/**
 * The custody state of every started execution, in log order.
 *
 * Pure: no I/O, no clock. Per action key, only the **latest cycle** counts — a
 * start followed by an outcome is closed, and a later start reopens the key.
 * (The gate refuses a second start for a key anyway; this function does not
 * assume that, because a projection that only works on well-formed logs is a
 * projection that goes quiet exactly when something has gone wrong.)
 */
export function executionCustody(records: EventRecord[]): ExecutionCustody[] {
  const cycles = new Map<string, ExecutionCustody>();
  for (const record of records) {
    const actionKey = record.action_key;
    if (typeof actionKey !== "string" || actionKey.length === 0) continue;

    if (record.event === "execution.started") {
      cycles.set(actionKey, {
        actionKey,
        task: record.task ?? null,
        // The marker is read once, here: a harness start is complete as
        // written, and every later reader asks this projection rather than
        // re-deriving the rule from a payload field.
        state: isDelegatedStart(record) ? "delegated" : "open",
        ts: record.ts,
        seq: record.seq,
        actor: record.actor,
        closedSeq: null,
        indeterminateSeq: null,
        reason: null,
        resolution: null,
      });
      continue;
    }

    const cycle = cycles.get(actionKey);
    if (cycle === undefined) continue;

    if (record.event === "execution.completed" || record.event === "execution.failed") {
      cycle.state = "settled";
      cycle.closedSeq = record.seq;
      continue;
    }
    if (record.event === "execution.indeterminate") {
      const reason = payloadOf(record)["reason"];
      cycle.state = "indeterminate";
      cycle.closedSeq = record.seq;
      cycle.indeterminateSeq = record.seq;
      cycle.reason = isIndeterminateReason(reason) ? reason : null;
      continue;
    }
    if (record.event === "execution.reconciled") {
      const resolution = payloadOf(record)["resolution"];
      cycle.state = "reconciled";
      cycle.closedSeq = record.seq;
      cycle.resolution = isReconcileResolution(resolution) ? resolution : null;
    }
  }
  return [...cycles.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * Executions that started, were meant to be watched, and never finished.
 *
 * This is the state a crash between `execution.started` and its outcome leaves
 * behind, and it is reported as itself: not as completed, not as failed, not as
 * clean. `approval status` lists it; `approval queue` does not, because nobody
 * is being asked to decide anything.
 *
 * A `delegated` start is NOT here (APRV-120). The harness ran the command and
 * this runtime never sees an exit status, so its record was never going to gain
 * an outcome; listing it as debris says something false about a log that is
 * exactly right.
 */
export function danglingExecutions(records: EventRecord[]): DanglingExecution[] {
  return executionCustody(records)
    .filter((cycle) => cycle.state === "open")
    .map(({ actionKey, task, ts, seq, actor }) => ({ actionKey, task, ts, seq, actor }));
}

/**
 * Executions whose side effect was attempted and whose outcome nobody knows,
 * and which no one has reconciled yet.
 *
 * Distinct from {@link danglingExecutions} in what it asks of a person. A
 * dangling execution needs someone to look at what the runtime did; an
 * indeterminate one needs someone to establish, from the relying party's own
 * evidence, whether the effect happened at all. Both are debris and both make
 * `approval status` unhealthy; only one of them is repaired with
 * `execution resolve`.
 */
export function indeterminateExecutions(records: EventRecord[]): ExecutionCustody[] {
  return executionCustody(records).filter((cycle) => cycle.state === "indeterminate");
}
