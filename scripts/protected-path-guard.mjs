#!/usr/bin/env node
/**
 * The protected-path guard, CI side (APRV-151).
 *
 * Asks git which protected paths changed between two commits, then asks the
 * COMMITTED log whether a human decided each one. Session wiring is never an
 * input: a session whose PreToolUse hook silently failed to load produces no
 * refused-request record, so the only thing that can catch it after the fact is
 * the absence of a grant in the log. See `src/core/protected-path-guard.ts` for
 * the evidence rules, the exempt evidence surface, and the ordering rule the
 * log's lag behind the primary checkout implies.
 *
 * Everything git touches is read at the HEAD COMMIT's tree, never the working
 * tree: `git show <head>:<path>`. A guard that read the checkout could be told
 * a different story than the one the pull request carries.
 *
 * Usage:
 *   node scripts/protected-path-guard.mjs --base <ref> --head <ref>
 *   ... --json          machine-readable report
 *   ... --repo <dir>    run against another checkout (default: this one)
 *
 * Exit codes: 0 pass, 1 a protected path lacks evidence (or the log fails
 * closed), 2 usage, 4 the guard itself could not look.
 *
 * Requires a build: it imports the checked core from `dist/`.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;
const EXIT_CANNOT_LOOK = 4;

/** The log and the policy, at their SPEC.md-fixed repository locations. */
const LOG_PATH = ".approval/log/events.jsonl";
const PAYLOAD_DIR = ".approval/payloads";
const POLICY_PATH = "APPROVAL.md";

/** Run git in `repo`, returning stdout or `null` when the command failed. */
function git(repo, args) {
  const run = spawnSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (run.error !== undefined && run.error !== null) return null;
  if (run.status !== 0) return null;
  return run.stdout;
}

/** A blob at a commit, or `null` when the tree does not carry it. */
function showBlob(repo, ref, path) {
  return git(repo, ["show", `${ref}:${path}`]);
}

function usage(message) {
  process.stderr.write(`protected-path-guard: ${message}\n`);
  process.stderr.write(
    "usage: node scripts/protected-path-guard.mjs --base <ref> --head <ref> [--repo <dir>] [--json]\n",
  );
  return EXIT_USAGE;
}

function parseArgs(argv) {
  const flags = { base: null, head: null, repo: REPO_ROOT, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    if (arg === "--base" || arg === "--head" || arg === "--repo") {
      const value = argv[index + 1];
      if (value === undefined) return { ok: false, message: `${arg} needs a value` };
      flags[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    return { ok: false, message: `unexpected argument ${JSON.stringify(arg)}` };
  }
  if (flags.base === null || flags.head === null) {
    return { ok: false, message: "--base and --head are both required" };
  }
  return { ok: true, flags };
}

/**
 * `policy.protected_paths` from the policy AT HEAD, parsed with the same
 * hardened YAML the runtime uses.
 *
 * A pull request that removed an entry would narrow the guarded set with the
 * very change the guard is checking, so the entries at BASE are read too and
 * the union is used. Narrowing the protected surface is itself a protected
 * edit, and it does not get to take effect before it is approved.
 */
function protectedPathsFrom(repo, refs, parsePolicy) {
  const found = new Set();
  for (const ref of refs) {
    const text = showBlob(repo, ref, POLICY_PATH);
    if (text === null) continue;
    let load;
    try {
      load = parsePolicy(text);
    } catch {
      continue;
    }
    for (const entry of load) found.add(entry);
  }
  return [...found];
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) return usage(parsed.message);
  const { base, head, repo, json } = parsed.flags;

  let guard;
  let verifyModule;
  let policyModule;
  try {
    guard = await import("../dist/src/core/protected-path-guard.js");
    verifyModule = await import("../dist/src/core/verify.js");
    policyModule = await import("../dist/src/core/policy-load.js");
  } catch (cause) {
    process.stderr.write(
      `protected-path-guard: the built core is missing (${String(cause)}). Run \`npm run build\` first.\n`,
    );
    return EXIT_CANNOT_LOOK;
  }

  const resolvedBase = git(repo, ["rev-parse", base]);
  const resolvedHead = git(repo, ["rev-parse", head]);
  if (resolvedBase === null || resolvedHead === null) {
    process.stderr.write(
      `protected-path-guard: git could not resolve ${resolvedBase === null ? base : head} in ${repo}\n`,
    );
    return EXIT_CANNOT_LOOK;
  }

  const diff = git(repo, ["diff", "--name-only", `${base}`, `${head}`]);
  if (diff === null) {
    process.stderr.write(`protected-path-guard: git could not diff ${base}..${head} in ${repo}\n`);
    return EXIT_CANNOT_LOOK;
  }
  const changedPaths = diff.split("\n").filter((line) => line.trim().length > 0);

  // The policy's own widening entries, from both ends of the range.
  const readEntries = (text) => {
    const load = policyModule.loadPolicyText(POLICY_PATH, text);
    if (load.ok !== true) return [];
    const entries = load.policy.protected_paths;
    return Array.isArray(entries) ? entries.filter((entry) => typeof entry === "string") : [];
  };
  let policyProtectedPaths = [];
  try {
    policyProtectedPaths = protectedPathsFrom(repo, [head, base], readEntries);
  } catch {
    policyProtectedPaths = [];
  }

  // The log AT HEAD, verified through the real verifier. It wants a path, so
  // the blob is materialized in a scratch directory and removed after.
  const logText = showBlob(repo, head, LOG_PATH);
  const scratch = mkdtempSync(join(tmpdir(), "approval-md-guard-"));
  let logStatus = "ok";
  let logDetail;
  let records = null;
  let window = {
    firstSeq: null,
    lastSeq: null,
    firstTs: null,
    lastTs: null,
    base: resolvedBase.trim().slice(0, 12),
    head: resolvedHead.trim().slice(0, 12),
  };
  try {
    if (logText === null) {
      logStatus = "missing";
    } else {
      const scratchLog = join(scratch, "events.jsonl");
      writeFileSync(scratchLog, logText, "utf8");
      const verified = verifyModule.verifyWithRecords(scratchLog);
      if (verified.result.status !== "clean") {
        logStatus = "unverified";
        logDetail = JSON.stringify(verified.result);
      } else {
        records = verified.records;
        const first = records[0];
        const last = records[records.length - 1];
        window = {
          ...window,
          firstSeq: first?.seq ?? null,
          lastSeq: last?.seq ?? null,
          firstTs: first?.ts ?? null,
          lastTs: last?.ts ?? null,
        };
      }
    }

    const policyBytes = showBlob(repo, head, POLICY_PATH);
    const policySha256AtHead =
      policyBytes === null ? null : createHash("sha256").update(policyBytes, "utf8").digest("hex");

    const payloadCache = new Map();
    const payloadFor = (hash) => {
      if (payloadCache.has(hash)) return payloadCache.get(hash);
      const blob = showBlob(repo, head, `${PAYLOAD_DIR}/${hash}.json`);
      let value = null;
      if (blob !== null) {
        try {
          value = JSON.parse(blob);
        } catch {
          value = null;
        }
      }
      payloadCache.set(hash, value);
      return value;
    };

    // When each protected path last changed in this range: the anchor the
    // recency bound is measured from. Author date, so a rebase does not move it.
    const changeTsCache = new Map();
    const changeTsFor = (path) => {
      if (changeTsCache.has(path)) return changeTsCache.get(path);
      const out = git(repo, [
        "log",
        "-1",
        "--format=%aI",
        `${base}..${head}`,
        "--",
        path,
      ]);
      const value = out === null || out.trim().length === 0 ? null : out.trim();
      changeTsCache.set(path, value);
      return value;
    };

    const report = guard.evaluateProtectedPaths({
      changedPaths,
      records,
      logStatus,
      logDetail,
      policyProtectedPaths,
      policySha256AtHead,
      policyPath: POLICY_PATH,
      payloadFor,
      changeTsFor,
      window,
    });

    if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(guard.renderGuardReport(report));

    return report.ok ? EXIT_OK : EXIT_FAIL;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (cause) => {
    process.stderr.write(`protected-path-guard: ${String(cause)}\n`);
    process.exitCode = EXIT_CANNOT_LOOK;
  },
);
