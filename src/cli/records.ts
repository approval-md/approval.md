/**
 * Reading stored lines back out of the log, for `tail` and `export`.
 *
 * Read-only in the strictest sense: this module opens the file once for
 * reading and returns the *stored bytes* of each complete line. It never
 * re-serializes, never normalizes, never repairs. `export` is required to be
 * byte-faithful, and the cheapest way to guarantee that is never to have a
 * parsed object on the write path at all.
 *
 * Called only after {@link verify} has passed over the same file, so `count` is
 * the number of complete lines verification vouched for. If the file no longer
 * has that many lines, something is writing underneath us; that is reported as
 * an I/O condition rather than papered over.
 */

import { readFileSync } from "node:fs";

export type ReadResult = { ok: true; lines: string[] } | { ok: false; message: string };

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The first `count` complete (newline-terminated) lines of the log, exactly as
 * stored, without their terminators.
 */
export function readCompleteLines(logPath: string, count: number): ReadResult {
  if (count === 0) return { ok: true, lines: [] };

  let raw: string;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, lines: [] };
    }
    return { ok: false, message: `log ${logPath} could not be read: ${detail(cause)}` };
  }

  const segments = raw.split("\n");
  const lines: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const line = segments[index];
    if (line === undefined || line.length === 0) {
      return {
        ok: false,
        message: `log ${logPath} lost line ${index + 1} between verification and read; refusing to print a moving target`,
      };
    }
    lines.push(line);
  }
  return { ok: true, lines };
}

/** Parse stored lines back into records for `--json` output. */
export function parseLines(
  logPath: string,
  lines: string[],
): { ok: true; records: unknown[] } | { ok: false; message: string } {
  const records: unknown[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      records.push(JSON.parse(line));
    } catch (cause) {
      return {
        ok: false,
        message: `log ${logPath} line ${index + 1} changed between verification and read (${detail(cause)})`,
      };
    }
  }
  return { ok: true, records };
}
