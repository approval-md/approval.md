#!/usr/bin/env node
/**
 * The protected-path grant guard (APRV-151): the gate's backstop, outside the
 * session.
 *
 * Every other enforcement path here runs INSIDE the agent's session, as a
 * PreToolUse hook. That makes all of them blind to one failure: a hook the
 * harness never invoked. It leaves no deny, no refused request, no record at
 * all — the session simply does not appear in the log — so a protected-path
 * edit made in such a session is indistinguishable, to the runtime, from an
 * edit nobody made. Two of those were observed in agent-created worktrees
 * (SPEC.md on 2026-08-29, `.github/workflows/ci.yml` on 2026-08-30).
 *
 * This guard asks the question from the other side, where the answer does not
 * depend on the session's own wiring: the change is in a pull request's diff,
 * and the committed log either carries a human's `policy.edit` grant naming
 * that file or it does not. It reads only VERIFIED records, decides nothing
 * from the author's account of itself, and fails closed on every axis — an
 * unreadable git state, an unreadable log, an unparseable summary, or a grant
 * it cannot tie to a specific file all leave the change UNAUTHORIZED.
 *
 * Usage:
 *   node scripts/protected-grant-guard.mjs --base origin/main
 *   node scripts/protected-grant-guard.mjs --base origin/main --json
 *   node scripts/protected-grant-guard.mjs --log <path> SPEC.md   (explicit)
 *
 * Options:
 *   --base <ref>      the diff base; the change set is `<ref>...HEAD`.
 *   --log <path>      read this log instead of the one at `--log-ref`.
 *   --log-ref <ref>   the ref whose `.approval/log/events.jsonl` is authoritative
 *                     (default: `--base`). The grant is appended to the primary
 *                     checkout's log AFTER a branch is cut, so the branch's own
 *                     copy is stale by construction and is never the one read.
 *   --repo <path>     the checkout to run git in (default: this script's repo).
 *   --since-seq <n>   only grants after seq `n` count (default: the head of
 *                     HEAD's own committed log, i.e. the branch point). A grant
 *                     older than the branch was given for somebody else's edit.
 *   --json            machine-readable verdict.
 *
 * Exit codes: 0 no unauthorized protected change, 1 at least one, 2 the guard
 * could not establish an answer (which is also a failure, deliberately).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { auditProtectedChanges } from "../dist/src/core/protected-grant.js";
import { loadPolicy } from "../dist/src/core/policy-load.js";
import { readVerifiedRecords } from "../dist/src/core/state.js";

/** The repository root, from `scripts/` at runtime. */
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The committed log, relative to a checkout root. */
const LOG_PATH = ".approval/log/events.jsonl";

/** The policy file, relative to a checkout root. */
const POLICY_PATH = "APPROVAL.md";

/** Run git in `cwd`; `null` on any non-zero exit or spawn failure. */
function git(cwd, args) {
  // The log is the largest thing this reads and it grows without bound, so the
  // 1 MiB default buffer is not the limit; a truncated read would look like an
  // unreadable ref, which fails closed but for the wrong reason.
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  if (result.error !== undefined || result.status !== 0) return null;
  return result.stdout;
}

/** The paths `base...HEAD` changed, or `null` when git could not say. */
function changedPaths(cwd, base) {
  const out = git(cwd, ["diff", "--name-only", `${base}...HEAD`]);
  if (out === null) return null;
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * The last seq in the log HEAD carries, or `null` when it carries none.
 *
 * This is the guard's window floor. A branch's own copy of
 * `.approval/log/events.jsonl` is frozen at the commit it was cut from (the
 * daemon writes the log in the primary checkout, never on a feature branch),
 * so its head is exactly "the log as of the moment this work started". Only
 * grants after it can have been given for this branch's changes; counting
 * older ones would let a single historical `policy.edit` authorize every
 * future edit to the same file.
 */
function branchPointSeq(cwd, ref) {
  const out = git(cwd, ["show", `${ref}:${LOG_PATH}`]);
  if (out === null) return null;
  const lines = out.split("\n").filter((line) => line.trim().length > 0);
  const last = lines[lines.length - 1];
  if (last === undefined) return 0;
  try {
    const seq = JSON.parse(last).seq;
    return Number.isInteger(seq) ? seq : null;
  } catch {
    return null;
  }
}

/** `git show <ref>:<path>` written to a scratch file, or `null`. */
function materialize(cwd, ref, path, scratch, name) {
  const out = git(cwd, ["show", `${ref}:${path}`]);
  if (out === null) return null;
  const file = join(scratch, name);
  writeFileSync(file, out, "utf8");
  return file;
}

/**
 * `policy.protected_paths`, from BOTH sides of the diff.
 *
 * The union, not the head's list: a change that removes an entry from
 * `protected_paths` in the same pull request that edits the file it was
 * protecting must not be able to un-protect it on the way in. An unreadable
 * policy on either side contributes nothing and the built-ins still stand.
 */
function protectedPaths(cwd, base, scratch) {
  const found = new Set();
  const sources = [
    materialize(cwd, base, POLICY_PATH, scratch, "base-APPROVAL.md"),
    join(cwd, POLICY_PATH),
  ];
  for (const file of sources) {
    if (file === null) continue;
    const loaded = loadPolicy({ file });
    if (!loaded.ok) continue;
    for (const entry of loaded.policy.protected_paths ?? []) found.add(entry);
  }
  return [...found];
}

export function parseArgs(argv) {
  const options = {
    base: "origin/main",
    log: null,
    logRef: null,
    repo: REPO_ROOT,
    sinceSeq: null,
    json: false,
    paths: [],
    error: null,
  };
  const takes = {
    "--base": "base",
    "--log": "log",
    "--log-ref": "logRef",
    "--repo": "repo",
    "--since-seq": "sinceSeq",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    const key = takes[arg];
    if (key !== undefined) {
      i += 1;
      const value = argv[i];
      if (value === undefined) options.error = `${arg} requires a value`;
      else options[key] = value;
      continue;
    }
    if (arg.startsWith("-")) options.error = `unknown option ${arg}`;
    else options.paths.push(arg);
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  const fail = (message) => {
    process.stderr.write(`protected-grant-guard: ${message}\n`);
    return 2;
  };
  if (options.error !== null) return fail(options.error);

  const scratch = mkdtempSync(join(tmpdir(), "protected-grant-"));
  const explicit = options.paths.length > 0;
  const changed = explicit ? options.paths : changedPaths(options.repo, options.base);
  if (changed === null) {
    return fail(`could not read the change set \`${options.base}...HEAD\` from git`);
  }

  const logRef = options.logRef ?? options.base;
  let logFile = options.log;
  if (logFile === null) {
    logFile = materialize(options.repo, logRef, LOG_PATH, scratch, "events.jsonl");
    if (logFile === null) {
      return fail(`could not read ${LOG_PATH} at ${logRef}; no grant can be established`);
    }
  }

  const read = readVerifiedRecords(logFile, { cache: null });
  if (!read.ok) {
    return fail(`the log at ${logRef} is not readable as a verified chain (${read.code}: ${read.message})`);
  }

  // The window floor. Explicit `--since-seq` wins; otherwise it is HEAD's own
  // committed log head, which is the branch point. `0` (the whole log) is used
  // only when the caller supplied the log by path and named the paths itself,
  // which is the unit-test shape, never CI.
  let sinceSeq = options.sinceSeq === null ? null : Number.parseInt(options.sinceSeq, 10);
  if (sinceSeq !== null && !Number.isInteger(sinceSeq)) return fail("--since-seq expects an integer");
  if (sinceSeq === null) sinceSeq = explicit && options.log !== null ? 0 : branchPointSeq(options.repo, "HEAD");
  if (sinceSeq === null) {
    return fail(`could not read HEAD:${LOG_PATH} to establish the grant window`);
  }

  const audit = auditProtectedChanges(
    changed,
    read.records,
    protectedPaths(options.repo, options.base, scratch),
    // The checkout this run sits in, as an extra anchor. The roots that
    // actually matter are derived from the log's own worktree paths; this only
    // helps a local run against the checkout that minted them.
    [options.repo],
    sinceSeq,
  );

  if (options.json) {
    process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
  } else if (audit.findings.length === 0) {
    process.stdout.write("no protected path changed\n");
  } else {
    for (const finding of audit.findings) {
      process.stdout.write(
        finding.grant === null
          ? `UNAUTHORIZED ${finding.path} — no policy.edit grant in the log at ${logRef} names it\n`
          : `granted      ${finding.path} — seq ${finding.grant.seq} by ${finding.grant.actor} (${finding.grant.path})\n`,
      );
    }
  }

  if (audit.unauthorized.length === 0) return 0;
  process.stderr.write(
    `protected-grant-guard: ${audit.unauthorized.length} protected-path change(s) reached this branch with no human grant in the committed log. ` +
      "Either the change was made in a session whose approval hook never ran, or it was made outside the gate. " +
      "Re-apply it through a granted policy.edit from a gated session, or have a human land it.\n",
  );
  return 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
