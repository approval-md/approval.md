#!/usr/bin/env node
/**
 * Re-run the protected-path guard on open pull requests when the log advances
 * (APRV-260).
 *
 * The guard reads a COMMITTED copy of the log. A grant a human tapped during a
 * session becomes committed evidence only when the daemon's next advance is
 * pushed or merged, so a gated protected-path pull request can fail the guard
 * for a reason that stops being true minutes later, with no diff to push and
 * nothing for the author to fix. GitHub will not re-run a check on its own.
 *
 * So when an advance lands on `main`, this script asks which open pull requests
 * have a FAILED protected-path job on their latest CI run and re-runs exactly
 * those jobs. It never re-runs a whole workflow, never touches a run that is
 * still going, and decides nothing about merging: the guard re-decides, from
 * the new log, on its own terms.
 *
 * ## What it asks `gh`, and in what order
 *
 * 1. `gh pr list --state open --limit 100 --json number,headRefName` — the open
 *    pull requests, with the branch each one's runs are keyed by.
 * 2. `gh run list --workflow ci.yml --branch <head> --event pull_request
 *    --limit 1 --json ...` — that branch's most recent CI run.
 * 3. `gh run view <id> --json jobs` — the jobs of that run, where the guard's
 *    own job is looked up BY NAME and by conclusion.
 *
 * A run that is not `completed` is left alone (re-running a live run is how you
 * get two of them), and so is one whose guard job did not fail. Everything the
 * script learns comes from `gh`'s JSON; nothing is parsed out of human text.
 *
 * Usage:
 *   node scripts/guard-rerun.mjs [--dry-run] [--gh <binary>]
 *
 * `--dry-run` prints the selection and re-runs nothing, which is what the test
 * exercises with a fake `gh` on PATH.
 *
 * Exit codes: 0 selection succeeded (re-runs attempted, failures reported), 2
 * usage, 4 `gh` could not be asked.
 */

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_CANNOT_LOOK = 4;

/** The job whose failure this script exists to clear. Must match `ci.yml`. */
export const GUARD_JOB_NAME = "protected paths (grant cross-check)";

/** The workflow the guard job lives in. */
const WORKFLOW = "ci.yml";

function usage(message) {
  process.stderr.write(`guard-rerun: ${message}\n`);
  process.stderr.write("usage: node scripts/guard-rerun.mjs [--dry-run] [--gh <binary>]\n");
  return EXIT_USAGE;
}

function parseArgs(argv) {
  const flags = { dryRun: false, gh: "gh" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      flags.dryRun = true;
      continue;
    }
    if (arg === "--gh") {
      const value = argv[index + 1];
      if (value === undefined) return { ok: false, message: "--gh needs a value" };
      flags.gh = value;
      index += 1;
      continue;
    }
    return { ok: false, message: `unexpected argument ${JSON.stringify(arg)}` };
  }
  return { ok: true, flags };
}

/** Run `gh` with the given arguments; `null` when it failed. */
function gh(binary, args) {
  const run = spawnSync(binary, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (run.error !== undefined && run.error !== null) return null;
  if (run.status !== 0) {
    process.stderr.write(`guard-rerun: gh ${args.join(" ")} failed: ${run.stderr.trim()}\n`);
    return null;
  }
  return run.stdout;
}

/** Run `gh` and parse its JSON; `null` when either step failed. */
function ghJson(binary, args) {
  const out = gh(binary, args);
  if (out === null) return null;
  try {
    return JSON.parse(out);
  } catch (cause) {
    process.stderr.write(`guard-rerun: gh ${args.join(" ")} did not return JSON (${String(cause)})\n`);
    return null;
  }
}

/**
 * The runs to re-run, as `{ pr, branch, runId }`, newest-first per pull
 * request. Pure selection: it asks `gh` and decides, and re-runs nothing.
 */
export function selectRuns(binary) {
  const prs = ghJson(binary, [
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "number,headRefName",
  ]);
  if (prs === null || !Array.isArray(prs)) return null;

  const selected = [];
  for (const pr of prs) {
    const number = typeof pr?.number === "number" ? pr.number : null;
    const branch = typeof pr?.headRefName === "string" ? pr.headRefName : null;
    if (number === null || branch === null) continue;

    const runs = ghJson(binary, [
      "run",
      "list",
      "--workflow",
      WORKFLOW,
      "--branch",
      branch,
      "--event",
      "pull_request",
      "--limit",
      "1",
      "--json",
      "databaseId,status,conclusion,headSha",
    ]);
    if (runs === null || !Array.isArray(runs) || runs.length === 0) continue;
    const run = runs[0];
    const runId = typeof run?.databaseId === "number" ? run.databaseId : null;
    if (runId === null) continue;
    // A run still in flight will report its own verdict shortly. Re-running it
    // now would race the run that is already there.
    if (run.status !== "completed") continue;

    const view = ghJson(binary, ["run", "view", String(runId), "--json", "jobs"]);
    const jobs = Array.isArray(view?.jobs) ? view.jobs : [];
    const guardJob = jobs.find((job) => job?.name === GUARD_JOB_NAME);
    if (guardJob === undefined) continue;
    if (guardJob.conclusion !== "failure") continue;

    selected.push({ pr: number, branch, runId });
  }
  return selected;
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) return usage(parsed.message);
  const { dryRun, gh: binary } = parsed.flags;

  const selected = selectRuns(binary);
  if (selected === null) {
    process.stderr.write("guard-rerun: could not list open pull requests\n");
    return EXIT_CANNOT_LOOK;
  }

  if (selected.length === 0) {
    process.stdout.write("no open pull request has a failed protected-path guard job\n");
    return EXIT_OK;
  }

  for (const entry of selected) {
    process.stdout.write(`rerun ${entry.runId} (pr #${entry.pr}, branch ${entry.branch})\n`);
  }
  if (dryRun) return EXIT_OK;

  for (const entry of selected) {
    const out = gh(binary, ["run", "rerun", String(entry.runId), "--failed"]);
    process.stdout.write(
      out === null
        ? `guard-rerun: could not re-run ${entry.runId} (pr #${entry.pr})\n`
        : `re-ran the failed jobs of ${entry.runId} (pr #${entry.pr})\n`,
    );
  }
  return EXIT_OK;
}

// Importable for the test; the CLI runs only as the entry point.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
