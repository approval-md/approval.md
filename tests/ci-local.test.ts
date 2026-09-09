/**
 * Pre-push CI parity (APRV-275).
 *
 * `npm run ci:local` is worth having only if the tier it runs is the tier the
 * workflow would run. A local script that guessed differently would be worse
 * than no script: a lane would read green, push, and lose a merge-queue slot to
 * the suite it thought it had already run.
 *
 * So the parity is asserted from both ends. The tier comes out of real git
 * diffs in throwaway repositories, classified by both `scripts/ci-local.mjs`
 * and `scripts/classify-tier.mjs`, which must agree; and the STEPS come out of
 * the checked-in bytes of `.github/workflows/ci.yml`, parsed with the same
 * hardened parser `tests/ci-guard.test.ts` uses, so a job whose command changes
 * in the workflow and not in the script is a red test here rather than a
 * surprise in the queue.
 *
 * The fixture repositories are the same device `tests/classify-tier.test.ts`
 * uses for the same reason: both scripts classify the repository they live in,
 * so a copy of them inside a throwaway repository is the only way to put a diff
 * of our choosing in front of the real code path.
 *
 * The script is spawned rather than imported wherever a verdict is under test,
 * because what `npm run ci:local` runs is the process. The one import is the
 * frozen platform table, which is data and not a verdict, and which has to be
 * readable on Linux too or the staleness check would be vacuous in CI.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

import { parseHardenedYaml } from "../src/core/policy-load.js";

/** The repository root, from `dist/tests/` at runtime. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CI_LOCAL = join(REPO_ROOT, "scripts", "ci-local.mjs");
const CLASSIFIER = join(REPO_ROOT, "scripts", "classify-tier.mjs");
const WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "ci.yml");

interface PlanStep {
  readonly id: string;
  readonly ci: string;
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly kind: string;
}

interface Plan {
  readonly tier: string;
  readonly reason: string;
  readonly source: string;
  readonly base: string | null;
  readonly guardBase: string | null;
  readonly paths: readonly string[];
  readonly host: { platform: string; node: string; isCiPlatform: boolean };
  readonly shardCount: number;
  readonly steps: readonly PlanStep[];
  readonly platformSensitive: ReadonlyArray<{ suite: string; file: string; why: string }>;
  readonly deviations: readonly string[];
  readonly notes: readonly string[];
}

interface CiLocalModule {
  readonly SHARD_COUNT: number;
  readonly PLATFORM_SENSITIVE_SUITES: ReadonlyArray<{
    suite: string;
    file: string;
    why: string;
  }>;
  readonly failingFiles: (output: string) => readonly string[];
}

const ciLocal = (await import(pathToFileURL(CI_LOCAL).href)) as CiLocalModule;

// ---------------------------------------------------------------------------
// The workflow, as data
// ---------------------------------------------------------------------------

function workflowJob(name: string): Record<string, unknown> {
  const parsed = parseHardenedYaml(readWorkflow(), {
    subject: "workflow YAML",
    tagContext: "a workflow file",
  });
  assert.ok(parsed.ok, ".github/workflows/ci.yml does not parse under the hardened settings");
  const value = parsed.value as Record<string, unknown>;
  const jobs = value["jobs"] as Record<string, unknown>;
  const entry = jobs[name];
  assert.ok(
    typeof entry === "object" && entry !== null,
    `.github/workflows/ci.yml no longer declares the \`${name}\` job`,
  );
  return entry as Record<string, unknown>;
}

function readWorkflow(): string {
  return readFileSync(WORKFLOW_PATH, "utf8");
}

/** Every `run:` string a job declares, in order. */
function runCommands(jobName: string): string[] {
  const steps = workflowJob(jobName)["steps"];
  assert.ok(Array.isArray(steps), `the \`${jobName}\` job declares no steps`);
  const out: string[] = [];
  for (const step of steps as unknown[]) {
    if (typeof step !== "object" || step === null) continue;
    const run = (step as Record<string, unknown>)["run"];
    if (typeof run === "string") out.push(run.trim());
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fixture repositories: a real git diff of our choosing
// ---------------------------------------------------------------------------

interface Fixture {
  readonly dir: string;
  readonly base: string;
}

/**
 * The environment a spawned `ci-local` gets, with this runner's own context
 * removed.
 *
 * `node --test` sets `NODE_TEST_CONTEXT` for each test file it runs, and the
 * variable is inherited by everything that file spawns. A grandchild
 * `node --test` that sees it believes it is a child of a runner, reports its
 * results over IPC, and exits 0 whatever they were. Nothing about the script
 * depends on this — a lane runs it from a shell — but a test that did not strip
 * it would be asserting on a red run that could never go red.
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["NODE_TEST_CONTEXT"];
  return env;
}

const scratchDirs: string[] = [];

function makeFixture(files: Readonly<Record<string, string>>): Fixture {
  // realpath: on macOS the temp root is itself a symlink, and both scripts run
  // their CLI only when argv[1] resolves to their own module URL.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ci-local-")));
  scratchDirs.push(dir);
  const gitIn = (args: readonly string[]): string => {
    const result = spawnSync("git", [...args], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout;
  };
  gitIn(["init", "-q"]);
  gitIn(["config", "user.email", "ci-local@example.invalid"]);
  gitIn(["config", "user.name", "ci-local test"]);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  copyFileSync(CLASSIFIER, join(dir, "scripts", "classify-tier.mjs"));
  copyFileSync(CI_LOCAL, join(dir, "scripts", "ci-local.mjs"));
  gitIn(["add", "-A"]);
  gitIn(["commit", "-qm", "base"]);
  const base = gitIn(["rev-parse", "HEAD"]).trim();

  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), contents);
  }
  gitIn(["add", "-A"]);
  gitIn(["commit", "-qm", "the change under test"]);
  return { dir, base };
}

/**
 * A fixture for the read-only cases, built once per change set. Every case
 * below that only classifies is asking the same question of the same diff, and
 * a fresh `git init` per assertion buys nothing but seconds in the shard this
 * file lands in. The cases that WRITE into a fixture take a fresh one.
 */
const sharedFixtures = new Map<string, Fixture>();

function sharedFixture(files: Readonly<Record<string, string>>): Fixture {
  const key = JSON.stringify(files);
  const existing = sharedFixtures.get(key);
  if (existing !== undefined) return existing;
  const made = makeFixture(files);
  sharedFixtures.set(key, made);
  return made;
}

function planOf(fixture: Fixture, extra: readonly string[] = []): Plan {
  const result = spawnSync(
    process.execPath,
    [
      join(fixture.dir, "scripts", "ci-local.mjs"),
      "--base",
      fixture.base,
      "--json",
      ...extra,
    ],
    { cwd: fixture.dir, encoding: "utf8", env: cleanEnv() },
  );
  assert.equal(result.status, 0, `ci-local failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as Plan;
}

function classifierTier(fixture: Fixture): string {
  const result = spawnSync(
    process.execPath,
    [join(fixture.dir, "scripts", "classify-tier.mjs"), "--base", fixture.base],
    { cwd: fixture.dir, encoding: "utf8", env: cleanEnv() },
  );
  assert.equal(result.status, 0, `classify-tier failed: ${result.stderr}`);
  return result.stdout.trim();
}

function stepIds(plan: Plan): string[] {
  return plan.steps.map((step) => step.id);
}

// ---------------------------------------------------------------------------
// The fixture diffs: docs-only, src, and mixed, plus records for the third
// tier, since a tier with no fixture is a tier nothing here proves.
// ---------------------------------------------------------------------------

const DOCS_ONLY: Readonly<Record<string, string>> = {
  "docs/pre-push.md": "# a page\n",
  "README.md": "# a readme\n",
};

const SRC: Readonly<Record<string, string>> = {
  "src/core/thing.ts": "export const thing = 1;\n",
};

const MIXED: Readonly<Record<string, string>> = { ...DOCS_ONLY, ...SRC };

const RECORDS: Readonly<Record<string, string>> = {
  "backlog/tasks/aprv-999 - a record.md": "---\nid: APRV-999\n---\n",
  "MILESTONES.md": "# milestones\n",
};

test("a docs-only diff takes the light tier, and the classifier agrees", () => {
  const fixture = sharedFixture(DOCS_ONLY);
  const plan = planOf(fixture);
  assert.equal(plan.tier, "light");
  assert.equal(
    plan.tier,
    classifierTier(fixture),
    "ci-local and the classifier CI asks disagreed about the same diff",
  );
  assert.deepEqual(stepIds(plan), ["build", "protected-paths", "doc-guard"]);
});

test("a src diff takes the full tier and plans every shard, and the classifier agrees", () => {
  const fixture = sharedFixture(SRC);
  const plan = planOf(fixture);
  assert.equal(plan.tier, "full");
  assert.equal(plan.tier, classifierTier(fixture));
  assert.deepEqual(stepIds(plan), [
    "build",
    "protected-paths",
    "full-shard-1",
    "full-shard-2",
    "full-shard-3",
    "lint",
  ]);
  assert.equal(plan.shardCount, 3);
});

test("a mixed diff takes the full tier, not the light tier its docs half would earn", () => {
  const fixture = sharedFixture(MIXED);
  const plan = planOf(fixture);
  assert.equal(plan.tier, "full");
  assert.equal(plan.tier, classifierTier(fixture));
  assert.ok(
    stepIds(plan).includes("full-shard-3"),
    "a mixed change ran something smaller than the full gate",
  );
});

test("a records-only diff takes the records tier and runs the reading tests", () => {
  const fixture = sharedFixture(RECORDS);
  const plan = planOf(fixture);
  assert.equal(plan.tier, "records");
  assert.equal(plan.tier, classifierTier(fixture));
  assert.deepEqual(stepIds(plan), ["build", "protected-paths", "records"]);
});

test("the protected-path cross-check is planned on every tier, as the workflow runs it", () => {
  // `if: always()` in the workflow: the tier says how much suite a change
  // needs, this says whether a change was consented to, and the two are
  // independent questions.
  assert.equal(String(workflowJob("protected-paths")["if"]), "always()");
  for (const files of [DOCS_ONLY, SRC, MIXED, RECORDS]) {
    const plan = planOf(sharedFixture(files));
    assert.ok(
      stepIds(plan).includes("protected-paths"),
      `the ${plan.tier} tier's plan left the grant cross-check out`,
    );
    assert.notEqual(plan.guardBase, null, "a merge base was computable and was not used");
  }
});

test("explicit paths classify without git, and say the cross-check is not in the plan", () => {
  const result = spawnSync(
    process.execPath,
    [CI_LOCAL, "--json", "docs/a.md", "README.md"],
    { cwd: REPO_ROOT, encoding: "utf8", env: cleanEnv() },
  );
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout) as Plan;
  assert.equal(plan.tier, "light");
  assert.equal(plan.guardBase, null);
  assert.ok(!stepIds(plan).includes("protected-paths"));
  assert.ok(
    plan.deviations.some((line) =>
      line.includes("protected-path cross-check is NOT in this plan"),
    ),
    "a plan missing the cross-check must say so rather than read as a complete run",
  );
});

// ---------------------------------------------------------------------------
// Parity with the checked-in workflow
// ---------------------------------------------------------------------------

function commandOf(plan: Plan, id: string): string {
  const step = plan.steps.find((entry) => entry.id === id);
  assert.ok(step !== undefined, `the plan has no \`${id}\` step`);
  return `${step.command} ${step.args.join(" ")}`;
}

test("the light tier runs the command the doc-guard job runs", () => {
  const plan = planOf(sharedFixture(DOCS_ONLY));
  assert.ok(
    runCommands("doc-guard").includes(commandOf(plan, "doc-guard")),
    "the docs guard command drifted from the workflow's doc-guard job",
  );
});

test("the records tier runs the command the records job runs", () => {
  const plan = planOf(sharedFixture(RECORDS));
  assert.ok(
    runCommands("records").includes(commandOf(plan, "records")),
    "the records command drifted from the workflow's records job",
  );
});

test("the full tier's shards and lint are the full job's commands, one per shard", () => {
  const plan = planOf(sharedFixture(SRC));
  const declared = runCommands("full");
  const found: string | undefined = declared.find((command) => command.includes("--shard"));
  assert.ok(found !== undefined, "the full job no longer shards");
  const template: string = found;
  for (let index = 1; index <= plan.shardCount; index += 1) {
    const expected: string = template.replaceAll("${{ matrix.shard }}", String(index));
    assert.equal(
      commandOf(plan, `full-shard-${String(index)}`),
      expected,
      "a shard command drifted from the workflow's full job",
    );
  }
  assert.ok(declared.includes(commandOf(plan, "lint")), "lint drifted from the workflow");
});

test("the shard count is the matrix the workflow declares", () => {
  const strategy = workflowJob("full")["strategy"] as Record<string, unknown>;
  const matrix = strategy["matrix"] as Record<string, unknown>;
  const shards = matrix["shard"];
  assert.ok(Array.isArray(shards), "the full job's matrix declares no shard axis");
  assert.equal(
    ciLocal.SHARD_COUNT,
    shards.length,
    "scripts/ci-local.mjs would run a different number of shards than the matrix has, so a lane would prove a fraction of the suite and read it as the whole gate",
  );
  assert.deepEqual(
    [...shards].map(Number),
    Array.from({ length: ciLocal.SHARD_COUNT }, (_value, index) => index + 1),
  );
});

test("the workflow still declares the Node 20 floor the local run cannot reproduce", () => {
  const floor = workflowJob("full-floor");
  assert.ok("strategy" in floor, "the floor leg stopped being a matrix");
  const plan = planOf(sharedFixture(SRC));
  const major = Number(plan.host.node.split(".")[0]);
  if (major !== 20) {
    assert.ok(
      plan.deviations.some((line) => line.includes("Node 20 floor")),
      "a host that is not the floor must say the floor legs were not reproduced",
    );
  }
});

// ---------------------------------------------------------------------------
// The platform report
// ---------------------------------------------------------------------------

test("every platform-sensitive suite named is a file that still exists", () => {
  // The check that keeps the table honest, and it runs on Linux too: a report
  // whose entries have been renamed away is a reassuring line about nothing.
  assert.ok(ciLocal.PLATFORM_SENSITIVE_SUITES.length > 0);
  for (const entry of ciLocal.PLATFORM_SENSITIVE_SUITES) {
    assert.ok(
      existsSync(join(REPO_ROOT, entry.file)),
      `${entry.file} is named as platform-sensitive and does not exist`,
    );
    assert.equal(entry.file, `tests/${entry.suite}.test.ts`);
    assert.ok(entry.why.length > 20, `${entry.file} is named with no reason given`);
  }
});

test("the platform report names the sensitive suites off Linux and nothing on it", () => {
  const plan = planOf(sharedFixture(SRC));
  if (plan.host.platform === "linux") {
    assert.deepEqual(
      plan.platformSensitive,
      [],
      "CI's own platform has nothing to warn about",
    );
    assert.equal(plan.host.isCiPlatform, true);
    return;
  }
  assert.equal(plan.host.isCiPlatform, false);
  assert.deepEqual(
    plan.platformSensitive.map((entry) => entry.file),
    ciLocal.PLATFORM_SENSITIVE_SUITES.map((entry) => entry.file),
    "the full tier runs every file, so every sensitive suite is at stake",
  );
  const temp = plan.platformSensitive.find((entry) => entry.suite === "cli-hook-scratch");
  assert.ok(temp !== undefined, "the temp-root suite is the one this warning exists for");
  assert.match(temp.why, /temp root/u);
});

test("a cheap tier reports only the sensitive suites it actually runs", () => {
  const plan = planOf(sharedFixture(DOCS_ONLY));
  assert.deepEqual(
    plan.platformSensitive,
    [],
    "the light tier runs the docs guard, which is not platform-sensitive; warning about suites it never runs is noise",
  );
});

// ---------------------------------------------------------------------------
// Red is red, and it names files
// ---------------------------------------------------------------------------

test("failingFiles reads the reporters both supported Node majors use", () => {
  const tap = ciLocal.failingFiles(
    ["ok 1 - dist/tests/a.test.js", "not ok 2 - dist/tests/b.test.js", "  ..."].join("\n"),
  );
  assert.deepEqual(tap, ["dist/tests/b.test.js"]);

  const spec = ciLocal.failingFiles(
    ["✖ failing tests:", "", "test at dist/tests/c.test.js:12:1", "✖ a case (1ms)"].join("\n"),
  );
  assert.deepEqual(spec, ["dist/tests/c.test.js"]);

  const tsc = ciLocal.failingFiles("src/core/gate.ts(4,1): error TS2322: nope\n");
  assert.deepEqual(tsc, ["src/core/gate.ts"]);

  assert.deepEqual(
    ciLocal.failingFiles("everything is fine\n"),
    [],
    "no shape recognised must yield no name, never a guess",
  );
});

test("a red step exits non-zero and names the file that failed", () => {
  // End to end, with a real child process going red: the light tier's one test
  // command, pointed at a file that fails on purpose. The fixture carries the
  // TypeScript source too, so the summary is asserted to name what a lane would
  // open rather than the build output it ran.
  const fixture = makeFixture(DOCS_ONLY);
  writeFileSync(
    join(fixture.dir, "package.json"),
    `${JSON.stringify(
      {
        name: "ci-local-fixture",
        private: true,
        type: "module",
        scripts: { build: "node scripts/stub-build.mjs" },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(fixture.dir, "scripts", "stub-build.mjs"), "process.exit(0);\n");
  mkdirSync(join(fixture.dir, "dist", "tests"), { recursive: true });
  mkdirSync(join(fixture.dir, "tests"), { recursive: true });
  writeFileSync(join(fixture.dir, "tests", "docs-guard.test.ts"), "// the source\n");
  writeFileSync(
    join(fixture.dir, "dist", "tests", "docs-guard.test.js"),
    [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'test("this fixture fails on purpose", () => {',
      "  assert.equal(1, 2);",
      "});",
      "",
    ].join("\n"),
  );

  const result = spawnSync(
    process.execPath,
    [join(fixture.dir, "scripts", "ci-local.mjs"), "docs/pre-push.md"],
    { cwd: fixture.dir, encoding: "utf8", env: cleanEnv() },
  );
  assert.equal(result.status, 1, `a red suite must exit non-zero, got ${String(result.status)}`);
  assert.match(result.stdout, /1 step\(s\) red/u);
  assert.match(
    result.stdout,
    /tests\/docs-guard\.test\.ts/u,
    "a red run must name the file, and name the source a lane would open",
  );
});

test("a green run of a cheap tier exits zero and says so", () => {
  const fixture = makeFixture(DOCS_ONLY);
  writeFileSync(
    join(fixture.dir, "package.json"),
    `${JSON.stringify(
      {
        name: "ci-local-fixture",
        private: true,
        type: "module",
        scripts: { build: "node scripts/stub-build.mjs" },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(fixture.dir, "scripts", "stub-build.mjs"), "process.exit(0);\n");
  mkdirSync(join(fixture.dir, "dist", "tests"), { recursive: true });
  writeFileSync(
    join(fixture.dir, "dist", "tests", "docs-guard.test.js"),
    ['import { test } from "node:test";', 'test("green", () => {});', ""].join("\n"),
  );

  const result = spawnSync(
    process.execPath,
    [join(fixture.dir, "scripts", "ci-local.mjs"), "docs/pre-push.md"],
    { cwd: fixture.dir, encoding: "utf8", env: cleanEnv() },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /every step this host can run is green/u);
});

test("a build that fails stops the run rather than reporting on a stale tree", () => {
  const fixture = makeFixture(DOCS_ONLY);
  writeFileSync(
    join(fixture.dir, "package.json"),
    `${JSON.stringify(
      {
        name: "ci-local-fixture",
        private: true,
        type: "module",
        scripts: { build: "node scripts/stub-build.mjs" },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(fixture.dir, "scripts", "stub-build.mjs"),
    'process.stdout.write("src/core/gate.ts(4,1): error TS2322: nope\\n");\nprocess.exit(2);\n',
  );

  const result = spawnSync(
    process.execPath,
    [join(fixture.dir, "scripts", "ci-local.mjs"), "docs/pre-push.md"],
    { cwd: fixture.dir, encoding: "utf8", env: cleanEnv() },
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /build failed/u);
  assert.match(result.stdout, /src\/core\/gate\.ts/u);
});

// ---------------------------------------------------------------------------
// The usual refusals
// ---------------------------------------------------------------------------

test("two different change sets at once is a usage error, not a guess", () => {
  const result = spawnSync(
    process.execPath,
    [CI_LOCAL, "--working-tree", "docs/a.md"],
    { cwd: REPO_ROOT, encoding: "utf8", env: cleanEnv() },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /two different change sets/u);
});

test("an unknown option is refused rather than ignored", () => {
  const result = spawnSync(process.execPath, [CI_LOCAL, "--fast"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: cleanEnv(),
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown option --fast/u);
});

test("the package exposes the script as ci:local", () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(manifest.scripts["ci:local"], "node scripts/ci-local.mjs");
});

process.on("exit", () => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});
