/**
 * Failing-test-id reporter (APRV-426).
 *
 * A `node:test` custom reporter whose whole output is one stable id per failed
 * assertion, newline separated. It exists so that "what failed" can be a set of
 * names rather than a number.
 *
 * ## Why a count is not evidence
 *
 * PR #532 sat about twenty hours armed and red. The lane that opened it had
 * closed its session reporting that the full suite had "22 failures, exactly
 * the known SMTP baseline". The count was right and the conclusion was wrong:
 * one of those twenty-two was a new, machine-dependent conformance failure, and
 * a count cannot tell one red from another. Two failures swapping places leave
 * the total untouched, so a total can only ever say "no worse than before by
 * one measure nobody chose". A named list says which ones, and a name that is
 * not on the known list is a new failure whatever the total does.
 *
 * ## The id
 *
 *     <suite>::<ancestor> > <ancestor> > <test name>
 *
 * `suite` is the test file's path under `dist/tests` with `.test.js` removed,
 * which is exactly the name `run-tests.mjs --only` takes, so an id read out of
 * a baseline can be pasted back into a command that reruns just that file. The
 * name path is the ancestor chain, so two files may hold tests of the same name
 * and two `describe` blocks in one file may too.
 *
 * Ids are deterministic and free of anything machine-local: no durations, no
 * absolute paths, no ordering. Two runs that fail the same assertions produce
 * the same set of lines, on any machine, under any shard split.
 *
 * ## Only leaves
 *
 * `node:test` fails a parent when a child fails, with `failureType`
 * `subtestsFailed`. Those are dropped here. A parent id would be a second name
 * for a failure already named, and a baseline that carried both would go stale
 * the moment a file gained a second failing case. Every id this reporter emits
 * names an assertion that failed on its own account.
 *
 * The reporter writes only ids, so it is attached alongside the run's normal
 * reporter rather than in place of it (`run-tests.mjs --baseline`).
 */

import { relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the built suite lives, so a file can be reduced to its `--only` name. */
const TEST_DIR = fileURLToPath(new URL("../dist/tests/", import.meta.url));

/**
 * A test file's suite name: its path under `dist/tests` without the suffix.
 *
 * A file outside that tree (a scratch suite in a test of this reporter, say)
 * keeps its own relative path rather than being forced into a shape it does not
 * have. Falling back to something honest matters more here than a tidy name:
 * the id is what a human greps for.
 */
export function suiteName(file) {
  if (typeof file !== "string" || file.length === 0) return "<unknown file>";
  const within = relative(TEST_DIR, file);
  const name = within.startsWith("..") ? file : within;
  return name.endsWith(".test.js")
    ? name.slice(0, -".test.js".length)
    : name.replace(/\.(test\.)?[cm]?js$/u, "");
}

/** The id for one `test:fail` event, given the ancestor names above it. */
export function failureId(file, ancestors, name) {
  const path = [...ancestors, name].filter((part) => typeof part === "string" && part.length > 0);
  return `${suiteName(file)}::${path.join(" > ")}`;
}

/**
 * Turn a `node:test` event stream into failing ids.
 *
 * Exported separately from the reporter so a test can drive it with a synthetic
 * stream instead of spawning a suite.
 */
export async function* failureIds(source) {
  /** file -> the names of the tests currently open above the cursor. */
  const openByFile = new Map();
  for await (const event of source) {
    const data = event?.data;
    if (data === undefined || data === null) continue;
    const file = typeof data.file === "string" ? data.file : "";
    const nesting = typeof data.nesting === "number" ? data.nesting : 0;
    if (event.type === "test:start") {
      const open = openByFile.get(file) ?? [];
      open.length = nesting;
      open[nesting] = data.name;
      openByFile.set(file, open);
      continue;
    }
    if (event.type !== "test:fail") continue;
    if (data.details?.error?.failureType === "subtestsFailed") continue;
    const open = openByFile.get(file) ?? [];
    yield `${failureId(file, open.slice(0, nesting), data.name)}\n`;
  }
}

export default failureIds;
