#!/usr/bin/env node
/**
 * The reference conformance runner (APRV-122).
 *
 * Usage:
 *
 *   node conformance/run.mjs            # run every suite, print JSON, exit 0/1
 *   node conformance/run.mjs --quiet    # exit code only
 *
 * Contract (see conformance/README.md — a second implementation's runner MUST
 * reproduce it):
 *
 *   - it reads `conformance/vectors/*.json` from the repository, by path, and
 *     runs every vector in every file;
 *   - it prints exactly one JSON object on stdout and nothing else;
 *   - it exits 0 only when every vector passed, every negative control was
 *     refused, and every file matched its manifest digest;
 *   - it exits 1 on any conformance failure and 2 on an INTERNAL failure — a
 *     suite it has no executor for, a malformed vector file, a count that does
 *     not match, an empty vectors directory. An internal failure is never
 *     reported as a pass and never as a skip.
 *
 * The last clause is the one that matters. A runner that quietly skips what it
 * cannot run reports a green suite for work nobody did, and the whole point of a
 * conformance suite is that a second implementation cannot get credit for the
 * cases it did not handle.
 *
 * This runner drives the TypeScript reference implementation, so it needs the
 * build: `npm run build` first.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const HARNESS = join(REPO_ROOT, "dist", "tests", "conformance-harness.js");

const quiet = process.argv.includes("--quiet");

function fail(message) {
  process.stderr.write(`conformance: ${message}\n`);
  process.exit(2);
}

if (!existsSync(HARNESS)) {
  fail(`the built harness is missing at ${HARNESS}; run \`npm run build\` first`);
}

let harness;
try {
  harness = await import(HARNESS);
} catch (cause) {
  fail(`the harness could not be loaded: ${cause instanceof Error ? cause.message : String(cause)}`);
}

let result;
try {
  result = harness.runAll();
} catch (cause) {
  // An internal failure: a suite with no executor, a malformed file, a count
  // mismatch. Exit 2, distinct from a conformance failure, because the run did
  // not happen rather than the implementation being wrong.
  fail(cause instanceof Error ? cause.message : String(cause));
} finally {
  harness.cleanup?.();
}

if (!quiet) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.ok ? 0 : 1);
