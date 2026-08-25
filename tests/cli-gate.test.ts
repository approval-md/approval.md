/**
 * Gate CLI tests (APRV-16 Part B) — every case spawns the real compiled CLI as a
 * child process, because the contract under test is what a human or an agent
 * observes: exit code, stdout bytes, stderr bytes, and the lines that end up in
 * the log. The `--json` shapes are frozen public API and are asserted with
 * `deepEqual` on whole objects.
 *
 * The child's environment is cleaned of `APPROVAL_HUMAN` unless a case supplies
 * it, so a developer who exports it in their own shell cannot make the
 * missing-identity cases pass by accident.
 *
 * No log line is written by hand anywhere in this file: every record is produced
 * by the CLI itself, and `approval log verify` is run afterwards to prove the
 * appended records left the chain clean.
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

/** dist/tests/cli-gate.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-cli-gate-")));
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
  "  read.*:",
  "    autonomy: autonomous",
  "  communicate.email.external:",
  "    autonomy: manual",
  "  financial.spend:",
  "    autonomy: manual",
  "    limits:",
  "      per_action_usd: 0.5",
  "```",
  "",
].join("\n");

/** Same policy, but every request lapses the instant it is made. */
const POLICY_INSTANT_TTL = POLICY.replace('approval_ttl: "1h"', 'approval_ttl: "1ms"');

/**
 * The content binding every declared action carries (amended SPEC.md §6.2, A1).
 *
 * Manual actions MUST have one — intake refuses `payload-hash-required` without
 * it — and the spend must present the same value, which these suites do with
 * `--payload-hash`. One constant across the fixture keeps the CLI assertions
 * about flags and exit codes rather than about hashing.
 */
const PAYLOAD_HASH = "3".repeat(64);

const TASK_FILE = [
  "---",
  "id: task-042",
  "title: Chase deposit refund from letting agency",
  "status: In Progress",
  "labels: []",
  "approval:",
  "  origin:",
  "    app: example-capture",
  '    created_by: "human:carter"',
  "  route:",
  '    assignee: "agent:claude-admin"',
  "    confidence: 0.82",
  "  state: proposed",
  "  actions:",
  "    - class: communicate.email.external",
  '      summary: "Send deposit chaser to agency@example.co.uk"',
  "      reversible: false",
  "      est_cost_usd: 0.02",
  '      idempotency_key: "task-042:chaser"',
  `      payload_hash: "${PAYLOAD_HASH}"`,
  "    - class: read.web",
  '      summary: "Read the scheme deadline page"',
  "      reversible: true",
  "      est_cost_usd: 0",
  '      idempotency_key: "task-042:read"',
  `      payload_hash: "${PAYLOAD_HASH}"`,
  "    - class: financial.spend",
  '      summary: "Pay the filing fee"',
  "      reversible: false",
  "      est_cost_usd: 5",
  '      idempotency_key: "task-042:fee"',
  `      payload_hash: "${PAYLOAD_HASH}"`,
  "---",
  "",
  "## Description",
  "Body.",
  "",
].join("\n");

/** A scratch working directory with a policy and a task file. */
function caseDir(policyText: string = POLICY): string {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), policyText, "utf8");
  writeFileSync(join(dir, "task-042.md"), TASK_FILE, "utf8");
  return dir;
}

/**
 * The SHA-256 of the case's policy bytes — the value APRV-118 pins onto
 * `approval.requested` and `approval.granted` at the write boundary.
 */
function policySha256(dir: string): string {
  return createHash("sha256").update(readFileSync(join(dir, "APPROVAL.md"))).digest("hex");
}

function logRecords(dir: string): Record<string, unknown>[] {
  const path = join(dir, ".approval", "log", "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
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

/** Attest the policy so gate operations may proceed. */
function attest(dir: string): void {
  const run = runCli(["policy", "attest", "--as", "human:carter"], dir);
  assert.equal(run.code, 0, run.stderr);
}

function jsonErr(run: Run): Record<string, unknown> {
  const parsed = JSON.parse(run.stderr) as Record<string, unknown>;
  return (parsed["error"] ?? parsed) as Record<string, unknown>;
}

/** register + request the manual chaser action; returns the working directory. */
function readyForDecision(policyText: string = POLICY): string {
  const dir = caseDir(policyText);
  attest(dir);
  assert.equal(runCli(["register", "task-042.md", "--as", "agent:claude"], dir).code, 0);
  const requested = runCli(
    ["request", "task-042", "--action", "task-042:chaser", "--as", "agent:claude"],
    dir,
  );
  assert.equal(requested.code, 0, requested.stderr);
  return dir;
}

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

test("register validates the envelope and appends task.registered", () => {
  const dir = caseDir();
  const run = runCli(["register", "task-042.md", "--as", "agent:claude"], dir);

  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stderr, "");
  assert.equal(run.stdout, "registered task-042 at seq 1: 3 action(s)\n");

  const records = logRecords(dir);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.["event"], "task.registered");
  assert.equal(records[0]?.["actor"], "agent:claude");
  assert.equal(records[0]?.["task"], "task-042");
  assertClean(dir);
});

test("register --json emits the frozen success shape", () => {
  const dir = caseDir();
  const run = runCli(["register", "task-042.md", "--as", "agent:claude", "--json"], dir);

  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stderr, "");
  assert.deepEqual(JSON.parse(run.stdout), { ok: true, seq: 1, task: "task-042", actions: 3 });
});

test("register: APPROVAL_HUMAN supplies the identity, and a bad --as is usage", () => {
  const dir = caseDir();
  assert.equal(
    runCli(["register", "task-042.md"], dir, { APPROVAL_HUMAN: "human:carter" }).code,
    0,
  );
  assert.equal(logRecords(dir)[0]?.["actor"], "human:carter");

  const other = caseDir();
  const bad = runCli(["register", "task-042.md", "--as", "carter", "--json"], other);
  assert.equal(bad.code, 2);
  assert.equal(jsonErr(bad)["code"], "usage");
  assert.deepEqual(logRecords(other), []);

  const none = caseDir();
  const missing = runCli(["register", "task-042.md", "--json"], none);
  assert.equal(missing.code, 2);
  assert.equal(jsonErr(missing)["code"], "usage");
});

test("register refuses an invalid envelope at exit 1 and appends nothing", () => {
  const dir = caseDir();
  writeFileSync(
    join(dir, "broken.md"),
    ["---", "id: task-9", "approval:", "  state: proposed", "---", "", "body", ""].join("\n"),
    "utf8",
  );
  const run = runCli(["register", "broken.md", "--as", "agent:claude", "--json"], dir);

  assert.equal(run.code, 1);
  assert.equal(run.stdout, "");
  const error = jsonErr(run);
  assert.equal(error["code"], "envelope-invalid");
  assert.ok(Array.isArray(error["errors"]));
  assert.deepEqual(logRecords(dir), []);
});

test("register reports an absent task file as I/O (exit 4)", () => {
  const dir = caseDir();
  const run = runCli(["register", "nope.md", "--as", "agent:claude", "--json"], dir);
  assert.equal(run.code, 4);
  assert.equal(jsonErr(run)["code"], "task-file-unreadable");
});

test("register refuses a second registration of the same task", () => {
  const dir = caseDir();
  assert.equal(runCli(["register", "task-042.md", "--as", "agent:claude"], dir).code, 0);
  const run = runCli(["register", "task-042.md", "--as", "agent:claude", "--json"], dir);
  assert.equal(run.code, 1);
  assert.equal(jsonErr(run)["code"], "task-already-registered");
  assert.equal(logRecords(dir).length, 1);
  assertClean(dir);
});

// ---------------------------------------------------------------------------
// request
// ---------------------------------------------------------------------------

test("request on the manual path appends approval.requested", () => {
  const dir = caseDir();
  attest(dir);
  assert.equal(runCli(["register", "task-042.md", "--as", "agent:claude"], dir).code, 0);

  const run = runCli(
    ["request", "task-042", "--action", "task-042:chaser", "--as", "agent:claude", "--json"],
    dir,
  );
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    ok: true,
    task: "task-042",
    action_key: "task-042:chaser",
    class: "communicate.email.external",
    autonomy: "manual",
    proceed: false,
    requested: true,
    seq: 3,
  });

  const requested = logRecords(dir)[2] as Record<string, unknown>;
  assert.equal(requested["event"], "approval.requested");
  assert.deepEqual(requested["payload"], {
    class: "communicate.email.external",
    est_cost_usd: 0.02,
    payload_hash: PAYLOAD_HASH,
    summary: "Send deposit chaser to agency@example.co.uk",
    reversible: false,
    // APRV-118: the attested policy this request was routed by.
    policy_sha256: policySha256(dir),
  });
  assertClean(dir);
});

test("an autonomous action appends NO approval event and reports proceed:true", () => {
  const dir = caseDir();
  attest(dir);
  assert.equal(runCli(["register", "task-042.md", "--as", "agent:claude"], dir).code, 0);

  const run = runCli(
    ["request", "task-042", "--action", "task-042:read", "--as", "agent:claude", "--json"],
    dir,
  );
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    ok: true,
    task: "task-042",
    action_key: "task-042:read",
    class: "read.web",
    autonomy: "autonomous",
    proceed: true,
    requested: false,
    seq: null,
  });
  assert.deepEqual(events(dir), ["policy.updated", "task.registered"]);
  assert.deepEqual(events(dir).filter((event) => event.startsWith("approval.")), []);
  assertClean(dir);
});

test("request refuses while the policy is unattested, and after it changes", () => {
  const dir = caseDir();
  assert.equal(runCli(["register", "task-042.md", "--as", "agent:claude"], dir).code, 0);
  const unattested = runCli(
    ["request", "task-042", "--action", "task-042:chaser", "--as", "agent:claude", "--json"],
    dir,
  );
  assert.equal(unattested.code, 1);
  const error = jsonErr(unattested);
  assert.equal(error["code"], "policy-not-attested");
  assert.equal(error["detail"], "not-attested");

  attest(dir);
  writeFileSync(join(dir, "APPROVAL.md"), `${POLICY}\n<!-- edited -->\n`, "utf8");
  const changed = runCli(
    ["request", "task-042", "--action", "task-042:chaser", "--as", "agent:claude", "--json"],
    dir,
  );
  assert.equal(changed.code, 1);
  assert.equal(jsonErr(changed)["detail"], "hash-mismatch");
  assert.equal(events(dir).includes("approval.requested"), false);
});

test("request refuses an unregistered task and an undeclared action key", () => {
  const dir = caseDir();
  attest(dir);
  const unregistered = runCli(
    ["request", "task-042", "--action", "task-042:chaser", "--as", "agent:claude", "--json"],
    dir,
  );
  assert.equal(unregistered.code, 1);
  assert.equal(jsonErr(unregistered)["code"], "not-registered");

  assert.equal(runCli(["register", "task-042.md", "--as", "agent:claude"], dir).code, 0);
  const undeclared = runCli(
    ["request", "task-042", "--action", "task-042:invented", "--as", "agent:claude", "--json"],
    dir,
  );
  assert.equal(undeclared.code, 1);
  assert.equal(jsonErr(undeclared)["code"], "action-not-registered");
  assertClean(dir);
});

test("request refuses a duplicate live request", () => {
  const dir = readyForDecision();
  const run = runCli(
    ["request", "task-042", "--action", "task-042:chaser", "--as", "agent:claude", "--json"],
    dir,
  );
  assert.equal(run.code, 1);
  const error = jsonErr(run);
  assert.equal(error["code"], "duplicate-request");
  assert.equal(error["state"], "requested");
  assert.equal(events(dir).filter((event) => event === "approval.requested").length, 1);
});

test("a budget refusal appends budget.exceeded, carries the verdicts, and exits 1", () => {
  const dir = caseDir();
  attest(dir);
  assert.equal(runCli(["register", "task-042.md", "--as", "agent:claude"], dir).code, 0);

  const run = runCli(
    ["request", "task-042", "--action", "task-042:fee", "--as", "agent:claude", "--json"],
    dir,
  );
  assert.equal(run.code, 1);
  const error = jsonErr(run);
  assert.equal(error["code"], "budget-exceeded");
  const verdicts = error["verdicts"] as Record<string, unknown>[];
  assert.deepEqual(verdicts.map((verdict) => verdict["limit"]), ["per_action_usd"]);

  assert.deepEqual(events(dir), ["policy.updated", "task.registered", "budget.exceeded"]);
  assert.equal(error["seq"], 3);
  assertClean(dir);
});

test("request without --action is a usage error", () => {
  const dir = caseDir();
  const run = runCli(["request", "task-042", "--as", "agent:claude", "--json"], dir);
  assert.equal(run.code, 2);
  assert.equal(jsonErr(run)["code"], "usage");
});

// ---------------------------------------------------------------------------
// grant / reject / revoke
// ---------------------------------------------------------------------------

test("grant --json emits the frozen shape and records the human decision", () => {
  const dir = readyForDecision();
  const run = runCli(
    ["grant", "task-042:chaser", "--note", "go, but cc me", "--as", "human:carter", "--json"],
    dir,
  );

  assert.equal(run.code, 0, run.stderr);
  // APRV-17: the frozen shape gains "token" on grant — the single-use execution
  // token, printed here once and stored nowhere.
  const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
  const token = String(parsed["token"]);
  assert.match(token, /^[a-f0-9]{64}$/u);
  assert.deepEqual(parsed, {
    ok: true,
    decision: "grant",
    state: "granted",
    action_key: "task-042:chaser",
    seq: 4,
    token,
  });

  const granted = logRecords(dir)[3] as Record<string, unknown>;
  assert.equal(granted["event"], "approval.granted");
  assert.equal(granted["actor"], "human:carter");
  // The budgets contract: class and est_cost_usd on every approval.granted,
  // plus the token's digest — the raw token never reaches the log.
  assert.deepEqual(granted["payload"], {
    class: "communicate.email.external",
    est_cost_usd: 0.02,
    payload_hash: PAYLOAD_HASH,
    note: "go, but cc me",
    token_sha256: createHash("sha256").update(token, "utf8").digest("hex"),
    // APRV-118: the attested policy the approver decided under.
    policy_sha256: policySha256(dir),
  });
  assertClean(dir);
});

test("grant is human-only: an agent actor is refused at exit 2 with nothing appended", () => {
  const dir = readyForDecision();
  const run = runCli(["grant", "task-042:chaser", "--as", "agent:claude", "--json"], dir);
  assert.equal(run.code, 2);
  assert.match(String(jsonErr(run)["message"]), /human-only/u);
  assert.equal(events(dir).includes("approval.granted"), false);

  const noIdentity = runCli(["grant", "task-042:chaser", "--json"], dir);
  assert.equal(noIdentity.code, 2);
  assert.match(String(jsonErr(noIdentity)["message"]), /APPROVAL_HUMAN/u);
  assert.equal(events(dir).includes("approval.granted"), false);
});

test("APPROVAL_HUMAN supplies the deciding human", () => {
  const dir = readyForDecision();
  const run = runCli(["reject", "task-042:chaser", "--json"], dir, {
    APPROVAL_HUMAN: "human:from-env",
  });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(logRecords(dir)[3]?.["actor"], "human:from-env");
  assert.equal(logRecords(dir)[3]?.["event"], "approval.rejected");
});

test("a second decision is refused at exit 1", () => {
  const dir = readyForDecision();
  assert.equal(runCli(["reject", "task-042:chaser", "--as", "human:carter"], dir).code, 0);
  const run = runCli(["grant", "task-042:chaser", "--as", "human:carter", "--json"], dir);
  assert.equal(run.code, 1);
  const error = jsonErr(run);
  assert.equal(error["code"], "already-decided");
  assert.equal(error["state"], "rejected");
  assert.equal(events(dir).includes("approval.granted"), false);
  assertClean(dir);
});

test("revoke: refused on an undecided request, accepted on a grant", () => {
  const dir = readyForDecision();
  const early = runCli(["revoke", "task-042:chaser", "--as", "human:carter", "--json"], dir);
  assert.equal(early.code, 1);
  assert.equal(jsonErr(early)["code"], "not-granted");

  assert.equal(runCli(["grant", "task-042:chaser", "--as", "human:carter"], dir).code, 0);
  const run = runCli(["revoke", "task-042:chaser", "--as", "human:carter", "--json"], dir);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    ok: true,
    decision: "revoke",
    state: "revoked",
    action_key: "task-042:chaser",
    seq: 5,
  });
  assertClean(dir);
});

// ---------------------------------------------------------------------------
// withdraw (APRV-106)
// ---------------------------------------------------------------------------

test("withdraw: the requester retracts, and every later decision is refused", () => {
  const dir = readyForDecision();
  const run = runCli(
    [
      "withdraw",
      "task-042",
      "--action",
      "task-042:chaser",
      "--reason",
      "timeout",
      "--as",
      "agent:claude",
      "--json",
    ],
    dir,
  );
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    ok: true,
    task: "task-042",
    action_key: "task-042:chaser",
    state: "withdrawn",
    reason: "timeout",
    seq: 4,
  });

  // The inbox is empty: a withdrawn request is not pending, by the same
  // derivation every surface builds its queue from.
  const queue = runCli(["queue", "--json"], dir);
  assert.equal(queue.code, 0, queue.stderr);
  assert.deepEqual(JSON.parse(queue.stdout), { ok: true, pending: [] });

  const late = runCli(["grant", "task-042:chaser", "--as", "human:carter", "--json"], dir);
  assert.equal(late.code, 1);
  assert.equal(jsonErr(late)["code"], "request-withdrawn");
  assert.equal(events(dir).includes("approval.granted"), false);
  assertClean(dir);
});

test("withdraw: anyone but the requester is refused not-requester", () => {
  const dir = readyForDecision();
  const run = runCli(
    ["withdraw", "task-042", "--action", "task-042:chaser", "--as", "human:carter", "--json"],
    dir,
  );
  assert.equal(run.code, 1);
  assert.equal(jsonErr(run)["code"], "not-requester");
  assert.equal(events(dir).includes("approval.withdrawn"), false);
  // Still decidable by the human who could not withdraw it: rejecting is the
  // on-the-record way to end someone else's pending request.
  assert.equal(runCli(["reject", "task-042:chaser", "--as", "human:carter"], dir).code, 0);
  assertClean(dir);
});

test("withdraw: an unrecognized --reason is a usage error, not a default", () => {
  const dir = readyForDecision();
  const run = runCli(
    [
      "withdraw",
      "task-042",
      "--action",
      "task-042:chaser",
      "--reason",
      "bored",
      "--as",
      "agent:claude",
      "--json",
    ],
    dir,
  );
  assert.equal(run.code, 2);
  assert.equal(jsonErr(run)["code"], "usage");
  assert.equal(events(dir).includes("approval.withdrawn"), false);
  assertClean(dir);
});

test("withdraw: --action is required and a decided request is already-decided", () => {
  const missing = readyForDecision();
  assert.equal(runCli(["withdraw", "task-042", "--as", "agent:claude"], missing).code, 2);

  const decided = readyForDecision();
  assert.equal(runCli(["grant", "task-042:chaser", "--as", "human:carter"], decided).code, 0);
  const run = runCli(
    ["withdraw", "task-042", "--action", "task-042:chaser", "--as", "agent:claude", "--json"],
    decided,
  );
  assert.equal(run.code, 1);
  assert.equal(jsonErr(run)["code"], "already-decided");
  assertClean(decided);
});

test("decide on an unrequested action is refused", () => {
  const dir = caseDir();
  attest(dir);
  assert.equal(runCli(["register", "task-042.md", "--as", "agent:claude"], dir).code, 0);
  const run = runCli(["grant", "task-042:chaser", "--as", "human:carter", "--json"], dir);
  assert.equal(run.code, 1);
  assert.equal(jsonErr(run)["code"], "not-requested");
});

// ---------------------------------------------------------------------------
// TTL: expire, and the late decision
// ---------------------------------------------------------------------------

test("a late grant is refused and materialises approval.expired with a system: actor", () => {
  // approval_ttl: 1ms — the request lapses effectively at once, so the late
  // decision is exercised without sleeping or faking a clock.
  const dir = readyForDecision(POLICY_INSTANT_TTL);
  assert.equal(events(dir).includes("approval.expired"), false);

  const run = runCli(["grant", "task-042:chaser", "--as", "human:carter", "--json"], dir);
  assert.equal(run.code, 1);
  const error = jsonErr(run);
  assert.equal(error["code"], "expired");
  assert.equal(error["state"], "expired");

  const records = logRecords(dir);
  const last = records[records.length - 1] as Record<string, unknown>;
  assert.equal(last["event"], "approval.expired");
  assert.equal(last["actor"], "system:gate");
  assert.equal(error["seq"], last["seq"]);
  assert.equal(events(dir).includes("approval.granted"), false);
  assertClean(dir);
});

test("expire is the system verb: it appends approval.expired with no identity", () => {
  const dir = readyForDecision(POLICY_INSTANT_TTL);
  const run = runCli(["expire", "task-042:chaser", "--json"], dir);

  assert.equal(run.code, 0, run.stderr);
  const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), ["action_key", "actor", "ok", "seq"]);
  assert.equal(parsed["actor"], "system:gate");
  assert.equal(parsed["ok"], true);

  const records = logRecords(dir);
  const expired = records[records.length - 1] as Record<string, unknown>;
  assert.equal(expired["event"], "approval.expired");
  assert.equal((expired["payload"] as Record<string, unknown>)["on_expiry"], "reject");

  // Terminal: every decision verb now refuses.
  for (const verb of ["grant", "reject", "revoke"]) {
    const late = runCli([verb, "task-042:chaser", "--as", "human:carter", "--json"], dir);
    assert.equal(late.code, 1);
    assert.equal(jsonErr(late)["code"], "expired");
  }
  assert.equal(events(dir).filter((event) => event === "approval.expired").length, 1);
  assertClean(dir);
});

test("expire refuses a request whose TTL has not lapsed", () => {
  const dir = readyForDecision();
  const run = runCli(["expire", "task-042:chaser", "--json"], dir);
  assert.equal(run.code, 1);
  const error = jsonErr(run);
  assert.equal(error["code"], "not-expired");
  assert.equal(error["state"], "requested");
  assert.equal(events(dir).includes("approval.expired"), false);
  assertClean(dir);
});

// ---------------------------------------------------------------------------
// I/O and torn-tail exit codes
// ---------------------------------------------------------------------------

test("a torn tail exits 3 and nothing is appended", () => {
  const dir = readyForDecision();
  const logPath = join(dir, ".approval", "log", "events.jsonl");
  const before = readFileSync(logPath, "utf8");
  writeFileSync(logPath, `${before}{"seq":4,"ts":"2026`, "utf8");

  const run = runCli(["grant", "task-042:chaser", "--as", "human:carter", "--json"], dir);
  assert.equal(run.code, 3);
  assert.equal(jsonErr(run)["code"], "log-torn-tail");
  assert.equal(readFileSync(logPath, "utf8"), `${before}{"seq":4,"ts":"2026`);
});

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

test("--help documents the exit codes, the human-only verbs, and amended §6.3", () => {
  const dir = caseDir();

  const root = runCli(["--help"], dir);
  assert.equal(root.code, 0);
  assert.match(root.stdout, /approval register/u);
  assert.match(root.stdout, /HUMAN-ONLY/u);
  assert.match(root.stdout, /exits 1, NOT 2/u);

  for (const verb of ["register", "request", "grant", "reject", "revoke", "expire"]) {
    const help = runCli([verb, "--help"], dir);
    assert.equal(help.code, 0, `${verb} --help failed`);
    // APRV-91: the frozen table lives in `approval --help`; the verb points
    // at it and states only the code peculiar to the gate (a refusal is 1).
    assert.doesNotMatch(help.stdout, /Exit codes \(frozen public API\)/u);
    assert.match(help.stdout, /exit codes: approval --help/u);
    assert.match(help.stdout, /A GATE REFUSAL IS 1, NOT 2/u);
    assert.match(help.stdout, /Refusal codes/u);
    assert.equal(help.stderr, "");
  }

  const request = runCli(["request", "--help"], dir);
  assert.match(request.stdout, /EXCLUSIVE to the manual path/u);
  assert.match(request.stdout, /proceed:true/u);

  for (const verb of ["grant", "reject", "revoke"]) {
    assert.match(runCli([verb, "--help"], dir).stdout, /HUMAN-ONLY/u);
  }
  assert.match(runCli(["expire", "--help"], dir).stdout, /system:gate/u);
});

test("an unknown flag on a gate verb is a usage error, not a refusal", () => {
  const dir = caseDir();
  const run = runCli(["request", "task-042", "--jsno"], dir);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /unknown flag --jsno/u);
});
