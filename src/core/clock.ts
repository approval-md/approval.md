/**
 * The write-boundary clock (amended SPEC.md §8, APRV-20 pass two / amendment A2).
 *
 * ## Why this module exists
 *
 * "Events written through the gate (`approval.*`, `execution.*`, `budget.*`,
 * `audit.*`, `policy.updated`) have `ts` assigned by the runtime at the write
 * boundary. Caller-supplied timestamps on these types MUST be refused. Because
 * TTL judgment and budget windows read `ts`, a party subject to those controls
 * must never author the clock they are judged by."
 *
 * Before this amendment every gate-typed append took `ts` as a positional
 * parameter, so an agent calling the core (or the CLI's own argv, had a flag
 * ever been added) could hand the runtime the moment it wished to be judged at:
 * a timestamp inside a lapsed TTL, or one that placed an authorization outside
 * the rolling budget window. The refusal the spec asks for is expressed here
 * **structurally rather than as a check**: the parameter no longer exists on any
 * public gate/token/execute/attest function, so there is nothing to refuse and
 * nothing to forget to refuse.
 *
 * Determinism is preserved by injection rather than by parameters. Every such
 * function takes an optional `clock` in its options; the CLI never passes one
 * (so the real clock is read once, at the write boundary, inside core), and
 * tests pass a fixed clock so TTL lapse and budget windows stay exercised
 * without sleeps. A replay still reproduces exactly, because the clock is an
 * input to the run rather than a read of ambient state inside the hashing path.
 *
 * ## The carve-out
 *
 * `core/log.ts`'s `appendEvent` still accepts `ts`, deliberately. SPEC.md §8
 * leaves direct log writers outside the gate free to supply their own
 * timestamps — an importer replaying a historical log is the obvious case, and
 * a writer that could not state when something happened could not import
 * anything. The rule binds the *gate*, which is where a subject of oversight
 * would benefit from lying.
 */

/** A source of RFC 3339 instants. Injected, never read from ambient state. */
export type Clock = () => string;

/** The default: the real clock, read at the write boundary and nowhere else. */
export const systemClock: Clock = () => new Date().toISOString();

/** Options carrying an injectable clock. Shared by every gate-typed writer. */
export interface ClockOptions {
  /**
   * The clock the runtime stamps this write with. Defaults to
   * {@link systemClock}. Tests inject a fixed clock; production does not pass
   * one at all, so the timestamp of a gate event is authored by the runtime and
   * never by the party being judged (amended SPEC.md §8).
   */
  clock?: Clock;
}

/** Read the injected clock, or the real one. One line, one place. */
export function tick(options: ClockOptions = {}): string {
  return (options.clock ?? systemClock)();
}
