/**
 * Default file locations and the I/O preflight that keeps filesystem problems
 * from being reported as tampering.
 *
 * SPEC.md §9 fixes the on-disk layout: the log lives at
 * `.approval/log/events.jsonl` and the derived SQLite index at
 * `.approval/index.sqlite`, both relative to the working directory. `--log` and
 * `--index` override them.
 *
 * **Why preflight exists.** `verify()` treats a non-ENOENT read failure as
 * `corrupt` — from inside the chain walker there is no way to tell "the bytes
 * are wrong" from "I was not allowed to look". At the CLI boundary there is:
 * we can stat and access the path before handing it to core, and a permission
 * bit can then be reported as a permission bit. An absent file is deliberately
 * *not* an error — an audit trail that has recorded nothing is a clean empty
 * log, not a missing one.
 *
 * Messages produced here must never contain the word "corrupt" in any form:
 * that word is reserved for statements about the log's contents.
 */

import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** SPEC.md §9: the log's location under the approval home directory. */
export const DEFAULT_LOG_PATH = ".approval/log/events.jsonl";

/** SPEC.md §9.2: the rebuildable SQLite projection. */
export const DEFAULT_INDEX_PATH = ".approval/index.sqlite";

/** Resolve a path flag against `cwd`, leaving absolute paths alone. */
export function resolvePath(value: string | null, fallback: string, cwd: string): string {
  const chosen = value ?? fallback;
  return isAbsolute(chosen) ? chosen : resolve(cwd, chosen);
}

export type Preflight =
  | { ok: true; present: boolean }
  | { ok: false; message: string };

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Check that the log path is something we can actually read before core is
 * asked to make claims about it.
 *
 * - absent → `{ ok: true, present: false }` (an empty log).
 * - a directory, a permission denial, or any other stat/access failure →
 *   `{ ok: false }` with an I/O message.
 */
export function preflightLog(logPath: string): Preflight {
  let stats;
  try {
    stats = statSync(logPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, present: false };
    }
    return { ok: false, message: `log ${logPath} could not be opened: ${detail(cause)}` };
  }

  if (stats.isDirectory()) {
    return { ok: false, message: `log ${logPath} is a directory, not a log file` };
  }

  try {
    accessSync(logPath, constants.R_OK);
  } catch (cause) {
    return { ok: false, message: `log ${logPath} is not readable: ${detail(cause)}` };
  }

  return { ok: true, present: true };
}
