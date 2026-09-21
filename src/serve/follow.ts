/**
 * `log/follow`, paged (APRV-421).
 *
 * `approval log follow` is a foreground stream: it prints verified records as
 * JSON Lines and stays. Over HTTP that shape is wrong in both directions — a
 * request has to end, and a tenant behind a sleeping Firecracker host has to
 * be able to come back tomorrow and resume — so this answers ONE page and
 * hands back the cursor to ask with next time.
 *
 * Everything else is the streaming verb's, unchanged, because it is literally
 * the same generator: `core/log-subscribe.ts` verifies the chain from genesis
 * before it emits anything, binds the exclusive `(seq, hash)` cursor to the
 * prefix the caller says it consumed, and refuses a mismatch as an integrity
 * failure with `cursor-mismatch` as its reason. Nothing in this file verifies,
 * parses or re-derives a record; it counts to a limit and stops.
 *
 * **At-least-once, and the cursor is the caller's.** This server keeps no
 * subscription state: a page is a function of the cursor in the request and
 * the bytes on disk. A caller that performs an external effect persists its
 * cursor after the effect, exactly as SPEC.md §8 requires of any consumer, and
 * a restart of this process on either side changes nothing about what the next
 * page contains. That is what "no in-memory state a restart loses" means here.
 */

import { LogSubscriptionError, subscribeVerifiedLog } from "../core/log-subscribe.js";
import type { EventRecord } from "../core/log.js";

/** Records one page carries when the caller names no limit. */
export const DEFAULT_FOLLOW_LIMIT = 200;

/** The most any caller may ask for in one page. */
export const MAX_FOLLOW_LIMIT = 1000;

export interface FollowCursor {
  /** Exclusive: the caller has consumed through this sequence number. */
  seq: number;
  /** The hash of record `seq`, or null when the caller never held one. */
  hash: string | null;
}

export interface FollowPage {
  records: EventRecord[];
  /** Where to resume. The caller sends this back verbatim. */
  cursor: FollowCursor;
  /**
   * True when this page exhausted the verified log rather than the limit.
   *
   * A caller that gets `false` asks again immediately; one that gets `true`
   * waits before it does. It is a statement about the snapshot this page was
   * cut from and never a promise about the next instant.
   */
  caught_up: boolean;
}

export type FollowResult =
  | { ok: true; page: FollowPage }
  | {
      ok: false;
      /** The CLI's own code for this failure: `integrity`, `torn-tail` or `io`. */
      code: string;
      message: string;
      /** `cursor-mismatch` and the rest of the subscription's own reasons. */
      reason: string | null;
    };

/**
 * The exit code `approval log follow` would have exited with for this failure.
 *
 * Carried on the response so a caller reproducing the CLI locally reports the
 * same thing. The numbers are `cli/exit-codes.ts`'s and are frozen public API;
 * they are mapped here exactly as `main.ts`'s `commandFollow` maps them.
 */
export function followFailureExit(code: string): number {
  if (code === "integrity") return 1;
  if (code === "torn-tail") return 3;
  return 4;
}

/** Clamp a caller's requested page size into the bounds above. */
export function clampFollowLimit(requested: number | null): number {
  if (requested === null) return DEFAULT_FOLLOW_LIMIT;
  return Math.min(Math.max(requested, 1), MAX_FOLLOW_LIMIT);
}

/**
 * Read one page of verified records after `cursor`.
 *
 * A failure returns NO records at all, including the ones a partial drain had
 * already produced: SPEC.md §8 says a subscription "MUST emit no record from a
 * batch that fails verification or its retained cursor binding", and a page
 * that carried half a batch beside an integrity refusal would be exactly that.
 */
export async function followPage(
  logPath: string,
  cursor: FollowCursor,
  limit: number,
): Promise<FollowResult> {
  const records: EventRecord[] = [];
  let caughtUp = true;

  const options = {
    from: cursor.seq,
    once: true,
    ...(cursor.hash === null ? {} : { expectedHash: cursor.hash }),
  };

  try {
    for await (const record of subscribeVerifiedLog(logPath, options)) {
      records.push(record);
      if (records.length >= limit) {
        // The generator's `finally` runs on this break: the iterator is closed
        // and nothing is left watching or waiting.
        caughtUp = false;
        break;
      }
    }
  } catch (cause) {
    if (!(cause instanceof LogSubscriptionError)) throw cause;
    return {
      ok: false,
      code: cause.kind === "torn-tail" ? "torn-tail" : cause.kind === "io" ? "io" : "integrity",
      message: cause.message,
      reason: cause.reason,
    };
  }

  const last = records.at(-1);
  return {
    ok: true,
    page: {
      records,
      cursor: last === undefined ? cursor : { seq: last.seq, hash: last.hash },
      caught_up: caughtUp,
    },
  };
}
