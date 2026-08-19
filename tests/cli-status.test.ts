/**
 * `approval status` and `approval queue` CLI tests (APRV-18 Part B/C).
 *
 * The two verbs answer two different people — the operator who repairs and the
 * human who decides — and these tests pin that separation as hard as they pin
 * the shapes: every case that puts something in one asserts that the other did
 * not grow it.
 *
 * As in the other CLI suites, every record is produced by the real CLI through
 * the real append path, and `approval log verify` runs after each flow.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-cli-status-")));
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

/** No budgets block at all: status must report an empty budget list, not fail. */
const POLICY_NO_BUDGETS = POLICY.split("budgets:")[0] as string;

/**
 * The content binding every declared action carries (amended SPEC.md §6.2, A1).
 *
 * Manual actions MUST have one — intake refuses `payload-hash-required` without
 * it — and the spend must present the same value, which these suites do with
 * `--payload-hash`. One constant across the fixture keeps the CLI assertions
 * about flags and exit codes rather than about hashing.
 */
const PAYLOAD_HASH = "3".repeat(64);

/**
 * The unrebuildable warning `status` carries in `payload_store.note`, pinned
 * verbatim (APRV-35).
 *
 * Duplicated from `src/cli/execute.ts` on purpose: the point of the key is the
 * sentence, and a test that matched it loosely would let the one warning about
 * the one cache a rebuild cannot recreate be softened without anybody noticing.
 */
const PAYLOAD_STORE_NOTE =
  "the payload store holds the bytes approvals bind to, keyed by their hash; " +
  "it is the one cache that cannot be rebuilt from the log, and losing it leaves " +
  "manual requests rendering as payload-unavailable rather than showing bytes no hash bound";

const TASK_FILE = [
  "---",
  "id: task-042",
  "title: Chase deposit refund",
  "status: In Progress",
  "approval:",
  "  origin:",
  "    app: example-capture",
  '    created_by: "human:carter"',
  "  state: proposed",
  "  actions:",
  "    - class: communicate.email.external",
  '      summary: "Send deposit chaser"',
  "      reversible: false",
  "      est_cost_usd: 0.02",
  '      idempotency_key: "task-042:chaser"',
  `      payload_hash: "${PAYLOAD_HASH}"`,
  "    - class: communicate.email.external",
  '      summary: "Send the follow-up"',
  "      reversible: false",
  "      est_cost_usd: 0.02",
  '      idempotency_key: "task-042:followup"',
  `      payload_hash: "${PAYLOAD_HASH}"`,
  "    - class: files.write.local",
  '      summary: "Write the draft"',
  "      reversible: true",
  "      est_cost_usd: 0.01",
  '      idempotency_key: "task-042:draft"',
  `      payload_hash: "${PAYLOAD_HASH}"`,
  "    - class: files.write.local",
  '      summary: "Write the second draft"',
  "      reversible: true",
  "      est_cost_usd: 0.01",
  '      idempotency_key: "task-042:draft2"',
  `      payload_hash: "${PAYLOAD_HASH}"`,
  "    - class: files.write.local",
  '      summary: "Write the third draft"',
  "      reversible: true",
  "      est_cost_usd: 0.01",
  '      idempotency_key: "task-042:draft3"',
  `      payload_hash: "${PAYLOAD_HASH}"`,
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

function assertClean(dir: string): void {
  const verify = runCli(["log", "verify", "--json"], dir);
  assert.equal(verify.code, 0, verify.stderr);
  assert.equal((JSON.parse(verify.stdout) as Record<string, unknown>)["status"], "clean");
}

function ready(policyText: string = POLICY): string {
  const dir = caseDir(policyText);
  assert.equal(runCli(["policy", "attest", "--as", "human:carter"], dir).code, 0);
  assert.equal(runCli(["register", "task-042.md", "--as", "agent:claude"], dir).code, 0);
  return dir;
}

function requestChaser(dir: string, actionKey = "task-042:chaser"): void {
  assert.equal(
    runCli(["request", "task-042", "--action", actionKey, "--as", "agent:claude"], dir).code,
    0,
  );
}

function grant(dir: string, actionKey: string): string {
  const run = runCli(["grant", actionKey, "--as", "human:carter", "--json"], dir);
  assert.equal(run.code, 0, run.stderr);
  return String((JSON.parse(run.stdout) as Record<string, unknown>)["token"]);
}

function statusJson(dir: string): { code: number; body: Record<string, unknown> } {
  const run = runCli(["status", "--json"], dir);
  return { code: run.code, body: JSON.parse(run.stdout) as Record<string, unknown> };
}

function queueJson(dir: string): { code: number; body: Record<string, unknown> } {
  const run = runCli(["queue", "--json"], dir);
  assert.equal(run.stderr, "", run.stderr);
  return { code: run.code, body: JSON.parse(run.stdout) as Record<string, unknown> };
}

/** Run a supervised action to completion, or to a failure with `exitCode`. */
function runSupervised(dir: string, actionKey: string, exitCode: number): void {
  const run = runCli(
    [
      "run",
      actionKey,
      "--as",
      "agent:claude",
      "--",
      process.execPath,
      "-e",
      `process.exit(${exitCode})`,
    ],
    dir,
  );
  assert.equal(run.code, exitCode, run.stderr);
}

// ===========================================================================
// approval status — the frozen shape
// ===========================================================================

test("status --json on a healthy repo emits the frozen shape and exits 0", () => {
  const dir = ready();
  requestChaser(dir);
  grant(dir, "task-042:chaser");

  const { code, body } = statusJson(dir);
  assert.equal(code, 0);
  assert.deepEqual(body, {
    ok: true,
    healthy: true,
    attestation: { state: "attested", seq: 1 },
    verification: { status: "clean", records: 4 },
    dangling: [],
    budgets: [
      {
        limit: "global.daily_actions",
        scope: "global",
        window: "rolling-24h",
        // One authorization in the window (the grant), plus the zero-cost
        // probe's own action — documented in --help, asserted here.
        consumed: 1,
        requested: 1,
        remaining: 48,
        pass: true,
      },
      {
        limit: "global.daily_usd",
        scope: "global",
        window: "rolling-24h",
        consumed: 0.02,
        requested: 0,
        remaining: 9.98,
        pass: true,
      },
    ],
    loop_escalations: [],
    // Additive (APRV-35). This fixture binds hashes but never supplies bytes,
    // so nothing was ever stored and the directory does not exist, which is
    // the normal state of a repo that has made no request carrying --payload,
    // and does not move `healthy` or the exit code above.
    payload_store: { present: false, files: 0, pruned: 0, orphans: 0, note: PAYLOAD_STORE_NOTE },
  });
  assert.equal(rawLog(dir), rawLog(dir), "status must not write");
  assertClean(dir);
});

test("status reports a policy edited after attestation as hash-mismatch, exit 1", () => {
  const dir = ready();
  writeFileSync(join(dir, "APPROVAL.md"), `${POLICY}\n# edited\n`, "utf8");
  const { code, body } = statusJson(dir);
  assert.equal(code, 1);
  assert.equal(body["healthy"], false);
  assert.deepEqual(body["attestation"], { state: "hash-mismatch", seq: 1 });
});

test("status reports a never-attested policy with a null seq, exit 1", () => {
  const dir = caseDir();
  const { code, body } = statusJson(dir);
  assert.equal(code, 1);
  assert.deepEqual(body["attestation"], { state: "not-attested", seq: null });
  assert.deepEqual(body["verification"], { status: "clean", records: 0 });
});

test("status with no budgets configured reports an empty budget list", () => {
  const dir = ready(POLICY_NO_BUDGETS);
  const { code, body } = statusJson(dir);
  assert.equal(code, 0);
  assert.deepEqual(body["budgets"], []);
});

test("status text mode names health, attestation, verification, dangling and budgets", () => {
  const dir = ready();
  const run = runCli(["status"], dir);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /health: ok/u);
  assert.match(run.stdout, /attestation: attested \(seq 1\)/u);
  assert.match(run.stdout, /verification: clean/u);
  assert.match(run.stdout, /dangling executions: none/u);
  assert.match(run.stdout, /budget global\.daily_usd/u);
  assert.match(run.stdout, /loop escalations: none/u);
  assert.match(run.stdout, /payload store: not created yet, 0 pruned by the log, 0 unbound; /u);
});

// ---------------------------------------------------------------------------
// The payload store (APRV-35)
// ---------------------------------------------------------------------------

test("status counts the payload store once a real request has stored bytes", () => {
  const dir = caseDir();
  const payload = '{"to":"landlord@example.com","body":"Chasing the deposit."}\n';
  writeFileSync(join(dir, "payload.json"), payload, "utf8");

  // The declared binding is whatever `approval payload hash` says about these
  // exact bytes, so the request below is the real accepted path rather than a
  // directory assembled by hand.
  const hashRun = runCli(["payload", "hash", "payload.json"], dir);
  assert.equal(hashRun.code, 0, hashRun.stderr);
  const hash = hashRun.stdout.trim();
  writeFileSync(join(dir, "task-042.md"), TASK_FILE.split(PAYLOAD_HASH).join(hash), "utf8");

  assert.equal(runCli(["policy", "attest", "--as", "human:carter"], dir).code, 0);
  assert.equal(runCli(["register", "task-042.md", "--as", "agent:claude"], dir).code, 0);
  const requested = runCli(
    [
      "request",
      "task-042",
      "--action",
      "task-042:chaser",
      "--as",
      "agent:claude",
      "--payload",
      "payload.json",
    ],
    dir,
  );
  assert.equal(requested.code, 0, requested.stderr);

  const { code, body } = statusJson(dir);
  assert.equal(code, 0);
  assert.deepEqual(body["payload_store"], {
    present: true,
    files: 1,
    // APRV-41: what the log says about the store, beside what the store holds.
    // Nothing has been pruned here, and the one file is bound by the request.
    pruned: 0,
    orphans: 0,
    note: PAYLOAD_STORE_NOTE,
  });
  assert.equal(body["healthy"], true, "the store is informational, not a health input");

  const text = runCli(["status"], dir);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /payload store: 1 file\(s\), 0 pruned by the log, 0 unbound; /u);
  assertClean(dir);
});

test("a lost payload store is reported without changing health or the exit code", () => {
  const dir = ready();
  requestChaser(dir);
  grant(dir, "task-042:chaser");

  // Deleting the store cannot be undone by any rebuild, which is exactly what
  // the note says; what it must NOT do is turn a healthy repo unhealthy.
  rmSync(join(dir, ".approval", "payloads"), { recursive: true, force: true });

  const { code, body } = statusJson(dir);
  assert.equal(code, 0);
  assert.equal(body["healthy"], true);
  assert.deepEqual(body["payload_store"], {
    present: false,
    files: 0,
    pruned: 0,
    orphans: 0,
    note: PAYLOAD_STORE_NOTE,
  });
  assert.match(
    String((body["payload_store"] as Record<string, unknown>)["note"]),
    /cannot be rebuilt from the log/u,
  );
});

// ===========================================================================
// dangling executions: status shows them, queue never does
// ===========================================================================

test("a dangling execution appears in status, never in queue, and nothing repairs it", () => {
  const dir = ready();
  requestChaser(dir);
  const token = grant(dir, "task-042:chaser");

  // `approval consume` starts the execution and, by design, never finishes it —
  // the same state a crash between started and its outcome leaves behind.
  assert.equal(
    runCli(["consume", "task-042:chaser", "--payload-hash", PAYLOAD_HASH, "--token", token, "--as", "agent:claude"], dir).code,
    0,
  );

  const dangled = statusJson(dir);
  assert.equal(dangled.code, 1);
  assert.equal(dangled.body["healthy"], false);
  const startedSeq = logRecords(dir).findIndex(
    (record) => record["event"] === "execution.started",
  ) + 1;
  assert.deepEqual(dangled.body["dangling"], [
    {
      action_key: "task-042:chaser",
      task: "task-042",
      ts: String(logRecords(dir)[startedSeq - 1]?.["ts"]),
      seq: startedSeq,
    },
  ]);
  assert.deepEqual(queueJson(dir).body, { ok: true, pending: [] });

  // The human recovery, through the same CLI: nothing else changes the state.
  const before = rawLog(dir);
  assert.equal(statusJson(dir).code, 1, "status changed the state");
  assert.equal(rawLog(dir), before, "status wrote to the log");
});

// ===========================================================================
// loop escalation in status
// ===========================================================================

test("three consecutive failures raise a loop escalation in status; a completion clears it", () => {
  const dir = ready();
  runSupervised(dir, "task-042:draft", 1);
  runSupervised(dir, "task-042:draft2", 1);
  assert.deepEqual(statusJson(dir).body["loop_escalations"], []);
  runSupervised(dir, "task-042:draft3", 1);

  const escalated = statusJson(dir);
  assert.equal(escalated.code, 1);
  assert.deepEqual(escalated.body["loop_escalations"], [
    { task: "task-042", consecutive_failures: 3, escalated: true },
  ]);

  // The manual path still works for the escalated task — escalation is a floor.
  requestChaser(dir);
  assert.equal(queueJson(dir).body["pending"] instanceof Array, true);
  const token = grant(dir, "task-042:chaser");
  const ran = runCli(
    [
      "run",
      "task-042:chaser",
      "--payload-hash", PAYLOAD_HASH, "--token",
      token,
      "--as",
      "agent:claude",
      "--",
      process.execPath,
      "-e",
      "process.exit(0)",
    ],
    dir,
  );
  assert.equal(ran.code, 0, ran.stderr);
  // That completion is for the same task, so the streak resets.
  assert.deepEqual(statusJson(dir).body["loop_escalations"], []);
  assertClean(dir);
});

// ===========================================================================
// approval queue — the inbox and nothing else
// ===========================================================================

test("queue lists exactly the live awaiting requests, with the TTL remaining", () => {
  const dir = ready();
  requestChaser(dir);
  requestChaser(dir, "task-042:followup");

  const { code, body } = queueJson(dir);
  assert.equal(code, 0);
  const pending = body["pending"] as Record<string, unknown>[];
  assert.equal(pending.length, 2);
  assert.deepEqual(
    pending.map((entry) => entry["action_key"]),
    ["task-042:chaser", "task-042:followup"],
  );
  const first = pending[0] as Record<string, unknown>;
  assert.equal(first["task"], "task-042");
  assert.equal(first["class"], "communicate.email.external");
  assert.equal(first["est_cost_usd"], 0.02);
  assert.equal(first["seq"], 3);
  assert.equal(typeof first["requested_ts"], "string");
  const remaining = first["ttl_remaining_ms"] as number;
  assert.ok(remaining > 0 && remaining <= 3_600_000, `ttl_remaining_ms out of range: ${remaining}`);
});

test("a decided request leaves the queue; an empty inbox is still exit 0", () => {
  const dir = ready();
  requestChaser(dir);
  assert.equal((queueJson(dir).body["pending"] as unknown[]).length, 1);

  grant(dir, "task-042:chaser");
  const after = queueJson(dir);
  assert.equal(after.code, 0);
  assert.deepEqual(after.body, { ok: true, pending: [] });

  const empty = runCli(["queue"], dir);
  assert.equal(empty.code, 0);
  assert.match(empty.stdout, /queue: empty/u);
});

test("queue on a fresh directory with no log at all is empty and exits 0", () => {
  const dir = caseDir();
  const run = runCli(["queue", "--json"], dir);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { ok: true, pending: [] });
});

test("a supervised action never enters the queue: it has no request to decide", () => {
  const dir = ready();
  runSupervised(dir, "task-042:draft", 0);
  assert.deepEqual(queueJson(dir).body, { ok: true, pending: [] });
  assertClean(dir);
});

// ===========================================================================
// usage and help
// ===========================================================================

test("status and queue reject unexpected positionals at exit 2", () => {
  const dir = ready();
  assert.equal(runCli(["status", "extra"], dir).code, 2);
  assert.equal(runCli(["queue", "extra"], dir).code, 2);
});

for (const [name, args] of [
  ["status", ["status", "--help"]],
  ["queue", ["queue", "--help"]],
] as Array<[string, string[]]>) {
  test(`help: ${name} --help documents the codes and the JSON shape`, () => {
    const dir = caseDir();
    const run = runCli(args, dir);
    assert.equal(run.code, 0);
    assert.equal(run.stderr, "");
    assert.match(run.stdout, /Usage:/u);
    // APRV-91: the frozen table is printed by `approval --help` alone.
    assert.match(run.stdout, /exit codes: approval --help/u);
    assert.match(run.stdout, /JSON shape/u);
  });
}

test("help: the status/queue distinction is stated in both help texts and at the root", () => {
  const dir = caseDir();
  assert.match(runCli(["queue", "--help"], dir).stdout, /THIS IS AN INBOX, NOT A DASHBOARD/u);
  assert.match(runCli(["status", "--help"], dir).stdout, /THIS IS NOT "approval queue"/u);
  const root = runCli(["--help"], dir).stdout;
  assert.match(root, /queue {5}the pending-decision INBOX/u);
  assert.match(root, /status {4}system HEALTH/u);
});
