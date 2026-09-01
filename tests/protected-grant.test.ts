/**
 * The protected-path grant guard (APRV-151).
 *
 * The guard exists because the session-local hook cannot report a hook that was
 * never invoked: a bypass of that shape leaves no record at all, so the only
 * place the question can be asked is from outside the session, over the
 * committed log. These suites therefore build every log through the REAL append
 * path — `core/gate.ts`'s `register`/`request`/`decide`/`withdraw`, which is the
 * only way a `policy.edit` grant ever exists — and never hand-write a line. A
 * guard tested against fabricated records would be a guard tested against
 * records the write boundary would have rejected.
 *
 * The two scenarios that name real files (`SPEC.md` in a worktree, and
 * `.github/workflows/ci.yml` in a worktree) are the two observed bypasses,
 * replayed in the shape the hook would have minted had it run.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { appendAttestation, decide, register, request, withdraw } from "./clock-adapters.js";
import type { EventRecord } from "../src/core/log.js";
import {
  auditProtectedChanges,
  checkoutRelative,
  checkoutRoots,
  grantedProtectedEdits,
  summaryPath,
} from "../src/core/protected-grant.js";
import { readVerifiedRecords } from "../src/core/state.js";
import { verify } from "../src/core/verify.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GUARD = join(REPO_ROOT, "scripts", "protected-grant-guard.mjs");

const scratch = mkdtempSync(join(tmpdir(), "approval-md-protected-grant-"));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const T0 = "2026-08-29T22:00:00.000Z";
const PAYLOAD_HASH = "7".repeat(64);

function at(minutes: number): string {
  return new Date(Date.parse(T0) + minutes * 60_000).toISOString();
}

const POLICY = [
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  "classes:",
  "  policy.edit:",
  "    autonomy: manual",
  "protected_paths:",
  "  - SPEC.md",
  "```",
  "",
].join("\n");

interface Case {
  dir: string;
  logPath: string;
  policyPath: string;
  options: { policy: { file: string } };
}

function newCase(): Case {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  const policyPath = join(dir, "APPROVAL.md");
  writeFileSync(policyPath, POLICY, "utf8");
  const unit: Case = {
    dir,
    logPath: join(dir, ".approval", "log", "events.jsonl"),
    policyPath,
    options: { policy: { file: policyPath } },
  };
  // Gated operations refuse against an unattested policy, so the ceremony runs
  // through the real append path here too.
  const attested = appendAttestation(unit.logPath, policyPath, "human:carter", T0);
  assert.equal(attested.ok, true, "attestation append failed");
  return unit;
}

/**
 * Register and request one `policy.edit` action, exactly as the hook does.
 *
 * The task id is the hook's own shape (`hook:<session>:<tool-use>`) and the
 * summary is the one `summaryFor` mints, so what the guard reads back here is
 * byte-for-byte what it reads back in production.
 */
function openEdit(unit: Case, key: string, summary: string, minute: number): string {
  const task = `hook:session-${counter}:${key}`;
  const actionKey = `${task}:policy.edit`;
  const registered = register(
    unit.logPath,
    {
      task,
      envelope: {
        origin: { app: "claude-code", created_by: "agent:claude-code" },
        state: "proposed",
        actions: [
          {
            class: "policy.edit",
            summary,
            reversible: true,
            est_cost_usd: "0",
            idempotency_key: actionKey,
            payload_hash: PAYLOAD_HASH,
          },
        ],
      },
    },
    at(minute),
    "agent:claude-code",
    unit.options,
  );
  assert.equal(registered.ok, true, registered.ok ? "" : registered.message);
  const requested = request(
    unit.logPath,
    { task, actionKey, cls: "policy.edit", summary, payload_hash: PAYLOAD_HASH },
    at(minute),
    "agent:claude-code",
    unit.options,
  );
  assert.equal(requested.ok, true, requested.ok ? "" : requested.message);
  return actionKey;
}

function grant(unit: Case, actionKey: string, minute: number): void {
  const decided = decide(unit.logPath, actionKey, "grant", "human:carter", at(minute), unit.options);
  assert.equal(decided.ok, true, decided.ok ? "" : decided.message);
}

function records(unit: Case): EventRecord[] {
  const read = readVerifiedRecords(unit.logPath, { cache: null });
  assert.equal(read.ok, true, read.ok ? "" : read.message);
  if (!read.ok) throw new Error("unreachable");
  return read.records;
}

function assertClean(unit: Case): void {
  assert.equal(verify(unit.logPath).status, "clean");
}

// ---------------------------------------------------------------------------
// Summary and path reading
// ---------------------------------------------------------------------------

test("summaryPath reads all three tier shapes the hook mints", () => {
  assert.equal(summaryPath("Edit /repo/SPEC.md"), "/repo/SPEC.md");
  assert.equal(
    summaryPath("branch proposal (worktree aprv-145-land): Edit /repo/.claude/worktrees/aprv-145-land/SPEC.md"),
    "/repo/.claude/worktrees/aprv-145-land/SPEC.md",
  );
  assert.equal(
    summaryPath("file named like a policy file, outside this gated checkout: Write /tmp/APPROVAL.md"),
    "/tmp/APPROVAL.md",
  );
  assert.equal(summaryPath("MultiEdit /repo/CLAUDE.md"), "/repo/CLAUDE.md");
});

test("summaryPath refuses a shell summary, so a command grant excuses no edit", () => {
  assert.equal(summaryPath("cd /repo && git add SPEC.md && git commit -m 'x'"), null);
  assert.equal(summaryPath("git push origin main"), null);
  assert.equal(summaryPath(""), null);
});

test("an agent-worktree path anchors itself, and names its own checkout root", () => {
  const path = "/Users/carter/dev/approval-md/.claude/worktrees/aprv-145-land/SPEC.md";
  assert.deepEqual(checkoutRoots([path]), ["Users/carter/dev/approval-md"]);
  assert.equal(checkoutRelative(path, []), "SPEC.md");
  assert.equal(
    checkoutRelative("/r/.claude/worktrees/w/.github/workflows/ci.yml", []),
    ".github/workflows/ci.yml",
  );
});

test("a live-checkout path anchors only against a known root, and never by suffix", () => {
  const roots = checkoutRoots(["/repo/.claude/worktrees/w/SPEC.md"]);
  assert.equal(checkoutRelative("/repo/SPEC.md", roots), "SPEC.md");
  assert.equal(
    checkoutRelative("/repo/docs/SPEC.md", roots),
    "docs/SPEC.md",
    "a different file resolves to a different relative path, so it cannot cover SPEC.md",
  );
  assert.equal(
    checkoutRelative("/elsewhere/SPEC.md", roots),
    null,
    "a path under no known checkout anchors nowhere and authorizes nothing",
  );
  assert.equal(checkoutRelative("/repo/../SPEC.md", roots), null);
});

test("a grant for docs/SPEC.md does not authorize a change to SPEC.md", () => {
  const unit = newCase();
  const key = openEdit(unit, "toolu_docs", "Edit /repo/.claude/worktrees/w/docs/SPEC.md", 0);
  grant(unit, key, 1);
  assertClean(unit);
  assert.equal(auditProtectedChanges(["SPEC.md"], records(unit), ["SPEC.md"]).unauthorized.length, 1);
});

// ---------------------------------------------------------------------------
// The audit, over real logs
// ---------------------------------------------------------------------------

test("a granted worktree edit authorizes the repository-relative change (the APRV-145 remediation)", () => {
  const unit = newCase();
  const key = openEdit(
    unit,
    "toolu_land",
    "branch proposal (worktree aprv-145-land): Edit /Users/carter/dev/approval-md/.claude/worktrees/aprv-145-land/SPEC.md",
    0,
  );
  grant(unit, key, 1);
  assertClean(unit);

  const audit = auditProtectedChanges(["SPEC.md"], records(unit), ["SPEC.md"]);
  assert.equal(audit.findings.length, 1);
  assert.equal(audit.unauthorized.length, 0);
  assert.equal(audit.findings[0]?.grant?.actor, "human:carter");
});

test("the observed bypass: a protected change with no grant anywhere in the log", () => {
  const unit = newCase();
  // A busy, entirely legitimate evening on some other file.
  const other = openEdit(unit, "toolu_other", "Edit /repo/docs/claude-code-hook.md", 0);
  grant(unit, other, 1);
  assertClean(unit);

  const audit = auditProtectedChanges(["SPEC.md"], records(unit), ["SPEC.md"]);
  assert.deepEqual(
    audit.unauthorized.map((finding) => finding.path),
    ["SPEC.md"],
  );
});

test("the ci.yml bypass is caught from the built-in protected set, with no policy at all", () => {
  const unit = newCase();
  assertClean(unit);
  const audit = auditProtectedChanges([".github/workflows/ci.yml", "src/cli/hook.ts"], records(unit));
  assert.deepEqual(
    audit.unauthorized.map((finding) => finding.path),
    [".github/workflows/ci.yml"],
    "an unprotected source file is not the guard's business, and ci.yml needs no policy to be protected",
  );
});

test("a request that was never answered authorizes nothing", () => {
  const unit = newCase();
  openEdit(unit, "toolu_pending", "Edit /repo/SPEC.md", 0);
  assertClean(unit);
  assert.equal(auditProtectedChanges(["SPEC.md"], records(unit), ["SPEC.md"]).unauthorized.length, 1);
});

test("a rejected request authorizes nothing", () => {
  const unit = newCase();
  const key = openEdit(unit, "toolu_denied", "Edit /repo/SPEC.md", 0);
  const decided = decide(unit.logPath, key, "reject", "human:carter", at(1), unit.options);
  assert.equal(decided.ok, true, decided.ok ? "" : decided.message);
  assertClean(unit);
  assert.equal(auditProtectedChanges(["SPEC.md"], records(unit), ["SPEC.md"]).unauthorized.length, 1);
});

test("a withdrawn request authorizes nothing", () => {
  const unit = newCase();
  const key = openEdit(unit, "toolu_withdrawn", "Edit /repo/SPEC.md", 0);
  const pulled = withdraw(unit.logPath, key, "agent:claude-code", at(1), {
    ...unit.options,
    reason: "cancelled",
  });
  assert.equal(pulled.ok, true, pulled.ok ? "" : pulled.message);
  assertClean(unit);
  assert.equal(auditProtectedChanges(["SPEC.md"], records(unit), ["SPEC.md"]).unauthorized.length, 1);
});

test("a granted SHELL policy.edit does not authorize the file it names", () => {
  const unit = newCase();
  const key = openEdit(
    unit,
    "toolu_shell",
    "cd /repo && git add SPEC.md && git commit -m 'APRV-145: land the amendment'",
    0,
  );
  grant(unit, key, 1);
  assertClean(unit);

  const audit = auditProtectedChanges(["SPEC.md"], records(unit), ["SPEC.md"]);
  assert.equal(audit.grants.length, 0, "a command grant is not a file grant");
  assert.equal(audit.unauthorized.length, 1);
});

test("a grant for one protected file does not cover another", () => {
  const unit = newCase();
  const key = openEdit(unit, "toolu_claude", "Edit /repo/.claude/worktrees/w/CLAUDE.md", 0);
  grant(unit, key, 1);
  assertClean(unit);

  const audit = auditProtectedChanges(["CLAUDE.md", "APPROVAL.md"], records(unit), []);
  assert.deepEqual(
    audit.unauthorized.map((finding) => finding.path),
    ["APPROVAL.md"],
  );
});

test("grantedProtectedEdits reports only what a human answered", () => {
  const unit = newCase();
  const granted = openEdit(unit, "toolu_a", "Edit /repo/SPEC.md", 0);
  openEdit(unit, "toolu_b", "Edit /repo/CLAUDE.md", 1);
  grant(unit, granted, 2);
  assertClean(unit);

  const edits = grantedProtectedEdits(records(unit));
  assert.deepEqual(
    edits.map((edit) => edit.path),
    ["/repo/SPEC.md"],
  );
});

test("the window excludes a grant older than the branch point", () => {
  const unit = newCase();
  const key = openEdit(
    unit,
    "toolu_old",
    "branch proposal (worktree old): Edit /repo/.claude/worktrees/old/SPEC.md",
    0,
  );
  grant(unit, key, 1);
  assertClean(unit);
  const all = records(unit);
  const head = all[all.length - 1]?.seq ?? 0;

  assert.equal(
    auditProtectedChanges(["SPEC.md"], all, ["SPEC.md"], [], 0).unauthorized.length,
    0,
    "with no window the grant stands",
  );
  assert.equal(
    auditProtectedChanges(["SPEC.md"], all, ["SPEC.md"], [], head).unauthorized.length,
    1,
    "a grant at or before the branch point authorizes nothing on this branch",
  );
});

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/** Run the guard with an explicit log and explicit paths. */
function runGuard(unit: Case, paths: readonly string[]): { status: number; out: string; err: string } {
  const result = spawnSync(
    process.execPath,
    [GUARD, "--log", unit.logPath, "--repo", unit.dir, ...paths],
    { encoding: "utf8" },
  );
  return { status: result.status ?? -1, out: result.stdout, err: result.stderr };
}

test("the runner exits 1 and names the file when a protected change has no grant", () => {
  const unit = newCase();
  assertClean(unit);
  const run = runGuard(unit, ["SPEC.md", ".github/workflows/ci.yml"]);
  assert.equal(run.status, 1);
  assert.match(run.out, /UNAUTHORIZED SPEC\.md/u);
  assert.match(run.out, /UNAUTHORIZED \.github\/workflows\/ci\.yml/u);
});

test("the runner exits 0 once the same change carries a grant", () => {
  const unit = newCase();
  const key = openEdit(
    unit,
    "toolu_ok",
    "branch proposal (worktree agent-a3f5d255372d43ac0): Edit /repo/.claude/worktrees/agent-a3f5d255372d43ac0/.github/workflows/ci.yml",
    0,
  );
  grant(unit, key, 1);
  assertClean(unit);

  const run = runGuard(unit, [".github/workflows/ci.yml"]);
  assert.equal(run.status, 0, run.err);
  assert.match(run.out, /^granted/mu);
});

test("the runner fails closed (exit 2) when it cannot read the change set from git", () => {
  const unit = newCase();
  const result = spawnSync(
    process.execPath,
    [GUARD, "--log", unit.logPath, "--repo", unit.dir, "--base", "origin/main"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /could not read the change set/u);
});

test("the runner fails closed (exit 2) when the log ref carries no log", () => {
  const unit = newCase();
  const result = spawnSync(
    process.execPath,
    [GUARD, "--repo", unit.dir, "SPEC.md"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /could not read \.approval\/log\/events\.jsonl/u);
});
