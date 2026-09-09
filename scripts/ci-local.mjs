#!/usr/bin/env node
/**
 * Pre-push CI parity (APRV-275): run the tier CI would select, here.
 *
 * The merge queue is serial. Every red run costs a queue slot, a re-merge and
 * another wait, and most of the reds this repository has collected were things
 * a laptop could have said first: a row-count pin missed on one platform, a
 * test coupled to the live policy, a conformance manifest regenerated on two
 * branches. What stopped a lane from running the gate locally was not the
 * suite, it was not knowing which suite: `npm test` is neither what a docs-only
 * change gets nor what a src change gets, and reconstructing the workflow's
 * job list by hand is exactly the kind of copy that drifts.
 *
 * So this script does not decide anything. It asks the same classifier the
 * `classify` job asks, by spawning the same command with the same arguments,
 * applies the same fail-closed rule to the answer, and then runs the jobs the
 * workflow declares for that tier. Where the laptop cannot reproduce a CI job,
 * it says so in the report rather than passing quietly: a Node 20 floor leg on
 * a Node 24 host, a temp-root shape that only exists on Linux, a protected-path
 * cross-check with no merge base to read.
 *
 * ## What it is not
 *
 * It is not a gate and it cannot become one. Nothing here is consulted by CI,
 * by the merge queue, or by the policy; a green run locally is a prediction,
 * and the workflow remains the verdict. That direction matters: a local script
 * that could be *believed* over CI would be a tier-selection surface inside an
 * agent's reach, which is the authority `scripts/classify-tier.mjs` exists to
 * keep out of agent hands. This one only ever runs more work, never less.
 *
 * Usage:
 *   node scripts/ci-local.mjs                  classify origin/main...HEAD, run that tier
 *   node scripts/ci-local.mjs --base <ref>     classify <ref>...HEAD instead
 *   node scripts/ci-local.mjs --working-tree   classify the working tree
 *   node scripts/ci-local.mjs <path>...        classify explicit paths
 *   ... --dry-run                              print the plan, run nothing
 *   ... --json                                 the plan as JSON (implies --dry-run)
 *   ... --parallel                             run the tier's jobs concurrently, as the matrix does
 *
 * Exit codes: 0 every step green, 1 any step red, 2 usage.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { RECORDS_TESTS } from "./classify-tier.mjs";

/** The repository root, from `scripts/` at runtime. */
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

const CLASSIFIER = "scripts/classify-tier.mjs";
const RUNNER = "scripts/run-tests.mjs";
const GUARD = "scripts/protected-path-guard.mjs";

const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

const EXIT_OK = 0;
const EXIT_RED = 1;
const EXIT_USAGE = 2;

/**
 * How many shards the full gate's matrix has.
 *
 * The number is duplicated from `.github/workflows/ci.yml` because a script
 * cannot read a workflow's matrix without a YAML parser it has no business
 * carrying. The duplication is not left to trust: `tests/ci-local.test.ts`
 * parses the checked-in workflow and asserts this constant is the matrix it
 * declares, so a change to one that is not made in the other is a red test
 * rather than a lane running two thirds of the suite.
 */
export const SHARD_COUNT = 3;

/** The three tiers, in the order they escalate. */
const TIERS = Object.freeze(["light", "records", "full"]);

// ---------------------------------------------------------------------------
// The platform report
// ---------------------------------------------------------------------------

/**
 * Suites whose meaning depends on the host, with what a non-Linux host cannot
 * prove about each. CI runs on `ubuntu-latest`, so a green run here is a
 * weaker statement than a green run there for exactly these files.
 *
 * The list is frozen, and every entry names a real file: the test asserts each
 * path exists, so a rename retires the entry loudly instead of leaving a
 * reassuring line that refers to nothing. Each `why` is the file's own reason,
 * taken from the comment in the test that states it.
 */
export const PLATFORM_SENSITIVE_SUITES = Object.freeze([
  Object.freeze({
    suite: "cli-hook-scratch",
    file: "tests/cli-hook-scratch.test.ts",
    why: "the temp root: on Linux os.tmpdir() IS /tmp, one segment, which is the shape the scratch depth floor once refused; elsewhere the root arrives through a symlink and is resolved to another name before any rule sees it. One case is skipped outright off darwin.",
  }),
  Object.freeze({
    suite: "verified-snapshot",
    file: "tests/verified-snapshot.test.ts",
    why: "the symlink-alias case: /var/folders/... and /private/var/folders/... are one directory on macOS and the test builds that aliasing by hand. On Linux it proves the resolution, not the aliasing that motivated it.",
  }),
  Object.freeze({
    suite: "cli-env",
    file: "tests/cli-env.test.ts",
    why: "the keychain source: macOS has `security` and Linux has no such binary at all, so the two hosts exercise different halves of the environment source map.",
  }),
  Object.freeze({
    suite: "cli-prompt",
    file: "tests/cli-prompt.test.ts",
    why: "terminal behaviour: macOS sends EOT the moment stdin is a pipe, which is not when Linux sends it.",
  }),
  Object.freeze({
    suite: "cli-doctor",
    file: "tests/cli-doctor.test.ts",
    why: "port binding: binding 80 fails EACCES on a developer box and succeeds in a root container, so the row under test resolves differently on each.",
  }),
  Object.freeze({
    suite: "live-draw",
    file: "tests/live-draw.test.ts",
    why: "a Unix socket address is 104 bytes on macOS and 108 on Linux, so the scratch-root length this suite works around is a per-platform limit.",
  }),
]);

/** The `--only` name of a `tests/<name>.test.ts` path. */
function suiteName(file) {
  return file.slice("tests/".length, -".test.ts".length);
}

/** Is this host the one CI runs on? */
export function isCiPlatform(platform = process.platform) {
  return platform === "linux";
}

/**
 * The platform-sensitive suites this plan will actually run, so the report
 * names what is at stake in THIS run rather than reciting the whole table
 * under a docs-only diff that runs none of them.
 */
export function platformReport(tier, platform = process.platform) {
  if (isCiPlatform(platform)) return [];
  const names = tierSuiteNames(tier);
  if (names === null) return [...PLATFORM_SENSITIVE_SUITES];
  const running = new Set(names);
  return PLATFORM_SENSITIVE_SUITES.filter((entry) => running.has(suiteName(entry.file)));
}

/**
 * Which suites a tier runs, by `--only` name, or `null` for "all of them".
 * The full tier's shards are a partition of the whole suite, so every file
 * runs; the cheap tiers name their sets.
 */
function tierSuiteNames(tier) {
  if (tier === "light") return ["docs-guard"];
  if (tier === "records") return [...RECORDS_TESTS];
  return null;
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

function git(args) {
  const result = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) return null;
  return result.stdout.trim();
}

/**
 * The commit the protected-path guard should read from, or `null` when this
 * checkout cannot answer. The workflow computes `git merge-base <target> HEAD`
 * and this does the same; a detached, shallow or fresh checkout with no such
 * ancestor gets a named refusal to compute rather than a guess.
 */
function mergeBase(ref) {
  return git(["merge-base", ref, "HEAD"]);
}

// ---------------------------------------------------------------------------
// Tier selection: the classifier, spawned exactly as the workflow spawns it
// ---------------------------------------------------------------------------

/**
 * Ask `scripts/classify-tier.mjs` for the verdict, then apply the workflow's
 * own fail-closed rule to the answer.
 *
 * The classifier is spawned rather than imported on purpose. The `classify`
 * job runs `node scripts/classify-tier.mjs --base "$base" --json` and reads its
 * stdout; running the same process with the same arguments makes an argv or
 * exit-code difference visible here instead of after a push, and it means this
 * script holds no copy of a path rule that could drift from the one CI reads.
 */
export function selectTier(source) {
  const args = [join(REPO_ROOT, CLASSIFIER), ...classifierArgs(source), "--json"];
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.error !== undefined || result.status !== 0) {
    return {
      tier: "full",
      reason: "classifier-unreadable",
      paths: [],
      classifier: args.slice(1),
    };
  }
  let verdict;
  try {
    verdict = JSON.parse(result.stdout);
  } catch {
    return {
      tier: "full",
      reason: "classifier-output-unparseable",
      paths: [],
      classifier: args.slice(1),
    };
  }
  // The workflow's `case` statement, verbatim in intent: anything that is not
  // one of the three known words is the full tier.
  const tier = TIERS.includes(verdict.tier) ? verdict.tier : "full";
  return {
    tier,
    reason: tier === verdict.tier ? String(verdict.reason) : "unrecognised-tier",
    paths: Array.isArray(verdict.paths) ? verdict.paths.map(String) : [],
    classifier: args.slice(1),
  };
}

/** The argv the classifier gets for this path source. */
function classifierArgs(source) {
  if (source.paths.length > 0) return [...source.paths];
  if (source.workingTree) return ["--working-tree"];
  return ["--base", source.base];
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * One step: what to run, which workflow job it stands in for, and how to read
 * a failure out of its output. `ci` is the job name in
 * `.github/workflows/ci.yml`, which is what the parity test joins on.
 */
function step(id, ci, name, command, args, kind = "generic") {
  return Object.freeze({ id, ci, name, command, args, kind });
}

/**
 * The plan for a tier: the jobs `.github/workflows/ci.yml` declares for it,
 * in an order a laptop can run them in.
 *
 * Every job compiles first in the workflow, once per job; here one build
 * serves every step, because they all read the same `dist/` and a second `tsc`
 * over an unchanged tree cannot fail where the first passed. That, and the
 * other three places this deliberately differs from the matrix, are listed in
 * {@link deviations} and printed with the plan.
 */
export function planFor(tier, options) {
  const steps = [
    step("build", "*", "build (every CI job compiles before it runs anything)", NPM, [
      "run",
      "build",
    ]),
  ];

  const guardBase = options.guardBase;
  if (guardBase !== null) {
    steps.push(
      step(
        "protected-paths",
        "protected-paths",
        "protected paths (grant cross-check)",
        process.execPath,
        [GUARD, "--base", guardBase, "--head", "HEAD"],
        "guard",
      ),
    );
  }

  if (tier === "light") {
    steps.push(
      step(
        "doc-guard",
        "doc-guard",
        "docs guard (light tier)",
        process.execPath,
        ["--test", "dist/tests/docs-guard.test.js"],
        "test",
      ),
    );
  } else if (tier === "records") {
    steps.push(
      step(
        "records",
        "records",
        "records guards (records tier)",
        process.execPath,
        [RUNNER, "--only", ...RECORDS_TESTS],
        "test",
      ),
    );
  } else {
    for (let index = 1; index <= SHARD_COUNT; index += 1) {
      steps.push(
        step(
          `full-shard-${String(index)}`,
          "full",
          `full gate, shard ${String(index)}/${String(SHARD_COUNT)}`,
          process.execPath,
          [RUNNER, "--shard", `${String(index)}/${String(SHARD_COUNT)}`],
          "test",
        ),
      );
    }
    steps.push(step("lint", "full", "lint", NPM, ["run", "lint"], "lint"));
  }

  return steps;
}

/**
 * Where this run is knowingly not the workflow. Printed rather than kept in a
 * comment: a lane that reads "green" needs the same sentence that tells it
 * what green here does not cover.
 */
export function deviations(tier, options) {
  const out = [
    "one build serves every step here; the workflow builds once per job, over the same tree.",
  ];
  if (tier === "full") {
    out.push(
      options.parallel
        ? "the shards run concurrently, as the matrix does; their output is buffered and printed per shard."
        : "the shards run one after another, not concurrently as the matrix does; --parallel matches the matrix shape.",
      "lint runs once; the workflow runs it inside every shard, and oxlint's verdict does not vary by shard.",
    );
  }
  const major = Number(process.versions.node.split(".")[0]);
  if (tier === "full" && major !== 20) {
    out.push(
      `the Node 20 floor legs are not reproduced: this host runs Node ${process.versions.node}. The floor runs on the merge queue and on pushes to main, so a floor-only failure is still ahead of this change.`,
    );
  }
  if (tier === "records" && major !== 20) {
    out.push(
      `the records tier runs on Node 20 in the workflow and on Node ${process.versions.node} here.`,
    );
  }
  if (options.guardBase === null) {
    out.push(
      "the protected-path cross-check is NOT in this plan (the notes say why). CI runs it on every event and every tier, so it is still ahead of this change.",
    );
  }
  return out;
}

/** The whole plan, as the JSON the tests read and `--dry-run` prints. */
export function buildPlan(source, options) {
  const selected = selectTier(source);
  const guardBase =
    source.paths.length > 0 || source.workingTree ? null : mergeBase(source.base);
  const withGuard = { ...options, guardBase };
  const steps = planFor(selected.tier, withGuard);
  const notes = [];
  if (guardBase === null && source.paths.length === 0 && !source.workingTree) {
    notes.push(
      `no merge base between ${source.base} and HEAD, so the protected-path cross-check cannot be computed here. Fetch the base ref, or expect CI to be the first to run it.`,
    );
  }
  if (source.workingTree) {
    notes.push(
      "--working-tree classifies uncommitted changes; the protected-path guard reads commits, so it is out of this plan by construction.",
    );
  }
  if (source.paths.length > 0) {
    notes.push(
      "explicit paths classify a hypothetical change set; nothing here was read from git, the protected-path cross-check included.",
    );
  }
  return {
    tier: selected.tier,
    reason: selected.reason,
    classifier: selected.classifier,
    source: source.paths.length > 0 ? "paths" : source.workingTree ? "working-tree" : "base",
    base: source.paths.length > 0 || source.workingTree ? null : source.base,
    guardBase,
    paths: selected.paths,
    host: {
      platform: process.platform,
      node: process.versions.node,
      isCiPlatform: isCiPlatform(),
    },
    shardCount: SHARD_COUNT,
    steps,
    platformSensitive: platformReport(selected.tier).map((entry) => ({ ...entry })),
    deviations: deviations(selected.tier, withGuard),
    notes,
  };
}

/**
 * The plan as JSON. The only transformation is the executable: a step runs
 * `process.execPath`, and printing that absolute path would make the report
 * differ between machines for no reason a reader cares about.
 */
export function planToJson(plan) {
  return {
    ...plan,
    steps: plan.steps.map((entry) => ({
      id: entry.id,
      ci: entry.ci,
      name: entry.name,
      command: entry.command === process.execPath ? "node" : entry.command,
      args: entry.args,
      kind: entry.kind,
    })),
  };
}

// ---------------------------------------------------------------------------
// Reading a failure out of a step's output
// ---------------------------------------------------------------------------

/**
 * The shapes a failure names a file in. Ordered, and each is tried against
 * every line; the first that matches claims the line.
 *
 * Two of the five are the same reporter under different Node majors, which is
 * the reason this is a list rather than one pattern. `node --test` defaults to
 * TAP off a TTY on Node 20, the floor, and to the `spec` reporter on Node 22
 * and later; a lane's host may be either, and the extraction must not quietly
 * name nothing on one of them. The verdict never depends on this, since the
 * exit code is the verdict, so an unrecognised shape costs a file name in the
 * summary and nothing else.
 */
const FAILURE_PATTERNS = Object.freeze([
  // node --test, TAP reporter (Node 20 off a TTY): `not ok 3 - /abs/x.test.js`
  /^not ok \d+ - (\S.*\.test\.js)\s*$/u,
  // node --test, spec reporter (Node 22+): the `failing tests:` roll-call
  /^\s*test at (\S.*\.test\.js):\d+:\d+\s*$/u,
  // a stack frame inside a failure, as a last resort
  /file:\/\/(\S+\.test\.js):\d+:\d+/u,
  // tsc: `src/x.ts(4,1): error TS2322: ...`
  /^(\S+\.[cm]?tsx?)[(:]\d+/u,
  // oxlint's span marker: `  ╭─[src/x.ts:1:1]`
  /╭─\[([^:\]]+)/u,
]);

/**
 * A path from a tool's output, as a repository-relative source path: resolved
 * against the root every step runs in, then `dist/tests/foo.test.js` mapped
 * back to `tests/foo.test.ts` when that file exists, because the lane's next
 * move is to open the source and not the build output.
 */
function sourceOf(path) {
  const absolute = path.startsWith("/") ? path : join(REPO_ROOT, path);
  const cleaned = absolute.startsWith(REPO_ROOT) ? absolute.slice(REPO_ROOT.length) : path;
  const match = /^dist\/(.*)\.js$/u.exec(cleaned);
  if (match === null) return cleaned;
  const candidate = `${match[1]}.ts`;
  return existsSync(join(REPO_ROOT, candidate)) ? candidate : cleaned;
}

/** Every file a step's output blamed, deduped and in first-seen order. */
export function failingFiles(output) {
  const seen = new Set();
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/u, "");
    for (const pattern of FAILURE_PATTERNS) {
      const match = pattern.exec(line);
      if (match !== null) {
        seen.add(sourceOf(match[1].trim()));
        break;
      }
    }
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/**
 * Run one step. Output is captured either way; when `tee` it also reaches the
 * terminal as it arrives, which is what a sequential run wants and what a
 * concurrent one cannot have without interleaving three suites into nonsense.
 */
function runStep(entry, tee) {
  return new Promise((resolve) => {
    const child = spawn(entry.command, entry.args, {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (stream, sink) => {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        output += chunk;
        if (tee) sink.write(chunk);
      });
    };
    collect(child.stdout, process.stdout);
    collect(child.stderr, process.stderr);
    child.on("error", (error) => {
      output += `\n${String(error.message)}\n`;
      resolve({ entry, code: 1, output });
    });
    child.on("close", (code) => {
      resolve({ entry, code: code ?? 1, output });
    });
  });
}

/**
 * The protected-path guard's "I could not look" is not a pass and not a
 * failure of the change: exit 4 means the evidence it needs was not reachable
 * from this checkout (the records branches are not fetched, the log is behind).
 * CI will run it against a checkout that has them, so it is reported here as
 * unresolved and left out of the verdict. Every other non-zero exit is red,
 * including the guard's own exit 1, which is a protected path with no grant.
 */
const GUARD_CANNOT_LOOK = 4;

function isRed(result) {
  if (result.code === 0) return false;
  if (result.entry.kind === "guard" && result.code === GUARD_CANNOT_LOOK) return false;
  return true;
}

async function runPlan(plan, options) {
  const results = [];
  const write = (text) => process.stdout.write(text);

  const [build, ...rest] = plan.steps;
  write(`\n── ${build.name}\n$ ${describe(build)}\n`);
  const built = await runStep(build, true);
  results.push(built);
  if (built.code !== 0) {
    write("\nbuild failed; nothing downstream would mean anything, so the run stops here.\n");
    return summarize(plan, results, write);
  }

  if (options.parallel) {
    const running = rest.map((entry) => runStep(entry, false));
    for (const [index, promise] of running.entries()) {
      const result = await promise;
      write(`\n── ${rest[index].name}\n$ ${describe(rest[index])}\n${result.output}`);
      results.push(result);
    }
  } else {
    for (const entry of rest) {
      write(`\n── ${entry.name}\n$ ${describe(entry)}\n`);
      // fail-fast: false, as the matrix declares. A red shard tells a lane one
      // thing; three red shards tell it a different and more useful thing.
      results.push(await runStep(entry, true));
    }
  }
  return summarize(plan, results, write);
}

function describe(entry) {
  const command = entry.command === process.execPath ? "node" : entry.command;
  return `${command} ${entry.args.join(" ")}`;
}

function summarize(plan, results, write) {
  write("\n");
  write(`── summary: ${plan.tier} tier (${plan.reason})\n`);
  const red = [];
  for (const result of results) {
    const status = result.code === 0 ? "ok" : isRed(result) ? "RED" : "unresolved";
    write(`${status.padEnd(10)} ${result.entry.name} (exit ${String(result.code)})\n`);
    if (isRed(result)) red.push(result);
  }
  if (plan.platformSensitive.length > 0) {
    write(
      `\nthis host is ${process.platform}, CI is linux. ${String(plan.platformSensitive.length)} suite(s) in this tier mean something different here:\n`,
    );
    for (const entry of plan.platformSensitive) write(`  ${entry.file}\n    ${entry.why}\n`);
  }
  const unresolved = results.filter((result) => result.code !== 0 && !isRed(result));
  for (const result of unresolved) {
    write(
      `\n${result.entry.name} could not reach what it needed to look at (exit ${String(result.code)}); CI runs it against a checkout that can. Unresolved, not green.\n`,
    );
  }
  if (red.length === 0) {
    write("\nevery step this host can run is green.\n");
    return EXIT_OK;
  }
  write(`\n${String(red.length)} step(s) red:\n`);
  for (const result of red) {
    const files = failingFiles(result.output);
    write(`  ${result.entry.name} — ${describe(result.entry)}\n`);
    if (files.length === 0) {
      write("    (no file named in the output; read the step's output above)\n");
    } else {
      for (const file of files) write(`    ${file}\n`);
    }
  }
  return EXIT_RED;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = [
  "usage: node scripts/ci-local.mjs [--base <ref> | --working-tree | <path>...]",
  "                                 [--dry-run] [--json] [--parallel]",
  "",
  "Runs the CI tier the classifier selects for this diff. --json implies --dry-run.",
].join("\n");

export function parseArgs(argv) {
  const options = {
    base: "origin/main",
    workingTree: false,
    paths: [],
    dryRun: false,
    json: false,
    parallel: false,
    help: false,
    error: null,
  };
  const fail = (message) => {
    if (options.error === null) options.error = message;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
      options.dryRun = true;
    } else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--parallel") options.parallel = true;
    else if (arg === "--working-tree") options.workingTree = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--base") {
      i += 1;
      const value = argv[i];
      if (value === undefined) fail("--base requires a ref");
      else options.base = value;
    } else if (arg.startsWith("--base=")) options.base = arg.slice("--base=".length);
    else if (arg.startsWith("-")) fail(`unknown option ${arg}`);
    else options.paths.push(arg);
  }
  if (options.workingTree && options.paths.length > 0) {
    fail("--working-tree and explicit paths name two different change sets");
  }
  return options;
}

function printPlan(plan, write) {
  write(`tier: ${plan.tier} (${plan.reason})\n`);
  write(`from: ${plan.source}${plan.base === null ? "" : ` ${plan.base}...HEAD`}\n`);
  write(`paths: ${String(plan.paths.length)} changed\n`);
  write(`host: ${plan.host.platform}, node ${plan.host.node}\n\n`);
  write("steps:\n");
  for (const entry of plan.steps) {
    write(`  ${entry.id.padEnd(16)} ${describe(entry)}\n`);
  }
  if (plan.platformSensitive.length > 0) {
    write("\nplatform-sensitive suites in this tier (CI runs linux):\n");
    for (const entry of plan.platformSensitive) write(`  ${entry.file}\n    ${entry.why}\n`);
  }
  if (plan.deviations.length > 0) {
    write("\nwhere this is not the workflow:\n");
    for (const line of plan.deviations) write(`  - ${line}\n`);
  }
  if (plan.notes.length > 0) {
    write("\nnotes:\n");
    for (const line of plan.notes) write(`  - ${line}\n`);
  }
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT_OK;
  }
  if (options.error !== null) {
    process.stderr.write(`ci-local: ${options.error}\n${USAGE}\n`);
    return EXIT_USAGE;
  }

  const plan = buildPlan(
    { base: options.base, workingTree: options.workingTree, paths: options.paths },
    { parallel: options.parallel },
  );

  if (options.json) {
    process.stdout.write(`${JSON.stringify(planToJson(plan), null, 2)}\n`);
    return EXIT_OK;
  }

  printPlan(plan, (text) => process.stdout.write(text));
  if (options.dryRun) return EXIT_OK;
  return runPlan(plan, options);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`ci-local: ${String(error)}\n`);
      process.exitCode = EXIT_RED;
    },
  );
}
