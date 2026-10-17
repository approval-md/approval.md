/**
 * The hook end to end for `git push` deletions (APRV-517).
 *
 * The APRV-648 refutation's S2 is a hook-level harm: `git push -ud origin
 * lane` reached the harness as an ALLOW (autonomous `vcs.push.branch`) and
 * `git push --del origin main` as an allow under supervised-retro, so the
 * manual `vcs.ref.delete` line of this repository's policy was never asked.
 * Each case here spawns the real compiled CLI as `approval hook claude-code`,
 * feeds it a Bash PreToolUse event under a policy shaped like this
 * repository's APPROVAL.md, and reads the verdict the harness would read.
 *
 * A manual class is asked and not answered here, so the hook denies on its
 * own short timeout; what the test reads is that it ASKED, and under which
 * class: the log gains an `approval.requested` naming `vcs.ref.delete`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-hook-push-")));
let counter = 0;
after(() => rmSync(scratch, { recursive: true, force: true }));

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, input = ""): Run {
  const env = { ...process.env };
  delete env["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], { cwd, encoding: "utf8", env, input });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** The push lines of this repository's APPROVAL.md. */
const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "  vcs.push.branch:",
  "    autonomy: autonomous",
  "  vcs.push.main:",
  "    autonomy: supervised-retro",
  "  vcs.history.rewrite:",
  "    autonomy: human-only",
  "  vcs.ref.delete:",
  "    autonomy: manual",
  "  release.publish:",
  "    autonomy: manual",
  "  policy.edit:",
  "    autonomy: manual",
  "  policy.core:",
  "    autonomy: manual",
  "  log.mutate:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

function ready(): string {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  return dir;
}

function rawLog(dir: string): string {
  const path = join(dir, ".approval/log/events.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function bashEvent(command: string, toolUseId: string): string {
  return JSON.stringify({
    session_id: "sess-push",
    transcript_path: "/dev/null",
    cwd: "/repo",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "just tidying a branch" },
    tool_use_id: toolUseId,
  });
}

function hook(dir: string, command: string, toolUseId: string): { permission: string; reason: string } {
  const run = runCli(
    ["hook", "claude-code", "--timeout", "200ms", "--interval", "50ms"],
    dir,
    bashEvent(command, toolUseId),
  );
  assert.equal(run.code, 0, `hook must exit 0 with a verdict: ${run.stderr}`);
  const output = (JSON.parse(run.stdout) as Record<string, Record<string, unknown>>)["hookSpecificOutput"];
  assert.ok(output !== undefined, "hookSpecificOutput is present");
  return { permission: String(output["permissionDecision"]), reason: String(output["permissionDecisionReason"]) };
}

/** The classes of the `approval.requested` records the log gained since `before`. */
function requestedClasses(dir: string, before: string): string[] {
  return rawLog(dir)
    .slice(before.length)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record["event"] === "approval.requested")
    .map((record) => String(record["class"] ?? (record["payload"] as Record<string, unknown> | undefined)?.["class"]));
}

const DELETING = [
  "git push -ud origin lane",
  "git push -du origin lane",
  "git push --del origin lane",
  "git push --de origin lane",
  "git push -ud origin main",
  "git push --del origin main",
  "git push --prune origin lane",
];

/** One attested gate for the whole file: attesting is the slow step, and each case has its own tool-use id. */
const gate = ready();

for (const [index, command] of DELETING.entries()) {
  test(`hook asks vcs.ref.delete for: ${command}`, () => {
    const dir = gate;
    const before = rawLog(dir);
    const verdict = hook(dir, command, `tu-del-${index}`);
    assert.equal(verdict.permission, "deny", verdict.reason);
    assert.match(verdict.reason, /^hook-timeout: /u);
    assert.deepEqual(requestedClasses(dir, before), ["vcs.ref.delete"], rawLog(dir).slice(before.length));
  });
}

test("hook: the control, an ordinary branch push, is still allowed unasked", () => {
  const dir = gate;
  const before = rawLog(dir);
  const verdict = hook(dir, "git push -u origin lane", "tu-control");
  assert.equal(verdict.permission, "allow", verdict.reason);
  assert.deepEqual(requestedClasses(dir, before), []);
});

test("hook: a push word the shell may expand is the human-only rewrite class", () => {
  const dir = gate;
  const before = rawLog(dir);
  const verdict = hook(dir, 'git push origin "$B"', "tu-unreadable");
  assert.equal(verdict.permission, "deny", verdict.reason);
  assert.match(verdict.reason, /^hook-class-human-only: /u);
  assert.deepEqual(requestedClasses(dir, before), []);
});

test("hook: an ambiguous abbreviation and a far-side program are refused as opaque", () => {
  const dir = gate;
  for (const [index, command] of ["git push --d origin lane", "git push --exec=x origin lane"].entries()) {
    const verdict = hook(dir, command, `tu-opaque-${index}`);
    assert.equal(verdict.permission, "deny", verdict.reason);
    assert.match(verdict.reason, /^hook-opaque: /u, command);
  }
});
