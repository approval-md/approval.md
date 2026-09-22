#!/usr/bin/env node
/**
 * Known-failure baseline (APRV-426): the list a run's failures are read
 * against, so "new failure" is a question about names and never about a total.
 *
 * ## What the file is
 *
 * `scripts/ci-baseline.json` is a committed list of test ids that are known to
 * fail, each with the Backlog task that owns the fix. It is a ledger of debt,
 * not a suppression list: nothing here changes an exit code, and a run whose
 * every failure is on the list is still a red run. What the list buys is the
 * one sentence a lane could not previously write honestly, "these failures and
 * no others", which is the sentence that would have caught the conformance
 * regression hiding inside a count of twenty-two.
 *
 * ## What an entry means
 *
 *   id    the failing test's id, as `scripts/ci-failure-ids.mjs` spells it:
 *         `<suite>::<name path>`. The suite half is a `run-tests.mjs --only`
 *         name, so an entry can be rerun on its own.
 *   task  the Backlog task that owns the failure. Required. A known failure
 *         with nobody's name on it is an unknown failure that somebody got
 *         tired of looking at, and the task id is what makes the difference
 *         checkable later.
 *   note  one line on why it fails, for the reader who did not file the task.
 *
 * ## What comparison reports
 *
 * Three sets, and all three are useful:
 *   new       failed, not on the list. The thing this file exists to surface.
 *   known     failed, on the list. Expected debt.
 *   cleared   on the list, did not fail. Either fixed (delete the entry) or
 *             not run by this invocation, which is why `cleared` is reported
 *             and never enforced: a shard or an `--only` set legitimately runs
 *             a fraction of the list, and treating an unrun entry as fixed
 *             would delete real debt on the strength of not having looked.
 *
 * ## Loading fails closed
 *
 * An unreadable, unparseable or malformed baseline is an error, never an empty
 * list. An empty list silently promotes every known failure to new, which is
 * noisy and safe, but it equally means a typo in the path produces a report
 * that looks authoritative and compares against nothing at all.
 *
 * Usable as a module and from the command line:
 *
 *     node scripts/ci-baseline.mjs <ids-file> [baseline.json]
 */

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The committed baseline, the default for every entry point here. */
export const DEFAULT_BASELINE = fileURLToPath(new URL("./ci-baseline.json", import.meta.url));

/** A baseline id must look like `<suite>::<name>`; anything else is a typo. */
const ID_SHAPE = /^[^\s:][^:]*::.+$/u;

/** A task reference must be a Backlog id, so the debt has an owner. */
const TASK_SHAPE = /^APRV-\d+$/u;

/**
 * Read and validate the baseline file. Throws on anything it cannot fully
 * understand: see "Loading fails closed" above.
 */
export function loadBaseline(path = DEFAULT_BASELINE) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`ci-baseline: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`ci-baseline: ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`ci-baseline: ${path} must be a JSON object with a known_failures array`);
  }
  const entries = parsed.known_failures;
  if (!Array.isArray(entries)) {
    throw new Error(`ci-baseline: ${path} has no known_failures array`);
  }
  const seen = new Set();
  const known = entries.map((entry, position) => {
    const where = `${path} known_failures[${position}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`ci-baseline: ${where} is not an object`);
    }
    const { id, task, note } = entry;
    if (typeof id !== "string" || !ID_SHAPE.test(id)) {
      throw new Error(`ci-baseline: ${where} has no well-formed id (expected <suite>::<test name>)`);
    }
    if (seen.has(id)) {
      throw new Error(`ci-baseline: ${where} repeats the id ${id}`);
    }
    seen.add(id);
    if (typeof task !== "string" || !TASK_SHAPE.test(task)) {
      throw new Error(
        `ci-baseline: ${where} (${id}) names no owning task. A known failure with nobody's name on it is an unknown failure.`,
      );
    }
    if (note !== undefined && typeof note !== "string") {
      throw new Error(`ci-baseline: ${where} (${id}) has a non-string note`);
    }
    return { id, task, note: note ?? "" };
  });
  return { path, known };
}

/** Read a failing-ids file into a de-duplicated, sorted list. */
export function readFailureIds(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`ci-baseline: cannot read the failing-ids file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseFailureIds(text);
}

/** The ids in a reporter's output, de-duplicated and sorted. */
export function parseFailureIds(text) {
  const ids = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return [...new Set(ids)].sort();
}

/**
 * Partition a run's failing ids against a baseline.
 *
 * Returns `{ new: [...], known: [...], cleared: [...] }`, each sorted. The
 * `known` and `cleared` members carry the baseline entry, so a report can name
 * the owning task without a second lookup.
 */
export function compareFailures(failed, baseline) {
  const byId = new Map(baseline.known.map((entry) => [entry.id, entry]));
  const observed = [...new Set(failed)].sort();
  const fresh = observed.filter((id) => !byId.has(id));
  const expected = observed.filter((id) => byId.has(id)).map((id) => byId.get(id));
  const seen = new Set(observed);
  const cleared = baseline.known.filter((entry) => !seen.has(entry.id));
  return { new: fresh, known: expected, cleared };
}

/**
 * The human-readable report. New failures are printed by NAME, one per line,
 * because the whole point is that a lane's closing note can carry them.
 */
export function formatComparison(comparison, { baselinePath = DEFAULT_BASELINE, total } = {}) {
  const lines = [];
  const failed = total ?? comparison.new.length + comparison.known.length;
  lines.push(`ci-baseline: ${failed} failing test${failed === 1 ? "" : "s"} against ${baselinePath}`);
  if (comparison.new.length === 0) {
    lines.push("  new failures: none; every failure is on the known list");
  } else {
    lines.push(`  NEW failures (${comparison.new.length}), not on the known list:`);
    for (const id of comparison.new) lines.push(`    ${id}`);
  }
  if (comparison.known.length > 0) {
    lines.push(`  known failures (${comparison.known.length}):`);
    for (const entry of comparison.known) {
      lines.push(`    ${entry.id}  [${entry.task}]`);
    }
  }
  if (comparison.cleared.length > 0) {
    lines.push(
      `  on the list and not seen in this run (${comparison.cleared.length}); fixed, or simply not run by this selection:`,
    );
    for (const entry of comparison.cleared) {
      lines.push(`    ${entry.id}  [${entry.task}]`);
    }
  }
  return lines.join("\n");
}

/**
 * Compare and print. Returns the comparison so a caller can decide what the
 * exit code should be; this module never decides that for a test run.
 */
export function reportFailureIds(ids, { baselinePath = DEFAULT_BASELINE, log = console.error } = {}) {
  const baseline = loadBaseline(baselinePath);
  const comparison = compareFailures(ids, baseline);
  log(formatComparison(comparison, { baselinePath, total: ids.length }));
  return comparison;
}

function main(argv) {
  const [idsPath, baselinePath = DEFAULT_BASELINE] = argv;
  if (idsPath === undefined) {
    console.error("usage: ci-baseline.mjs <ids-file> [baseline.json]");
    return 2;
  }
  let comparison;
  try {
    comparison = reportFailureIds(readFailureIds(idsPath), { baselinePath, log: console.log });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  // Standalone, the exit code answers the one question the file exists for.
  return comparison.new.length === 0 ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
