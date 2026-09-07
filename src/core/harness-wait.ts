/**
 * How long a harness hook waits, and how long the question it opened outlives
 * that wait (APRV-287).
 *
 * Two numbers with two readers each, which is the whole reason they live here
 * rather than beside either one. `cli/hook.ts` uses them to decide when a
 * request it opened has been abandoned; `cli/channel-telegram.ts` uses the wait
 * to decide which pending requests on a listener's first cycle are stale enough
 * to collapse into one message. Two copies of the same duration would be two
 * answers to "is anybody still waiting on this", and the channel would collapse
 * questions the hook was still holding open, or leave a dead queue on a phone.
 *
 * Nothing here reads a clock, a policy or the log: these are durations, and
 * every judgment made with them is made by a caller that already holds the
 * instant it is judging against.
 */

/**
 * The hook's default wait, chosen to sit inside Claude Code's own 60s hook
 * default. The string form is what the flag parser takes; the millisecond form
 * is what a comparison takes.
 */
export const HOOK_DEFAULT_WAIT = "55s";

/** {@link HOOK_DEFAULT_WAIT} in milliseconds. */
export const HOOK_DEFAULT_WAIT_MS = 55_000;

/**
 * How long a request outlives the wait that opened it, before the hook takes it
 * back (APRV-287).
 *
 * The window exists for exactly one thing: the retry. A hook whose wait expires
 * leaves its question open because a decision inside the policy's TTL still
 * authorizes an identical retry of the identical command (APRV-117), and the
 * agent that was denied usually retries within a minute or two. So the question
 * stays live for that long and no longer.
 *
 * Past it, nobody is coming back for the answer. The request was accruing on an
 * approver's phone as one more message a restarted listener would re-deliver,
 * and on 2026-09-06 a dozen of those arrived at once behind a dead daemon. A
 * request nothing will adopt is withdrawn (reason `timeout`), which authorizes
 * nothing, refuses a late tap in the approver's own words, and leaves the log
 * saying exactly what happened: the asker gave up.
 *
 * Five minutes because it is longer than any retry loop this runtime has been
 * observed to take and shorter than the shortest TTL an operator is likely to
 * write. It is a default: `--retry-grace` moves it per invocation, and `0`
 * withdraws at the moment the wait expires.
 */
export const HOOK_RETRY_GRACE_MS = 5 * 60_000;

/**
 * How old a request opened under `waitMs` must be before the grace has run out.
 *
 * Measured from the `approval.requested` record's own timestamp, which is the
 * instant the runtime wrote at the write boundary, and never from anything a
 * caller states about when it started waiting.
 */
export function abandonedAfterMs(waitMs: number, graceMs: number): number {
  return Math.max(0, waitMs) + Math.max(0, graceMs);
}
