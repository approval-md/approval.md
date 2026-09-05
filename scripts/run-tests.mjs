#!/usr/bin/env node
/**
 * Test runner shim: explicit file-list discovery for `node --test` (APRV-48).
 *
 * Node 20 constraint, do not simplify this back to a glob. `node --test`
 * expands glob arguments itself only from Node 21; on Node 20 a quoted glob
 * argument (dist/tests, double-star, *.test.js) is taken as one literal path
 * and the runner exits with "Could not find ...". This repo's floor is
 * Node ≥ 20 (package.json engines, CLAUDE.md; the floor shaped the
 * better-sqlite3 decision), and CI runs the floor leg on 20 and the shard
 * matrix on 22, so the invocation must be valid on both. Discovery is
 * therefore done here with fs and the runner receives explicit file paths,
 * which behave identically on every supported version.
 *
 * Two further properties a bare glob would not give us:
 *   - zero discovered files is a hard failure, never a silently green run;
 *   - the file list is sorted, so execution order is deterministic.
 *
 * One discovery, two selectors, and both fail closed rather than quietly
 * running less than was asked for: `--only <name>...` names an exact set (the
 * records tier, APRV-112) and `--shard <k>/<n>` takes one slice of the whole
 * suite for the full gate's parallel matrix (APRV-149).
 *
 * The module is importable: everything below is a function, and the CLI runs
 * only when this file is the entry point, so a test can exercise the selectors
 * without spawning the suite it is part of.
 */

import { chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, relative } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const TEST_DIR = join(REPO_ROOT, "dist", "tests");

const USAGE = "run-tests.mjs [--only <name>...] [--shard <k>/<n>]";

// ---------------------------------------------------------------------------
// Harness binaries are stubbed for the whole suite (APRV-227)
// ---------------------------------------------------------------------------

/**
 * Where the stub `claude` and `cursor-agent` are written, in front of PATH.
 *
 * Under `dist/`, which is build output and already ignored, so the suite
 * leaves nothing in the working tree and nothing to clean up.
 */
const STUB_BIN_DIR = join(REPO_ROOT, "dist", "test-bin");

/** What every stub answers `--version` with. Fixed, so records are identical everywhere. */
export const STUB_HARNESS_VERSION = "0.0.0-approval-md-test-stub";

/** The harness binaries this runtime knows how to spawn (`core/harness-version.ts`). */
const STUBBED_BINARIES = ["claude", "cursor-agent", "codex"];

/**
 * Put a stub in front of every harness binary the runtime can spawn, for the
 * whole suite, and return the PATH the test process gets.
 *
 * ## Why this exists
 *
 * Two places in the runtime spawn a harness binary by name off PATH, and
 * neither is configurable, deliberately: `cli/gloss.ts` runs `claude -p` to
 * render a sentence, and `core/harness-version.ts` runs `<binary> --version` to
 * stamp the record a hook is about to write. "PATH is the only seam" is the
 * right design and it has one consequence for a test suite — on a developer's
 * own machine, where the real CLI is installed, a test that forgets to stub it
 * silently runs somebody's actual harness. `tests/fake-claude.ts` documents
 * what that already cost once: the suite had been making real model calls on
 * every listener case for several tasks, and nobody could see it.
 *
 * So the guarantee is made HERE, once, for every file rather than per file: no
 * test run through this runner reaches a real harness binary. A file that wants
 * particular behaviour still prepends its own stub (`tests/fake-claude.ts`, and
 * `tests/harness-version.test.ts`'s per-case stubs) and wins, because it goes
 * in front of this one.
 *
 * The stub answers `--version` and refuses everything else. Refusing is the
 * useful default: a `spawnGloss` that reaches this gets a fast `null`, which is
 * exactly what it gets from a machine with no CLI installed, instead of ten
 * seconds and a real model call.
 *
 * **This covers `npm test` and CI, not a bare `node --test dist/tests/x.js`.**
 * A single-file run during development still inherits the developer's own PATH.
 * That is a real gap and it is stated rather than papered over: closing it in
 * the runtime would mean a test-only switch inside the code that decides what
 * to execute, which is a worse thing to own than a documented gap.
 */
function stubHarnessBinaries() {
  mkdirSync(STUB_BIN_DIR, { recursive: true });
  for (const name of STUBBED_BINARIES) {
    const path = join(STUB_BIN_DIR, name);
    writeFileSync(
      path,
      [
        "#!/bin/sh",
        `# Written by scripts/run-tests.mjs (APRV-227). Not a real ${name}.`,
        'if [ "$1" = "--version" ]; then',
        `  echo "${STUB_HARNESS_VERSION}"`,
        "  exit 0",
        "fi",
        `echo "approval.md test stub: refusing to act as a real ${name}" >&2`,
        "exit 1",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(path, 0o755);
  }
  return `${STUB_BIN_DIR}:${process.env.PATH ?? ""}`;
}

/** Recursively collect *.test.js files under a directory. */
function collectTestFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
      files.push(full);
    }
  }
  return files;
}

/** Every built test file, sorted: the whole suite in a deterministic order. */
export function discoverTestFiles() {
  return collectTestFiles(TEST_DIR).sort();
}

/** A discovered file's `--only` name: its path under dist/tests, no suffix. */
function testName(file) {
  return file.slice(TEST_DIR.length + 1, -".test.js".length);
}

/**
 * The files of shard `index` of `count`, by position in the sorted list:
 * file at position i belongs to shard (i mod count) + 1.
 *
 * Why this is exhaustive and non-overlapping, stated rather than assumed,
 * because a shard scheme that quietly drops a file turns a green matrix into
 * no evidence at all. Every position i has exactly one residue i mod count in
 * 0..count-1, and each of those residues is claimed by exactly one shard
 * number in 1..count, so each file lands in exactly one shard and the shards
 * of a full matrix reassemble the discovered list. Discovery is sorted and
 * every job compiles the same tree, so shard k means the same files in every
 * job of that matrix.
 *
 * Round-robin rather than contiguous blocks: neighbouring names in a sorted
 * list tend to be one subsystem and one cost profile, and interleaving spreads
 * the slow files across shards instead of stacking them into one.
 */
export function selectShard(files, index, count) {
  return files.filter((_file, position) => position % count === index - 1);
}

/**
 * Parse the runner's arguments. Every ambiguity is an error, never a smaller
 * run: an unknown option, a shard spec that is not `<k>/<n>`, an index outside
 * 1..n, `--only` with no names, and the two selectors together.
 */
export function parseRunnerArgs(argv) {
  const options = { only: null, shard: null, error: null };
  const fail = (message) => {
    if (options.error === null) options.error = message;
  };
  let collectingNames = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--only") {
      options.only ??= [];
      collectingNames = true;
    } else if (arg === "--shard" || arg.startsWith("--shard=")) {
      collectingNames = false;
      let value;
      if (arg === "--shard") {
        i += 1;
        value = argv[i];
      } else {
        value = arg.slice("--shard=".length);
      }
      if (value === undefined) {
        fail("--shard requires a <k>/<n> argument");
        continue;
      }
      const match = /^(\d+)\/(\d+)$/u.exec(value);
      if (match === null) {
        fail(`--shard ${value} is not of the form <k>/<n>`);
        continue;
      }
      const index = Number(match[1]);
      const count = Number(match[2]);
      if (count < 1) {
        fail(`--shard ${value}: a shard count must be at least 1`);
        continue;
      }
      if (index < 1 || index > count) {
        fail(
          `--shard ${value}: shard index ${index} is outside 1..${count}, so some shard of this matrix runs files no shard claims`,
        );
        continue;
      }
      options.shard = { index, count };
    } else if (arg.startsWith("-")) {
      fail(`unknown option ${arg}`);
    } else if (collectingNames) {
      options.only.push(arg);
    } else {
      fail(`unexpected argument ${arg}`);
    }
  }
  if (options.only !== null && options.only.length === 0) {
    fail("--only requires at least one test name");
  }
  if (options.only !== null && options.shard !== null) {
    fail(
      "--only and --shard cannot be combined: --only names an exact set and the tier that " +
        "passes it depends on getting all of it, while --shard slices the whole suite. " +
        "Together they would run a fraction of a set that was asked for in full.",
    );
  }
  return options;
}

/** Select the files this invocation should run, or null after an error. */
function selectFiles(options, discovered) {
  if (options.only !== null) {
    const byName = new Map(discovered.map((file) => [testName(file), file]));
    const missing = options.only.filter((name) => !byName.has(name));
    if (missing.length > 0) {
      console.error(
        `run-tests: --only named ${missing.join(", ")}, which matched no built test file. ` +
          "Refusing to run a smaller suite than was asked for.",
      );
      return null;
    }
    const files = options.only.map((name) => byName.get(name));
    console.error(`run-tests: ${files.length} of ${discovered.length} test files selected by --only`);
    return files;
  }
  if (options.shard !== null) {
    const { index, count } = options.shard;
    const files = selectShard(discovered, index, count);
    if (files.length === 0) {
      console.error(
        `run-tests: shard ${index}/${count} selected none of the ${discovered.length} discovered ` +
          "test files. An empty shard reports success having proved nothing; use a shard count " +
          "no larger than the suite.",
      );
      return null;
    }
    console.error(
      `run-tests: shard ${index}/${count}: ${files.length} of ${discovered.length} test files`,
    );
    return files;
  }
  console.error(`run-tests: ${discovered.length} test files discovered`);
  return discovered;
}

function main(argv) {
  const options = parseRunnerArgs(argv);
  if (options.error !== null) {
    console.error(`run-tests: ${options.error}; usage: ${USAGE}`);
    return 1;
  }

  const discovered = discoverTestFiles();
  if (discovered.length === 0) {
    console.error(
      `run-tests: no *.test.js files found under ${relative(REPO_ROOT, TEST_DIR)}; ` +
        "did the build run? Refusing to report success on an empty suite.",
    );
    return 1;
  }

  const files = selectFiles(options, discovered);
  if (files === null) return 1;

  const result = spawnSync(process.execPath, ["--test", ...files], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    // APRV-227: no test run through this runner reaches a real harness binary.
    env: { ...process.env, PATH: stubHarnessBinaries() },
  });

  return result.status ?? 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
