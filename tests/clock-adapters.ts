/**
 * Clock-injection adapters for the gate-typed writers (amended SPEC.md §8, A2).
 *
 * Under A2 no public gate/token/execute/attest function takes a `ts`: the
 * runtime assigns a gate event's timestamp at the write boundary, so the party
 * whose TTL and budget window are being judged cannot author the clock it is
 * judged by. Determinism is preserved by *injection* — `options.clock` — rather
 * than by a parameter.
 *
 * These suites still want explicit timestamps: TTL lapse, rolling budget
 * windows, and expiry arithmetic are exercised at chosen instants rather than
 * with sleeps. So each wrapper below takes the timestamp the old signature took
 * and hands it to core **as an injected clock**, which is the sanctioned path.
 * The wrappers keep the core names, so the existing call sites read unchanged
 * and the diff for A2 stays honest about what actually moved.
 *
 * What is deliberately NOT here: any way to reach the core functions with a
 * caller-supplied `ts` parameter. There is none — the parameter does not exist,
 * which is the compile-level half of A2's guarantee. `tests/clock.test.ts`
 * covers the runtime half (the recorded `ts` comes from the injected clock) and
 * the default (no clock injected → the real clock, not the caller's).
 *
 * This file is not a test file (no `.test.ts` suffix), so the runner ignores it.
 */

import {
  appendAttestation as appendAttestationCore,
  type AttestOptions,
  type AttestationAppendResult,
} from "../src/core/attest.js";
import {
  finishExecution as finishExecutionCore,
  indeterminateExecution as indeterminateExecutionCore,
  reconcileExecution as reconcileExecutionCore,
  resolveExecution as resolveExecutionCore,
  startExecution as startExecutionCore,
  type ExecuteOptions,
  type FinishResult,
  type IndeterminateReason,
  type IndeterminateResult,
  type ReconcileResolution,
  type ReconcileResult,
  type ResolveOutcome,
  type ResolveResult,
  type StartResult,
} from "../src/core/execute.js";
import {
  consumeHarnessGrant as consumeHarnessGrantCore,
  decide as decideCore,
  expire as expireCore,
  register as registerCore,
  request as requestCore,
  withdraw as withdrawCore,
  type ConsumeHarnessResult,
  type Decision,
  type DecideOptions,
  type DecideResult,
  type ExpireResult,
  type GateOptions,
  type RegisterResult,
  type RegisterSource,
  type RequestInput,
  type RequestResult,
  type WithdrawOptions,
  type WithdrawResult,
} from "../src/core/gate.js";
import {
  consumeToken as consumeTokenCore,
  type ConsumeResult,
  type TokenOptions,
} from "../src/core/token.js";

/** Freeze a timestamp into the shape core reads it from. */
function frozen<T extends object>(options: T, ts: string): T & { clock: () => string } {
  return { ...options, clock: () => ts };
}

export function register(
  logPath: string,
  source: RegisterSource,
  ts: string,
  actor: string,
  options: GateOptions = {},
): RegisterResult {
  return registerCore(logPath, source, actor, frozen(options, ts));
}

export function request(
  logPath: string,
  input: RequestInput,
  ts: string,
  actor: string,
  options: GateOptions = {},
): RequestResult {
  return requestCore(logPath, input, actor, frozen(options, ts));
}

export function decide(
  logPath: string,
  actionKey: string,
  decision: Decision,
  actor: string,
  ts: string,
  options: DecideOptions = {},
): DecideResult {
  return decideCore(logPath, actionKey, decision, actor, frozen(options, ts));
}

export function expire(
  logPath: string,
  actionKey: string,
  ts: string,
  options: GateOptions = {},
): ExpireResult {
  return expireCore(logPath, actionKey, frozen(options, ts));
}

export function withdraw(
  logPath: string,
  actionKey: string,
  actor: string,
  ts: string,
  options: WithdrawOptions = {},
): WithdrawResult {
  return withdrawCore(logPath, actionKey, actor, frozen(options, ts));
}

export function consumeHarnessGrant(
  logPath: string,
  actionKey: string,
  actor: string,
  ts: string,
  options: GateOptions = {},
): ConsumeHarnessResult {
  return consumeHarnessGrantCore(logPath, actionKey, actor, frozen(options, ts));
}

export function consumeToken(
  logPath: string,
  actionKey: string,
  presentedToken: string,
  ts: string,
  actor: string,
  options: TokenOptions = {},
): ConsumeResult {
  return consumeTokenCore(logPath, actionKey, presentedToken, actor, frozen(options, ts));
}

export function startExecution(
  logPath: string,
  actionKey: string,
  options: ExecuteOptions,
  ts: string,
  actor: string,
): StartResult {
  return startExecutionCore(logPath, actionKey, frozen(options, ts), actor);
}

export function finishExecution(
  logPath: string,
  actionKey: string,
  exitCode: number,
  ts: string,
  actor: string,
  options: ExecuteOptions = {},
): FinishResult {
  return finishExecutionCore(logPath, actionKey, exitCode, actor, frozen(options, ts));
}

export function resolveExecution(
  logPath: string,
  actionKey: string,
  outcome: ResolveOutcome,
  note: string,
  ts: string,
  actor: string,
  options: ExecuteOptions = {},
): ResolveResult {
  return resolveExecutionCore(logPath, actionKey, outcome, note, actor, frozen(options, ts));
}

export function indeterminateExecution(
  logPath: string,
  actionKey: string,
  reason: IndeterminateReason,
  ts: string,
  actor: string,
  options: ExecuteOptions = {},
): IndeterminateResult {
  return indeterminateExecutionCore(logPath, actionKey, reason, actor, frozen(options, ts));
}

export function reconcileExecution(
  logPath: string,
  actionKey: string,
  resolution: ReconcileResolution,
  note: string,
  ts: string,
  actor: string,
  options: ExecuteOptions = {},
): ReconcileResult {
  return reconcileExecutionCore(logPath, actionKey, resolution, note, actor, frozen(options, ts));
}

export function appendAttestation(
  logPath: string,
  policyPath: string,
  actor: string,
  ts: string,
  options: AttestOptions = {},
): AttestationAppendResult {
  return appendAttestationCore(logPath, policyPath, actor, frozen(options, ts));
}
