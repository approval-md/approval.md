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

const files = collectTestFiles(TEST_DIR).sort();

if (files.length === 0) {
  console.error(
    `run-tests: no *.test.js files found under ${relative(REPO_ROOT, TEST_DIR)}; ` +
      "did the build run? Refusing to report success on an empty suite.",
  );
  process.exit(1);
}

console.error(`run-tests: ${files.length} test files discovered`);

const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: REPO_ROOT,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
