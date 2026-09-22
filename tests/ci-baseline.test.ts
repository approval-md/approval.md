/**
 * Known-failure baseline (APRV-426) — a red is a name, never a number.
 *
 * PR #532 was armed for auto-merge and sat about twenty hours red. The lane
 * that opened it had checked its work and reported the full suite at "22
 * failures, exactly the known SMTP baseline". The count was accurate. One of
 * the twenty-two was a new, machine-dependent conformance failure, and it was
 * invisible because a count cannot tell one red from another: two failures
 * swapping places leave the total alone.
 *
 * So the baseline is a list of test ids with an owning task each
 * (`scripts/ci-baseline.json`), a reporter turns a run into ids
 * (`scripts/ci-failure-ids.mjs`), and a comparison names what is new
 * (`scripts/ci-baseline.mjs`, `run-tests.mjs --baseline`). This file holds
 * three properties:
 *
 *   1. the committed list is well formed and bound to reality — every entry
 *      names a built suite and an existing Backlog task, so it rots loudly;
 *   2. loading fails closed on anything malformed, because an empty list
 *      compared against silently reports every failure as new while a typo in
 *      a path produces a report that looks authoritative and checked nothing;
 *   3. the whole path works on a real `node --test` run: a planted failure is
 *      reported by name, a baselined one is not, and a parent that failed only
 *      because its child did is never an id of its own.
 *
 * The third is exercised against a scratch suite spawned through the real
 * runner binary rather than a synthetic event stream, since the shape of
 * `node:test`'s events is exactly the thing this could be wrong about.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

/** The repository root, from `dist/tests/` at runtime. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RUNNER = join(REPO_ROOT, "scripts", "run-tests.mjs");
const BASELINE_MODULE = join(REPO_ROOT, "scripts", "ci-baseline.mjs");
const REPORTER = join(REPO_ROOT, "scripts", "ci-failure-ids.mjs");
const BASELINE_FILE = join(REPO_ROOT, "scripts", "ci-baseline.json");

type Entry = { id: string; task: string; note: string };
type Baseline = { path: string; known: Entry[] };
type Comparison = { new: string[]; known: Entry[]; cleared: Entry[] };

type BaselineModule = {
  DEFAULT_BASELINE: string;
  loadBaseline: (path?: string) => Baseline;
  compareFailures: (failed: readonly string[], baseline: Baseline) => Comparison;
  parseFailureIds: (text: string) => string[];
  formatComparison: (
    comparison: Comparison,
    options?: { baselinePath?: string; total?: number },
  ) => string;
};

type Runner = {
  discoverTestFiles: () => string[];
  parseRunnerArgs: (argv: readonly string[]) => {
    only: string[] | null;
    shard: { index: number; count: number } | null;
    baseline: string | null;
    error: string | null;
  };
};

async function baselineModule(): Promise<BaselineModule> {
  return (await import(pathToFileURL(BASELINE_MODULE).href)) as unknown as BaselineModule;
}

async function runner(): Promise<Runner> {
  return (await import(pathToFileURL(RUNNER).href)) as unknown as Runner;
}

/** A scratch directory for one case. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "approval-md-baseline-"));
}

/**
 * The environment a spawned `node --test` needs, which is this process's
 * MINUS `NODE_TEST_CONTEXT`.
 *
 * A test runner inherited into a child makes node believe the child is already
 * inside a test file, and it answers by printing "run() is being called
 * recursively within a test file" and SKIPPING every file it was given. The
 * child then exits green having run nothing, which is the one way a test of a
 * test runner can pass while proving the opposite of what it claims. Scrubbing
 * the variable is also what reproduces reality: no operator's shell has it.
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["NODE_TEST_CONTEXT"];
  return env;
}

// ---------------------------------------------------------------------------
// The committed list is bound to reality
// ---------------------------------------------------------------------------

test("the committed baseline loads and every entry owns its debt", async () => {
  const { loadBaseline, DEFAULT_BASELINE } = await baselineModule();
  assert.equal(DEFAULT_BASELINE, BASELINE_FILE);
  const baseline = loadBaseline();
  // An EMPTY list is legal and is the goal. An earlier draft of this case
  // asserted the list was non-empty, on the reasoning that APRV-416's SMTP
  // failures are why the file exists — which would have turned the day APRV-416
  // lands and its entries are correctly deleted into a red suite, punishing the
  // fix. PR #536 was open with that fix while this was being written, so the
  // trap was about a week from firing. What is held to here is that every entry
  // present is well formed and owned; how many there are is the debt, not the
  // contract.
  for (const entry of baseline.known) {
    assert.match(entry.task, /^APRV-\d+$/u, `${entry.id} names ${entry.task}, which is not a task id`);
    assert.ok(entry.note.length > 0, `${entry.id} carries no note saying why it fails`);
  }
});

test("every baselined id names a built test suite and an existing task", async () => {
  const { loadBaseline } = await baselineModule();
  const { discoverTestFiles } = await runner();
  const testDir = join(REPO_ROOT, "dist", "tests");
  const suites = new Set(
    discoverTestFiles().map((file) => file.slice(testDir.length + 1, -".test.js".length)),
  );
  // Task files are `<id> - <slug>.md`, lower-cased, across the live and
  // completed trees. A baseline entry pointing at a task nobody can find is a
  // failure with no owner wearing an owner's clothes.
  const taskFiles = ["tasks", "completed", "archive/tasks", "drafts"]
    .flatMap((dir) => {
      try {
        return readdirSync(join(REPO_ROOT, "backlog", dir));
      } catch {
        return [];
      }
    })
    .map((name) => name.toLowerCase());
  for (const entry of loadBaseline().known) {
    const suite = entry.id.slice(0, entry.id.indexOf("::"));
    assert.ok(
      suites.has(suite),
      `scripts/ci-baseline.json names the suite \`${suite}\`, which matched no built test file. A renamed or deleted suite must break the baseline loudly rather than leave a dead entry excusing a failure that can no longer occur.`,
    );
    assert.ok(
      taskFiles.some((name) => name.startsWith(`${entry.task.toLowerCase()} -`)),
      `scripts/ci-baseline.json points ${entry.id} at ${entry.task}, which is not a Backlog task file`,
    );
  }
});

// ---------------------------------------------------------------------------
// Loading fails closed
// ---------------------------------------------------------------------------

test("a malformed baseline is an error, never an empty list", async () => {
  const { loadBaseline } = await baselineModule();
  const dir = scratch();
  const cases: Array<{ name: string; text: string; expected: RegExp }> = [
    { name: "not-json.json", text: "{", expected: /not valid JSON/u },
    { name: "array.json", text: "[]", expected: /must be a JSON object/u },
    { name: "no-list.json", text: '{"known":[]}', expected: /no known_failures array/u },
    {
      name: "entry-not-object.json",
      text: '{"known_failures":["a::b"]}',
      expected: /is not an object/u,
    },
    {
      name: "bad-id.json",
      text: '{"known_failures":[{"id":"no-separator","task":"APRV-1"}]}',
      expected: /well-formed id/u,
    },
    {
      name: "no-task.json",
      text: '{"known_failures":[{"id":"a::b"}]}',
      expected: /names no owning task/u,
    },
    {
      name: "bad-task.json",
      text: '{"known_failures":[{"id":"a::b","task":"someday"}]}',
      expected: /names no owning task/u,
    },
    {
      name: "duplicate.json",
      text: '{"known_failures":[{"id":"a::b","task":"APRV-1"},{"id":"a::b","task":"APRV-2"}]}',
      expected: /repeats the id a::b/u,
    },
  ];
  for (const { name, text, expected } of cases) {
    const path = join(dir, name);
    writeFileSync(path, text, "utf8");
    assert.throws(() => loadBaseline(path), expected, `${name} was accepted`);
  }
  assert.throws(() => loadBaseline(join(dir, "absent.json")), /cannot read/u);
});

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

test("comparison partitions a run's failures into new, known and unseen", async () => {
  const { compareFailures, formatComparison } = await baselineModule();
  const baseline: Baseline = {
    path: "<synthetic>",
    known: [
      { id: "alpha::one", task: "APRV-1", note: "" },
      { id: "alpha::two", task: "APRV-2", note: "" },
    ],
  };
  const comparison = compareFailures(
    // Out of order and with a repeat, which a sharded run can produce.
    ["beta::three", "alpha::one", "beta::three"],
    baseline,
  );
  assert.deepEqual(comparison.new, ["beta::three"]);
  assert.deepEqual(
    comparison.known.map((entry) => entry.id),
    ["alpha::one"],
  );
  assert.deepEqual(
    comparison.cleared.map((entry) => entry.id),
    ["alpha::two"],
  );
  const report = formatComparison(comparison);
  assert.match(report, /NEW failures \(1\)/u);
  assert.match(report, /beta::three/u);
  // The known failure's owner is named in the report, so a reader does not
  // have to open the JSON to learn who owns the debt.
  assert.match(report, /alpha::one {2}\[APRV-1\]/u);

  // The whole point: the same TOTAL, a different set, and the report says so.
  const swapped = compareFailures(["alpha::one", "gamma::four"], baseline);
  assert.deepEqual(swapped.new, ["gamma::four"]);
  assert.equal(
    compareFailures(["alpha::one", "alpha::two"], baseline).new.length,
    0,
    "two known failures must not be reported as new",
  );
});

test("an all-known run still reports, and the report never claims success", async () => {
  const { compareFailures, formatComparison } = await baselineModule();
  const baseline: Baseline = { path: "<synthetic>", known: [{ id: "a::b", task: "APRV-1", note: "" }] };
  const report = formatComparison(compareFailures(["a::b"], baseline), { total: 1 });
  assert.match(report, /1 failing test /u);
  assert.match(report, /new failures: none/u);
  assert.doesNotMatch(report, /pass|green|success/iu);
});

// ---------------------------------------------------------------------------
// The reporter, against a real node:test run
// ---------------------------------------------------------------------------

/**
 * Run a scratch suite under the real reporter and return the ids it wrote.
 *
 * Spawned rather than driven with a synthetic event stream on purpose: the
 * event shape is what this could be wrong about, so the assertion has to come
 * from `node:test` itself.
 */
function idsFromScratchSuite(source: string): string[] {
  const dir = scratch();
  const file = join(dir, "scratch.test.mjs");
  const ids = join(dir, "ids.txt");
  writeFileSync(file, source, "utf8");
  spawnSync(
    process.execPath,
    [
      "--test",
      `--test-reporter=${pathToFileURL(REPORTER).href}`,
      `--test-reporter-destination=${ids}`,
      file,
    ],
    { encoding: "utf8", env: cleanEnv() },
  );
  return readFileSync(ids, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

test("the reporter names leaf failures and never a parent that only held one", () => {
  const ids = idsFromScratchSuite(
    [
      'import assert from "node:assert/strict";',
      'import { describe, test } from "node:test";',
      'test("a passing case", () => { assert.ok(true); });',
      'test("a failing case", () => { assert.equal(1, 2); });',
      'describe("a group", () => {',
      '  test("a nested failure", () => { assert.ok(false); });',
      "});",
      'test("a parent", async (t) => { await t.test("an inner failure", () => { assert.ok(false); }); });',
      "",
    ].join("\n"),
  );
  const names = ids.map((id) => id.slice(id.indexOf("::") + 2));
  assert.deepEqual(
    [...names].sort(),
    ["a failing case", "a group > a nested failure", "a parent > an inner failure"],
    `the reporter emitted ${JSON.stringify(ids)}. It must name every leaf failure with its ancestor path, name no passing test, and never emit an id for a parent whose own failure was only that a child failed.`,
  );
  // A file outside dist/tests keeps an honest suite half rather than a
  // fabricated one; what matters is that the separator is always present.
  for (const id of ids) assert.ok(id.includes("::"), `${id} has no suite separator`);
});

test("the same failures produce the same ids on a second run", () => {
  const source = [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'test("one", () => { assert.ok(false); });',
    'test("two", () => { assert.ok(false); });',
    "",
  ].join("\n");
  const first = idsFromScratchSuite(source).map((id) => id.slice(id.indexOf("::")));
  const second = idsFromScratchSuite(source).map((id) => id.slice(id.indexOf("::")));
  assert.deepEqual(
    first.sort(),
    second.sort(),
    "ids must be deterministic: a baseline compared against a run whose ids move is a baseline that never matches",
  );
});

// ---------------------------------------------------------------------------
// End to end: ids file plus baseline, through the standalone CLI
// ---------------------------------------------------------------------------

test("the standalone comparison exits non-zero exactly when a failure is new", () => {
  const dir = scratch();
  const ids = join(dir, "ids.txt");
  const baseline = join(dir, "baseline.json");
  writeFileSync(ids, "alpha::known\nbeta::fresh\n", "utf8");
  writeFileSync(
    baseline,
    JSON.stringify({ known_failures: [{ id: "alpha::known", task: "APRV-416", note: "n" }] }),
    "utf8",
  );

  const withNew = spawnSync(process.execPath, [BASELINE_MODULE, ids, baseline], { encoding: "utf8" });
  assert.equal(withNew.status, 1, withNew.stderr);
  assert.match(withNew.stdout, /NEW failures \(1\)/u);
  assert.match(withNew.stdout, /beta::fresh/u);

  writeFileSync(ids, "alpha::known\n", "utf8");
  const allKnown = spawnSync(process.execPath, [BASELINE_MODULE, ids, baseline], { encoding: "utf8" });
  assert.equal(allKnown.status, 0, allKnown.stderr);
  assert.match(allKnown.stdout, /new failures: none/u);

  // A baseline that cannot be read is an error, not a clean bill of health.
  const broken = spawnSync(process.execPath, [BASELINE_MODULE, ids, join(dir, "absent.json")], {
    encoding: "utf8",
  });
  assert.equal(broken.status, 2);
  assert.match(broken.stderr, /cannot read/u);
});

// ---------------------------------------------------------------------------
// The runner's flag
// ---------------------------------------------------------------------------

test("--baseline parses, defaults to the committed list, and never eats an --only name", async () => {
  const { parseRunnerArgs } = await runner();
  const bare = parseRunnerArgs(["--baseline"]);
  assert.equal(bare.error, null);
  assert.equal(bare.baseline, BASELINE_FILE);

  const named = parseRunnerArgs(["--baseline=/tmp/other.json"]);
  assert.equal(named.error, null);
  assert.equal(named.baseline, "/tmp/other.json");

  // `--only a b --baseline` must leave the set at exactly {a, b}: a flag that
  // silently joined the name list would shrink the run it was asked to check.
  const withOnly = parseRunnerArgs(["--only", "docs-guard", "ci-guard", "--baseline"]);
  assert.equal(withOnly.error, null);
  assert.deepEqual(withOnly.only, ["docs-guard", "ci-guard"]);
  assert.equal(withOnly.baseline, BASELINE_FILE);

  // And an empty path is refused rather than resolved to the working directory.
  assert.match(String(parseRunnerArgs(["--baseline="]).error), /requires a path/u);

  // Unchanged: no baseline asked for, none applied.
  assert.equal(parseRunnerArgs([]).baseline, null);
});

test("--baseline changes which failures are named, never which files run", async () => {
  const { parseRunnerArgs } = await runner();
  const plain = parseRunnerArgs(["--shard", "2/3"]);
  const baselined = parseRunnerArgs(["--shard", "2/3", "--baseline"]);
  assert.deepEqual(plain.shard, baselined.shard);
  assert.deepEqual(plain.only, baselined.only);
  assert.equal(plain.error, null);
  assert.equal(baselined.error, null);
});

test("--baseline on a green selection reports no new failures and stays green", () => {
  // `version` is a small, fast, reliably green suite; the property under test
  // is that adding the flag neither changes the exit code nor invents a
  // failure, which needs a suite that passes.
  const result = spawnSync(process.execPath, [RUNNER, "--only", "version", "--baseline"], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: cleanEnv(),
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /new failures: none/u);
});
