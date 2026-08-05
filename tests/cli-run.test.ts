/**
 * `approval run` and `approval wait` CLI tests (APRV-18 Part B/C).
 *
 * Every case spawns the real compiled CLI as a child process, because the
 * contract under test is what a human or an agent observes: the exit code, the
 * bytes on each stream, and the lines that end up in the log. No log line is
 * written by hand — every record is produced by the CLI — and `approval log
 * verify` runs after each flow.
 *
 * The child's environment is cleaned of `APPROVAL_HUMAN` unless a case supplies
 * it, so a developer who exports it cannot make the missing-identity cases pass
 * by accident.
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
import { fileURLToPath } from "node:url";

/** dist/tests/cli-run.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-cli-run-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, env: Record<string, string> = {}): Run {
  const childEnv = { ...process.env, ...env };
  if (env["APPROVAL_HUMAN"] === undefined) delete childEnv["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv,
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

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
  "  files.write.*:",
  "    autonomy: supervised",
  "  communicate.email.external:",
  "    autonomy: manual",
  "budgets:",
  "  global:",
  "    daily_usd: 10",
  "    daily_actions: 50",
  "```",
  "",
].join("\n");

/** Short enough to lapse inside a test. */
const POLICY_SHORT_TTL = POLICY.replace('approval_ttl: "1h"', 'approval_ttl: "1s"');

/** One supervised action a day: the second start must be refused. */
const POLICY_TIGHT = POLICY.replace("    daily_actions: 50", "    daily_actions: 1");

const TASK_FILE = [
  "---",
  "id: task-042",
  "title: Chase deposit refund",
  "status: In Progress",
  "approval:",
  "  origin:",
  "    app: cartsos",
  '    created_by: "human:carter"',
  "  state: proposed",
  "  actions:",
  "    - class: communicate.email.external",
  '      summary: "Send deposit chaser"',
  "      reversible: false",
  "      est_cost_usd: 0.02",
  '      idempotency_key: "task-042:chaser"',
  "    - class: files.write.local",
  '      summary: "Write the draft"',
  "      reversible: true",
  "      est_cost_usd: 0.01",
  '      idempotency_key: "task-042:draft"',
  "    - class: files.write.local",
  '      summary: "Write the second draft"',
  "      reversible: true",
  "      est_cost_usd: 0.01",
  '      idempotency_key: "task-042:draft2"',
  "---",
  "",
  "## Description",
  "Body.",
  "",
].join("\n");

function caseDir(policyText: string = POLICY): string {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), policyText, "utf8");
  writeFileSync(join(dir, "task-042.md"), TASK_FILE, "utf8");
  return dir;
}

function logPath(dir: string): string {
  return join(dir, ".approval", "log", "events.jsonl");
}

function rawLog(dir: string): string {
  return existsSync(logPath(dir)) ? readFileSync(logPath(dir), "utf8") : "";
}

function logRecords(dir: string): Record<string, unknown>[] {
  return rawLog(dir)
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function events(dir: string): string[] {
  return logRecords(dir).map((record) => String(record["event"]));
}

function lastRecord(dir: string): Record<string, unknown> {
  const all = logRecords(dir);
  return all[all.length - 1] as Record<string, unknown>;
}

function assertClean(dir: string): void {
  const verify = runCli(["log", "verify", "--json"], dir);
  assert.equal(verify.code, 0, verify.stderr);
  assert.equal((JSON.parse(verify.stdout) as Record<string, unknown>)["status"], "clean");
}

function jsonErr(run: Run): Record<string, unknown> {
  const parsed = JSON.parse(run.stderr.trim().split("\n")[0] as string) as Record<string, unknown>;
  return (parsed["error"] ?? parsed) as Record<string, unknown>;
}

/** Attest + register: the baseline every scenario starts from. */
function ready(policyText: string = POLICY): string {
  const dir = caseDir(policyText);
  assert.equal(runCli(["policy", "attest", "--as", "human:carter"], dir).code, 0);
  assert.equal(runCli(["register", "task-042.md", "--as", "agent:claude"], dir).code, 0);
  return dir;
}

/** Request + grant the manual action; returns the raw token, printed once. */
function grantChaser(dir: string): string {
  assert.equal(
    runCli(["request", "task-042", "--action", "task-042:chaser", "--as", "agent:claude"], dir).code,
    0,
  );
  const granted = runCli(["grant", "task-042:chaser", "--as", "human:carter", "--json"], dir);
  assert.equal(granted.code, 0, granted.stderr);
  const token = (JSON.parse(granted.stdout) as Record<string, unknown>)["token"];
  assert.equal(typeof token, "string");
  return String(token);
}

/** A child that exits with `code` after printing a marker. */
function exiting(code: number): string[] {
  return [process.execPath, "-e", `console.log("child ran");process.exit(${code})`];
}

// ===========================================================================
// approval run — refusals
// ===========================================================================

test("run without a token on a manual action exits 5 and appends NOTHING", () => {
  const dir = ready();
  grantChaser(dir);
  const before = rawLog(dir);

  const run = runCli(
    ["run", "task-042:chaser", "--as", "agent:claude", "--json", "--", ...exiting(0)],
    dir,
  );
  assert.equal(run.code, 5, run.stderr);
  assert.equal(jsonErr(run)["code"], "token-required");
  assert.equal(rawLog(dir), before, "the refusal wrote to the log");
  assert.equal(run.stdout.includes("child ran"), false, "the child was spawned anyway");
  assertClean(dir);
});

test("run with the wrong token exits 1 (a refusal is not a missing token)", () => {
  const dir = ready();
  grantChaser(dir);
  const run = runCli(
    [
      "run",
      "task-042:chaser",
      "--token",
      "a".repeat(64),
      "--as",
      "agent:claude",
      "--json",
      "--",
      ...exiting(0),
    ],
    dir,
  );
  assert.equal(run.code, 1, run.stderr);
  assert.equal(jsonErr(run)["code"], "token-mismatch");
  assert.equal(run.stdout.includes("child ran"), false);
  assertClean(dir);
});

test("run on an undeclared action key exits 1 with action-not-registered", () => {
  const dir = ready();
  const run = runCli(
    ["run", "task-042:nope", "--as", "agent:claude", "--json", "--", ...exiting(0)],
    dir,
  );
  assert.equal(run.code, 1);
  assert.equal(jsonErr(run)["code"], "action-not-registered");
});

test("run without a command, without an action key, or without an identity exits 2", () => {
  const dir = ready();
  assert.equal(runCli(["run", "task-042:draft", "--as", "agent:claude"], dir).code, 2);
  assert.equal(runCli(["run", "--as", "agent:claude", "--", ...exiting(0)], dir).code, 2);
  assert.equal(runCli(["run", "task-042:draft", "--", ...exiting(0)], dir).code, 2);
  assert.equal(rawLog(dir).includes("execution.started"), false);
});

// ===========================================================================
// approval run — the happy paths
// ===========================================================================

test("run appends execution.started BEFORE the child runs, then completed with exit 0", () => {
  const dir = ready();
  const token = grantChaser(dir);
  const snapshot = join(dir, "log-as-the-child-saw-it.jsonl");

  // The child copies the log the moment it starts: whatever is in that file is
  // proof of what had been appended before the spawn.
  const run = runCli(
    [
      "run",
      "task-042:chaser",
      "--token",
      token,
      "--as",
      "agent:claude",
      "--json",
      "--",
      process.execPath,
      "-e",
      "require('fs').copyFileSync(process.env.SNAP_LOG, process.env.SNAP_OUT);console.log('child ran')",
    ],
    dir,
    { SNAP_LOG: logPath(dir), SNAP_OUT: snapshot },
  );

  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /child ran/u);

  const seen = readFileSync(snapshot, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as Record<string, unknown>)["event"]);
  assert.equal(seen[seen.length - 1], "execution.started", "started was not appended before spawn");
  assert.equal(seen.includes("execution.completed"), false);

  assert.deepEqual(events(dir), [
    "policy.updated",
    "task.registered",
    "approval.requested",
    "approval.granted",
    "execution.started",
    "execution.completed",
  ]);
  assert.deepEqual(lastRecord(dir)["payload"], { exit_code: 0 });
  assert.equal(rawLog(dir).includes(token), false, "the raw token reached the log");

  // The --json summary is on STDERR: stdout belongs to the child.
  const summary = JSON.parse(run.stderr.trim()) as Record<string, unknown>;
  assert.deepEqual(summary, {
    ok: true,
    action_key: "task-042:chaser",
    task: "task-042",
    class: "communicate.email.external",
    autonomy: "manual",
    started_seq: 5,
    outcome: "execution.completed",
    outcome_seq: 6,
    exit_code: 0,
  });
  assertClean(dir);
});

test("a failing child is recorded as execution.failed and run exits with the child's code", () => {
  const dir = ready();
  const token = grantChaser(dir);
  const run = runCli(
    ["run", "task-042:chaser", "--token", token, "--as", "agent:claude", "--", ...exiting(42)],
    dir,
  );
  assert.equal(run.code, 42, run.stderr);
  assert.equal(lastRecord(dir)["event"], "execution.failed");
  assert.deepEqual(lastRecord(dir)["payload"], { exit_code: 42 });
  assertClean(dir);
});

test("a child killed by a signal is recorded and reported as 128 + signal", () => {
  const dir = ready();
  const token = grantChaser(dir);
  const run = runCli(
    [
      "run",
      "task-042:chaser",
      "--token",
      token,
      "--as",
      "agent:claude",
      "--",
      process.execPath,
      "-e",
      "process.kill(process.pid, 'SIGKILL')",
    ],
    dir,
  );
  assert.equal(run.code, 137, `expected 128+SIGKILL(9): ${run.stderr}`);
  assert.equal(lastRecord(dir)["event"], "execution.failed");
  assert.deepEqual(lastRecord(dir)["payload"], { exit_code: 137 });
  assertClean(dir);
});

test("a command that cannot be spawned is recorded as exit_code 127", () => {
  const dir = ready();
  const token = grantChaser(dir);
  const run = runCli(
    [
      "run",
      "task-042:chaser",
      "--token",
      token,
      "--as",
      "agent:claude",
      "--",
      join(dir, "no-such-binary"),
    ],
    dir,
  );
  assert.equal(run.code, 127);
  assert.deepEqual(lastRecord(dir)["payload"], { exit_code: 127 });
  assertClean(dir);
});

test("a supervised action runs with NO token and its budget is charged at the start", () => {
  const dir = ready();
  const run = runCli(
    ["run", "task-042:draft", "--as", "agent:claude", "--json", "--", ...exiting(0)],
    dir,
  );
  assert.equal(run.code, 0, run.stderr);
  const summary = JSON.parse(run.stderr.trim()) as Record<string, unknown>;
  assert.equal(summary["autonomy"], "supervised");

  assert.deepEqual(events(dir), [
    "policy.updated",
    "task.registered",
    "execution.started",
    "execution.completed",
  ]);
  assert.deepEqual(logRecords(dir)[2]?.["payload"], {
    class: "files.write.local",
    est_cost_usd: 0.01,
  });

  // The start event IS the authorization the budget window counts.
  const status = runCli(["status", "--json"], dir);
  const budgets = (JSON.parse(status.stdout) as Record<string, unknown>)["budgets"] as Record<
    string,
    unknown
  >[];
  assert.equal(budgets.find((entry) => entry["limit"] === "global.daily_usd")?.["consumed"], 0.01);
  assertClean(dir);
});

test("a supervised start over budget exits 1 and logs budget.exceeded", () => {
  const dir = ready(POLICY_TIGHT);
  assert.equal(
    runCli(["run", "task-042:draft", "--as", "agent:claude", "--", ...exiting(0)], dir).code,
    0,
  );
  const run = runCli(
    ["run", "task-042:draft2", "--as", "agent:claude", "--json", "--", ...exiting(0)],
    dir,
  );
  assert.equal(run.code, 1);
  assert.equal(jsonErr(run)["code"], "budget-exceeded");
  assert.equal(run.stdout.includes("child ran"), false);
  assert.equal(events(dir).includes("budget.exceeded"), true);
  assertClean(dir);
});

test("a supervised run refuses when the policy changed since attestation", () => {
  const dir = ready();
  writeFileSync(join(dir, "APPROVAL.md"), `${POLICY}\n# edited\n`, "utf8");
  const run = runCli(
    ["run", "task-042:draft", "--as", "agent:claude", "--json", "--", ...exiting(0)],
    dir,
  );
  assert.equal(run.code, 1);
  assert.equal(jsonErr(run)["code"], "policy-not-attested");
  assert.equal(jsonErr(run)["detail"], "hash-mismatch");
  assert.equal(events(dir).includes("execution.started"), false);
});

// ===========================================================================
// the crash: a dangling execution, and the human recovery
// ===========================================================================

test("a crash between started and its outcome leaves a dangling execution nothing repairs", () => {
  const dir = ready();
  const token = grantChaser(dir);

  // A real crash: the child kills the `approval run` process that spawned it,
  // after execution.started has landed and before any outcome could.
  const crashed = runCli(
    [
      "run",
      "task-042:chaser",
      "--token",
      token,
      "--as",
      "agent:claude",
      "--",
      process.execPath,
      "-e",
      "process.kill(process.ppid, 'SIGKILL')",
    ],
    dir,
  );
  assert.notEqual(crashed.code, 0);
  assert.deepEqual(events(dir), [
    "policy.updated",
    "task.registered",
    "approval.requested",
    "approval.granted",
    "execution.started",
  ]);

  // status reports it distinctly; queue does not carry it.
  const status = runCli(["status", "--json"], dir);
  assert.equal(status.code, 1);
  const health = JSON.parse(status.stdout) as Record<string, unknown>;
  assert.equal(health["healthy"], false);
  assert.deepEqual((health["dangling"] as Record<string, unknown>[]).map((e) => e["action_key"]), [
    "task-042:chaser",
  ]);
  const queue = runCli(["queue", "--json"], dir);
  assert.equal(queue.code, 0);
  assert.deepEqual(JSON.parse(queue.stdout), { ok: true, pending: [] });

  // Nothing auto-repairs: a second run refuses, and the log is unchanged.
  const before = rawLog(dir);
  const again = runCli(
    ["run", "task-042:chaser", "--token", token, "--as", "agent:claude", "--json", "--", ...exiting(0)],
    dir,
  );
  assert.equal(again.code, 1);
  assert.equal(jsonErr(again)["code"], "token-consumed");
  assert.equal(rawLog(dir), before);
  assertClean(dir);
});

// ===========================================================================
// approval wait
// ===========================================================================

/** Decide `actionKey` from another process after `delayMs`, without blocking. */
function decideLater(dir: string, verb: string, actionKey: string, delayMs: number): void {
  const helper = join(dir, `decide-${verb}-${counter}.cjs`);
  writeFileSync(
    helper,
    [
      'const { spawnSync } = require("node:child_process");',
      `setTimeout(() => {`,
      `  spawnSync(process.execPath, [${JSON.stringify(CLI_ENTRY)}, ${JSON.stringify(verb)}, ${JSON.stringify(actionKey)}, "--as", "human:carter"], { cwd: ${JSON.stringify(dir)}, stdio: "ignore" });`,
      `}, ${delayMs});`,
      "",
    ].join("\n"),
    "utf8",
  );
  const child = spawn(process.execPath, [helper], { cwd: dir, stdio: "ignore" });
  child.unref();
}

test("wait exits 0 when a grant lands mid-wait", () => {
  const dir = ready();
  assert.equal(
    runCli(["request", "task-042", "--action", "task-042:chaser", "--as", "agent:claude"], dir).code,
    0,
  );
  decideLater(dir, "grant", "task-042:chaser", 400);

  const run = runCli(["wait", "task-042", "--timeout", "20s", "--interval", "100ms", "--json"], dir);
  assert.equal(run.code, 0, run.stderr);
  const payload = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.equal(payload["status"], "granted");
  assert.deepEqual(payload["actions"], [
    { action_key: "task-042:chaser", state: "granted", seq: 4 },
  ]);
  assertClean(dir);
});

test("wait exits 1 when the request is rejected", () => {
  const dir = ready();
  assert.equal(
    runCli(["request", "task-042", "--action", "task-042:chaser", "--as", "agent:claude"], dir).code,
    0,
  );
  decideLater(dir, "reject", "task-042:chaser", 400);

  const run = runCli(["wait", "task-042", "--timeout", "20s", "--interval", "100ms", "--json"], dir);
  assert.equal(run.code, 1, run.stderr);
  assert.equal((JSON.parse(run.stdout) as Record<string, unknown>)["status"], "rejected");
  assertClean(dir);
});

test("wait exits 6 on timeout, having appended nothing", () => {
  const dir = ready();
  assert.equal(
    runCli(["request", "task-042", "--action", "task-042:chaser", "--as", "agent:claude"], dir).code,
    0,
  );
  const before = rawLog(dir);

  const run = runCli(["wait", "task-042", "--timeout", "1s", "--interval", "100ms", "--json"], dir);
  assert.equal(run.code, 6, run.stdout);
  const payload = JSON.parse(run.stderr.trim()) as Record<string, unknown>;
  assert.deepEqual(payload, {
    ok: false,
    task: "task-042",
    status: "timeout",
    actions: [{ action_key: "task-042:chaser", state: "requested", seq: 3 }],
  });
  assert.equal(rawLog(dir), before, "wait wrote to the log");
  assertClean(dir);
});

test("wait exits 3 when the TTL lapses, and still writes nothing", () => {
  const dir = ready(POLICY_SHORT_TTL);
  assert.equal(
    runCli(["request", "task-042", "--action", "task-042:chaser", "--as", "agent:claude"], dir).code,
    0,
  );
  const before = rawLog(dir);

  const run = runCli(["wait", "task-042", "--timeout", "20s", "--interval", "100ms", "--json"], dir);
  assert.equal(run.code, 3, run.stderr);
  assert.equal((JSON.parse(run.stdout) as Record<string, unknown>)["status"], "expired");
  assert.equal(rawLog(dir), before, "wait materialised an event");
  assertClean(dir);
});

test("wait on a task with no requests returns immediately with 0", () => {
  const dir = ready();
  const run = runCli(["wait", "task-042", "--timeout", "20s", "--json"], dir);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    ok: true,
    task: "task-042",
    status: "granted",
    actions: [],
  });
});

test("wait rejects a missing or malformed --timeout at exit 2", () => {
  const dir = ready();
  assert.equal(runCli(["wait", "task-042"], dir).code, 2);
  assert.equal(runCli(["wait", "task-042", "--timeout", "soon"], dir).code, 2);
  assert.equal(runCli(["wait", "--timeout", "1s"], dir).code, 2);
});

// ===========================================================================
// help
// ===========================================================================

for (const [name, args] of [
  ["run", ["run", "--help"]],
  ["wait", ["wait", "--help"]],
] as Array<[string, string[]]>) {
  test(`help: ${name} --help documents its codes and JSON shape`, () => {
    const dir = caseDir();
    const run = runCli(args, dir);
    assert.equal(run.code, 0);
    assert.equal(run.stderr, "");
    assert.match(run.stdout, /Usage:/u);
    assert.match(run.stdout, /Exit codes \(frozen public API\)/u);
    assert.match(run.stdout, /JSON shape/u);
  });
}

test("help: run documents exit 5 and wait documents exit 6", () => {
  const dir = caseDir();
  assert.match(runCli(["run", "--help"], dir).stdout, /5 {2}NO VALID EXECUTION TOKEN/u);
  assert.match(runCli(["wait", "--help"], dir).stdout, /6 {2}TIMEOUT/u);
  assert.match(runCli(["--help"], dir).stdout, /ADDITIONS to the table/u);
});
