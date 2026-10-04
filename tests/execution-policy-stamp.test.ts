/**
 * APRV-447: every harness `execution.started` carries `policy_sha256`.
 *
 * The stamp names the attested policy the gate resolved the start's class
 * against. These cases pin what makes it trustworthy as a join key for the
 * agentvillage-data follower (which maps it to `policy_version`):
 *
 * - both write paths stamp it, `startHarnessExecution` (policy-authorized) and
 *   `consumeHarnessGrant` (grant-authorized), and the value equals the hash of
 *   the attestation `approval status` reports for the store;
 * - every surface that reaches those paths carries it: the hook route for an
 *   autonomous and a supervised class, and `approval start` on the policy and
 *   the grant path;
 * - a caller cannot choose it: a value supplied on the input, in the options,
 *   or inside the action's own payload is ignored;
 * - a re-attest moves it on the next start, and an unattested edit produces no
 *   start at all, so no stamp ever names bytes nobody attested;
 * - a record without the field still validates, so every historical start does.
 *
 * Every record here is produced by the real append path (a gate verb or a CLI
 * verb), and every scenario ends with the chain verified.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { policyBytesHash } from "../src/core/attest.js";
import {
  consumeHarnessGrant,
  decide,
  proposedTaskId,
  register,
  request,
  startHarnessExecution,
  type ConsumeHarnessOptions,
  type GateOptions,
  type HarnessStartInput,
} from "../src/core/gate.js";
import { appendEvent, type EventRecord } from "../src/core/log.js";
import { payloadHash } from "../src/core/payload.js";
import { validate } from "../src/core/validate.js";
import { verify } from "../src/core/verify.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-policy-stamp-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, input = ""): Run {
  const childEnv = { ...process.env };
  delete childEnv["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv,
    input,
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
  "  files.write.workspace:",
  "    autonomy: autonomous",
  "  vcs.push.main:",
  "    autonomy: supervised",
  "  communicate.email.external:",
  "    autonomy: manual",
  "  intent.publish.*:",
  "    autonomy: manual",
  "    agent_may_request: true",
  "  intent.publish.stated.index:",
  "    autonomy: autonomous",
  "  intent.publish.inferred.index:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

const AGENT = "agent:claude";
const HUMAN = "human:carter";
const PAYLOAD_HASH = "1".repeat(64);
/** A well-formed digest no attestation in any case here ever names. */
const FORGED = "f".repeat(64);

interface Case {
  dir: string;
  logPath: string;
  policyPath: string;
  options: GateOptions;
}

/** A store laid out where `approval status` finds it, its policy attested. */
function ready(policyText: string = POLICY): Case {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  const policyPath = join(dir, "APPROVAL.md");
  writeFileSync(policyPath, policyText, "utf8");
  attest(dir);
  return {
    dir,
    logPath: join(dir, ".approval", "log", "events.jsonl"),
    policyPath,
    options: { policy: { file: policyPath } },
  };
}

function attest(dir: string): void {
  const run = runCli(["policy", "attest", "--as", HUMAN], dir);
  assert.equal(run.code, 0, run.stderr);
}

function records(unit: Case): EventRecord[] {
  if (!existsSync(unit.logPath)) return [];
  return readFileSync(unit.logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EventRecord);
}

function payloadOf(record: EventRecord): Record<string, unknown> {
  return (record.payload ?? {}) as Record<string, unknown>;
}

function starts(unit: Case): EventRecord[] {
  return records(unit).filter((record) => record.event === "execution.started");
}

function assertClean(unit: Case): void {
  const result = verify(unit.logPath);
  assert.equal(result.status, "clean", `log not clean: ${JSON.stringify(result)}`);
}

/**
 * The attested policy hash as `approval status` reports it: status names the
 * attesting record's seq, and that record carries the hash it attested. Also
 * cross-checked against the bytes on disk, so the comparison is with the store
 * and not only with the log.
 */
function statusAttestedHash(unit: Case): string {
  const run = runCli(["status", "--json"], unit.dir);
  const report = JSON.parse(run.stdout) as { attestation: { state: string; seq: number | null } };
  assert.equal(report.attestation.state, "attested", run.stdout);
  const seq = report.attestation.seq;
  const record = records(unit).find((candidate) => candidate.seq === seq);
  assert.ok(record !== undefined, `status names seq ${String(seq)}, which the log does not carry`);
  assert.equal(record.event, "policy.updated");
  const sha = payloadOf(record)["sha256"];
  assert.equal(typeof sha, "string");
  assert.equal(sha, policyBytesHash(readFileSync(unit.policyPath)));
  return sha as string;
}

const ENVELOPE = {
  origin: { app: "example-capture", created_by: HUMAN },
  state: "proposed",
  actions: [
    {
      class: "communicate.email.external",
      summary: "Send deposit chaser",
      reversible: false,
      est_cost_usd: "0.02",
      idempotency_key: "task-042:chaser",
      payload_hash: PAYLOAD_HASH,
    },
  ],
};

/** Register, request `execution: "harness"`, and grant, through the gate. */
function harnessGrant(unit: Case): void {
  const registered = register(unit.logPath, { task: "task-042", envelope: ENVELOPE }, AGENT, unit.options);
  assert.equal(registered.ok, true, registered.ok ? "" : registered.message);
  const requested = request(
    unit.logPath,
    {
      task: "task-042",
      actionKey: "task-042:chaser",
      payload_hash: PAYLOAD_HASH,
      cls: "communicate.email.external",
      est_cost_usd: "0.02",
      reversible: false,
      summary: "Send deposit chaser",
      execution: "harness",
    },
    AGENT,
    unit.options,
  );
  assert.equal(requested.ok, true, requested.ok ? "" : requested.message);
  const granted = decide(unit.logPath, "task-042:chaser", "grant", HUMAN, unit.options);
  assert.equal(granted.ok, true, granted.ok ? "" : granted.message);
}

function autonomousStart(unit: Case, key: string, extra: Record<string, unknown> = {}) {
  return startHarnessExecution(
    unit.logPath,
    {
      task: "hook:sess-1:tu-1",
      actionKey: key,
      cls: "files.write.workspace",
      payload_hash: PAYLOAD_HASH,
      ...extra,
    } as HarnessStartInput,
    AGENT,
    unit.options,
  );
}

// ---------------------------------------------------------------------------
// The two write paths
// ---------------------------------------------------------------------------

test("startHarnessExecution stamps the attested policy hash approval status reports", () => {
  const unit = ready();
  const started = autonomousStart(unit, "hook:sess-1:tu-1:files.write.workspace");
  assert.equal(started.ok, true, started.ok ? "" : started.message);
  if (!started.ok) return;
  assert.equal(payloadOf(started.record)["policy_sha256"], statusAttestedHash(unit));
  // The returned record is the appended one: the stamp is covered by the hash.
  const onDisk = starts(unit);
  assert.equal(onDisk.length, 1);
  assert.equal(payloadOf(onDisk[0] as EventRecord)["policy_sha256"], statusAttestedHash(unit));
  assertClean(unit);
});

test("consumeHarnessGrant stamps the attested policy hash, which equals the grant's own pin", () => {
  const unit = ready();
  harnessGrant(unit);
  const spent = consumeHarnessGrant(unit.logPath, "task-042:chaser", AGENT, {
    ...unit.options,
    presentedPayloadHash: PAYLOAD_HASH,
  });
  assert.equal(spent.ok, true, spent.ok ? "" : spent.message);
  if (!spent.ok) return;
  const expected = statusAttestedHash(unit);
  assert.equal(payloadOf(spent.record)["policy_sha256"], expected);
  const grant = records(unit).find((record) => record.event === "approval.granted");
  assert.ok(grant !== undefined);
  assert.equal(payloadOf(grant)["policy_sha256"], expected);
  assertClean(unit);
});

// ---------------------------------------------------------------------------
// A caller cannot choose the value
// ---------------------------------------------------------------------------

test("a policy_sha256 supplied on the start input or options is ignored", () => {
  const unit = ready();
  const started = startHarnessExecution(
    unit.logPath,
    {
      task: "hook:sess-1:tu-2",
      actionKey: "hook:sess-1:tu-2:files.write.workspace",
      cls: "files.write.workspace",
      payload_hash: PAYLOAD_HASH,
      policy_sha256: FORGED,
      payload: { policy_sha256: FORGED },
    } as HarnessStartInput,
    AGENT,
    { ...unit.options, policy_sha256: FORGED } as GateOptions,
  );
  assert.equal(started.ok, true, started.ok ? "" : started.message);
  if (!started.ok) return;
  assert.equal(payloadOf(started.record)["policy_sha256"], statusAttestedHash(unit));
  assert.notEqual(payloadOf(started.record)["policy_sha256"], FORGED);
  assertClean(unit);
});

test("a policy_sha256 supplied in the grant spend's options is ignored", () => {
  const unit = ready();
  harnessGrant(unit);
  const spent = consumeHarnessGrant(unit.logPath, "task-042:chaser", AGENT, {
    ...unit.options,
    presentedPayloadHash: PAYLOAD_HASH,
    policy_sha256: FORGED,
  } as ConsumeHarnessOptions);
  assert.equal(spent.ok, true, spent.ok ? "" : spent.message);
  if (!spent.ok) return;
  assert.equal(payloadOf(spent.record)["policy_sha256"], statusAttestedHash(unit));
  assertClean(unit);
});

test("a proposal whose own payload names a policy_sha256 is stamped with the attested one", () => {
  const unit = ready();
  const key = "intent.publish.stated.index:stamp-1";
  const payload = { text: "climbing on Sunday", policy_sha256: FORGED };
  const proposed = runCli(
    ["propose", "--class", "intent.publish.stated.index", "--key", key, "--summary", "s", "--payload-json", JSON.stringify(payload), "--as", AGENT, "--json"],
    unit.dir,
  );
  assert.equal(proposed.code, 0, proposed.stderr);
  const task = proposedTaskId(AGENT, "intent.publish.stated.index", key);
  const started = runCli(
    ["start", task, "--action", key, "--payload-json", JSON.stringify(payload), "--as", AGENT, "--json"],
    unit.dir,
  );
  assert.equal(started.code, 0, started.stderr);
  const record = starts(unit).at(-1);
  assert.ok(record !== undefined);
  // The payload's bytes are named by hash and never lifted into the record.
  assert.equal(payloadOf(record)["payload_hash"], payloadHash(payload));
  assert.equal(payloadOf(record)["policy_sha256"], statusAttestedHash(unit));
  assertClean(unit);
});

// ---------------------------------------------------------------------------
// The value follows the attestation
// ---------------------------------------------------------------------------

test("a re-attest changes the stamp on the next start, and an unattested edit starts nothing", () => {
  const unit = ready();
  const first = autonomousStart(unit, "hook:sess-1:tu-3:files.write.workspace");
  assert.equal(first.ok, true, first.ok ? "" : first.message);
  if (!first.ok) return;
  const before = statusAttestedHash(unit);
  assert.equal(payloadOf(first.record)["policy_sha256"], before);

  // An edit nobody attested: no start, so no stamp can name these bytes.
  writeFileSync(unit.policyPath, `${POLICY}\n<!-- amended -->\n`, "utf8");
  const raw = readFileSync(unit.logPath, "utf8");
  const refused = autonomousStart(unit, "hook:sess-1:tu-4:files.write.workspace");
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.code, "policy-not-attested");
  assert.equal(readFileSync(unit.logPath, "utf8"), raw);

  attest(unit.dir);
  const after = statusAttestedHash(unit);
  assert.notEqual(after, before);
  const second = autonomousStart(unit, "hook:sess-1:tu-5:files.write.workspace");
  assert.equal(second.ok, true, second.ok ? "" : second.message);
  if (!second.ok) return;
  assert.equal(payloadOf(second.record)["policy_sha256"], after);
  // The earlier record is untouched: the log is append-only.
  assert.equal(payloadOf(starts(unit)[0] as EventRecord)["policy_sha256"], before);
  assertClean(unit);
});

// ---------------------------------------------------------------------------
// The surfaces that reach the two paths
// ---------------------------------------------------------------------------

function hookEvent(command: string, toolUseId: string): string {
  return JSON.stringify({
    session_id: "sess-stamp",
    transcript_path: "/dev/null",
    cwd: "/repo",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "stamp" },
    tool_use_id: toolUseId,
  });
}

test("the hook route stamps autonomous and supervised starts", () => {
  const unit = ready();
  const expected = statusAttestedHash(unit);
  for (const [command, id] of [
    ["ls -la", "tu-read"],
    ["git push origin main", "tu-push"],
  ] as const) {
    const run = runCli(["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"], unit.dir, hookEvent(command, id));
    assert.equal(run.code, 0, run.stderr);
    const output = (JSON.parse(run.stdout) as { hookSpecificOutput: Record<string, unknown> }).hookSpecificOutput;
    assert.equal(output["permissionDecision"], "allow", String(output["permissionDecisionReason"]));
  }
  const all = starts(unit);
  const classes = all.map((record) => payloadOf(record)["class"]);
  assert.ok(classes.includes("vcs.push.main"), `classes: ${JSON.stringify(classes)}`);
  assert.ok(classes.some((cls) => typeof cls === "string" && cls.startsWith("read.")), `classes: ${JSON.stringify(classes)}`);
  for (const record of all) {
    assert.equal(payloadOf(record)["execution"], "harness");
    assert.equal(payloadOf(record)["policy_sha256"], expected, JSON.stringify(record));
  }
  assertClean(unit);
});

test("approval start stamps both the policy path and the grant path", () => {
  const unit = ready();
  const expected = statusAttestedHash(unit);
  const text = { text: "lunch on the beach?" };

  const stated = "intent.publish.stated.index:stamp-policy";
  assert.equal(
    runCli(["propose", "--class", "intent.publish.stated.index", "--key", stated, "--summary", "s", "--payload-json", JSON.stringify(text), "--as", AGENT, "--json"], unit.dir).code,
    0,
  );
  const policyStart = runCli(
    ["start", proposedTaskId(AGENT, "intent.publish.stated.index", stated), "--action", stated, "--payload-json", JSON.stringify(text), "--as", AGENT, "--json"],
    unit.dir,
  );
  assert.equal(policyStart.code, 0, policyStart.stderr);
  assert.equal((JSON.parse(policyStart.stdout) as Record<string, unknown>)["authorization"], "policy");

  const inferred = "intent.publish.inferred.index:stamp-grant";
  const asked = runCli(
    ["propose", "--class", "intent.publish.inferred.index", "--key", inferred, "--summary", "s", "--payload-json", JSON.stringify(text), "--as", AGENT, "--json"],
    unit.dir,
  );
  assert.equal(asked.code, 0, `${asked.stdout}${asked.stderr}`);
  const granted = runCli(["grant", inferred, "--as", HUMAN, "--json"], unit.dir);
  assert.equal(granted.code, 0, `${granted.stdout}${granted.stderr}`);
  const grantStart = runCli(
    ["start", proposedTaskId(AGENT, "intent.publish.inferred.index", inferred), "--action", inferred, "--payload-json", JSON.stringify(text), "--as", AGENT, "--json"],
    unit.dir,
  );
  assert.equal(grantStart.code, 0, grantStart.stderr);
  assert.equal((JSON.parse(grantStart.stdout) as Record<string, unknown>)["authorization"], "grant");

  const byKey = new Map(starts(unit).map((record) => [record.action_key, record]));
  for (const key of [stated, inferred]) {
    const record = byKey.get(key);
    assert.ok(record !== undefined, `no execution.started for ${key}`);
    assert.equal(payloadOf(record)["policy_sha256"], expected);
  }
  assertClean(unit);
});

// ---------------------------------------------------------------------------
// The schema
// ---------------------------------------------------------------------------

test("an execution.started without the field still validates and appends", () => {
  const unit = ready();
  const appended = appendEvent(unit.logPath, {
    ts: "2026-10-04T09:00:00.000Z",
    event: "execution.started",
    actor: AGENT,
    task: "task-042",
    action_key: "task-042:pre-aprv-447",
    payload: { class: "files.write.workspace", est_cost_usd: "0", execution: "harness", payload_hash: PAYLOAD_HASH },
  });
  assert.equal(appended.ok, true, appended.ok ? "" : JSON.stringify(appended.error));
  if (!appended.ok) return;
  assert.equal(validate("event", appended.record).ok, true);
  assert.equal(validate("event", appended.record, { mode: "historical" }).ok, true);
  assert.equal("policy_sha256" in payloadOf(appended.record), false);
  assertClean(unit);
});

test("the schema refuses a malformed stamp at the write boundary", () => {
  const record = {
    seq: 9,
    ts: "2026-10-04T09:19:02Z",
    event: "execution.started",
    task: "task-042",
    action_key: "task-042:chaser",
    actor: AGENT,
    payload: { class: "files.write.workspace", est_cost_usd: "0", execution: "harness", payload_hash: PAYLOAD_HASH },
    alg: "sha256/jcs",
    prev: "0".repeat(64),
    hash: "0".repeat(64),
  };
  assert.equal(validate("event", { ...record, payload: { ...record.payload, policy_sha256: FORGED } }).ok, true);
  for (const bad of ["", "ABC", FORGED.toUpperCase(), FORGED.slice(1), 42, null]) {
    const result = validate("event", { ...record, payload: { ...record.payload, policy_sha256: bad } });
    assert.equal(result.ok, false, `accepted ${JSON.stringify(bad)}`);
  }
});
