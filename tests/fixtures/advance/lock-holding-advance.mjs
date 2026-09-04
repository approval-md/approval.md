/**
 * An advance child that leaves the append lock held, then refuses (APRV-233).
 *
 * Stands in for `daemon/advance-child.js` in the one case that needs the
 * daemon's OUTCOME record to fail: the incident it reproduces is a
 * `finishExecution` that could not append, and the deterministic way to produce
 * one in a test is to make the append time out on a lock nobody releases.
 *
 * It speaks the child protocol and nothing else — one JSON line on stdout — and
 * it never touches the log itself: the lockfile is a sentinel beside the log,
 * not a write to it. The test removes it once it has seen the failure.
 */

import { closeSync, openSync } from "node:fs";
import { join } from "node:path";

const request = JSON.parse(process.argv[2] ?? "{}");
const lock = join(request.cwd ?? ".", ".approval", "log", "events.jsonl.lock");
try {
  closeSync(openSync(lock, "wx"));
} catch {
  // Already held: the case works either way, since the point is only that the
  // outcome append meets a lock it cannot get.
}

process.stdout.write(
  `${JSON.stringify({
    ok: false,
    code: "log-advance-push-rejected",
    message: "the lock-holding advance stub refused and left the append lock held",
  })}\n`,
);
