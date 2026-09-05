/**
 * The rerun selector (APRV-260).
 *
 * When a log advance lands on main, a protected-path guard that failed only
 * because the grant was not yet in a committed log can now pass, and GitHub
 * re-runs nothing on its own. `scripts/guard-rerun.mjs` decides which runs to
 * re-run. What is asserted here is the SELECTION, because the selection is the
 * whole risk: re-running the wrong run wastes minutes, and re-running a run
 * that is still going produces two of them.
 *
 * `gh` is faked on PATH — a node script that answers the three JSON calls from
 * a fixture and records any `run rerun` it is asked for. Faking it is right
 * here for the reason the log fixtures elsewhere are real: the subject is this
 * script's choice among answers, not GitHub's API, and a test that reached the
 * real API would assert nothing repeatable.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { scratchRoot } from "./scenario.js";

/** dist/tests/…test.js -> the repository root. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts", "guard-rerun.mjs");

/** Must match the job name in `.github/workflows/ci.yml`. */
const GUARD_JOB = "protected paths (grant cross-check)";

const { root, cleanup } = scratchRoot("guard-rerun");
after(cleanup);

/**
 * The world `gh` reports: four open pull requests, one of which has a failed
 * guard job on a completed run. The others are the three ways a pull request
 * must NOT be selected.
 */
const FIXTURE = {
  prs: [
    { number: 270, headRefName: "aprv-260-guard-log-lag" },
    { number: 271, headRefName: "already-green" },
    { number: 272, headRefName: "still-running" },
    { number: 273, headRefName: "failed-elsewhere" },
  ],
  runs: {
    "aprv-260-guard-log-lag": [{ databaseId: 111, status: "completed", conclusion: "failure" }],
    "already-green": [{ databaseId: 222, status: "completed", conclusion: "success" }],
    "still-running": [{ databaseId: 333, status: "in_progress", conclusion: null }],
    "failed-elsewhere": [{ databaseId: 444, status: "completed", conclusion: "failure" }],
  },
  jobs: {
    "111": { jobs: [{ name: "classify tier", conclusion: "success" }, { name: GUARD_JOB, conclusion: "failure" }] },
    "222": { jobs: [{ name: GUARD_JOB, conclusion: "success" }] },
    "333": { jobs: [{ name: GUARD_JOB, conclusion: null }] },
    "444": { jobs: [{ name: GUARD_JOB, conclusion: "success" }, { name: "full gate", conclusion: "failure" }] },
  },
};

const FIXTURE_PATH = join(root, "gh-fixture.json");
const RERUN_LOG = join(root, "reruns.txt");
const BIN_DIR = join(root, "bin");

/** A `gh` that answers from the fixture and records what it was told to re-run. */
function installFakeGh(): void {
  mkdirSync(BIN_DIR, { recursive: true });
  writeFileSync(FIXTURE_PATH, JSON.stringify(FIXTURE), "utf8");
  const source = [
    "#!/usr/bin/env node",
    "// A fake `gh` for tests/guard-rerun.test.ts. Answers three JSON calls.",
    'import { appendFileSync, readFileSync } from "node:fs";',
    'const fixture = JSON.parse(readFileSync(process.env.GH_FIXTURE, "utf8"));',
    "const args = process.argv.slice(2);",
    "const say = (value) => process.stdout.write(`${JSON.stringify(value)}\\n`);",
    'if (args[0] === "pr" && args[1] === "list") say(fixture.prs);',
    'else if (args[0] === "run" && args[1] === "list") {',
    '  const branch = args[args.indexOf("--branch") + 1];',
    "  say(fixture.runs[branch] ?? []);",
    '} else if (args[0] === "run" && args[1] === "view") say(fixture.jobs[args[2]] ?? { jobs: [] });',
    'else if (args[0] === "run" && args[1] === "rerun") {',
    '  appendFileSync(process.env.GH_RERUN_LOG, `${args.slice(2).join(" ")}\\n`);',
    '  process.stdout.write("re-run queued\\n");',
    "} else {",
    "  process.stderr.write(`fake gh: unexpected call ${args.join(\" \")}\\n`);",
    "  process.exitCode = 1;",
    "}",
    "",
  ].join("\n");
  // `.mjs` so node reads it as a module whatever the scratch directory's
  // nearest package.json says.
  writeFileSync(join(BIN_DIR, "gh.mjs"), source, "utf8");
  writeFileSync(
    join(BIN_DIR, "gh"),
    ['#!/bin/sh', `exec "${process.execPath}" "${join(BIN_DIR, "gh.mjs")}" "$@"`, ""].join("\n"),
    "utf8",
  );
  chmodSync(join(BIN_DIR, "gh"), 0o755);
}

installFakeGh();

function runSelector(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${BIN_DIR}:${process.env.PATH ?? ""}`,
      GH_FIXTURE: FIXTURE_PATH,
      GH_RERUN_LOG: RERUN_LOG,
    },
  });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

test("--dry-run selects exactly the pull requests whose guard job failed", () => {
  const run = runSelector(["--dry-run"]);
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  const selected = run.stdout.split("\n").filter((line) => line.startsWith("rerun "));
  assert.deepEqual(selected, ["rerun 111 (pr #270, branch aprv-260-guard-log-lag)"]);
  // Nothing was re-run: a dry run is a selection and no more.
  assert.equal(existsSync(RERUN_LOG), false, "a dry run must not call `gh run rerun`");
});

test("the three near misses are each left alone, for their own reason", () => {
  const run = runSelector(["--dry-run"]);
  // 222: the guard job passed. 333: the run is still in flight, and re-running
  // it would race the verdict already coming. 444: something else failed, and
  // a log advance says nothing about it.
  for (const id of ["222", "333", "444"]) {
    assert.equal(run.stdout.includes(id), false, `run ${id} must not be selected`);
  }
});

test("without --dry-run the failed jobs of exactly the selected runs are re-run", () => {
  const run = runSelector([]);
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  const called = readFileSync(RERUN_LOG, "utf8").trim().split("\n");
  // `--failed` and nothing else: the whole run is never re-run, so a passing
  // shard does not pay for the guard's staleness.
  assert.deepEqual(called, ["111 --failed"]);
  assert.match(run.stdout, /re-ran the failed jobs of 111 \(pr #270\)/u);
});

test("the job name the selector looks for is the one ci.yml declares", () => {
  const script = readFileSync(SCRIPT, "utf8");
  const workflow = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  assert.ok(
    script.includes(`"${GUARD_JOB}"`),
    "scripts/guard-rerun.mjs no longer looks for the guard job by its declared name",
  );
  assert.ok(
    workflow.includes(`name: ${GUARD_JOB}`),
    "the protected-path job in ci.yml was renamed; the rerun selector matches jobs BY NAME and would silently select nothing",
  );
});
