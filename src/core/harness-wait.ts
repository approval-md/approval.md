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
 *
 * Since APRV-423 it holds a third number of the same kind: the ceiling the
 * HARNESS puts on one hook entry, which bounds the wait from above the way the
 * grace bounds the question from below.
 */

import type { HarnessKind } from "./harness-version.js";

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
 * The HARD ceiling each harness puts on one hook entry (APRV-423).
 *
 * Not the wait, and not an operator's configured `timeout` either: this is the
 * number past which the harness itself will not let a hook entry be configured
 * at all, so no setting an operator can write raises it. Past it the harness
 * stops holding the tool call, the hook process is killed or its verdict is
 * discarded, and a tap that arrives afterwards grants a call nobody holds.
 *
 * `null` means this project has not OBSERVED a hard ceiling for that harness,
 * which is a different statement from "there is none". Claude Code, Cursor,
 * Codex, Grok and Muse each let the operator set the entry's `timeout`, and the
 * documentation this project has checked names a default rather than a maximum
 * (docs/claude-code-hook.md: `timeout` defaults to 60s and the shipped config
 * uses 600). Writing a number here that nobody verified would put a guess in the
 * one place a TTL is computed from, so the entry stays `null` and the operator
 * states their own with `--harness-cap`.
 *
 * Hermes is the one entry with a number, and it is documented: an entry's
 * `timeout` may not exceed 300 seconds (docs/hermes-hook.md, "Two timeouts bound
 * the wait, and the shorter one wins"). Its `plugins.hook_callback_timeout`
 * bounds the whole dispatch and defaults lower still, but that one an operator
 * raises, so it is not a ceiling.
 */
export const HARNESS_PROCESS_CAP_MS: Readonly<Record<HarnessKind, number | null>> = {
  "claude-code": null,
  cursor: null,
  codex: null,
  grok: null,
  muse: null,
  hermes: 300_000,
};

/**
 * How far before the harness cap a capped request's TTL lapses (APRV-423).
 *
 * Two of `daemon/daemon.ts`'s `DEFAULT_INTERVAL_MS`, and the arithmetic is the
 * whole justification. The expiry is appended by a sweep, and a sweep runs every
 * `intervalMs`, so the record lands somewhere in `[lapse, lapse + intervalMs]`.
 * One interval of margin would only guarantee the LAPSE happened before the cap
 * and would let the append land on it; two guarantee that a daemon running at
 * the default interval has appended `approval.expired` at `cap - 30s` at the
 * latest, which is strictly before the cap with a full interval to spare.
 *
 * The guarantee is stated in terms of the DEFAULT interval and holds no better
 * than the interval actually configured: an operator running `--interval 5m`
 * gets a lapse before the cap and an append after it, and the honest thing is to
 * say so rather than to scale the margin off a number this module cannot see.
 * The number is not imported from the daemon because durations live here and a
 * core module that reached into `daemon/` for a constant would invert that.
 */
export const HARNESS_CAP_MARGIN_MS = 60_000;

/**
 * The cap in force for one hook invocation: the smaller of what the harness will
 * not let an operator exceed and what the operator says their entry is set to.
 *
 * Both are ceilings on the same thing — how long this harness can hold this tool
 * call — so the smaller one is the one that bites, exactly as
 * docs/hermes-hook.md's two-timeout table says. `null` when neither is known,
 * which leaves the policy TTL as the only deadline and is the behaviour every
 * deployment had before APRV-423.
 *
 * `operatorCapMs` is self-reported (a flag on the hook's own command line), and
 * it is bounded twice for it: it may only ever make the window SMALLER, because
 * every use of the result goes through {@link effectiveRequestTtlMs}'s `min`,
 * and a value that is not a usable duration is dropped rather than trusted.
 */
export function harnessCapMs(kind: HarnessKind, operatorCapMs?: number | null): number | null {
  const declared = HARNESS_PROCESS_CAP_MS[kind];
  const stated =
    typeof operatorCapMs === "number" && Number.isFinite(operatorCapMs) && operatorCapMs > 0
      ? Math.floor(operatorCapMs)
      : null;
  if (declared === null) return stated;
  if (stated === null) return declared;
  return Math.min(declared, stated);
}

/**
 * The TTL that actually governs one request: the policy's, narrowed by the
 * harness cap the request carries (APRV-423).
 *
 * Three properties, and each is a rule this codebase already has:
 *
 * 1. **It only ever narrows.** The result is the `min` of the two, so a cap
 *    cannot extend a policy TTL by any value a caller states. The cap is a field
 *    the party under oversight puts on its own request, and SPEC.md §11.1
 *    invariant 4 lets such a field raise scrutiny and never lower it; a shorter
 *    window is strictly less authority, so this is the permitted direction.
 * 2. **A policy that declares no TTL is still narrowed.** `policyTtlMs === null`
 *    means "this policy bounds nothing", and a harness request nobody can be
 *    holding any more is not something a missing policy line should keep alive.
 *    With no cap either, `null` comes back out and nothing lapses, which is what
 *    every request did before this existed.
 * 3. **It never goes negative.** A cap at or below the margin yields `0`, which
 *    lapses the request at the first instant after it was written. That is the
 *    fail-closed end of the range: a harness that cannot hold a call for longer
 *    than the margin cannot hold one long enough for a human, and a request
 *    nobody can answer in time is better terminal than pending.
 */
export function effectiveRequestTtlMs(
  policyTtlMs: number | null,
  capMs: number | null,
): number | null {
  if (capMs === null || !Number.isFinite(capMs) || capMs <= 0) return policyTtlMs;
  const derived = Math.max(0, Math.floor(capMs) - HARNESS_CAP_MARGIN_MS);
  return policyTtlMs === null ? derived : Math.min(policyTtlMs, derived);
}
