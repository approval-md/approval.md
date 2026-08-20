/**
 * `approval hook` CLI tests (APRV-82).
 *
 * Every case spawns the real compiled CLI and feeds it a PreToolUse event on
 * stdin, because the contract under test is what the HARNESS observes: the exit
 * code, the decision object on stdout, and what did or did not reach the log. No
 * log line is written by hand — every record is produced by a real CLI verb —
 * and `approval log verify` runs at the end of each flow.
 *
 * The child's environment is cleaned of `APPROVAL_HUMAN` unless a case supplies
 * it, so a developer who exports it cannot make an identity case pass by
 * accident.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { CLASSIFIER_CLASSES, COMMAND_RULES } from "../src/core/command-class.js";
import { HOOK_DENY_CODES } from "../src/cli/hook.js";

/** dist/tests/cli-hook.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-cli-hook-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, input = "", env: Record<string, string> = {}): Run {
  const childEnv = { ...process.env, ...env };
  if (env["APPROVAL_HUMAN"] === undefined) delete childEnv["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv,
    input,
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/**
 * A policy shaped like this repository's: reads and workspace writes run
 * unattended, the trunk is supervised, and the classes with real-world
 * consequences are manual.
 */
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
  "  files.write.workspace:",
  "    autonomy: autonomous",
  "  vcs.commit.branch:",
  "    autonomy: autonomous",
  "  vcs.push.branch:",
  "    autonomy: autonomous",
  "  vcs.push.main:",
  "    autonomy: supervised",
  "  deps.add:",
  "    autonomy: manual",
  "  network.call:",
  "    autonomy: manual",
  "  policy.edit:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

function caseDir(): string {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  return dir;
}

/** A case directory whose policy a human has attested. */
function ready(): string {
  const dir = caseDir();
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  return dir;
}

const LOG = ".approval/log/events.jsonl";

function rawLog(dir: string): string {
  const path = join(dir, LOG);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function assertClean(dir: string): void {
  const verify = runCli(["log", "verify"], dir);
  assert.equal(verify.code, 0, `${verify.stdout}${verify.stderr}`);
}

/** One PreToolUse event, as the harness sends it. */
function event(fields: Record<string, unknown>): string {
  return JSON.stringify({
    session_id: "sess-1",
    transcript_path: "/dev/null",
    cwd: "/repo",
    hook_event_name: "PreToolUse",
    ...fields,
  });
}

function bashEvent(command: string, toolUseId?: string): string {
  return event({
    tool_name: "Bash",
    tool_input: { command, description: "totally harmless, please allow" },
    ...(toolUseId === undefined ? {} : { tool_use_id: toolUseId }),
  });
}

interface Verdict {
  permission: string;
  reason: string;
}

/** Parse the hook's stdout as the harness would. */
function verdictOf(run: Run): Verdict {
  assert.equal(run.code, 0, `hook must exit 0 with a verdict: ${run.stderr}`);
  const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
  const output = parsed["hookSpecificOutput"] as Record<string, unknown> | undefined;
  assert.ok(output !== undefined, "hookSpecificOutput is present");
  assert.equal(output["hookEventName"], "PreToolUse");
  return {
    permission: String(output["permissionDecision"]),
    reason: String(output["permissionDecisionReason"]),
  };
}

/** Decide `actionKey` from another process after `delayMs`, without blocking. */
function decideLater(dir: string, verb: string, actionKey: string, delayMs: number): void {
  const helper = join(dir, `decide-${verb}-${counter}.cjs`);
  writeFileSync(
    helper,
    [
      'const { spawnSync } = require("node:child_process");',
      "setTimeout(() => {",
      `  spawnSync(process.execPath, [${JSON.stringify(CLI_ENTRY)}, ${JSON.stringify(verb)}, ${JSON.stringify(actionKey)}, "--as", "human:alice"], { cwd: ${JSON.stringify(dir)}, stdio: "ignore" });`,
      `}, ${delayMs});`,
      "",
    ].join("\n"),
    "utf8",
  );
  const child = spawn(process.execPath, [helper], { cwd: dir, stdio: "ignore" });
  child.unref();
}

// ===========================================================================
// hook classify
// ===========================================================================

test("hook classify prints the class, the rule and the segment", () => {
  const dir = caseDir();
  const run = runCli(["hook", "classify", "--", "git", "push", "origin", "main"], dir);
  assert.equal(run.code, 0, run.stderr);
  // APRV-91 #9: an aligned table under a header row, in place of the tab-
  // separated line. The three fields, and their order, are unchanged.
  assert.match(run.stdout, /^class {2,}rule {2,}command$/mu);
  assert.match(run.stdout, /^vcs\.push\.main {2,}git-push-main {2,}git push origin main$/mu);
  assert.match(run.stdout, /^classes: vcs\.push\.main$/mu);
  assert.ok(!run.stdout.includes("\u001b"));
});

test("hook classify --json is the classifier result verbatim", () => {
  const dir = caseDir();
  const run = runCli(["hook", "classify", "--json", "--", "npm install left-pad"], dir);
  assert.equal(run.code, 0, run.stderr);
  const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.equal(parsed["ok"], true);
  assert.deepEqual(parsed["classes"], ["deps.add"]);
});

test("hook classify reports a refusal without failing", () => {
  const dir = caseDir();
  const run = runCli(["hook", "classify", "--json", "--", "bash -c 'rm -rf /'"], dir);
  assert.equal(run.code, 0, run.stderr);
  const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.equal(parsed["ok"], false);
  assert.equal(parsed["code"], "opaque");
});

test("hook classify writes nothing to the log", () => {
  const dir = ready();
  const before = rawLog(dir);
  runCli(["hook", "classify", "--", "npm publish"], dir);
  assert.equal(rawLog(dir), before);
});

test("hook classify without a command is a usage error", () => {
  const dir = caseDir();
  const run = runCli(["hook", "classify"], dir);
  assert.equal(run.code, 2);
});

// ===========================================================================
// hook claude-code: the paths that never touch the log
// ===========================================================================

test("a non-gated tool passes through", () => {
  const dir = ready();
  const before = rawLog(dir);
  const run = runCli(
    ["hook", "claude-code", "--as", "agent:claude-code"],
    dir,
    event({ tool_name: "Read", tool_input: { file_path: "src/core/gate.ts" } }),
  );
  assert.equal(verdictOf(run).permission, "allow");
  assert.equal(rawLog(dir), before, "a pass-through must not touch the log");
});

test("an ordinary file edit passes through; a policy file does not", () => {
  const dir = ready();
  const ordinary = runCli(
    ["hook", "claude-code"],
    dir,
    event({ tool_name: "Write", tool_input: { file_path: "src/core/x.ts" } }),
  );
  assert.equal(verdictOf(ordinary).permission, "allow");

  const before = rawLog(dir);
  const protectedEdit = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    event({ tool_name: "Write", tool_input: { file_path: "APPROVAL.md" } }),
  );
  const verdict = verdictOf(protectedEdit);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-timeout: /u);
  assert.notEqual(rawLog(dir), before, "the policy.edit request must reach the log");
  const log = rawLog(dir);
  assert.match(log, /"class":"policy\.edit"/u);
  assertClean(dir);
});

test("an autonomous command is allowed with no log growth", () => {
  const dir = ready();
  const before = rawLog(dir);
  const run = runCli(["hook", "claude-code"], dir, bashEvent("ls -la && git status"));
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "allow");
  assert.match(verdict.reason, /^autonomous: /u);
  assert.equal(rawLog(dir), before, "an autonomous action has no approval lifecycle");
});

test("the approval CLI itself is pass-through", () => {
  const dir = ready();
  const before = rawLog(dir);
  const run = runCli(["hook", "claude-code"], dir, bashEvent("approval queue --json"));
  assert.equal(verdictOf(run).permission, "allow");
  assert.equal(rawLog(dir), before);
});

test("an unclassified command denies without touching the log", () => {
  const dir = ready();
  const before = rawLog(dir);
  const run = runCli(["hook", "claude-code"], dir, bashEvent("vim CLAUDE.md"));
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-unclassified: /u);
  assert.equal(rawLog(dir), before);
});

test("an opaque command denies", () => {
  const dir = ready();
  const run = runCli(["hook", "claude-code"], dir, bashEvent("bash -c 'git push --force'"));
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-opaque: /u);
});

test("malformed stdin denies with hook-io", () => {
  const dir = ready();
  const run = runCli(["hook", "claude-code"], dir, "{not json");
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-io: /u);
});

test("empty stdin denies with hook-io", () => {
  const dir = ready();
  const verdict = verdictOf(runCli(["hook", "claude-code"], dir, ""));
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-io: /u);
});

test("an unattested policy denies with the gate's own refusal code", () => {
  const dir = caseDir();
  // APRV-101: the hook writes to an existing log and creates none, so this case
  // has to be a scaffolded (empty) log — otherwise the refusal under test is
  // preempted by `hook-log-unreachable`, which is a different sentence about a
  // different problem. `init` makes .approval/log/ and appends nothing.
  const init = runCli(["init"], dir);
  assert.equal(init.code, 0, init.stderr);
  const run = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    bashEvent("npm install left-pad"),
  );
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-gate-refused:policy-not-attested: /u);
});

test("an unloadable policy denies with hook-policy-unavailable", () => {
  const dir = ready();
  const run = runCli(
    ["hook", "claude-code", "--policy", "nowhere/APPROVAL.md"],
    dir,
    bashEvent("ls -la"),
  );
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-policy-unavailable: /u);
});

// ===========================================================================
// hook claude-code: the gated paths
// ===========================================================================

test("a manual command is allowed when a grant lands mid-wait", () => {
  const dir = ready();
  decideLater(dir, "grant", "hook:sess-1:tu-grant:deps.add", 700);
  const run = runCli(
    ["hook", "claude-code", "--as", "agent:claude-code", "--timeout", "20s", "--interval", "100ms"],
    dir,
    bashEvent("npm install left-pad", "tu-grant"),
  );
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "allow", verdict.reason);
  assert.match(verdict.reason, /^granted: /u);
  const log = rawLog(dir);
  assert.match(log, /"event":"approval\.requested"/u);
  assert.match(log, /"event":"approval\.granted"/u);
  assertClean(dir);
});

test("a rejected request denies with hook-rejected", () => {
  const dir = ready();
  decideLater(dir, "reject", "hook:sess-1:tu-reject:network.call", 700);
  const run = runCli(
    ["hook", "claude-code", "--timeout", "20s", "--interval", "100ms"],
    dir,
    bashEvent("curl -sS https://example.com", "tu-reject"),
  );
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-rejected: /u);
  assertClean(dir);
});

test("no decision inside --timeout denies with hook-timeout and LEAVES THE REQUEST OPEN", () => {
  // APRV-106 withdrew here, because a retried tool call was a new request with
  // a new key and a late grant therefore authorized nothing. APRV-117 removes
  // that premise (a retry adopts or carries the same question, keyed by the
  // payload hash), so the question stays in front of the human and the answer
  // it gets is worth something. The property APRV-106 was protecting — never
  // solicit a decision nobody can consume — is preserved by carryover rather
  // than by retraction, and the two tests below are what hold it.
  const dir = ready();
  const run = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    bashEvent("npm install left-pad", "tu-timeout"),
  );
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-timeout: /u);
  assert.match(verdict.reason, /NOTHING WAS WITHDRAWN/u);
  assert.match(verdict.reason, /authorizes a retry/u);

  // Nothing was retracted, and the request is the hook's own harness request.
  const log = rawLog(dir);
  assert.doesNotMatch(log, /"event":"approval\.withdrawn"/u);
  assert.match(log, /"event":"approval\.requested"/u);
  assert.match(log, /"execution":"harness"/u);
  assert.match(log, /"actor":"agent:claude-code"/u);

  // APRV-106's `wait_until` is gone: under carryover the sentence it rendered
  // ("requester waits until …") is false, and the deadline that governs is the
  // policy's TTL, which the channel line falls back to on its own.
  assert.doesNotMatch(log, /"wait_until"/u);

  // The human's inbox still holds the question, because answering it still does
  // something.
  const queue = runCli(["queue", "--json"], dir);
  assert.equal(queue.code, 0, queue.stderr);
  assert.match(queue.stdout, /hook:sess-1:tu-timeout:deps\.add/u);
  assertClean(dir);
});

test("a grant landing after the wait authorizes an identical retry, with no second prompt", () => {
  // APRV-117 AC#1 and AC#2's converse: the incident of 2026-08-19, replayed and
  // fixed. The hook gives up, the human answers late, and the retried command
  // proceeds on the answer they gave.
  const dir = ready();
  const first = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    bashEvent("npm install left-pad", "tu-late"),
  );
  assert.equal(verdictOf(first).permission, "deny");

  // The late tap. It is accepted now — the request is still pending.
  const late = runCli(
    ["grant", "hook:sess-1:tu-late:deps.add", "--as", "human:carter", "--json"],
    dir,
  );
  assert.equal(late.code, 0, late.stderr);

  // The retry: same bytes, same cwd, a NEW tool-use id, as the harness sends it.
  const retry = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    bashEvent("npm install left-pad", "tu-retry"),
  );
  const verdict = verdictOf(retry);
  assert.equal(verdict.permission, "allow", verdict.reason);
  assert.match(verdict.reason, /^granted: /u);
  assert.match(verdict.reason, /carried: hook:sess-1:tu-late:deps\.add/u);

  // No second question was ever asked: exactly one approval.requested exists,
  // and the retry opened no request of its own.
  const log = rawLog(dir);
  assert.equal(log.match(/"event":"approval\.requested"/gu)?.length, 1);
  assert.doesNotMatch(log, /hook:sess-1:tu-retry/u);

  // The grant was spent, once, through the ordinary execution vocabulary.
  assert.match(log, /"event":"execution\.started"/u);
  assert.doesNotMatch(log, /"event":"execution\.completed"/u);
  assertClean(dir);
});

test("a carried grant is spent exactly once; the next identical command asks again", () => {
  // APRV-117 AC#3. The second retry gets no free ride: it files a fresh request
  // through the ordinary path and waits like anything else.
  const dir = ready();
  runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    bashEvent("npm install left-pad", "tu-once"),
  );
  const granted = runCli(
    ["grant", "hook:sess-1:tu-once:deps.add", "--as", "human:carter"],
    dir,
  );
  assert.equal(granted.code, 0, granted.stderr);

  const spend = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    bashEvent("npm install left-pad", "tu-spend"),
  );
  assert.equal(verdictOf(spend).permission, "allow");

  const again = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    bashEvent("npm install left-pad", "tu-again"),
  );
  const verdict = verdictOf(again);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-timeout: /u);

  const log = rawLog(dir);
  // Two questions in total: the one the human answered, and the one the third
  // invocation had to ask because the answer had been spent.
  assert.equal(log.match(/"event":"approval\.requested"/gu)?.length, 2);
  assert.equal(log.match(/"event":"execution\.started"/gu)?.length, 1);
  assert.match(log, /hook:sess-1:tu-again:deps\.add/u);
  assertClean(dir);
});

test("a retry while the question is pending adopts it rather than opening a duplicate", () => {
  // APRV-117 AC#2: the phone never shows two prompts for one command.
  const dir = ready();
  for (const toolUseId of ["tu-adopt-1", "tu-adopt-2", "tu-adopt-3"]) {
    const run = runCli(
      ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
      dir,
      bashEvent("curl -sS https://example.com", toolUseId),
    );
    assert.equal(verdictOf(run).permission, "deny");
  }

  const log = rawLog(dir);
  assert.equal(log.match(/"event":"approval\.requested"/gu)?.length, 1);
  // Only the first invocation registered a task; the other two adopted its
  // question and registered nothing.
  assert.equal(log.match(/"event":"task\.registered"/gu)?.length, 1);
  assert.doesNotMatch(log, /tu-adopt-2/u);
  assert.doesNotMatch(log, /tu-adopt-3/u);

  // And the adopters can consume the decision the first one waited for.
  const granted = runCli(
    ["grant", "hook:sess-1:tu-adopt-1:network.call", "--as", "human:carter"],
    dir,
  );
  assert.equal(granted.code, 0, granted.stderr);
  const after = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    bashEvent("curl -sS https://example.com", "tu-adopt-4"),
  );
  assert.equal(verdictOf(after).permission, "allow");
  assertClean(dir);
});

test("replay bounds: different bytes or a different cwd is a different question", () => {
  // APRV-117 AC#4. The grant authorizes THESE bytes in THIS directory. Anything
  // else is a new request and a new prompt.
  const dir = ready();
  runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    bashEvent("npm install left-pad", "tu-bounds"),
  );
  const granted = runCli(
    ["grant", "hook:sess-1:tu-bounds:deps.add", "--as", "human:carter"],
    dir,
  );
  assert.equal(granted.code, 0, granted.stderr);

  // A different command: one character of difference is a different payload.
  const otherBytes = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    bashEvent("npm install right-pad", "tu-other-bytes"),
  );
  const bytesVerdict = verdictOf(otherBytes);
  assert.equal(bytesVerdict.permission, "deny");
  assert.match(bytesVerdict.reason, /^hook-timeout: /u);

  // The same command, run somewhere else. `cwd` is inside the hashed payload.
  const elsewhere = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    JSON.stringify({
      session_id: "sess-1",
      cwd: "/somewhere-else",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm install left-pad" },
      tool_use_id: "tu-other-cwd",
    }),
  );
  const cwdVerdict = verdictOf(elsewhere);
  assert.equal(cwdVerdict.permission, "deny");
  assert.match(cwdVerdict.reason, /^hook-timeout: /u);

  // Three separate questions; the original grant is untouched and unspent.
  const log = rawLog(dir);
  assert.equal(log.match(/"event":"approval\.requested"/gu)?.length, 3);
  assert.equal(log.match(/"event":"execution\.started"/gu)?.length, undefined);
  assertClean(dir);
});

test("a grant that lapsed its TTL carries nothing", async () => {
  // The last replay bound: within the TTL. A one-second TTL makes the lapse
  // observable without a clock injection, and `queue` is what materialises it.
  const dir = caseDir();
  writeFileSync(
    join(dir, "APPROVAL.md"),
    POLICY.replace('approval_ttl: "1h"', 'approval_ttl: "1s"'),
    "utf8",
  );
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);

  runCli(
    ["hook", "claude-code", "--timeout", "100ms", "--interval", "50ms"],
    dir,
    bashEvent("npm install left-pad", "tu-ttl"),
  );
  const granted = runCli(["grant", "hook:sess-1:tu-ttl:deps.add", "--as", "human:carter"], dir);
  assert.equal(granted.code, 0, granted.stderr);

  // Wait out the TTL, then retry: the grant is no longer live, so the retry
  // asks its own question rather than proceeding on a lapsed one.
  await delay(1_400);
  const retry = runCli(
    ["hook", "claude-code", "--timeout", "100ms", "--interval", "50ms"],
    dir,
    bashEvent("npm install left-pad", "tu-ttl-retry"),
  );
  assert.equal(verdictOf(retry).permission, "deny");
  const log = rawLog(dir);
  assert.equal(log.match(/"event":"approval\.requested"/gu)?.length, 2);
  assert.equal(log.match(/"event":"execution\.started"/gu)?.length, undefined);
  assertClean(dir);
});

test("a supervised class is allowed and records no approval event", () => {
  const dir = ready();
  const run = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    bashEvent("git push origin main", "tu-supervised"),
  );
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "allow", verdict.reason);
  const log = rawLog(dir);
  assert.match(log, /"event":"task\.registered"/u);
  assert.doesNotMatch(log, /"event":"approval\.requested"/u);
  assertClean(dir);
});

test("a mixed command gates on the strictest class it contains", () => {
  const dir = ready();
  const run = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    bashEvent("git status && curl -sS https://example.com", "tu-mixed"),
  );
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-timeout: /u);
  assert.match(rawLog(dir), /"class":"network\.call"/u);
  assertClean(dir);
});

// ===========================================================================
// Usage
// ===========================================================================

test("hook --help and the subcommand helps exit 0", () => {
  const dir = caseDir();
  for (const args of [
    ["hook", "--help"],
    ["hook", "claude-code", "--help"],
    ["hook", "classify", "--help"],
  ]) {
    const run = runCli(args, dir);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /approval hook/u);
  }
});

test("an unknown subcommand and an unknown flag are usage errors, not verdicts", () => {
  const dir = caseDir();
  const unknownSub = runCli(["hook", "codex"], dir);
  assert.equal(unknownSub.code, 2);
  assert.equal(unknownSub.stdout, "");

  const unknownFlag = runCli(["hook", "claude-code", "--force"], dir, bashEvent("ls"));
  assert.equal(unknownFlag.code, 2);
  assert.equal(unknownFlag.stdout, "");
});

test("a non-principal --as is a usage error", () => {
  const dir = ready();
  const run = runCli(["hook", "claude-code", "--as", "system:gate"], dir, bashEvent("ls"));
  assert.equal(run.code, 2);
});

test("docs/claude-code-hook.md still lists every rule and every deny code", () => {
  // The doc's table is hand-kept. This is what keeps it honest: a rule added to
  // the classifier without a row here, or a renamed deny code, fails the suite
  // rather than leaving a reader with a table that quietly stopped being true.
  const doc = readFileSync(
    fileURLToPath(new URL("../../docs/claude-code-hook.md", import.meta.url)),
    "utf8",
  );
  for (const rule of COMMAND_RULES) {
    assert.ok(doc.includes(`\`${rule.id}\``), `docs/claude-code-hook.md has no row for ${rule.id}`);
  }
  for (const cls of CLASSIFIER_CLASSES) {
    assert.ok(doc.includes(cls), `docs/claude-code-hook.md never mentions ${cls}`);
  }
  for (const code of HOOK_DENY_CODES) {
    assert.ok(doc.includes(code), `docs/claude-code-hook.md never mentions ${code}`);
  }
});

// ===========================================================================
// policy.protected_paths (APRV-107)
// ===========================================================================

/** A case directory whose attested policy widens the protected set. */
function readyWithProtectedPaths(): string {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "APPROVAL.md"),
    POLICY.replace(
      "classes:",
      ["protected_paths:", "  - SPEC.md", "  - design/", "classes:"].join("\n"),
    ),
    "utf8",
  );
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  return dir;
}

test("an edit to a policy-listed file is gated; the same file is ungated without the list", () => {
  const listed = readyWithProtectedPaths();
  const before = rawLog(listed);
  const gated = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    listed,
    event({ tool_name: "Edit", tool_input: { file_path: "SPEC.md" } }),
  );
  const verdict = verdictOf(gated);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-timeout: /u);
  assert.notEqual(rawLog(listed), before, "the policy.edit request must reach the log");
  assert.match(rawLog(listed), /"class":"policy\.edit"/u);
  assertClean(listed);

  // Same file, a policy that never named it: an ordinary workspace edit.
  const plain = ready();
  const plainBefore = rawLog(plain);
  const ungated = runCli(
    ["hook", "claude-code"],
    plain,
    event({ tool_name: "Edit", tool_input: { file_path: "SPEC.md" } }),
  );
  assert.equal(verdictOf(ungated).permission, "allow");
  assert.equal(rawLog(plain), plainBefore, "an ungated edit must not touch the log");
});

test("a listed directory prefix gates a Bash write beneath it", () => {
  const dir = readyWithProtectedPaths();
  const run = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    bashEvent("cp notes.md design/notes.md"),
  );
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-timeout: /u);
  assert.match(rawLog(dir), /"class":"policy\.edit"/u);
  assertClean(dir);
});

test("the built-in protected set survives a policy that lists other paths", () => {
  const dir = readyWithProtectedPaths();
  const run = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    dir,
    event({ tool_name: "Write", tool_input: { file_path: "CLAUDE.md" } }),
  );
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /^hook-timeout: /u);
  assertClean(dir);
});

test("an unlisted workspace file is still autonomous under a widened policy", () => {
  const dir = readyWithProtectedPaths();
  const before = rawLog(dir);
  const run = runCli(
    ["hook", "claude-code"],
    dir,
    event({ tool_name: "Write", tool_input: { file_path: "src/core/x.ts" } }),
  );
  assert.equal(verdictOf(run).permission, "allow");
  assert.equal(rawLog(dir), before);
});

test("hook classify reads the policy, and --dir scopes which policy", () => {
  const listed = readyWithProtectedPaths();
  const plain = caseDir();

  const inPlace = runCli(["hook", "classify", "--json", "--", "cp draft.md SPEC.md"], listed);
  assert.equal(inPlace.code, 0, inPlace.stderr);
  assert.deepEqual(
    (JSON.parse(inPlace.stdout) as { classes: string[] }).classes,
    ["policy.edit"],
  );

  const elsewhere = runCli(["hook", "classify", "--json", "--", "cp draft.md SPEC.md"], plain);
  assert.deepEqual(
    (JSON.parse(elsewhere.stdout) as { classes: string[] }).classes,
    ["files.write.workspace"],
  );

  const scoped = runCli(
    ["hook", "classify", "--json", "--dir", listed, "--", "cp draft.md SPEC.md"],
    plain,
  );
  assert.deepEqual(
    (JSON.parse(scoped.stdout) as { classes: string[] }).classes,
    ["policy.edit"],
  );
});

test("hook classify with no readable policy still answers, and says it is the narrow answer", () => {
  const bare = join(scratch, "no-policy");
  mkdirSync(bare, { recursive: true });
  const run = runCli(["hook", "classify", "--json", "--", "cp draft.md SPEC.md"], bare);
  assert.equal(run.code, 0);
  assert.deepEqual(
    (JSON.parse(run.stdout) as { classes: string[] }).classes,
    ["files.write.workspace"],
  );
  assert.match(run.stderr, /built-in protected paths only/u);
  // The built-ins never depend on a policy being readable.
  const builtin = runCli(["hook", "classify", "--json", "--", "cp draft.md CLAUDE.md"], bare);
  assert.deepEqual(
    (JSON.parse(builtin.stdout) as { classes: string[] }).classes,
    ["policy.edit"],
  );
});

test("HOOK_DENY_CODES is the closed vocabulary the help text prints", () => {
  const help = runCli(["hook", "--help"], caseDir()).stdout;
  for (const code of HOOK_DENY_CODES) {
    assert.match(help, new RegExp(code.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
});
