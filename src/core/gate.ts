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
 * and nothing is written.
 *
 * Every writer of this module then re-derives and tries again, bounded
 * (APRV-150 for the two harness writers, APRV-236 for {@link register},
 * {@link request}, {@link decide}, {@link withdraw} and
 * {@link finishHarnessExecution}): see {@link withHeadMovedRetry} and
 * `core/head-retry.ts` for why a lost race is not a verdict, and why the retry
 * is a new read plus new checks plus a new compare-and-append rather than a
 * second attempt at the same write. {@link expire} is the one exception, and it
 * needs none: it is materialisation the daemon's next tick performs again.
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

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  ATTESTATION_REFUSAL,
  attestationRefusal,
  checkAttestationOfBytes,
  isPolicySha256,
  POLICY_HASH_FIELD,
  unreadablePolicyStatus,
  type AttestationRefusalDetail,
} from "./attest.js";
// Type-only, deliberately: the vocabulary is defined once, in the module that
// owns the projection over it, and importing it as a value here would put a
// runtime edge from the gate to the audit module for four string literals.
import type { Reaction } from "./audit.js";
import { evaluateBudgetsWithTask, type BudgetScope, type BudgetVerdict } from "./budgets.js";
import {
  evaluateIntakeLimits,
  intakeRefusalOf,
  type IntakeScope,
  type IntakeVerdict,
} from "./intake-limits.js";
import { tick, type ClockOptions } from "./clock.js";
import { readTaskFile } from "./frontmatter.js";
import { attemptsOf, withHeadRetry } from "./head-retry.js";
import {
  appendEvent,
  type AppendError,
  type AppendOptions,
  type EventInput,
  type EventRecord,
  type LogHead,
} from "./log.js";
import { HARNESS_TASK_PREFIX, harnessLoopFloor, isLoopEscalated } from "./loop.js";
import { normalizeUsd, usdOrZero, type UsdInput } from "./money.js";
import { isPayloadHash, payloadHash as hashOfPayload } from "./payload.js";
import { loadPayload, payloadStoreDirFor, storePayload } from "./payload-store.js";
import {
  loadPolicyText,
  policyUnreadable,
  POLICY_FILENAMES,
  tokenDeliveryOf,
  type Autonomy,
  type PolicyLoadResult,
} from "./policy-load.js";
import { humanOnlyRefusal, resolve, type Resolution } from "./policy-match.js";
import {
  LIVE_SELECTION,
  resolveLiveSelector,
  type LiveSelectorUnavailableReason,
} from "./sampler.js";
import {
  forgetPrivateKey,
  isRecipientKey,
  keyStoreDirFor,
  mintRecipientKeypair,
  RECIPIENT_KEY_FIELD,
  sealToken,
  SEALED_TOKEN_FIELD,
  SELF_DELIVERY_FIELD,
  writePrivateKey,
} from "./seal.js";
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
import { displayHashOf, DISPLAY_HASH_FIELD } from "./wysiwys.js";

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
 * Does an `approvers` list name this actor (APRV-137, amended SPEC.md §5.2)?
 *
 * The spelling a valid policy uses is the bare id (`alice`), which is what
 * `policy.schema.json` admits and what the keys of the top-level `approvers`
 * map are: its `identifier` pattern is lowercase alphanumerics with `_` and
 * `-`, so a `human:` prefix inside a roster is a schema violation and never
 * reaches here. The whole actor string is compared as well, which can only ever
 * match a loader more permissive than the shipped schema; it widens nothing for
 * a valid policy, because `alice` and `human:alice` are the same person under
 * either comparison.
 *
 * Comparison is exact and case-sensitive. An identity that matched under
 * folding would let `human:Alice` and `human:alice` be one approver on one host
 * and two on another, and a roster is a list of people rather than a pattern
 * language. An empty list names nobody and therefore matches nobody;
 * `approvers` carries `minItems: 1`, so a valid policy cannot produce one, and
 * that branch stays a fail-closed backstop rather than a reachable path.
 */
function namesApprover(approvers: readonly string[], actor: string): boolean {
  const bare = actor.startsWith("human:") ? actor.slice("human:".length) : actor;
  return approvers.some((name) => name === actor || name === bare);
}

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
   * The approver's queue is at the ceiling the policy declared (SPEC.md §5.2's
   * `limits.max_pending`, per class or on a `budgets` scope; APRV-173).
   *
   * A limit on ATTENTION rather than on money, which is why it is its own code
   * and why it fires where it does: after the legality checks that say whether
   * this request may exist at all, and before budgets, which are about the
   * world's exposure rather than the human's. An agent that floods the queue
   * with cheap in-budget requests spends nothing and still defeats the gate,
   * because an approver facing two hundred prompts stops reading them and
   * starts clearing them.
   *
   * Nothing is appended, deliberately, and this is the one refusal shaped
   * differently from `budget-exceeded` on purpose (Carter's approved reading,
   * 2026-08-31). A `budget.exceeded` record exists because a budget refusal is
   * a fact about a commitment audit must be able to reconstruct; a record per
   * refused flood request would hand the flooder the log growth it was refused
   * the queue for. `error.limits` carries the failing verdicts, and the
   * requests that WERE admitted are all in the log to count from.
   *
   * Transient in the sense that matters to a caller: the queue drains when a
   * human decides, a requester withdraws, or a TTL lapses. Retrying at once
   * gets the same answer.
   */
  "queue-full",
  /**
   * This origin created more requests in the last hour than the policy's
   * `limits.requests_per_hour` allows (SPEC.md §5.2, APRV-173).
   *
   * Distinct from `queue-full`, and the distinction is the repair. That code
   * says the queue is full whoever is asking, so the caller waits for an
   * approver; this one says the caller's own recent volume is the problem, so
   * it slows down. Origin is the requesting actor at v0.1, which the runtime
   * assigns rather than the caller (see `core/intake-limits.ts`), so a
   * requester cannot re-label itself into a fresh hour.
   *
   * Counted over request CREATION, not over live requests: a request that was
   * answered a minute after it was made still spent the origin's share of the
   * hour. A ceiling that forgot each request as it was answered could be
   * cleared by withdrawing every request as fast as it was made.
   *
   * Nothing is appended, for the same reason `queue-full` appends nothing.
   */
  "rate-limited",
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
   *
   * Since APRV-146 the same code answers the same fact at the harness write
   * boundary: {@link startHarnessExecution} refuses a start that names no
   * payload hash, and {@link consumeHarnessGrant} refuses a spend that presents
   * none (or a grant whose request recorded none). The fact is identical at both
   * ends — a binding is required here and there is none — and the repair is the
   * same shape: state the bytes, or request the action again so the record does.
   * `payload-mismatch` stays the code for bytes that are stated and wrong.
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
   * The action's class resolves to `human-only` (APRV-185, amended SPEC.md
   * §5.2): the policy reserves it to human hands, and a person performs it
   * outside agent execution entirely.
   *
   * Its own code, and distinct from every rejection, because nobody decided
   * anything. A `reject` is a human's answer to a question that was legitimately
   * asked; this is the policy answering that the question does not arise — there
   * is no approval to seek, no approver to ask, and no grant that could be
   * recorded. An agent that read a rejection would sensibly try again with a
   * better summary; an agent that reads this must stop asking and hand the
   * action to a person.
   *
   * Every verb of this module that could mint or withdraw authority returns it:
   * {@link request}, {@link decide} in all three of its decisions, and
   * {@link consumeHarnessGrant}. Grant is the obvious one. Reject and revoke are
   * refused too, and the reason is stated plainly rather than assumed: those
   * verbs WITHDRAW authority, and withdrawing authority that cannot exist would
   * write a decision record about a human-only class into the log, which reads
   * afterwards as a class the gate transacts in. A pending request that a policy
   * amendment has since raised to `human-only` is not stranded by that: it
   * authorizes nothing, no token can be minted for it and no run can spend it,
   * and its requester withdraws it (`withdraw`) or its TTL lapses (`expire`).
   * Neither of those verbs is refused here, deliberately — they are the exits
   * from a question nobody may answer.
   *
   * Evaluated immediately after the check that establishes a request exists at
   * all, and before every other check on the path, on all three verbs. A class
   * that cannot be transacted in is answered before any question about who may
   * decide it, under which policy hash, or against which budget.
   */
  "class-human-only",
  /**
   * Loop safety escalated the task to manual (SPEC.md §10.2, APRV-18): three
   * consecutive `execution.failed` events. Only the non-manual paths are
   * refused — see {@link request}.
   */
  "loop-escalated",
  /**
   * A harness outcome was reported for an action key whose `execution.started`
   * carries no `execution: "harness"` marker (APRV-145).
   *
   * The mirror image of `core/execute.ts`'s `execution-delegated`, and the pair
   * is what keeps the two write surfaces from overlapping by one record. That
   * code refuses a HUMAN recovery verb over a harness start; this one refuses a
   * HARNESS report over a start this runtime is watching itself. An untrusted
   * report that could close an `approval run` execution would be reporting an
   * exit code the runtime was about to observe for itself, and the outcome the
   * log kept would be whichever one landed first.
   */
  "not-delegated",
  /**
   * Every harness-marked start the reported tool call opened already carries an
   * outcome (APRV-145). An execution has exactly one, and a second report would
   * be a second answer about one command — including a `completed` written over
   * a `failed`, which is a streak cleared by repetition rather than by recovery.
   *
   * Named for the fact rather than for the reporter, and spelled exactly as
   * `core/execute.ts` spells the same fact, so a reader who has met one has met
   * both.
   */
  "already-finished",
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
  /**
   * A grant was recorded by a person the resolved rule's `approvers` list does
   * not name (APRV-137, amended SPEC.md §5.2).
   *
   * Distinct from `actor-not-human`, and the distinction is the repair. That
   * code says the actor is not a person at all, and the fix is to run the verb
   * as one. This one says the actor IS a person and is not one the policy
   * named for this class, so the fix is to ask a named approver. Before this
   * code the list was parsed, surfaced by `policy explain`, and enforced
   * nowhere: a policy writing `approvers: [alice]` on `financial.spend` bound
   * nothing while its author believed it bound the class.
   *
   * Scope, and its limits. The check is defense in depth inside the trust
   * boundary §11 states plainly: human identity in v0.1 is config-declared, so
   * anyone who can set that configuration can present any name on this list.
   * What it defends is the honest mistake and the wrong-approver routing, not
   * an actor choosing whose name to wear. The check binds `grant` alone;
   * reject and revoke withdraw authority rather than confer it, and
   * restricting them would leave a request standing, or an authorization live,
   * because the wrong person tried to end it.
   */
  "actor-not-approver",
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
   * The rendered semantic diff of a proposed policy is larger than a channel
   * prompt can show whole (APRV-109, amended SPEC.md §10.3).
   *
   * A refusal rather than a truncation, and its own code so a caller can tell
   * "this amendment is too big for a phone" from every other reason a proposal
   * fails. A prompt that showed two thirds of a policy change would collect a
   * signature for the third it did not show; the repair is to read the diff at
   * a terminal and attest there, which the message names.
   */
  "diff-too-large",
  /** No `policy.proposed` record at the named seq (APRV-109). */
  "proposal-not-found",
  /**
   * The policy bytes changed after the attestation prompt was rendered
   * (APRV-109).
   *
   * Distinct from `policy-drift`, which is about a pending approval routed
   * under superseded rules. This one says the human is looking at a hash the
   * file no longer has, so attesting would name bytes the approver was never
   * shown. Nothing is appended and the amendment is proposed again.
   */
  "proposal-stale",
  /**
   * An attestation was proposed for a policy file that already matches its
   * attestation (APRV-109). There is no amendment to sign, and a prompt for one
   * would ask a human to re-attest bytes already in force.
   */
  "policy-already-attested",
  /**
   * A grant carrying `reaction: loved` or `reaction: disliked` and no non-blank
   * note (APRV-239, amended SPEC.md §5.2).
   *
   * Grant only. Evaluated with the other checks that read nothing, and nothing
   * is appended. `reject` and `revoke` accept no reaction at all, which is a
   * usage error at the verb rather than a member of this union: their reason IS
   * their note, and there is no second field for a grade to sit in.
   *
   * Its own code rather than the audit path's `note-required` because a caller
   * branching on a gate refusal is branching on this union, and the two verbs
   * are answered by two different modules. The message names `--note`, which is
   * the whole of the fix.
   */
  "reaction-note-required",
  /**
   * The append itself failed; `append` carries the underlying error. Its
   * `code` is `head-moved` when the log grew between this module's read and its
   * append: every check that authorized the write was made against an older log,
   * so nothing was written. Since APRV-236 this code reaches a caller only after
   * the bounded read-check-append retry is spent (`core/head-retry.ts`), and its
   * message says how many attempts were made. A single lost race is no longer
   * reported at all: it is re-derived, and the answer the fresh log supports is
   * what the caller receives.
   */
  "append-failed",
  /**
   * A `delivery: "self"` request could not publish a delivery address (APRV-211):
   * the ephemeral private key could not be written beside the log.
   *
   * Fail closed, and unlike APRV-105's ordinary sealed path, which drops the
   * convenience and leaves the paste path standing. There is no paste path
   * here — the requester is a process, not a terminal — so a request admitted
   * without an address would spend a human's decision on an authorization
   * nothing can ever open. Nothing is appended; the next attempt asks again.
   */
  "token-delivery-unavailable",
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
  /**
   * The failing request-volume verdicts, when `code` is `queue-full` or
   * `rate-limited` (APRV-173). Separate from `verdicts` because they are a
   * different measurement with a different shape, and because a caller that
   * branched on `verdicts` to read money out of a budget refusal must not find
   * queue counts there.
   */
  limits?: IntakeVerdict[];
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
  /**
   * Where to find `APPROVAL.md`. `dir`/`file` have the same semantics as
   * `loadPolicy`.
   *
   * `read` is the one read seam a gate operation uses to fetch the policy bytes
   * (APRV-142), defaulting to `readFileSync`. It exists so a test can simulate
   * a file swapped mid-operation and prove the swap cannot land: the seam is
   * called exactly once per gate operation, so a reader that returns different
   * bytes on its second call has no second call to return them to. It is not a
   * widening of anything — a caller holding `GateOptions` can already name any
   * file through `file`.
   */
  policy?: { dir?: string; file?: string; read?: (path: string) => Uint8Array };
  /** Lock tuning for the append path. */
  append?: AppendOptions;
  /**
   * How many times a writer of this module re-derives its verdict after a
   * `head-moved` refusal, at most `head-retry.ts`'s `HEAD_MOVED_ATTEMPTS`
   * (APRV-150, APRV-236, {@link withHeadMovedRetry}).
   *
   * Only ever lowers the bound. `1` is the pre-APRV-150 behaviour — one read,
   * one set of checks, one append, and a lost race is reported as a refusal —
   * which is what a test pins the old shape with. A larger number, a zero or a
   * fraction is ignored in favour of the runtime's own value: the ceiling is not
   * a caller's to raise.
   */
  retryOnHeadMoved?: number;
  /**
   * Where payload material is stored (APRV-28). Defaults to the convention
   * `core/payload-store.ts` defines: `.approval/payloads/`, beside the log.
   */
  payloadStoreDir?: string;
  /**
   * Where per-request private keys live (APRV-105). Defaults to the convention
   * `core/seal.ts` defines: `.approval/keys/`, beside the log. Under the default
   * `token_delivery: manual` nothing here is ever written or read.
   */
  keyStoreDir?: string;
  /**
   * The environment the operator's sampling secret is read from (APRV-127).
   * Injected by tests; defaults to `process.env`. The secret is never read from
   * the policy file or from anywhere else inside the repository.
   */
  env?: NodeJS.ProcessEnv;
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

/**
 * The policy bytes one gate operation decides under — read exactly once
 * (APRV-142).
 *
 * The gate used to read `APPROVAL.md` twice per operation: once inside
 * `checkAttestation` to hash it, and again inside `loadPolicy` to parse it. The
 * red team measured the window (946 of 3000 probes saw the file change between
 * the two reads) and never won it, but "narrow" is not a property, and the two
 * reads could in principle attest one policy and enforce a different one. One
 * read removes the window rather than shrinking it: there is no second read for
 * a swap to land in.
 *
 * `bytes` is `null` only when the read itself failed, which every consumer
 * turns into a refusal — an unreadable policy is never a pass.
 */
interface PolicyRead {
  path: string;
  bytes: Uint8Array | null;
  cause: string | null;
}

/** Read the policy file once, through {@link GateOptions.policy}'s seam. */
function readPolicyOnce(options: GateOptions): PolicyRead {
  const path = policyPathOf(options);
  const read = options.policy?.read ?? readFileSync;
  try {
    return { path, bytes: read(path), cause: null };
  } catch (cause) {
    return {
      path,
      bytes: null,
      cause: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/**
 * Parse the bytes already read, without touching the filesystem again.
 *
 * Fails closed on an unreadable read, exactly as `loadPolicy` would have: the
 * result is a `file-missing` failure, and `resolve` reads that as all-manual.
 */
function parsePolicy(read: PolicyRead, options: GateOptions): PolicyLoadResult {
  if (read.bytes === null) {
    return policyUnreadable(read.path, read.cause ?? "unknown error");
  }
  return loadPolicyText(
    read.path,
    Buffer.from(read.bytes).toString("utf8"),
    options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir },
  );
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
 * The hash is the same value `approval policy attest` recorded and, since
 * APRV-142, provably the same bytes {@link parsePolicy} parses: both take the
 * one {@link PolicyRead} the operation performed. It names the exact rules this
 * operation is being decided under. Callers pin it onto the event they write:
 * an operation that could not be authorized without an attested policy should
 * say, on the record, which attested policy authorized it.
 */
function requireAttestation(
  records: EventRecord[],
  read: PolicyRead,
): { ok: true; sha256: string } | GateRefusal {
  const status =
    read.bytes === null
      ? unreadablePolicyStatus(read.path, read.cause ?? "unknown error")
      : checkAttestationOfBytes(records, read.bytes);
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
 * The request-volume scope (APRV-173): the same three fields the budget scope
 * carries, read from the same resolution and the same load.
 *
 * Identical by construction rather than by coincidence. A queue ceiling written
 * on a rule must be attributed by that rule's pattern for the reason SPEC.md
 * §5.2 gives budgets: one `financial.*` rule is one ceiling shared by every
 * class it governs, and a limit taken from a rule that did not win would be
 * compared against a window it does not scope. A policy that fails to load
 * offers no limits at all here, exactly as it offers no budgets: everything is
 * `manual` in that case, and the human gate is the ceiling.
 */
function intakeScopeOf(load: PolicyLoadResult, resolution: Resolution): IntakeScope {
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
// The bounded head-moved retry (APRV-150, APRV-236)
// ---------------------------------------------------------------------------

/**
 * Run one whole gate operation, and re-run it from the top on `head-moved`.
 *
 * The mechanism, the bound and the reasoning all live in `core/head-retry.ts`
 * and are shared with `core/execute.ts` and `core/gate-window.ts`. There is one
 * implementation of this in the runtime; this is the adapter that reads the
 * ceiling a caller asked for out of {@link GateOptions}.
 *
 * `attempt` is the ENTIRE operation, from `readGateRecords` to the append: a new
 * read of the verified log, a new read of the policy, a fresh attestation check,
 * a fresh derivation, fresh escalation, single-use, intake and budget checks, and
 * a new append against the head that the new read observed. Nothing is carried
 * across an attempt except the caller's inputs, so nothing stale can authorize a
 * write, and a verdict the interleaved record changed is the verdict enforced.
 */
function withHeadMovedRetry<T extends { ok: true } | GateRefusal>(
  options: GateOptions,
  attempt: () => T,
): T {
  return withHeadRetry(attemptsOf(options.retryOnHeadMoved), attempt);
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
  /** Canonical decimal USD string (APRV-121); see `core/money.ts`. */
  est_cost_usd?: string;
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
    const declaredCost = normalizeUsd(item["est_cost_usd"]);
    if (declaredCost !== null) action.est_cost_usd = declaredCost;
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
  return withHeadMovedRetry(options, () => attemptRegister(logPath, source, actor, options));
}

/**
 * One whole registration: resolve the source, validate the envelope, read the
 * log, check for a prior registration and a cross-task key collision, append.
 *
 * The body is APRV-236's only change to it: every line was here before, and the
 * retry re-enters at the top, so the double-registration and key-collision scans
 * are re-run against the fresh head rather than replayed from the stale one. A
 * task someone else registered in the window is refused `task-already-registered`
 * by the fresh read, which is the answer the log now supports.
 */
function attemptRegister(
  logPath: string,
  source: RegisterSource,
  actor: string,
  options: GateOptions,
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
    const declaredCost = normalizeUsd(item["est_cost_usd"]);
    if (declaredCost !== null) action.est_cost_usd = declaredCost;
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
  /** Canonical decimal USD string (APRV-121); a JSON number is read as the historical form. */
  est_cost_usd?: UsdInput;
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
  /**
   * The caller has established that loop safety floors this action to `manual`
   * for this invocation (APRV-145, amended SPEC.md §10.2).
   *
   * The THIRD way into the manual path, beside a class that resolves manual and
   * an action the APRV-127 live draw selected, and it works exactly as that
   * second one does: the non-manual branch is skipped and everything below it
   * runs unchanged, so nothing in the manual path knows or asks how the action
   * got here. The flag is a fact the caller computed from the log
   * (`core/loop.ts`'s `harnessLoopFloor`) and it can only ever ADD scrutiny: a
   * caller that sets it wrongly asks a human about a command that did not need
   * one, and a caller that omits it is refused at the write boundary by
   * {@link startHarnessExecution}, which re-checks the same streaks.
   */
  loopFloor?: boolean;
  /**
   * `"self"` when the requesting process will consume its own grant, in its own
   * process, and no other principal needs the raw token (APRV-211).
   *
   * The daemon's cadence advance is the case it exists for. The daemon is the
   * requester AND the executor: it asks the gate, a human answers on the phone,
   * and the same process spends the answer through {@link startExecution}'s
   * APRV-105 sealed path. Before this field, the grant handed its raw token back
   * to the GRANTING surface — the Telegram listener's terminal — which printed
   * it under "single-use · stored nowhere · copy it now", the APRV-166 relay
   * path meant for a requester in another process. Nobody was ever going to
   * carry that value anywhere; it was a live credential rendered for a principal
   * that was not the requester, which SPEC.md §11.1's raw-secrets invariant
   * exists to prevent.
   *
   * So it does two things and nothing else. {@link request} mints the sealed
   * delivery address for this action REGARDLESS of `defaults.token_delivery`,
   * because there is no terminal on the other end of the paste path and a
   * request with no address would be an authorization nobody could open; and
   * {@link decide} withholds the raw token from its own return value, so no
   * granting surface has one to print. The token still exists, still binds to
   * the payload bytes, is still single-use, and is still minted only by a
   * human's grant. Nothing here reduces scrutiny: it removes a reader, not a
   * check.
   *
   * Refused when the key cannot be written (`token-delivery-unavailable`), which
   * is the fail-closed direction: a self-delivered grant nobody can open would
   * spend a human's decision on an authorization that can never execute.
   */
  delivery?: "self";
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

/**
 * Why a `supervised-live` action was, or was not, sent to the human gate
 * (amended SPEC.md §5.2/§6.3, APRV-127).
 *
 * Returned to the caller and **never written to the log**. See
 * {@link liveVerdict} for why the log carries no trace of the selection.
 */
export interface LiveVerdict {
  /** The class's declared `live_rate`, as `policy-match.ts` resolved it. */
  rate: number;
  /** True when this action must stop for a human before it may execute. */
  gated: boolean;
  /**
   * Machine-readable and closed, because a supervisor branches on it:
   *
   * - `selected` — the HMAC fell under the rate. This is the fraction working.
   * - `not-selected` — it did not. The action proceeds, and still enters the
   *   retrospective pool.
   * - `payload-hash-absent` — the registration declared no `payload_hash`, so
   *   there is nothing to select over. Gated: an action whose bytes nobody
   *   named cannot be shown to have been fairly sampled, and the manual path
   *   refuses it by name a moment later.
   * - the three {@link LiveSelectorUnavailableReason}s — no usable secret.
   *   Gated. See `core/sampler.ts` on why live selection fails closed where
   *   retrospective sampling fails open.
   */
  reason: "selected" | "not-selected" | "payload-hash-absent" | LiveSelectorUnavailableReason;
  /** The algorithm an operator holding the secret recomputes to check this. */
  selection: typeof LIVE_SELECTION;
  /** The NAME of the secret's environment variable. Never the secret. */
  secretEnv: string | null;
}

/**
 * The LATEST `approval.requested` for an action key, or an empty stand-in.
 *
 * Latest, because an action key may be requested again after a rejection or an
 * expiry, and the grant being recorded answers the live cycle. Returns a bare
 * object rather than `null` so the one caller can read a field off it without a
 * branch; there is nothing on it to mistake for a real value.
 */
function requestRecord(records: EventRecord[], actionKey: string): EventRecord {
  let found: EventRecord | null = null;
  for (const record of records) {
    if (record.event === "approval.requested" && record.action_key === actionKey) found = record;
  }
  return found ?? ({ payload: {} } as EventRecord);
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
      /**
       * The live-selection verdict, for a `supervised-live` class only
       * (APRV-127). Absent for every other class: there was no fraction to fall
       * inside or outside of.
       */
      live?: LiveVerdict;
    }
  | GateRefusal;

/**
 * Decide whether one `supervised-live` action stops at the human gate.
 *
 * Selected **iff** `HMAC-SHA-256(operator secret, payload_hash)`, read as a
 * uniform value in [0, 1), falls below the class's `live_rate` — the identical
 * construction `core/sampler.ts` already uses for retrospective sampling, reused
 * rather than reinvented so there is one selection mechanism in this runtime and
 * one thing to get right.
 *
 * The four properties the design asks for, and where each comes from:
 *
 * - **Deterministic.** HMAC over the payload hash is a pure function. Same
 *   secret, same bytes, same rate, same verdict — on every machine, forever.
 * - **Agent-unpredictable.** The secret is operator-held and named only by
 *   `audit.sampling_secret_env`. An agent that cannot read it cannot compute its
 *   own luck, and seeding from content alone is forbidden by SPEC.md §5.2 for
 *   exactly that reason.
 * - **No re-roll.** The input is the payload hash, not a nonce, a timestamp, or
 *   an attempt counter. A refused, retried, or duplicated request over identical
 *   bytes gets identical treatment, so "ask again until it comes up unsampled"
 *   is not a strategy — there is nothing to re-roll. Changing the bytes changes
 *   the verdict, but bytes are the action, so that is a different request.
 * - **Post-hoc verifiable.** An operator holding the secret can recompute the
 *   verdict for any request in the log from its `payload_hash` and the `live_rate`
 *   of the policy the request pinned in `policy_sha256`.
 *
 * ## Nothing about the selection is written to the log
 *
 * A sampled action's `approval.requested` is byte-for-byte what a `manual`
 * class's would have been: same fields, same values, same order. That is
 * deliberate, and it is what "follows the manual path bit for bit" means at the
 * level of the record.
 *
 * Two reasons. First, the selection VALUE in the log would be a free oracle: an
 * agent that could read a corpus of (payload hash, value) pairs learns about the
 * secret it is not supposed to hold. `core/audit.ts` omits it from `audit.sampled`
 * for the same reason. Second, a "this one was sampled live" marker would be a
 * distinction a channel, an approver, or a later reader could act on — treating
 * the sampled request as a lesser question than a manual one — and the whole
 * value of the mechanism is that a sampled action is answered exactly as a
 * manual one is. The verdict travels to the CALLER, which needs it to explain
 * itself on stderr, and stops there.
 *
 * Nothing is lost to audit: the verdict is recomputable from the request's own
 * `payload_hash` plus the secret, which is strictly better evidence than a
 * self-reported field, because it cannot be forged by whoever wrote the record.
 */
function liveVerdict(
  load: PolicyLoadResult,
  resolution: Resolution,
  payloadHash: string | null,
  env: NodeJS.ProcessEnv | undefined,
): LiveVerdict {
  const rate = resolution.liveRate ?? 1;
  const selector = resolveLiveSelector(load, env ?? process.env);
  if (!selector.available) {
    return {
      rate,
      gated: true,
      reason: selector.reason,
      selection: LIVE_SELECTION,
      secretEnv: selector.secretEnv,
    };
  }
  if (payloadHash === null) {
    return {
      rate,
      gated: true,
      reason: "payload-hash-absent",
      selection: LIVE_SELECTION,
      secretEnv: selector.secretEnv,
    };
  }
  const selected = selector.selects(payloadHash, rate);
  return {
    rate,
    gated: selected,
    reason: selected ? "selected" : "not-selected",
    selection: LIVE_SELECTION,
    secretEnv: selector.secretEnv,
  };
}

/**
 * `est_cost_usd` as the budgets contract wants it recorded: always a canonical
 * decimal USD string (APRV-121), `"0"` when the caller declared nothing.
 *
 * A caller may hand in either form — the string this runtime writes, or the
 * JSON number a pre-APRV-121 caller (and a historical record) carries — and
 * both normalize to the one spelling that enters hashed material.
 */
function costOf(value: UsdInput | undefined): string {
  return usdOrZero(value);
}

/**
 * `{ display_hash }` for the material this runtime holds, or `{}` (APRV-119).
 *
 * The material is the caller's, when it supplied any, and otherwise whatever the
 * payload store holds under the declared binding — the same two sources
 * `channels/tagging.ts` renders from, in the same order, so the hash recorded
 * here names the rendering a channel will actually produce. The store is
 * content-addressed and re-verified on every read, so a tampered file answers
 * nothing rather than a rendering of the wrong bytes.
 *
 * Never fatal. A payload that cannot be canonicalized, a store that cannot be
 * read, a file that does not verify: each costs a reader one cross-check, and
 * none of them is a reason to refuse a request that has passed every check that
 * governs authority.
 */
function displayHashField(
  input: RequestInput,
  options: GateOptions,
  logPath: string,
  boundHash: string,
  cls: string,
): Record<string, string> {
  let material: unknown;
  if (input.payload !== undefined) {
    material = input.payload.value;
  } else {
    const loaded = loadPayload(options.payloadStoreDir ?? payloadStoreDirFor(logPath), boundHash);
    if (!loaded.ok) return {};
    material = loaded.value;
  }
  const hash = displayHashOf(material, cls);
  return hash === null ? {} : { [DISPLAY_HASH_FIELD]: hash };
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
 * 3b. **Declaration** (SPEC.md §7, APRV-147), for a `manual` resolution and for
 *    a `supervised-live` one. The log must carry a `task.registered` for the
 *    task and an action with this idempotency key, or the request is refused
 *    `not-registered` / `action-not-registered` and nothing is appended. Before
 *    the live draw and before the binding below, so an undeclared action never
 *    reaches a human's queue, never has the live fraction drawn over a hash it
 *    chose for itself, and hears the real reason rather than
 *    `payload-hash-required`.
 * 4. **Off the manual path, stop — unless the live fraction says otherwise.**
 *    `supervised`/`autonomous` append **no event** (amended SPEC.md §6.3) and
 *    return `proceed: true`. Their budget is charged at `execution.started`,
 *    which APRV-18 appends — checking budgets here as well would charge them
 *    twice or, worse, pass here and fail there. A `supervised-live` class
 *    (APRV-127) draws its declared fraction here: an action the draw selects
 *    falls through into everything below and is treated as `manual` from this
 *    line on, and an action it does not proceeds exactly as before.
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
  return withHeadMovedRetry(options, () => attemptRequest(logPath, input, actor, options));
}

/**
 * One whole intake, from the clock read to the append.
 *
 * Re-entered from the top on a moved head (APRV-236), which re-runs every check
 * above against the fresh log: attestation, the human-only class test, the §7
 * declaration, the live draw, the duplicate-request and single-use scans, the
 * §5.2 intake limits and the budgets. A key someone else requested or started in
 * the window is refused `duplicate-request` or `already-executed` rather than
 * `append-failed`, and the live draw is re-run over the same registered hash, so
 * it selects identically and no attempt can shop for a different answer.
 *
 * Two side effects sit inside the retried cycle and are safe there. The payload
 * store is content-addressed, so a second write of the same bytes is the same
 * file. The recipient keypair is minted per attempt and overwrites the previous
 * attempt's private half at the same path, so the key that survives is always
 * the one whose public half the appended record carries.
 */
function attemptRequest(
  logPath: string,
  input: RequestInput,
  actor: string,
  options: GateOptions,
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

  // One read of the policy file for the whole operation (APRV-142): the same
  // bytes are hashed for attestation and parsed for the decision.
  const policyRead = readPolicyOnce(options);
  const attested = requireAttestation(read.records, policyRead);
  if (!attested.ok) return attested;

  const load = parsePolicy(policyRead, options);
  const resolution = resolve(
    load,
    input.cls,
    input.reversible === undefined ? {} : { reversible: input.reversible },
  );

  // APRV-185, amended SPEC.md §5.2, and the first thing intake asks once the
  // class has an autonomy: a `human-only` class is not requestable. The policy
  // itself answers, so nothing is put in front of a human, nothing is drawn,
  // and nothing is appended — a `human-only` class must never acquire an
  // `approval.requested` record, because such a record is a question in a
  // queue that no approver may answer.
  //
  // Placed above the §7 declaration check deliberately. An unregistered action
  // in a human-only class is refused for the class rather than for the missing
  // registration: registering it would not help, and `not-registered` would
  // send the caller to fix the one thing that cannot make this request valid.
  if (resolution.autonomy === "human-only") {
    return refuse(
      "class-human-only",
      humanOnlyRefusal(
        input.cls,
        `action ${input.actionKey} cannot be requested and no approval.requested was written`,
      ),
    );
  }

  // SPEC.md §7's first invariant, enforced at intake since APRV-147: "an
  // action's class MUST be declared before an execution token can be requested
  // for it". Asked of the LOG, before the live draw, before the binding is
  // derived, and before anything is appended, on every path that can put a
  // question in front of a human or select one to put there.
  //
  // Three things the check buys, in the order they bite:
  //
  // - A request for an action nobody registered can no longer reach a human's
  //   queue. Without it, a caller supplying its own `payload_hash` recorded an
  //   `approval.requested` for a class the log never saw declared, and the
  //   approver was shown a prompt whose class, cost, and summary came from the
  //   requester alone.
  // - The refusal a caller hits is the real one. The registration failure used
  //   to surface as `payload-hash-required`, which names the second-order
  //   symptom and sends the reader to fix the wrong thing. `registeredAction`
  //   answers `not-registered` before `action-not-registered`, and both land
  //   before the binding check below.
  // - The live fraction is drawn over a declared hash or not at all. §5.2's
  //   no-re-roll property rests on the selection input being the registration's
  //   own bytes; over a caller-supplied hash there is nothing to lose, so an
  //   agent could vary what it presents until the draw came up unsampled. An
  //   unregistered action is now refused before `liveVerdict` runs at all.
  //
  // Deliberately not on the plain `supervised`/`autonomous` proceed path: those
  // answers record nothing and mint nothing, and SPEC.md §7 is enforced for them
  // where they acquire consequence, in `core/execute.ts` at start time.
  if (
    resolution.autonomy === "manual" ||
    resolution.supervision === "live" ||
    input.loopFloor === true
  ) {
    const declared = registeredAction(read.records, input.task, input.actionKey);
    if (!declared.ok) return declared;
  }

  // Amended SPEC.md §6.2/§10 (A1): a manual grant binds to bytes. The log's
  // declaration wins over anything the caller passed — `register` wrote it from
  // the envelope, and a request that could name its own hash could approve one
  // payload and execute another, which is the property this exists to remove.
  //
  // Read BEFORE the autonomy branch since APRV-127, because a `supervised-live`
  // class selects over exactly this value. A caller-supplied fallback is
  // accepted here on the same terms the manual path always accepted it, and it
  // cannot be used to steer the selection: an agent that changes the hash it
  // presents changes which bytes it is asking to have approved, and the
  // registration's own declaration wins whenever there is one. Since APRV-147
  // the fallback is reachable only for a REGISTERED action whose declaration
  // carries no hash — the check above has already refused the unregistered
  // case, which is where "the declaration wins" used to have no declaration to
  // win with.
  const payloadHash =
    declaredPayloadHash(read.records, input.task, input.actionKey) ??
    (isPayloadHash(input.payload_hash) ? input.payload_hash : null);

  let live: LiveVerdict | null = null;
  // APRV-145: the loop floor's door into the manual path. It is checked here
  // rather than inside `resolve` for the reason §7's irreversibility floor is
  // applied after class resolution: `resolve` is pure over policy text, and a
  // failure streak is a projection over the log. A floored action skips this
  // whole branch — the per-task `loop-escalated` refusal below included, which
  // would otherwise refuse the very question the floor exists to ask.
  if (resolution.autonomy !== "manual" && input.loopFloor !== true) {
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
    // APRV-127. A `supervised-live` class puts a declared fraction of its
    // actions through the human gate before they run. This is where that
    // fraction is drawn, and the drawing is the LAST check on the non-manual
    // path: loop escalation above already refuses to let an escalated task
    // proceed unsupervised, and asking whether an action is in the live
    // fraction only matters once it would otherwise have been allowed through.
    if (resolution.supervision === "live") {
      live = liveVerdict(load, resolution, payloadHash, options.env);
    }
    if (live === null || !live.gated) {
      // Amended SPEC.md §6.3: no approval.* event exists off the manual path.
      // An UNSAMPLED supervised-live action leaves by exactly this door, so it
      // proceeds as a supervised action always has and enters the retrospective
      // pool on its `execution.started` like any other.
      return {
        ok: true,
        autonomy: resolution.autonomy,
        proceed: true,
        resolution,
        record: null,
        ...(live === null ? {} : { live }),
      };
    }
    // Sampled. Fall through into the manual path — the same code, in the same
    // order, producing the same record. Nothing below this line knows or asks
    // how the action got here.
  }

  if (payloadHash === null) {
    return refuse(
      "payload-hash-required",
      live === null
        ? `action ${input.actionKey} resolves to manual and its registered declaration carries no payload_hash. Amended SPEC.md §6.2 makes the hash MUST for manual actions: an approval binds to the exact bytes it approves, so a request with nothing to bind to would ask a human to authorize a payload that could still change afterwards. Declare payload_hash (SHA-256 over the RFC 8785 canonical serialization of the concrete payload) on the action and register the task again.`
        : `action ${input.actionKey} resolves to supervised-live at rate ${String(live.rate)} and its registered declaration carries no payload_hash, so there is nothing to draw the live fraction over and nothing an approval could bind to. Amended SPEC.md §5.2 selects the live fraction by HMAC over the payload hash precisely so that identical bytes always select identically; an action with no declared bytes is gated rather than waved through, because a sample nobody can reproduce is not a sample. Declare payload_hash (SHA-256 over the RFC 8785 canonical serialization of the concrete payload) on the action and register the task again.`,
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

  // APRV-173, SPEC.md §5.2's request-volume limits, enforced here and nowhere
  // else. Placed AFTER the legality checks above and BEFORE budgets, and both
  // halves of that placement are deliberate.
  //
  // After `duplicate-request` and `already-executed`, because those say the
  // request may not exist at all: a second request for a live action key is
  // refused for being a duplicate rather than for the queue it would have
  // joined, and a caller told `queue-full` about an action that already
  // executed would be sent to wait for a queue to drain instead of to stop.
  //
  // Before budgets, because these limits protect the approver's attention and
  // budgets protect the world's exposure. The cheaper measurement guards the
  // scarcer resource: a flood of in-budget requests passes every budget verdict
  // and still empties the one thing this system cannot refill, which is a
  // human's willingness to read a prompt.
  //
  // Off the manual path this code is unreachable, and correctly so: the
  // `proceed: true` return above happens first. An autonomous or unsampled
  // supervised action appends no `approval.requested` (§6.3), joins no queue,
  // and puts nothing in front of anyone, so a queue ceiling has nothing to
  // measure it against.
  //
  // A refusal here appends NOTHING: no event, no payload file, no recipient
  // key. So a refused request consumes no budget (nothing was authorized), no
  // window (the window counts `approval.requested` records and none was
  // written), and no attention.
  const intake = evaluateIntakeLimits(
    read.records,
    intakeScopeOf(load, resolution),
    { class: input.cls, origin: actor },
    ts,
    ttlOf(load),
  );
  if (!intake.pass) {
    const failedLimits = intake.verdicts.filter((entry) => !entry.pass);
    // Never null on this branch: `pass` is false only when a verdict failed.
    const code = intakeRefusalOf(intake) ?? "queue-full";
    const detail = failedLimits
      .map(
        (entry) =>
          `${entry.limit} (${entry.scope}, ${String(entry.observed)} of ${
            entry.ceiling === null ? "an unreadable ceiling" : String(entry.ceiling)
          }${entry.note === undefined ? "" : `: ${entry.note}`})`,
      )
      .join(", ");
    return refuse(
      code,
      code === "queue-full"
        ? `the approver's queue is at its declared ceiling, so action ${input.actionKey} was not added to it: ${detail}. SPEC.md §5.2 caps simultaneously pending requests because approver attention is the resource this gate spends. Nothing was appended and no budget was consumed; the request can be made again once a pending request is decided, withdrawn, or lapses.`
        : `request intake is rate-limited for ${actor}: ${detail}. SPEC.md §5.2 caps request creation per origin over a rolling hour. Nothing was appended and no budget was consumed; the window is rolling, so the oldest request in it ages out on its own.`,
      { limits: failedLimits },
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
    // APRV-119 (WYSIWYS). The digest of the canonical rendering every channel
    // MUST present for this payload, so the log states what reading the
    // approver was shown and not only which bytes they were bound to. Assigned
    // here at the write boundary from `core/wysiwys.ts` — the same pure
    // function the channels render with — exactly as `policy_sha256` is
    // assigned from the runtime's own attestation check, and for the same
    // reason: a requester that could name its own display hash could show one
    // reading and record another. `RequestInput` carries no field for it.
    //
    // Absent, rather than invented, when this runtime does not hold the bytes:
    // the caller supplied none and the store has none. A hash over material
    // nobody holds would name a rendering nobody made.
    ...displayHashField(input, options, logPath, payloadHash, input.cls),
    // APRV-118. The attested policy this request was routed by, assigned here
    // at the write boundary from the runtime's own attestation check — the same
    // read that authorized the request, one line of code from the append.
    // {@link RequestInput} carries no field for it, exactly as it carries no
    // `ts`: the refusal of a caller-supplied value is structural, so a requester
    // cannot name the rules it claims to have been routed by.
    [POLICY_HASH_FIELD]: attested.sha256,
  };
  // APRV-105. Sealed delivery publishes an ADDRESS for the token this request
  // may earn: an ephemeral X25519 public key whose private half is written 0600
  // beside the log and never leaves this machine. Minted HERE, at the last check
  // before the append, so a refused request leaves no key file behind.
  //
  // Guarded by the policy, and by the policy alone: under the default
  // `manual` no key is minted, no field is added, and the record this call
  // appends is byte-identical to the one it appended before this feature
  // existed. `RequestInput` carries no field for the key, so a caller cannot
  // opt itself in — the operator's policy decides, exactly as it decides
  // autonomy. A key that cannot be written is not a reason to refuse a request:
  // the delivery is a convenience, the human's decision is not, and a request
  // that recorded a key it cannot open would be worse than one that recorded
  // none. So a failed write drops the field and the paste path stands.
  //
  // APRV-211. `delivery: "self"` mints the address whatever the policy says,
  // and refuses when it cannot. The operator's `token_delivery` setting chooses
  // between two ways of getting a token to a HUMAN AT A TERMINAL; a requester
  // that is a process in the same machine has no terminal on the other end, so
  // the setting has nothing to choose between and the address is the only route
  // that exists. See {@link RequestInput.delivery}.
  const selfDelivered = input.delivery === "self" && input.execution !== "harness";
  if (
    (tokenDeliveryOf(load) === "sealed" || selfDelivered) &&
    input.execution !== "harness" // a harness grant mints no token to deliver
  ) {
    const keypair = mintRecipientKeypair();
    const written = writePrivateKey(
      options.keyStoreDir ?? keyStoreDirFor(logPath),
      input.actionKey,
      keypair.privateKey,
    );
    if (written.ok) payload[RECIPIENT_KEY_FIELD] = keypair.publicKey;
    else if (selfDelivered) {
      return {
        ok: false,
        code: "token-delivery-unavailable",
        message: `action ${input.actionKey} is requested with self-delivery, so the grant's token can only reach this process through the sealed address this request publishes — and the private half could not be written (${written.message}). Nothing was appended: a decision spent on an authorization nobody can open would be worse than a question asked again.`,
      };
    }
    if (written.ok && selfDelivered) payload[SELF_DELIVERY_FIELD] = "self";
  }
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
    // `manual` because that is the path this action took and the rules it is now
    // under: it has a request, it needs a grant, and it will spend a token. The
    // CLASS may still be supervised-live — `resolution` says so, unchanged — and
    // `live` says how it got here. What a caller must not read back is
    // "supervised, proceed", so the field a caller branches on says `manual`.
    autonomy: "manual",
    proceed: false,
    resolution,
    record: appended.record,
    ...(live === null ? {} : { live }),
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
  /**
   * The graded reaction the approver gave, on `grant` only (APRV-239, amended
   * SPEC.md §5.2), recorded as `payload.reaction` on `approval.granted`.
   *
   * A human answering the gate is already saying what they think of the action;
   * this is where they can say it in one word rather than in prose nothing can
   * read back. It is GUIDANCE and never enforcement: the grant record itself is
   * the authorization, and no routing, matching, sampling, budget, token or
   * execution decision reads this field (SPEC.md §11.1 invariant 10). It cannot
   * widen or narrow what the grant authorizes, and a `disliked` grant is exactly
   * as much of a grant as a `loved` one.
   *
   * Ignored on `reject` and `revoke` — the CLI refuses the flag outright there,
   * as a usage error naming `--note` — because their reason is their note and a
   * grade beside a refusal is a second answer to a question with one.
   */
  reaction?: Reaction;
}

/**
 * The two grades a grant may not carry without the approver's own words
 * (amended SPEC.md §5.2). The same pair `core/audit.ts` enforces on a review,
 * spelled here rather than imported as a value so this module's runtime imports
 * stay where they are; `tests/gate.test.ts` pins the two lists together.
 */
const GRADES_REQUIRING_NOTE: ReadonlySet<string> = new Set(["disliked", "loved"]);

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
       *
       * Absent — on a grant that DID mint one — when the request declared
       * self-delivery and the token was sealed to its address (APRV-211). The
       * authorization is complete; the granting surface simply has no copy to
       * print, because the requester is a process that opens the seal itself.
       * See {@link RequestInput.delivery}.
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
  return withHeadMovedRetry(options, () =>
    attemptDecide(logPath, actionKey, decision, actor, options),
  );
}

/**
 * One whole decision, from the clock read to the append.
 *
 * APRV-236 put this under the bounded retry, and this verb is the reason the
 * task exists: on 2026-09-02 `approval grant` refused a human's tap with
 * `head moved: expected seq 14218, found 14219` while two lanes and the daemon
 * were appending, and the person had to type it again. Three times.
 *
 * The re-entry re-derives everything a decision rests on: the fresh
 * `requestState`, the human-only class test, the TTL lapse, the policy
 * attestation and the §6.2 drift check, the approver roster, and the budgets at
 * the moment of commitment. So a request that stopped being decidable in the
 * window is refused for THAT, in the gate's own vocabulary — `already-decided`
 * when someone answered it, `request-withdrawn` when its asker took it back,
 * `expired` when the TTL lapsed, `policy-drift` when a human re-attested — and
 * never as a lost race. A token is minted per attempt and only the appended
 * attempt's digest reaches the log, so no attempt leaves a live credential
 * behind.
 */
function attemptDecide(
  logPath: string,
  actionKey: string,
  decision: Decision,
  actor: string,
  options: DecideOptions,
): DecideResult {
  const ts = tick(options);
  if (!HUMAN_ACTOR.test(actor)) {
    return refuse(
      "actor-not-human",
      `${decision} is a human-only verb; the actor must match human:<id>, got ${JSON.stringify(actor)}`,
    );
  }

  // APRV-239, beside the actor check and before anything is read: whether a
  // grade came with words is a property of these arguments alone, so it is
  // settled before a log is opened and nothing is appended when it fails. The
  // schema enforces the same rule at the write boundary, which is what makes it
  // true of every record whatever surface wrote it; this refusal exists so the
  // person holding the phone gets a message that names the fix.
  if (
    decision === "grant" &&
    options.reaction !== undefined &&
    GRADES_REQUIRING_NOTE.has(options.reaction) &&
    (options.note === undefined || options.note.trim().length === 0)
  ) {
    return refuse(
      "reaction-note-required",
      `--reaction ${options.reaction} requires --note "<text>": it is the grade an agent is most likely to act on and least able to interpret alone, and "${options.reaction}" with no words says something about this action and nothing about what. Blank is not a note. \`liked\` and \`indifferent\` need none. Nothing was appended and the request is still pending.`,
    );
  }

  const read = readGateRecords(logPath);
  if (!read.ok) return read;

  const policyRead = readPolicyOnce(options);
  let attestedSha256: string | null = null;
  if (decision === "grant") {
    const attested = requireAttestation(read.records, policyRead);
    if (!attested.ok) return attested;
    attestedSha256 = attested.sha256;
  }

  const load = parsePolicy(policyRead, options);
  const ttlMs = ttlOf(load);
  const derivation = requestState(read.records, actionKey, ts, ttlMs);

  if (derivation.state === "none") {
    return refuse(
      "not-requested",
      `action ${actionKey} has no approval.requested record to decide`,
      { state: derivation.state },
    );
  }

  // APRV-185, amended SPEC.md §5.2. A request exists, and its class is one the
  // policy reserves to human hands: no decision may be recorded about it, in
  // any of this verb's three directions.
  //
  // `request` refuses such a class outright, so the only way a live request can
  // be sitting under one is a policy amendment between the request and the
  // decision. That is the case this exists for, and it is why REJECT and REVOKE
  // are refused alongside grant rather than left open as the tidy-up. Those two
  // withdraw authority rather than confer it, which is exactly why they are
  // normally unrestricted — but a decision record of any kind about a
  // human-only class reads afterwards as a class this gate transacts in, and
  // the log is the artifact both parties are supposed to be able to trust about
  // that. The request is not stranded: it authorizes nothing, no token exists
  // for it, and its requester withdraws it or its TTL lapses. Neither
  // `withdraw` nor `expire` is refused here, deliberately — they are the exits
  // from a question nobody may answer.
  //
  // A request whose payload carries no usable class cannot be tested and falls
  // through, exactly as it does for `grant-classless-request` below.
  const declaredClass = derivation.declared.class;
  if (declaredClass !== null && declaredClass.length > 0) {
    const classResolution = resolve(
      load,
      declaredClass,
      derivation.declared.reversible === null ? {} : { reversible: derivation.declared.reversible },
    );
    if (classResolution.autonomy === "human-only") {
      return refuse(
        "class-human-only",
        humanOnlyRefusal(
          declaredClass,
          `no ${decision} may be recorded for action ${actionKey}`,
        ),
        { state: derivation.state },
      );
    }
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
    payload["est_cost_usd"] = derivation.declared.est_cost_usd ?? "0";
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
    // APRV-239. Grant only, and written only when it was given: an omitted
    // reaction leaves no key, which is the difference between "the approver said
    // nothing" and "the approver said indifferent". It sits under the grant's
    // own branch so a value passed with `reject` or `revoke` is structurally
    // unable to reach a record, whatever the CLI in front of it does.
    if (options.reaction !== undefined) payload["reaction"] = options.reaction;
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
    // APRV-137, and deliberately the last check before budgets: a budget
    // refusal WRITES a `budget.exceeded` record, so every cheaper refusal must
    // run first and leave the log untouched. `resolution` is the single winning
    // rule of SPEC.md §5.2 — the same one rule that contributes the limits the
    // next call charges against, so the roster enforced here and the ceiling
    // enforced there always come from the same author's line.
    //
    // A rule that declares no `approvers` restricts nobody: the list is a
    // narrowing, and a narrowing nobody wrote narrows nothing. A `default`- or
    // `fail-closed`-provenance resolution therefore restricts nobody either, by
    // carrying `null`, which is the reading that keeps a repository recoverable:
    // an unparseable policy already resolves every class to `manual`, and one
    // that ALSO refused every grant would be a gate nobody could pass to fix it.
    // Attestation is the control on that path.
    const approvers = resolution.approvers;
    if (approvers !== null && !namesApprover(approvers, actor)) {
      return refuse(
        "actor-not-approver",
        `${actor} is not named in the approvers list for class ${cls}: the rule ${
          resolution.matched === null ? "in force" : `\`${resolution.matched.pattern}\``
        } names ${approvers.length === 0 ? "nobody" : approvers.map((name) => `\`${name}\``).join(", ")}. A grant recorded here would authorize the action on the word of someone the policy did not put in front of this class. Ask a named approver to decide it, or amend the policy and re-attest.`,
        { state: derivation.state },
      );
    }
    const budget = evaluateBudgetsWithTask(
      read.records,
      budgetScopeOf(load, resolution),
      { class: cls, est_cost_usd: derivation.declared.est_cost_usd ?? "0" },
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
            est_cost_usd: derivation.declared.est_cost_usd ?? "0",
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
      // APRV-105. Sealed delivery, decided by the REQUEST rather than by this
      // site's own policy read: the recipient key exists only because the
      // requester's policy said `sealed`, and this grant may be happening on
      // another machine entirely — the listener on a laptop, the requester
      // elsewhere, the log synced through git. Reading the key off the request
      // is what makes the handover work across that gap, and it widens nothing:
      // the key can only receive a token, never mint, forge, rebind or respend
      // one. Under `manual` no request carries a key and no grant is sealed, so
      // the record here is byte-identical to a pre-APRV-105 grant.
      //
      // The raw token is STILL returned to this caller and still printed once on
      // the granting surface. Sealing adds a second reader; it removes none.
      //
      // APRV-211 adds the one request for which it DOES remove one. A request
      // that declared self-delivery was minted by a process that will open the
      // seal itself (the daemon's own advance), so every copy of the token that
      // leaves this function is a copy nobody needs: the observed defect was the
      // Telegram listener printing "copy it now" on Carter's terminal for an
      // action they were not going to run. Withheld HERE, at the single choke
      // point, rather than at each granting surface — a value never handed out
      // cannot be printed by a surface written later. Only when the seal was
      // actually written: an unopenable grant with no returned token would be a
      // decision spent on nothing.
      const declared = payloadOf(requestRecord(read.records, actionKey));
      const recipient = declared[RECIPIENT_KEY_FIELD];
      if (isRecipientKey(recipient)) {
        const sealed = sealToken(token, recipient, actionKey);
        // An unusable recipient key drops the convenience and never the grant:
        // a human's yes must not be voidable by a malformed delivery address.
        if (sealed !== null) {
          payload[SEALED_TOKEN_FIELD] = { ...sealed };
          if (declared[SELF_DELIVERY_FIELD] === "self") token = undefined;
        }
      }
    }
  }
  if (decision === "revoke") {
    // APRV-105. The authorization is dead, so its delivery address dies with it.
    // A key file that outlived its grant would be a standing decryption
    // capability for a ciphertext the log keeps forever, held for no reason.
    forgetPrivateKey(options.keyStoreDir ?? keyStoreDirFor(logPath), actionKey);
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
 *    that lands in between wins and this withdrawal never overwrites it. Since
 *    APRV-236 the loser of that race re-reads and re-checks rather than
 *    reporting the lost race: the human's answer is on the fresh head, so the
 *    refusal the requester receives is `already-decided`, which is the fact they
 *    need. `tests/concurrency.test.ts` races the two.
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
  return withHeadMovedRetry(options, () => attemptWithdraw(logPath, actionKey, actor, options));
}

/** One whole withdrawal, re-entered from the top on a moved head (APRV-236). */
function attemptWithdraw(
  logPath: string,
  actionKey: string,
  actor: string,
  options: WithdrawOptions,
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

  const load = parsePolicy(readPolicyOnce(options), options);
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

/**
 * The policy hash pinned on the `approval.granted` record at `seq`, or `null`.
 *
 * `null` covers both shapes that are not a claim about policy: a grant written
 * before APRV-118 added the field, and a value that is not a SHA-256. A
 * malformed one reads as absent for the same reason `core/state.ts` reads it
 * that way — a corrupt byte must not be able to void an authorization, and a
 * crafted one must not be able to claim agreement it cannot prove.
 */
function grantedPolicyHash(records: EventRecord[], seq: number | null): string | null {
  if (seq === null) return null;
  for (const record of records) {
    if (record.seq !== seq) continue;
    const value = payloadOf(record)[POLICY_HASH_FIELD];
    return isPolicySha256(value) ? value : null;
  }
  return null;
}

/**
 * `GateOptions` plus the one thing a harness spend states about itself
 * (APRV-146).
 */
export interface ConsumeHarnessOptions extends GateOptions {
  /**
   * The hash of the payload the harness is about to run (amended SPEC.md §10.4).
   *
   * REQUIRED for every spend. It is never read from the log: a value read from
   * the log would prove nothing, and the whole point is that the process about
   * to run the command states, independently, what it holds so the runtime can
   * compare it against what the human approved. Optional in the type and
   * enforced at the write boundary, exactly as `core/execute.ts` enforces
   * `presentedPayloadHash`, so omitting it is a machine-readable refusal rather
   * than a compile error a caller could silence with a placeholder.
   */
  presentedPayloadHash?: string;
  /**
   * The task id of the invocation doing the spending (APRV-200).
   *
   * Used for one thing and nothing else: to decide whether the recorded
   * {@link HARNESS_GRANT_ORIGIN} is `direct` or `carried`. It never gates the
   * spend, never changes a refusal, and never appears on the record itself.
   *
   * It is a CLAIM, in §9's computed-versus-claimed vocabulary, and it is bounded
   * the way §11.1 invariant 4 bounds every claim: the only value it can produce
   * unaided is the one that ADDS scrutiny. `direct` is reachable solely by
   * presenting the task the request record already carries, which is a fact the
   * gate reads out of the verified log rather than out of the caller; anything
   * else, absence included, records `carried`.
   */
  spendingTask?: string;
}

/**
 * How the authorization reached the process that spent it (APRV-200).
 *
 * `direct` — the tool call that spent this grant is the tool call that asked for
 * it. One process opened the request, waited, saw the decision and proceeded, so
 * the gate observed the whole ordering: nothing this runtime authorized could
 * have run before the human answered.
 *
 * `carried` — a LATER tool call spent it, under APRV-117's carryover or its
 * adoption sibling. The asking invocation had already returned a verdict (a
 * `hook-timeout` deny, which leaves the request open), and whether the harness
 * honoured that verdict is a fact this runtime never observes: it decides, and
 * the harness executes. So the ordering the record implies — grant, then
 * execution — is only guaranteed for `direct`, and this marker is what lets an
 * auditor tell the two apart from the committed log alone. See
 * `docs/claude-code-hook.md`, "When the grant can follow the write".
 *
 * Absent on an `execution.started` that names no `grant_seq`: an unattended
 * execution has no grant, so it has no origin to report (SPEC.md §6.3).
 */
export type HarnessGrantOrigin = "direct" | "carried";

/** The payload field {@link HarnessGrantOrigin} is recorded under. */
export const HARNESS_GRANT_ORIGIN = "grant_origin";

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
 * cannot answer anything, so it answers nothing. `policy-drift` is the second
 * half of the same idea and is APRV-134: attested is not enough when what is
 * attested is a DIFFERENT policy from the one the approver decided under, and
 * the gap between a tap and a retry's spend is exactly where a re-attestation
 * fits.
 *
 * Everything else follows the derivation: `not-requested` when the key has no
 * request, `expired` when the TTL lapsed (judged from the request's own `ts`,
 * event or no event, exactly as {@link decide} judges it), `already-executed`
 * when something already spent it, `not-granted` for every other state and for
 * a grant that is not harness-executed. The content binding is checked last and
 * refuses twice over (APRV-146): `payload-hash-required` when the grant records
 * no bytes or the consumer states none, `payload-mismatch` when the bytes stated
 * are not the bytes approved. Budgets are not re-evaluated: the
 * authorization was charged at `approval.granted`, and `core/budgets.ts`'s
 * consumption contract already dedupes a start event against a grant carrying
 * the same `action_key`.
 *
 * ## What the record says about ORDER (APRV-200)
 *
 * The start carries `grant_origin`, which answers a question the log could not
 * previously be asked: was the tool call that spent this grant the tool call
 * that asked for it? `direct` says yes, and the gate observed the whole ordering
 * in one process. `carried` says a LATER invocation spent it — APRV-117's
 * carryover, or its adoption sibling — which means the asking invocation had
 * already returned a verdict, and this runtime never sees whether the harness
 * honoured it. A grant that arrives after the effect it names is a ratification
 * and not an approval, and `carried` is the window in which that is possible.
 * See {@link HarnessGrantOrigin} and `docs/claude-code-hook.md`.
 */
export function consumeHarnessGrant(
  logPath: string,
  actionKey: string,
  actor: string,
  options: ConsumeHarnessOptions = {},
): ConsumeHarnessResult {
  // APRV-150. Every attempt is a complete spend: a fresh verified read, a fresh
  // attestation, a fresh derivation of the request's state, and an append
  // against the head that read observed. A record landing in the window moves
  // the head and nothing else, unless it is a record that bears on this spend —
  // a competing consumer's `execution.started` — in which case the next attempt
  // derives `already-executed` and refuses it. The grant is spent once either
  // way, and it is the fresh log that decides which.
  return withHeadMovedRetry(options, () =>
    attemptHarnessConsume(logPath, actionKey, actor, options),
  );
}

function attemptHarnessConsume(
  logPath: string,
  actionKey: string,
  actor: string,
  options: ConsumeHarnessOptions,
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

  const policyRead = readPolicyOnce(options);
  const attested = requireAttestation(read.records, policyRead);
  if (!attested.ok) return attested;

  const load = parsePolicy(policyRead, options);
  const derivation = requestState(read.records, actionKey, ts, ttlOf(load));

  if (derivation.state === "none") {
    return refuse(
      "not-requested",
      `action ${actionKey} has no approval.requested record, so there is no grant to proceed on`,
      { state: derivation.state },
    );
  }
  // APRV-185, and the same placement `decide` uses: once a request is known to
  // exist, a class the policy reserves to human hands is answered before every
  // question about the spend. A harness grant is spent by a LATER process, so a
  // policy amendment can raise the class in the gap — and a spend here would
  // let a harness run a command in a class no agent may execute at all, on the
  // strength of a grant recorded under rules that no longer stand.
  const spendClass = derivation.declared.class;
  if (spendClass !== null && spendClass.length > 0) {
    const spendResolution = resolve(
      load,
      spendClass,
      derivation.declared.reversible === null ? {} : { reversible: derivation.declared.reversible },
    );
    if (spendResolution.autonomy === "human-only") {
      return refuse(
        "class-human-only",
        humanOnlyRefusal(
          spendClass,
          `the harness grant for action ${actionKey} may not be spent and no execution.started was written`,
        ),
        { state: derivation.state },
      );
    }
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

  // APRV-134: the spend-time half of APRV-118's comparison. `decide` refuses a
  // grant whose request was routed under a policy that is no longer in force;
  // this path is the remaining consumer that could still spend one under
  // different rules, because a harness grant is spent by a LATER PROCESS —
  // a retry after the first invocation's wait timed out, minutes later. A human
  // re-attesting in that gap changes the autonomy, the limits and the TTL that
  // put the question in front of them, and the command about to run is the one
  // they answered under the old rules. Refused with APRV-118's own
  // `policy-drift`, and deliberately the same code: the fact is the same fact
  // (the file is attested and is a different file), the remedy is the same
  // remedy (request it again under the policy that governs now), and a second
  // code for one condition would be a distinction an agent has to learn without
  // being able to act on it differently.
  //
  // The grant's own pinned hash is read first and the request's is the
  // fallback, so a log in which only one of the pair carries the field is
  // judged by whichever one does. Absence on both is not a mismatch: the field
  // is additive per SPEC.md §8, and reading its absence as drift would strand
  // every grant in a log written before APRV-118.
  const pinned =
    grantedPolicyHash(read.records, derivation.decisionSeq) ?? derivation.declared.policy_sha256;
  if (pinned !== null && pinned !== attested.sha256) {
    return refuse(
      "policy-drift",
      `action ${actionKey} was approved under policy ${pinned} and the attested policy is now ${attested.sha256}; a human re-attested between the decision and this spend, so the rules the approver saw are not the rules this command would run under. Nothing was appended: the grant is void and the action must be requested again, which re-resolves its autonomy, limits and TTL under the current policy.`,
      { state: derivation.state },
    );
  }

  // Content binding at the spend (APRV-146), reading APRV-140's rule the way
  // `core/execute.ts` reads it. A harness grant approves specific bytes: the
  // request recorded their hash, the human answered about them, and
  // `findHarnessCarry` matched a retry to this grant on that hash alone. So the
  // process about to run the command states the bytes it holds and they must be
  // the ones the grant carries.
  //
  // Neither absence is waved through. A request that recorded no binding is a
  // record this gate could not have written — `request` refuses
  // `payload-hash-required` for every manual action — so accepting it would make
  // the binding bypassable by log construction. A consumer that presents none
  // has not shown that it is running the approved command, which is the same
  // fact stated by omission. Ambiguity resolves to the stricter path, and the
  // grant stays live either way: nothing here is appended.
  const declaredHash = derivation.declared.payload_hash;
  if (declaredHash === null) {
    return refuse(
      "payload-hash-required",
      `action ${actionKey}'s request records no payload_hash, so there is nothing for this spend to be checked against. Amended SPEC.md §6.2 makes the binding MUST for a manual action, and a harness request is one; a grant carrying none reached the log some other way. Request the action again, which binds it to the payload the harness is about to run.`,
      { state: derivation.state },
    );
  }
  const presented = options.presentedPayloadHash;
  if (!isPayloadHash(presented)) {
    return refuse(
      "payload-hash-required",
      `the grant for ${actionKey} binds to payload_hash ${declaredHash} and this consumer presented ${presented === undefined ? "none" : JSON.stringify(presented)}. Amended SPEC.md §10.4: an executor MUST recompute the hash of the payload it is about to execute, so a spend that cannot state its bytes cannot be shown to be running the approved ones. Nothing was appended and the grant is still live.`,
      { state: derivation.state },
    );
  }
  if (presented !== declaredHash) {
    return refuse(
      "payload-mismatch",
      `the payload presented for ${actionKey} is not the one approved: the grant binds to ${declaredHash}, this consumer presented ${JSON.stringify(presented)}. A grant approves specific bytes; changing them after the decision requires a new request. Nothing was appended and the grant is still live.`,
      { state: derivation.state },
    );
  }

  const payload: Record<string, unknown> = {
    // The budgets contract: class and est_cost_usd on every start event.
    class: derivation.declared.class ?? "",
    est_cost_usd: derivation.declared.est_cost_usd ?? "0",
    // Why no completion will ever follow (see the doc comment).
    execution: "harness",
    // APRV-146: unconditional, because a grant with no binding and a consumer
    // that states none were both refused above. Every execution.started this
    // module writes names the bytes that ran.
    payload_hash: declaredHash,
    // APRV-200: whether the tool call that spent this grant is the tool call
    // that asked for it. Derived here, from the request's own task as the
    // verified log records it, so the laxer of the two values is unreachable by
    // assertion alone.
    [HARNESS_GRANT_ORIGIN]: (options.spendingTask !== undefined &&
    derivation.task !== null &&
    options.spendingTask === derivation.task
      ? "direct"
      : "carried") satisfies HarnessGrantOrigin,
  };
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
// startHarnessExecution
// ---------------------------------------------------------------------------

/** What the harness is about to run, as one class of one command. */
export interface HarnessStartInput {
  task: string;
  actionKey: string;
  cls: string;
  /**
   * The hash of the bytes the verdict was computed over, and which are about to
   * run (amended SPEC.md §6.2/§10.4, APRV-140).
   *
   * REQUIRED. A start event that cannot say WHAT ran records only that something
   * did, which is the whole of what APRV-140 set out to fix and is exactly the
   * state the harness path was left in. Optional in the type and enforced at the
   * write boundary, on the reading `core/execute.ts` gives
   * `presentedPayloadHash`: a caller that omits it is refused
   * `payload-hash-required` and told what to compute, rather than turned away by
   * the compiler and left to satisfy it with a placeholder.
   */
  payload_hash?: string;
  /** Canonical decimal USD string (APRV-121); a JSON number is read as the historical form. */
  est_cost_usd?: UsdInput;
}

export type HarnessStartResult = { ok: true; record: EventRecord } | GateRefusal;

/**
 * Charge and record a harness execution that no human was asked about
 * (APRV-141).
 *
 * ## The blind spot this closes
 *
 * `core/budgets.ts` computes consumption from `approval.granted` and
 * `execution.started`, and `core/audit.ts` draws its retrospective sample from
 * `execution.started` alone. The harness hook wrote neither for a supervised or
 * autonomous verdict — the comment said, correctly, that writing one per agent
 * action fills the log — so under Claude Code the majority of real activity
 * consumed no budget, `daily_actions` included, and was invisible to the
 * overseer that exists to read a sample of it. A budget that the busiest
 * execution path does not charge is not a budget, and the decision recorded on
 * APRV-141 is that the log volume is the lesser cost.
 *
 * ## Why this record and not a new event type
 *
 * It is the same `execution.started` {@link consumeHarnessGrant} appends, with
 * the same `execution: "harness"` marker saying why no `execution.completed` or
 * `execution.failed` will ever follow: the harness runs the command and this
 * runtime never observes an exit status. Reusing the shape means budgets and
 * audit count these without learning a second vocabulary, and the gate's
 * existing single-use rule (a key with an `execution.started` is
 * `already-executed`) applies unchanged. What differs is only the authorization
 * being recorded: there, a human's grant; here, the policy itself.
 *
 * ## What it refuses
 *
 * The same two facts the hook's own guard checks and `core/execute.ts` checks
 * before an unattended start — attestation and loop-escalation — re-checked at
 * the write boundary against the records this append is authorized by, plus the
 * budget verdict this record is the charge for. A class that resolves `manual`
 * is refused outright: a manual action is authorized by a grant and spent
 * through {@link consumeHarnessGrant} or a token, and admitting one here would
 * be a second, unapproved spender.
 *
 * Since APRV-146 the content binding is refused here too. `payload-hash-required`
 * says the caller named no bytes, and it is a refusal rather than an omitted
 * field because a start event with no `payload_hash` is a record that says
 * something ran without saying what — the state APRV-140 closed everywhere else.
 */
export function startHarnessExecution(
  logPath: string,
  input: HarnessStartInput,
  actor: string,
  options: GateOptions = {},
): HarnessStartResult {
  // APRV-150, and the writer the incident was reported against. This is the
  // busiest append in the system — one per class per gated tool call, most of
  // them autonomous — so it is the one most likely to lose a benign race, and a
  // lost race denied a command no human had any question about. Each attempt
  // re-runs all of it: attestation, resolution, escalation, the loop floor, the
  // single-use scan and the budget verdict, against the head it appends on.
  return withHeadMovedRetry(options, () => attemptHarnessStart(logPath, input, actor, options));
}

function attemptHarnessStart(
  logPath: string,
  input: HarnessStartInput,
  actor: string,
  options: GateOptions,
): HarnessStartResult {
  const ts = tick(options);
  if (!PRINCIPAL_ACTOR.test(actor)) {
    return refuse(
      "actor-invalid",
      `recording a harness execution requires a human: or agent: actor, got ${JSON.stringify(actor)}`,
    );
  }

  const read = readGateRecords(logPath);
  if (!read.ok) return read;

  // One read of the policy file for the whole operation (APRV-142): the same
  // bytes are hashed for attestation and parsed for the decision.
  const policyRead = readPolicyOnce(options);
  const attested = requireAttestation(read.records, policyRead);
  if (!attested.ok) return attested;

  const load = parsePolicy(policyRead, options);
  const resolution = resolve(load, input.cls);
  // APRV-185, and the belt to the hook's braces exactly as the loop floor below
  // is: `approval hook claude-code` denies a human-only class before the harness
  // ever runs the command, and a caller that reaches this write boundary without
  // asking the hook first must not be able to record an execution in a class no
  // agent may execute. Checked before `manual`, because the two refusals say
  // different things: that one says a human's grant authorizes this, and this
  // one says nothing authorizes it here at all.
  if (resolution.autonomy === "human-only") {
    return refuse(
      "class-human-only",
      humanOnlyRefusal(
        input.cls,
        `the harness execution of ${input.actionKey} may not be recorded and no execution.started was written`,
      ),
    );
  }
  if (resolution.autonomy === "manual") {
    return refuse(
      "not-granted",
      `class ${input.cls} resolves to manual (${resolution.provenance}), and a manual action is authorized by a human's grant rather than by the policy. Request it and spend the grant; this path records only the executions the policy itself authorized.`,
    );
  }

  if (isLoopEscalated(read.records, input.task)) {
    return refuse(
      "loop-escalated",
      `task ${input.task} has three consecutive execution.failed events and is escalated to manual (SPEC.md §10.2), so its ${resolution.autonomy} actions may not start unsupervised. The streak clears when an execution.completed for the task lands.`,
    );
  }

  // APRV-145, the harness scopes of the amended §10.2, re-checked at the write
  // boundary. The hook applies the floor before it gets here — an escalated
  // session's command is routed to the human gate rather than recorded as
  // unattended — and this is the belt to that pair of braces: a caller that
  // reaches this function without asking the hook first must not be able to
  // record an unattended harness execution for a session or an actor that is
  // three failed tool calls deep. A check in the hook alone is a check-then-
  // append with a window in it (§11.1 invariant 5).
  const floor = harnessLoopFloor(read.records, input.task, actor);
  if (floor !== null) {
    return refuse(
      "loop-escalated",
      `${floor.scope} ${floor.key} has ${String(floor.consecutiveFailures)} consecutive failed harness tool calls and is floored to manual (amended SPEC.md §10.2), so ${input.actionKey} may not be recorded as an unattended execution. Route the command through the human gate, or land an execution.completed in the same ${floor.scope} scope: nothing else clears the streak.`,
    );
  }

  for (const record of read.records) {
    if (record.action_key !== input.actionKey) continue;
    if (record.event !== "execution.started") continue;
    return refuse(
      "already-executed",
      `action ${input.actionKey} already started at seq ${record.seq}; an idempotency key is single-use`,
    );
  }

  // The content binding, REQUIRED (APRV-146). Until this it was recorded only
  // when a caller happened to supply one, so APRV-140's rule — every
  // `execution.started` names the bytes that ran — reached `approval run` and
  // stopped at the harness path, which is where most of the executions in this
  // repository's own log are written. Checked after the free checks and BEFORE
  // the budget evaluation, because a budget refusal WRITES and this one must
  // leave the log exactly as it found it.
  const bytes = input.payload_hash;
  if (!isPayloadHash(bytes)) {
    return refuse(
      "payload-hash-required",
      `recording a harness execution of ${input.actionKey} requires the payload_hash of what is about to run (amended SPEC.md §6.2, APRV-140), and this caller presented ${bytes === undefined ? "none" : JSON.stringify(bytes)}. A start event that cannot state its bytes says only that something ran; the harness computes the hash of the payload it is about to execute and passes it here. Nothing was appended.`,
    );
  }

  const cost = costOf(input.est_cost_usd);
  const budget = evaluateBudgetsWithTask(
    read.records,
    budgetScopeOf(load, resolution),
    { class: input.cls, est_cost_usd: cost },
    ts,
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
          est_cost_usd: cost,
          stage: "execution",
          verdicts: budget.verdicts,
        },
      },
      options,
      read.head,
    );
    const message = `budget refused the execution: ${failed
      .map((verdict) => `${verdict.limit} (${verdict.scope})`)
      .join(", ")}`;
    return logged.ok
      ? refuse("budget-exceeded", message, { verdicts: failed, record: logged.record })
      : refuse(
          "budget-exceeded",
          `${message}; the budget.exceeded event could not be appended: ${logged.message}`,
          { verdicts: failed },
        );
  }

  const payload: Record<string, unknown> = {
    // The budgets contract: class and est_cost_usd on every start event.
    class: input.cls,
    est_cost_usd: cost,
    // Why no completion will ever follow (see `consumeHarnessGrant`).
    execution: "harness",
    // APRV-146: unconditional, because a caller that states no bytes was refused
    // above. The record says what ran, not only that something did.
    payload_hash: bytes,
  };

  const appended = append(
    logPath,
    {
      ts,
      event: "execution.started",
      actor,
      task: input.task,
      action_key: input.actionKey,
      payload,
    },
    options,
    // The head read at the top: attestation, escalation, single-use and the
    // budget verdict were all judged against exactly that log.
    read.head,
  );
  if (!appended.ok) return appended;
  return { ok: true, record: appended.record };
}

// ---------------------------------------------------------------------------
// finishHarnessExecution — the completion counterpart (APRV-145)
// ---------------------------------------------------------------------------

/**
 * Which untrusted reporter asserted a harness outcome. CLOSED, and extended only
 * by a task that adds the case.
 *
 * It names the reporter and reduces nothing: it is a CLAIMED field in the
 * computed-versus-claimed vocabulary of SPEC.md §9, recorded so a reader can
 * tell a report from an observation without reading the record's provenance out
 * of its shape.
 */
export const HARNESS_REPORTERS = ["post-tool-use"] as const;
export type HarnessReporter = (typeof HARNESS_REPORTERS)[number];

export function isHarnessReporter(value: unknown): value is HarnessReporter {
  return typeof value === "string" && (HARNESS_REPORTERS as readonly string[]).includes(value);
}

/** What a harness says happened to one tool call. */
export interface HarnessFinishInput {
  /** The harness's identifier for the run of tool calls. */
  sessionId: string;
  /** The harness's identifier for this tool call. */
  toolUseId: string;
  /** Read from the reporting event by a CLOSED set of readings; never guessed. */
  outcome: "completed" | "failed";
  reportedBy: HarnessReporter;
  /**
   * The exit code, when the harness stated one, and `null` otherwise.
   *
   * Claude Code's post-execution event carries none (`docs/claude-code-hook.md`),
   * so in practice this is `null` on that adapter. It is `null` rather than
   * omitted-and-inferred for the reason `execution.indeterminate` carries a null
   * one: a fabricated number reads exactly like a measured one.
   */
  exitCode?: number | null;
}

export type HarnessFinishResult =
  | { ok: true; task: string; records: EventRecord[] }
  | GateRefusal;

/**
 * Close the delegated starts one harness tool call opened, with the outcome the
 * harness reported (APRV-145, amended SPEC.md §10.2).
 *
 * ## Why this is its own surface and not one of the recovery verbs
 *
 * APRV-146 made `finishExecution`, `resolveExecution` and `indeterminateExecution`
 * refuse `execution-delegated` over a harness start, and the reconciliation
 * recorded on APRV-145 keeps all three refusing it exactly as merged. Those three
 * write an outcome the RUNTIME observed, or a person did, and a harness start has
 * neither. This function writes a third thing — an outcome an untrusted reporter
 * ASSERTED, marked as such on its face — and it is a separate, marked surface so
 * that the carve-out is one named function a reader can audit rather than a
 * condition threaded through the human recovery path.
 *
 * ## What it will not do
 *
 * - **It resolves task and key from the log, never from the report.** The caller
 *   names a session and a tool-use id; this function reads the `execution.started`
 *   records the runtime itself wrote for that task (§11.1 invariant 1). A report
 *   can therefore only ever close an execution this runtime authorized.
 * - **It refuses a start with no harness marker** (`not-delegated`), so an
 *   untrusted report can never close an `approval run` execution it does not own.
 * - **It records none of the tool's output text.** §11.1 invariant 3 has no
 *   exception for diagnostics, and a tool's stdout is exactly where a credential
 *   arrives.
 * - **It takes no timestamp.** `execution.*` is gate-typed, so the refusal is
 *   structural: there is no parameter to pass and the clock is read once here,
 *   as {@link startHarnessExecution} reads it.
 * - **It requires no attestation and charges no budget.** The counterpart
 *   authorizes nothing (§11.1 invariant 8 does not bind it), and a report of a
 *   FAILURE that an unattested policy could block would be a self-reported field
 *   lowering scrutiny by omission.
 *
 * A partial close — some of the tool call's keys settled and some not — is left
 * as it is found. It over-counts failures and under-counts completions, and both
 * are the strict direction.
 */
export function finishHarnessExecution(
  logPath: string,
  input: HarnessFinishInput,
  actor: string,
  options: GateOptions = {},
): HarnessFinishResult {
  if (!PRINCIPAL_ACTOR.test(actor)) {
    return refuse(
      "actor-invalid",
      `reporting a harness outcome requires a human: or agent: actor, got ${JSON.stringify(actor)}. The runtime did not observe this exit; the party that did must be named on the record.`,
    );
  }
  const task = `${HARNESS_TASK_PREFIX}${input.sessionId}:${input.toolUseId}`;

  const survey = readGateRecords(logPath);
  if (!survey.ok) return survey;

  /** Every action key this task started, and whether it is delegated and open. */
  const started = new Map<string, { harness: boolean; open: boolean; seq: number }>();
  for (const record of survey.records) {
    const key = record.action_key;
    if (typeof key !== "string" || key.length === 0) continue;
    if (record.event === "execution.started") {
      if (record.task !== task) {
        started.delete(key);
        continue;
      }
      started.set(key, {
        harness: payloadOf(record)["execution"] === "harness",
        open: true,
        seq: record.seq,
      });
      continue;
    }
    if (
      record.event === "execution.completed" ||
      record.event === "execution.failed" ||
      record.event === "execution.indeterminate" ||
      record.event === "execution.reconciled"
    ) {
      const entry = started.get(key);
      if (entry !== undefined) entry.open = false;
    }
  }

  const delegated = [...started.entries()].filter(([, entry]) => entry.harness);
  if (delegated.length === 0) {
    return refuse(
      "not-delegated",
      started.size === 0
        ? `no execution.started record names task ${task}, so this report closes nothing. A harness outcome may only close an execution this runtime authorized, and the task and the action key are read from the log rather than from the report (SPEC.md §10.2, §11.1 invariant 1). Nothing was appended.`
        : `task ${task} started ${String(started.size)} execution(s) and none carries execution: "harness", so none of them is a harness's to close. An outcome reported from the harness side may not be written over an execution this runtime is watching itself; \`approval execution resolve\` is the human recovery verb for those. Nothing was appended.`,
    );
  }

  const open = delegated.filter(([, entry]) => entry.open).map(([key]) => key);
  if (open.length === 0) {
    return refuse(
      "already-finished",
      `every delegated execution of task ${task} already carries an outcome; an execution has exactly one. Nothing was appended.`,
    );
  }

  const event = input.outcome === "completed" ? "execution.completed" : "execution.failed";
  const exitCode = input.exitCode ?? null;
  const appended: EventRecord[] = [];
  for (const actionKey of open) {
    // One read per append, and the append carries the head that read observed:
    // the delegated-and-open judgment is re-made against exactly the log this
    // record chains onto (§11.1 invariant 5). The first append moves the head,
    // so a single head reused across the loop would refuse every record after
    // the first.
    //
    // APRV-236's bounded retry is applied HERE, per key, rather than around the
    // whole verb. This loop appends one record per open delegated execution, and
    // re-entering the verb after some of them landed would find those keys
    // already closed and could report `already-finished` for a call that in fact
    // wrote records. The per-key read-check-append IS the cycle, so retrying it
    // is exactly the unit the helper is for, and every counterpart already
    // appended stands untouched.
    const step = withHeadMovedRetry<FinishStep>(options, () =>
      attemptFinishOne(logPath, task, actionKey, event, exitCode, actor, input, appended.length, options),
    );
    if (!step.ok) return step;
    if (step.record !== undefined) appended.push(step.record);
  }

  if (appended.length === 0) {
    return refuse(
      "already-finished",
      `every delegated execution of task ${task} already carries an outcome; an execution has exactly one. Nothing was appended.`,
    );
  }
  return { ok: true, task, records: appended };
}

/**
 * One outcome record: the fresh read, the delegated-and-open judgment made on
 * it, and the append against the head that read observed.
 *
 * `{ ok: true }` with no `record` is the skip the loop above used to spell as
 * `continue`: this key acquired an outcome since the survey, which is not a
 * refusal of the report as a whole. A refusal is returned as-is and ends the
 * verb, with whatever counterparts already landed still standing.
 */
type FinishStep = { ok: true; record?: EventRecord } | GateRefusal;

function attemptFinishOne(
  logPath: string,
  task: string,
  actionKey: string,
  event: "execution.completed" | "execution.failed",
  exitCode: number | null,
  actor: string,
  input: HarnessFinishInput,
  alreadyAppended: number,
  options: GateOptions,
): FinishStep {
  const read = readGateRecords(logPath);
  if (!read.ok) return read;
  let harness = false;
  let stillOpen = false;
  for (const record of read.records) {
    if (record.action_key !== actionKey) continue;
    if (record.event === "execution.started") {
      harness = record.task === task && payloadOf(record)["execution"] === "harness";
      stillOpen = harness;
      continue;
    }
    if (
      record.event === "execution.completed" ||
      record.event === "execution.failed" ||
      record.event === "execution.indeterminate" ||
      record.event === "execution.reconciled"
    ) {
      stillOpen = false;
    }
  }
  if (!harness) {
    return refuse(
      "not-delegated",
      `action ${actionKey} is no longer a delegated start of task ${task}; the log moved under this report. ${String(alreadyAppended)} counterpart(s) were appended before it and stand.`,
    );
  }
  if (!stillOpen) return { ok: true };

  const result = append(
    logPath,
    {
      ts: tick(options),
      event,
      actor,
      task,
      action_key: actionKey,
      payload: {
        // The same marker the start carries: this record is about a command the
        // harness ran, and says so on its face.
        execution: "harness",
        // WHO asserted it. A closed code, and nothing of what the tool printed.
        reported_by: input.reportedBy,
        exit_code: exitCode,
      },
    },
    options,
    read.head,
  );
  if (!result.ok) return result;
  return { ok: true, record: result.record };
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

  const load = parsePolicy(readPolicyOnce(options), options);
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

  const expired = appendExpiry(logPath, derivation, load, ts, options, read.head);
  if (expired.ok) {
    // APRV-105, the third and last death of a delivery address. A lapsed request
    // can never be granted, so the private key that would have opened its token
    // opens nothing; keeping it would be keeping a decryption capability for a
    // ciphertext that may not even exist. Best effort and never fatal: the
    // expiry is the record that matters, and a key file that survives a failed
    // unlink is inert.
    forgetPrivateKey(options.keyStoreDir ?? keyStoreDirFor(logPath), actionKey);
  }
  return expired;
}
