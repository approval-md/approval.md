/**
 * The bounded head-moved retry, in one place (APRV-150, APRV-236).
 *
 * ## The fact this module is about
 *
 * `core/log.ts` takes a compare-and-append precondition: a writer states the
 * `(seq, hash)` its checks were made against, and the append is refused under
 * the lock when the tail is something else. That refusal is `append-failed`
 * with `append.code === "head-moved"`, and it is correct: every read-dependent
 * check that authorized the write is stale.
 *
 * Stale is not the same as wrong. A moved head says the verdict must be
 * computed again; it does not say what the verdict is. Treating the two as the
 * same is what turned a busy log into a lottery, twice:
 *
 *  - 2026-08-29 (APRV-150): a session's first `git status` — class `read.shell`,
 *    autonomous, no human anywhere near it — was denied by the Claude Code hook
 *    because an unrelated record landed a few milliseconds earlier.
 *  - 2026-09-02 (APRV-236): `approval grant` refused a human's decision with
 *    `head moved: expected seq 14218, found 14219` while two lanes and the
 *    daemon were appending. The human ran it again. Twice more.
 *
 * The second one is the worse of the two, because the caller it handed the
 * retry to was a person. A compare-and-append refusal is a fact about timing
 * rather than about authority, and asking a human to retype is the wrong party
 * to hand it to.
 *
 * ## What a retry is here, and what it is not
 *
 * The unit of retry is the WHOLE read-check-append cycle: a new read of the
 * verified log, a new read of the policy, a fresh attestation, a fresh
 * derivation of the request's state, fresh escalation, single-use, intake and
 * budget checks, and a new append against the head that the new read observed.
 * Nothing crosses an attempt except the caller's own inputs.
 *
 * The append is never retried on its own. That distinction is the whole safety
 * argument, and it is worth stating as three properties:
 *
 *  - **compare-and-append is untouched.** Every attempt supplies the head it
 *    read, and a stale write is still refused under the lock. SPEC.md §11.1
 *    invariant 5 holds per attempt, which is where it has to hold.
 *  - **A changed verdict is the new verdict.** If the record that moved the head
 *    decided the request, spent the key, exhausted the budget, lapsed the TTL or
 *    re-attested a different policy, the next attempt derives that and refuses
 *    it with the code those fresh facts produce — `already-decided`,
 *    `request-withdrawn`, `already-executed`, `budget-exceeded`, `expired`,
 *    `policy-drift` — never `append-failed`. A retry cannot launder a denial
 *    into an allow, because it never replays the earlier conclusion.
 *  - **Only `head-moved` retries.** Every other refusal, a real verdict included,
 *    is returned on the first attempt. So is a lock timeout, a corrupt log and a
 *    schema refusal at the write boundary: retrying those would be either
 *    pointless or a second write.
 *
 * The bound is what keeps a busy log from turning one call into an unbounded
 * write loop. When it is spent the last `head-moved` refusal is returned with
 * its code and its `append` error unchanged, and with the attempt count added to
 * its message so a reader can tell one lost race from a log under sustained
 * contention. The caller fails closed on it exactly as it always did.
 */

import type { AppendError } from "./log.js";

/**
 * How many times a gate writer re-derives its verdict against a moved head
 * before it gives up. Small, fixed, and not configurable upward.
 *
 * APRV-150 chose three for the hook's writers; APRV-236 gives the same three to
 * every other writer a human or a session drives, rather than inventing a
 * second number for the same fact.
 */
export const HEAD_MOVED_ATTEMPTS = 3;

/**
 * The shape this module needs of a writer's result: an `ok` discriminator, and
 * on the refusal side a code and the append error beneath it.
 *
 * Deliberately structural. `GateRefusal`, `ExecuteRefusal`, `TokenRefusal` and
 * `GateWindowRefusal` are four frozen unions in four modules that must not
 * learn about each other; what they share is this, and this is all the helper
 * reads.
 */
export interface HeadRetryable {
  ok: boolean;
  code?: string;
  message?: string;
  append?: AppendError;
}

/** Did this refusal come from the compare-and-append precondition alone? */
export function isHeadMoved(result: HeadRetryable): boolean {
  return !result.ok && result.code === "append-failed" && result.append?.code === "head-moved";
}

/**
 * The attempt budget for one operation: `ceiling` unless the caller asked for
 * fewer.
 *
 * Clamped rather than trusted, and clamped in the one direction that matters: a
 * caller may ask for LESS tolerance of a moved head (a test pinning the
 * unretried behaviour, a caller that would rather fail fast), never for more.
 * Ambiguity — a non-integer, a zero, a negative — resolves to the value the
 * runtime chose, not the caller's.
 */
export function attemptsOf(asked: number | undefined, ceiling = HEAD_MOVED_ATTEMPTS): number {
  if (asked === undefined || !Number.isInteger(asked) || asked < 1) return ceiling;
  return Math.min(asked, ceiling);
}

/**
 * Run one whole read-check-append cycle, and run it again from the top while it
 * loses the race, up to `attempts` times.
 *
 * `cycle` MUST be the entire operation: it re-reads, re-runs every check on the
 * head it just read, and returns either the append it attempted or the refusal
 * those fresh facts produced. A `cycle` that closes over a stale read would
 * defeat the only property that makes this safe.
 */
export function withHeadRetry<T extends HeadRetryable>(attempts: number, cycle: () => T): T {
  let result = cycle();
  let made = 1;
  for (; made < attempts && isHeadMoved(result); made += 1) {
    result = cycle();
  }
  return isHeadMoved(result) ? exhausted(result, made) : result;
}

/**
 * The refusal handed back once the bound is spent.
 *
 * The code stays `append-failed` and the `append` error stays the writer's own,
 * because that is what a caller branches on and it is still the true reason.
 * What is added is the count, so the message says how hard the writer tried:
 * one lost race and a log under sustained contention are different operational
 * facts, and a reader who cannot tell them apart cannot act on either.
 */
function exhausted<T extends HeadRetryable>(result: T, attempts: number): T {
  const note = `; ${String(attempts)} attempt${
    attempts === 1 ? "" : "s"
  } were made, each a fresh read, fresh checks and a fresh compare-and-append, and the head had moved again every time. Nothing was appended.`;
  // A copy, never a mutation: the caller's refusal objects are values, and the
  // only field that changes is the human-readable one. The cast restores `T`
  // after the spread, which widens `message` to `string | undefined`.
  return { ...result, message: `${result.message ?? "the head moved"}${note}` } as T;
}
