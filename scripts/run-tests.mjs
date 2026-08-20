#!/usr/bin/env node
/**
 * Test runner shim: explicit file-list discovery for `node --test` (APRV-48).
 *
 * Node 20 constraint, do not simplify this back to a glob. `node --test`
 * expands glob arguments itself only from Node 21; on Node 20 a quoted glob
 * argument (dist/tests, double-star, *.test.js) is taken as one literal path
 * and the runner exits with "Could not find ...". This repo's floor is
 * Node ≥ 20 (package.json engines, CLAUDE.md; the floor shaped the
 * better-sqlite3 decision), and CI runs the matrix on 20 and 22, so the
 * invocation must be valid on both. Discovery is
 * therefore done here with fs and the runner receives explicit file paths,
 * which behave identically on every supported version.
 *
 * Two further properties a bare glob would not give us:
 *   - zero discovered files is a hard failure, never a silently green run;
 *   - the file list is sorted, so execution order is deterministic.
 */

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const TEST_DIR = join(REPO_ROOT, "dist", "tests");

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

const discovered = collectTestFiles(TEST_DIR).sort();

if (discovered.length === 0) {
  console.error(
    `run-tests: no *.test.js files found under ${relative(REPO_ROOT, TEST_DIR)}; ` +
      "did the build run? Refusing to report success on an empty suite.",
  );
  process.exit(1);
}

/**
 * `--only <name>...` runs a named subset, which is how the records tier
 * (APRV-112) reaches the tests that read the project's records without
 * duplicating discovery. Names are base names without the `.test.js` suffix.
 * A name that matches nothing is a hard failure, never a quietly smaller run:
 * a renamed test file must not silently drop out of the tier that exists to
 * run it.
 */
let files = discovered;
const argv = process.argv.slice(2);
if (argv.length > 0) {
  if (argv[0] !== "--only") {
    console.error(`run-tests: unknown option ${argv[0]}; usage: run-tests.mjs [--only <name>...]`);
    process.exit(1);
  }
  const names = argv.slice(1);
  if (names.length === 0) {
    console.error("run-tests: --only requires at least one test name");
    process.exit(1);
  }
  const byName = new Map(
    discovered.map((file) => [file.slice(TEST_DIR.length + 1, -".test.js".length), file]),
  );
  const missing = names.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    console.error(
      `run-tests: --only named ${missing.join(", ")}, which matched no built test file. ` +
        "Refusing to run a smaller suite than was asked for.",
    );
    process.exit(1);
  }
  files = names.map((name) => byName.get(name));
  console.error(`run-tests: ${files.length} of ${discovered.length} test files selected by --only`);
} else {
  console.error(`run-tests: ${files.length} test files discovered`);
}

const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: REPO_ROOT,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
