/**
 * Token CLI tests (APRV-17 Part B) — every case spawns the real compiled CLI as
 * a child process, because the contract under test is what a human or an agent
 * observes: exit code, stdout bytes, stderr bytes, and the lines that end up in
 * the log. The `--json` shapes are frozen public API and are asserted with
 * `deepEqual` on whole objects.
 *
 * The named guarantee is checked at the CLI boundary too: after every flow the
 * log's raw bytes are scanned for the raw token printed by `approval grant`. If
 * the CLI ever leaked it into the log, these tests fail loudly.
 *
 * The child's environment is cleaned of `APPROVAL_HUMAN` unless a case supplies
 * it, so a developer who exports it cannot make the missing-identity cases pass
 * by accident. No log line is written by hand: every record is produced by the
 * CLI, and `approval log verify` runs afterwards.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

/** dist/tests/cli-token.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-cli-token-")));
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
  "  communicate.email.external:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

/** Short enough to lapse inside a test, long enough to grant first. */
const POLICY_SHORT_TTL = POLICY.replace('approval_ttl: "1h"', 'approval_ttl: "1s"');

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
  "    - class: communicate.email.external",
  '      summary: "Send the follow-up"',
  "      reversible: false",
  "      est_cost_usd: 0.02",
  '      idempotency_key: "task-042:followup"',
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

function assertClean(dir: string): void {
  const verify = runCli(["log", "verify", "--json"], dir);
  assert.equal(verify.code, 0, verify.stderr);
  assert.equal((JSON.parse(verify.stdout) as Record<string, unknown>)["status"], "clean");
}

/** THE named guarantee, at the CLI boundary. */
function assertTokenAbsentFromLog(dir: string, token: string): void {
  const raw = rawLog(dir);
  assert.ok(raw.length > 0);
  assert.equal(raw.includes(token), false, "the RAW TOKEN reached the log");
}

function jsonErr(run: Run): Record<string, unknown> {
  const parsed = JSON.parse(run.stderr) as Record<string, unknown>;
  return (parsed["error"] ?? parsed) as Record<string, unknown>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Attest, register, request: a live manual request awaiting a decision. */
function readyForDecision(policyText: string = POLICY, actionKey = "task-042:chaser"): string {
  const dir = caseDir(policyText);
  assert.equal(runCli(["policy", "attest", "--as", "human:carter"], dir).code, 0);
  assert.equal(runCli(["register", "task-042.md", "--as", "agent:claude"], dir).code, 0);
  assert.equal(
    runCli(["request", "task-042", "--action", actionKey, "--as", "agent:claude"], dir).code,
    0,
  );
  return dir;
}

/** Grant through the CLI and return the token it printed exactly once. */
function grantToken(dir: string, actionKey = "task-042:chaser"): string {
  const run = runCli(["grant", actionKey, "--as", "human:carter", "--json"], dir);
  assert.equal(run.code, 0, run.stderr);
  const token = (JSON.parse(run.stdout) as Record<string, unknown>)["token"];
  assert.equal(typeof token, "string", "grant --json printed no token");
  return String(token);
}

// ===========================================================================
// grant prints the token — once
// ===========================================================================

test("grant prints the raw token on stdout, warns it is shown once, and logs only its hash", () => {
  const dir = readyForDecision();
  const run = runCli(["grant", "task-042:chaser", "--as", "human:carter"], dir);

  assert.equal(run.code, 0, run.stderr);
  const match = /^token: ([a-f0-9]{64})$/mu.exec(run.stdout);
  assert.notEqual(match, null, `no token line in stdout:\n${run.stdout}`);
  const token = String(match?.[1]);
  assert.match(run.stdout, /shown ONCE/u);
  assert.match(run.stdout, /revoke and request again/u);

  const granted = logRecords(dir)[3] as Record<string, unknown>;
  assert.equal(granted["event"], "approval.granted");
  assert.deepEqual(granted["payload"], {
    class: "communicate.email.external",
    est_cost_usd: 0.02,
    token_sha256: sha256(token),
  });
  assertTokenAbsentFromLog(dir, token);
  assertClean(dir);
});

test("grant --json carries the token, and the token appears in no other command's output", () => {
  const dir = readyForDecision();
  const token = grantToken(dir);
  assert.match(token, /^[a-f0-9]{64}$/u);

  for (const args of [
    ["log", "export"],
    ["log", "tail", "-n", "50"],
    ["log", "export", "--json"],
    ["token", "task-042:chaser", "--json"],
  ]) {
    const run = runCli(args, dir);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(
      run.stdout.includes(token),
      false,
      `${args.join(" ")} leaked the raw token`,
    );
  }
  assertTokenAbsentFromLog(dir, token);
});

// ===========================================================================
// approval token — status
// ===========================================================================

test("token --json emits the frozen live shape and writes nothing", () => {
  const dir = readyForDecision();
  const token = grantToken(dir);
  const before = rawLog(dir);

  const run = runCli(["token", "task-042:chaser", "--json"], dir);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    ok: true,
    action_key: "task-042:chaser",
    state: "granted",
    live: true,
    token_sha256: sha256(token),
    grant_seq: 4,
    class: "communicate.email.external",
    est_cost_usd: 0.02,
    task: "task-042",
  });
  assert.equal(rawLog(dir), before, "approval token wrote to the log");
  assertClean(dir);
});

test("token in text mode prints the digest and says the raw token cannot be recovered", () => {
  const dir = readyForDecision();
  const token = grantToken(dir);
  const run = runCli(["token", "task-042:chaser"], dir);

  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, new RegExp(`token_sha256: ${sha256(token)}`, "u"));
  assert.match(run.stdout, /stored nowhere/u);
  assert.equal(run.stdout.includes(token), false);
});

test("token refuses a request that is not granted at exit 1", () => {
  const dir = readyForDecision();
  const run = runCli(["token", "task-042:chaser", "--json"], dir);

  assert.equal(run.code, 1);
  assert.equal(run.stdout, "");
  const error = jsonErr(run);
  assert.equal(error["code"], "not-granted");
  assert.equal(error["state"], "requested");
});

test("token refuses an unknown action key with not-granted", () => {
  const dir = readyForDecision();
  const run = runCli(["token", "task-042:nope", "--json"], dir);
  assert.equal(run.code, 1);
  assert.equal(jsonErr(run)["code"], "not-granted");
});

test("token reports the three deaths: consumed, revoked, expired", () => {
  // Execution.
  const executed = readyForDecision();
  const executedToken = grantToken(executed);
  assert.equal(
    runCli(
      ["consume", "task-042:chaser", "--token", executedToken, "--as", "agent:claude"],
      executed,
    ).code,
    0,
  );
  const consumed = runCli(["token", "task-042:chaser", "--json"], executed);
  assert.equal(consumed.code, 1);
  assert.equal(jsonErr(consumed)["code"], "token-consumed");
  assertClean(executed);

  // Revocation.
  const revokedDir = readyForDecision();
  grantToken(revokedDir);
  assert.equal(
    runCli(["revoke", "task-042:chaser", "--as", "human:carter"], revokedDir).code,
    0,
  );
  const revoked = runCli(["token", "task-042:chaser", "--json"], revokedDir);
  assert.equal(revoked.code, 1);
  assert.equal(jsonErr(revoked)["code"], "token-revoked");
  assert.equal(jsonErr(revoked)["state"], "revoked");
  assertClean(revokedDir);

  // The parent request's TTL, with no separate token TTL: a 1s policy TTL, a
  // grant inside it, and a check after it.
  const expiring = readyForDecision(POLICY_SHORT_TTL);
  const expiringToken = grantToken(expiring);
  assert.equal(runCli(["token", "task-042:chaser", "--json"], expiring).code, 0);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_200);
  const expired = runCli(["token", "task-042:chaser", "--json"], expiring);
  assert.equal(expired.code, 1);
  assert.equal(jsonErr(expired)["code"], "token-expired");
  const spend = runCli(
    ["consume", "task-042:chaser", "--token", expiringToken, "--as", "agent:claude", "--json"],
    expiring,
  );
  assert.equal(spend.code, 1);
  assert.equal(jsonErr(spend)["code"], "token-expired");
  assert.deepEqual(events(expiring).filter((event) => event.startsWith("execution.")), []);
  assertClean(expiring);
});

// ===========================================================================
// approval consume — plumbing
// ===========================================================================

test("consume --json emits the frozen shape and appends exactly one execution.started", () => {
  const dir = readyForDecision();
  const token = grantToken(dir);

  const run = runCli(
    ["consume", "task-042:chaser", "--token", token, "--as", "agent:claude", "--json"],
    dir,
  );
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    ok: true,
    action_key: "task-042:chaser",
    event: "execution.started",
    seq: 5,
    token_sha256: sha256(token),
    grant_seq: 4,
    class: "communicate.email.external",
    est_cost_usd: 0.02,
  });

  assert.deepEqual(events(dir), [
    "policy.updated",
    "task.registered",
    "approval.requested",
    "approval.granted",
    "execution.started",
  ]);
  const started = logRecords(dir)[4] as Record<string, unknown>;
  assert.deepEqual(started["payload"], {
    class: "communicate.email.external",
    est_cost_usd: 0.02,
    token_sha256: sha256(token),
  });
  assertTokenAbsentFromLog(dir, token);
  assertClean(dir);
});

test("the second consume is refused token-consumed and appends nothing", () => {
  const dir = readyForDecision();
  const token = grantToken(dir);
  const spec = ["consume", "task-042:chaser", "--token", token, "--as", "agent:claude", "--json"];

  assert.equal(runCli(spec, dir).code, 0);
  const second = runCli(spec, dir);
  assert.equal(second.code, 1);
  assert.equal(second.stdout, "");
  assert.equal(jsonErr(second)["code"], "token-consumed");
  assert.equal(jsonErr(second)["seq"], 5);
  assert.equal(events(dir).filter((event) => event === "execution.started").length, 1);
  assertClean(dir);
});

test("a wrong token is token-mismatch, and the real token still works afterwards", () => {
  const dir = readyForDecision();
  const token = grantToken(dir);
  const wrong = "0".repeat(64);

  const bad = runCli(
    ["consume", "task-042:chaser", "--token", wrong, "--as", "agent:claude", "--json"],
    dir,
  );
  assert.equal(bad.code, 1);
  assert.equal(jsonErr(bad)["code"], "token-mismatch");
  assert.deepEqual(events(dir).filter((event) => event.startsWith("execution.")), []);

  const good = runCli(
    ["consume", "task-042:chaser", "--token", token, "--as", "agent:claude", "--json"],
    dir,
  );
  assert.equal(good.code, 0, good.stderr);
  assertClean(dir);
});

test("a token is bound to its action key: presenting it for another action refuses", () => {
  const dir = readyForDecision();
  const chaserToken = grantToken(dir);
  assert.equal(
    runCli(["request", "task-042", "--action", "task-042:followup", "--as", "agent:claude"], dir)
      .code,
    0,
  );
  const followupToken = grantToken(dir, "task-042:followup");

  const crossed = runCli(
    ["consume", "task-042:followup", "--token", chaserToken, "--as", "agent:claude", "--json"],
    dir,
  );
  assert.equal(crossed.code, 1);
  assert.equal(jsonErr(crossed)["code"], "token-mismatch");

  assert.equal(
    runCli(
      ["consume", "task-042:followup", "--token", followupToken, "--as", "agent:claude"],
      dir,
    ).code,
    0,
  );
  assertTokenAbsentFromLog(dir, chaserToken);
  assertTokenAbsentFromLog(dir, followupToken);
  assertClean(dir);
});

test("consume refuses a revoked grant with token-revoked and appends nothing", () => {
  const dir = readyForDecision();
  const token = grantToken(dir);
  assert.equal(runCli(["revoke", "task-042:chaser", "--as", "human:carter"], dir).code, 0);

  const run = runCli(
    ["consume", "task-042:chaser", "--token", token, "--as", "agent:claude", "--json"],
    dir,
  );
  assert.equal(run.code, 1);
  assert.equal(jsonErr(run)["code"], "token-revoked");
  assert.deepEqual(events(dir).filter((event) => event.startsWith("execution.")), []);
  assertClean(dir);
});

// ===========================================================================
// usage
// ===========================================================================

test("usage failures are exit 2 and write nothing", () => {
  const dir = readyForDecision();
  const token = grantToken(dir);
  const before = rawLog(dir);

  const cases: string[][] = [
    ["token"],
    ["token", "a", "b"],
    ["token", "task-042:chaser", "--bogus"],
    ["consume", "--token", token],
    ["consume", "task-042:chaser"],
    ["consume", "task-042:chaser", "--token", token, "--as", "system:gate"],
  ];
  for (const args of cases) {
    const run = runCli([...args, "--json"], dir);
    assert.equal(run.code, 2, `${args.join(" ")} was not a usage error`);
    assert.equal(jsonErr(run)["code"], "usage");
    assert.equal(run.stdout, "");
  }

  // Identity comes from APPROVAL_HUMAN when --as is absent.
  const missing = runCli(["consume", "task-042:chaser", "--token", token, "--json"], dir);
  assert.equal(missing.code, 2);
  assert.match(String(jsonErr(missing)["message"]), /APPROVAL_HUMAN/u);

  assert.equal(rawLog(dir), before, "a usage error wrote to the log");
});

test("APPROVAL_HUMAN supplies consume's identity when --as is absent", () => {
  const dir = readyForDecision();
  const token = grantToken(dir);
  const run = runCli(["consume", "task-042:chaser", "--token", token], dir, {
    APPROVAL_HUMAN: "human:carter",
  });
  assert.equal(run.code, 0, run.stderr);
  assert.equal((logRecords(dir)[4] as Record<string, unknown>)["actor"], "human:carter");
  assertClean(dir);
});

// ===========================================================================
// help
// ===========================================================================

test("--help documents the exit codes, the JSON shape, and the shown-once rule", () => {
  const dir = caseDir();

  for (const verb of ["token", "consume"]) {
    const help = runCli([verb, "--help"], dir);
    assert.equal(help.code, 0, `${verb} --help failed`);
    for (const code of ["0", "1", "2", "3", "4"]) {
      assert.ok(help.stdout.includes(`  ${code}  `), `${verb} --help is missing exit ${code}`);
    }
    assert.match(help.stdout, /SHOWN ONCE/u);
    assert.match(help.stdout, /token-consumed/u);
    assert.match(help.stdout, /JSON shape/u);
  }

  assert.match(runCli(["consume", "--help"], dir).stdout, /INTERNAL/u);
  assert.match(runCli(["token", "--help"], dir).stdout, /does NOT print the token/u);
  assert.match(runCli(["grant", "--help"], dir).stdout, /PRINTS\nIT ONCE|PRINTS IT ONCE/u);

  const root = runCli(["--help"], dir);
  assert.match(root.stdout, /approval token/u);
  assert.match(root.stdout, /consume/u);
});
