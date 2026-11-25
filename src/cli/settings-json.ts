/**
 * Reading a harness's JSON settings file, shared by `approval doctor` (which
 * looks for the `approval hook` command a settings file registers) and the
 * hook's write pass (which guards the scripts a settings file names as hook
 * commands, lead CLAIMS L62289, S2). One reader and one walk, so the two never
 * disagree about what a settings document says.
 *
 * Shape-agnostic on purpose, as doctor always was: a settings document is
 * parsed as JSON and its STRING leaves are what a caller searches. A file that
 * is not JSON says nothing this can read.
 */

import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from "node:fs";

/** A parsed document; `null` when the file cannot be read, is not JSON, or is refused by a bound. */
export type JsonDocument = { value: unknown } | null;

/**
 * Parse the JSON file at `path`.
 *
 * Unbounded (doctor's reading, unchanged): the file is read whole. Bounded by
 * `maxBytes` (the hook's reading): the file is opened without waiting (a FIFO
 * never blocks the hook), and anything that is not a regular file, or holds
 * more than `maxBytes` bytes, is not read at all.
 */
export function readJsonDocument(path: string, options: { maxBytes?: number } = {}): JsonDocument {
  let text: string;
  if (options.maxBytes === undefined) {
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return null;
    }
  } else {
    const read = readBounded(path, options.maxBytes);
    if (read === null) return null;
    text = read;
  }
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return null;
  }
}

/** A regular file's text, or `null` when it is not one or holds more than `maxBytes` bytes. */
function readBounded(path: string, maxBytes: number): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    // One byte past the bound, so a file that grew after the stat is refused.
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (;;) {
      const got = readSync(fd, buffer, length, buffer.length - length, null);
      if (got === 0) break;
      length += got;
      if (length > maxBytes) return null;
    }
    return buffer.subarray(0, length).toString("utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Every string leaf of a parsed JSON value: in arrays and object values, at any depth. */
export function jsonStringLeaves(root: unknown): string[] {
  const out: string[] = [];
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node === "string") {
      out.push(node);
      continue;
    }
    if (Array.isArray(node)) {
      stack.push(...(node as unknown[]));
      continue;
    }
    if (typeof node === "object" && node !== null) {
      stack.push(...Object.values(node as Record<string, unknown>));
    }
  }
  return out;
}
