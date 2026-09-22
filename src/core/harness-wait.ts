/**
 * How long a harness hook waits, and how long the question it opened outlives
 * that wait (APRV-287).
 *
 * Three numbers with two readers each, which is the whole reason they live
 * here rather than beside any one of them. `cli/hook.ts` uses them to decide
 * when a request it opened has been abandoned; `cli/channel-telegram.ts` uses the wait
 * to decide which pending requests on a listener's first cycle are stale enough
 * to collapse into one message. Two copies of the same duration would be two
 * answers to "is anybody still waiting on this", and the channel would collapse
 * questions the hook was still holding open, or leave a dead queue on a phone.
 * The third, APRV-423's margin, is read by the hook (which refuses a harness
 * ceiling too short to hold a human's answer) and by `core/state.ts` (which
 * judges every request against the window that ceiling leaves).
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

/**
 * How far below a harness's own timeout a hook-originated request must lapse
 * (APRV-423).
 *
 * A harness bounds the hook process: Hermes caps a `pre_tool_call` entry at
 * 300 s, Claude Code kills the hook at the `timeout` in its settings file, and
 * every one of them treats the killed process as a NON-BLOCKING error and runs
 * the tool call. So when the harness gives up first the hook is already gone,
 * the request is still pending on somebody's phone, and the tap that arrives
 * afterwards is recorded as a grant on a call nobody holds (APRV-410, observed
 * 2026-09-20). The two records then disagree about the same moment: one says
 * denied, the other says approved.
 *
 * The fix is to make the question end BEFORE the process that asked it does,
 * and this is the distance between the two. It is 60 s because the daemon's
 * TTL sweep runs on a 30 s interval (`daemon/daemon.ts`'s
 * `DEFAULT_INTERVAL_MS`): a request that lapses one millisecond after a sweep
 * waits a whole interval for the next one, so a margin of two intervals leaves
 * the `approval.expired` append a full tick of room in the common case, and it
 * lands inside the cap. Anything smaller would make the ordering this task is
 * about depend on where in the sweep cycle the lapse fell.
 *
 * The common case, and not a guarantee. `Daemon.tick` skips a sweep when the
 * previous tick is still running, and the request record's `ts` is stamped at
 * the write boundary, some intake latency after the harness spawned the hook,
 * so the cap runs from an instant slightly before the one the margin counts
 * from. An overrunning tick plus a slow intake can put the `approval.expired`
 * record after the kill. What keeps a late tap safe regardless is not this
 * margin but the lazy refusal: `core/state.ts` judges the lapse by arithmetic
 * whether or not the record exists, so `decide` refuses the tap `expired` and
 * materialises the record then. The margin buys the ORDERING in the common
 * case, so the two records agree without a human ever seeing the disagreement;
 * the refusal is what makes the grant impossible in every case.
 *
 * It is a floor on the cap as well as a subtraction from it. A cap at or below
 * the margin leaves no window in which a human could answer at all: `cli/hook.ts`
 * refuses such a configuration rather than opening a question that is already
 * dead, and `schema/event.schema.json` refuses a record carrying one at the
 * write boundary (its `minimum` is this constant plus one, pinned equal by
 * `tests/harness-cap-ttl.test.ts`).
 */
export const HARNESS_CAP_MARGIN_MS = 60_000;

/**
 * The deadline a hook-originated request is judged by: the SHORTER of the
 * policy's TTL and the harness's cap minus {@link HARNESS_CAP_MARGIN_MS}
 * (APRV-423).
 *
 * `null` means no deadline, exactly as `defaults.approval_ttl`'s absence means
 * it (SPEC.md §6): nothing lapses, and no duration is invented for a policy
 * that declared none.
 *
 * **The cap may only shorten.** It is a self-reported field (the hook states
 * the ceiling its own harness runs it under), and SPEC.md §11.1 invariant 4
 * says such a field never reduces scrutiny. Recording it raw and taking the
 * minimum HERE is what makes that structural: a cap larger than the policy TTL
 * changes nothing, a cap of an hour under a one-minute TTL changes nothing, and
 * the only direction a requester can move its own deadline is earlier. The same
 * shape as `core/gate-window.ts`'s `expires_at`, which clamps a claimed window
 * against the derived one for the same reason.
 *
 * A cap that does not clear the margin yields `0`, which reads as lapsed from
 * the instant the request is written. That is the fail-closed answer for a
 * harness whose ceiling leaves no room for a human, and it is unreachable
 * through the write path: the hook refuses the configuration before it
 * appends, and the event schema refuses the record for any caller that did
 * not come through the hook.
 */
export function harnessCappedTtlMs(
  policyTtlMs: number | null,
  capMs: number | null,
): number | null {
  if (capMs === null) return policyTtlMs;
  const fromCap = Math.max(0, capMs - HARNESS_CAP_MARGIN_MS);
  return policyTtlMs === null ? fromCap : Math.min(policyTtlMs, fromCap);
}

/**
 * Does `capMs` leave a window a human could answer in?
 *
 * The one question `cli/hook.ts` asks before it opens a request under a cap.
 * Strictly greater: a cap EQUAL to the margin yields a zero-length window,
 * which is a question that expires as it is asked.
 */
export function harnessCapFitsMargin(capMs: number): boolean {
  return capMs > HARNESS_CAP_MARGIN_MS;
}
