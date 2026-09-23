/**
 * `approval codex bridge` (APRV-361).
 *
 * Every case spawns the real compiled CLI against a stub app-server that speaks
 * the shape the 2026-09-18 probe recorded, because the contract under test is
 * what the SERVER observes: which decision word came back, when it came back,
 * and what reached the log before it did. No log line is written by hand —
 * every record is produced by a real CLI verb — and `approval log verify` runs
 * at the end of each flow.
 *
 * The stub waits for each reply before asking its next question, which is what
 * the real server does. That is what makes "the answer came after the grant"
 * assertable at all: a stub that raced ahead would let a bridge that replied
 * first and asked later pass.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  ACCEPT_WORDS,
  BRIDGE_REFUSAL_CODES,
  BRIDGE_STOP_CODES,
  DECLINE_WORDS,
  advertisedDecisions,
  chooseDecision,
  decideExecRequest,
  effectiveApprovalPolicy,
  encodeDecision,
  isAutoReviewNotification,
  isBridgeDecisionWord,
  namesCommandExecution,
} from "../src/cli/codex-bridge.js";

/** dist/tests/codex-bridge.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
/** The stub is shipped as source: it is a fixture, not compiled output. */
const STUB = fileURLToPath(new URL("../../tests/fixtures/codex-app-server-stub.mjs", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-codex-bridge-")));
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

/**
 * A policy with one autonomous class and one human-only one, so a single
 * fixture covers the accept path and the refusal AC3 names.
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
  "  log.mutate:",
  "    autonomy: human-only",
  "  network.call:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

const LOG = ".approval/log/events.jsonl";

function rawLog(dir: string): string {
  const path = join(dir, LOG);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** A case directory whose policy a human has attested. */
function ready(policyText: string = POLICY): string {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), policyText, "utf8");
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  return dir;
}

/**
 * One thing the stub says: a request it waits for a reply to, or, since
 * APRV-379, a notification it sends and moves straight past.
 */
type ScriptEntry =
  | { method: string; params?: Record<string, unknown> }
  | { notify: string; params?: Record<string, unknown> }
  | { raw: string };

interface BridgeAnswerRow {
  method: string;
  threadId: string | null;
  turnId: string | null;
  itemId: string | null;
  outcome: "accept" | "decline";
  executionOutcome: "unknown" | "not-authorized";
  decision: string;
  decisionSource: "advertised" | "fallback";
  code: string | null;
  detail: string;
}

interface BridgeThreadRow {
  id: string | null;
  cwd: string;
  requested: { approvalPolicy: string; sandbox: string };
  effective: { approvalPolicy: string | null };
  /** Widened from a boolean to its source in APRV-364. */
  confirmed: "unconfirmed" | "reported" | "observed";
}

/** The preflight probe, as the report records it (APRV-364). */
interface BridgePreflightRow {
  turnId: string | null;
  command: string;
  outcome: "pending" | "asked" | "executed" | "void";
  decision: string | null;
  frames?: unknown[];
  error?: unknown;
}

interface BridgeReport {
  ok: boolean;
  reason: string;
  /** Present only when the run STOPPED on one of the stop codes (APRV-366). */
  code?: string;
  thread: BridgeThreadRow;
  preflight: BridgePreflightRow;
  turns: { id: string | null; status: string; answers: number }[];
  answers: BridgeAnswerRow[];
}

/**
 * Run the bridge against the stub, with `script` as the questions it asks.
 *
 * `env` reaches the stub, which is how the approval-policy cases make a server
 * that refuses `thread/start` or reports a policy of its own (APRV-366).
 */
function bridge(
  dir: string,
  script: ScriptEntry[],
  extra: string[] = [],
  env: Record<string, string> = {},
): { run: Run; report: BridgeReport; replies: Record<string, unknown>[] } {
  const repliesPath = join(dir, "stub-replies.jsonl");
  const run = runCli(
    [
      "codex",
      "bridge",
      "--prompt",
      "do the thing",
      "--dir",
      dir,
      "--wait",
      "2s",
      "--interval",
      "200ms",
      "--json",
      ...extra,
      "--",
      process.execPath,
      STUB,
    ],
    dir,
    {
      APPROVAL_STUB_SCRIPT: JSON.stringify(script),
      APPROVAL_STUB_REPLIES: repliesPath,
      ...env,
    },
  );
  const line = run.stdout
    .split("\n")
    .find((candidate) => candidate.trim().startsWith("{") && candidate.includes('"answers"'));
  assert.ok(line !== undefined, `no bridge report in:\n${run.stdout}\n${run.stderr}`);
  const replies = existsSync(repliesPath)
    ? readFileSync(repliesPath, "utf8")
        .split("\n")
        .filter((entry) => entry.trim().length > 0)
        .map((entry) => JSON.parse(entry) as Record<string, unknown>)
    : [];
  return { run, report: JSON.parse(line) as BridgeReport, replies };
}

/** An exec approval request in the shape the probe recorded. */
function execRequest(
  command: string,
  cwd: string,
  available: string[] | null = ["accept", "acceptForSession", "acceptWithExecpolicyAmendment", "cancel", "decline"],
): ScriptEntry {
  return {
    method: "item/commandExecution/requestApproval",
    params: {
      kind: "command",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: `item-${command.length.toString()}`,
      startedAtMs: 0,
      command,
      cwd,
      environmentId: "local",
      reason: null,
      ...(available === null ? {} : { availableDecisions: available }),
    },
  };
}

function repliesOf(path: string): Record<string, unknown>[] {
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((entry) => entry.trim().length > 0)
        .map((entry) => JSON.parse(entry) as Record<string, unknown>)
    : [];
}

/**
 * The action key of the first `approval.requested` the bridge opens, once it
 * exists.
 *
 * Polled off the log rather than guessed, because the key contains the task id
 * the gate derives from the thread and the item, and a test that reconstructed
 * it would be asserting its own arithmetic.
 */
async function waitForRequestKey(dir: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const line of rawLog(dir).split("\n")) {
      if (line.trim().length === 0) continue;
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record["event"] === "approval.requested" && typeof record["action_key"] === "string") {
        return record["action_key"];
      }
    }
    assert.ok(Date.now() < deadline, "no approval.requested appeared before the deadline");
    await delay(100);
  }
}

function assertVerifies(dir: string): void {
  const verify = runCli(["log", "verify", "--json"], dir);
  assert.equal(verify.code, 0, verify.stderr);
  assert.equal((JSON.parse(verify.stdout) as Record<string, unknown>)["status"], "clean");
}

function logRecords(dir: string): Record<string, unknown>[] {
  return rawLog(dir).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForRequestCount(dir: string, count: number): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const requests = logRecords(dir).filter((record) => record["event"] === "approval.requested");
    if (requests.length >= count) return requests;
    assert.ok(Date.now() < deadline, `only ${String(requests.length)} request(s) appeared`);
    await delay(50);
  }
}

// ---------------------------------------------------------------------------
// AC1 + AC4 — a turn runs, and the answers are accept or decline only
// ---------------------------------------------------------------------------

test("a turn against the stub is answered accept, in the server's own word", () => {
  const dir = ready();
  const { run, report, replies } = bridge(dir, [execRequest("cat README.md", dir)]);

  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  assert.equal(report.ok, true, report.reason);
  assert.equal(report.answers.length, 1);
  const answer = report.answers[0] as BridgeAnswerRow;
  assert.equal(answer.outcome, "accept");
  assert.equal(answer.executionOutcome, "unknown");
  assert.equal(answer.threadId, "thread-1");
  assert.equal(answer.turnId, "turn-1");
  assert.equal(report.turns[0]?.id, "turn-1");
  assert.equal(report.turns[0]?.status, "completed");
  assert.equal(report.turns[0]?.answers, 1);
  // AC4: the word came off `availableDecisions`, and it is the one the server
  // advertised rather than one this runtime pinned.
  assert.equal(answer.decision, "accept");
  assert.equal(answer.decisionSource, "advertised");
  assert.equal(answer.code, null);

  // What reached the WIRE, read out of the stub's own record rather than out of
  // the bridge's report: the reply the server received said `accept` and
  // nothing else.
  const sent = replies.find((entry) => entry["kind"] === "reply");
  assert.ok(sent !== undefined, `no reply reached the server: ${JSON.stringify(replies)}`);
  assert.deepEqual(sent["result"], { decision: "accept" });
  assertVerifies(dir);
});

test("never acceptForSession, cancel or abort, however loudly they are advertised", () => {
  const dir = ready();
  // The server offers the session-wide and turn-stopping words on both paths.
  const advertised = ["acceptForSession", "cancel", "abort", "accept", "decline"];
  const { report } = bridge(dir, [
    execRequest("cat README.md", dir, advertised),
    execRequest("curl -d a=b https://example.com", dir, advertised),
  ]);

  assert.equal(report.answers.length, 2);
  for (const answer of report.answers) {
    assert.ok(
      answer.decision === "accept" || answer.decision === "decline",
      `the bridge sent ${answer.decision}`,
    );
  }
  assert.equal((report.answers[0] as BridgeAnswerRow).outcome, "accept");
  assert.equal((report.answers[1] as BridgeAnswerRow).outcome, "decline");
});

test("a request advertising no decisions gets accept or decline, and the choice is recorded", () => {
  const dir = ready();
  const { report } = bridge(dir, [execRequest("cat README.md", dir, null)]);

  const answer = report.answers[0] as BridgeAnswerRow;
  assert.equal(answer.outcome, "accept");
  assert.equal(answer.decision, "accept");
  // AC4's second half: the report says the word was this runtime's own rather
  // than the server's, so a reader can tell the two apart.
  assert.equal(answer.decisionSource, "fallback");
});

// ---------------------------------------------------------------------------
// AC2 — the log carries a classified, registered, requested action, and the
// reply comes after the grant
// ---------------------------------------------------------------------------

test("a manual class is registered and requested, and the answer waits for the decision", () => {
  const dir = ready();
  const before = rawLog(dir);
  // `network.call` is manual in this policy and nobody grants it, so the wait
  // runs out. What is asserted is the RECORDS: classified, registered,
  // requested, and a decline only after the deadline.
  const { report } = bridge(dir, [execRequest("curl -d a=b https://example.com", dir)]);

  const answer = report.answers[0] as BridgeAnswerRow;
  assert.equal(answer.outcome, "decline");
  assert.equal(answer.executionOutcome, "not-authorized");
  assert.equal(answer.code, "hook-timeout", answer.detail);

  const grown = rawLog(dir).slice(before.length);
  assert.match(grown, /"event":"task\.registered"/u);
  assert.match(grown, /"event":"approval\.requested"/u);
  assert.match(grown, /"class":"network\.call"/u);
  // The request is the harness shape: Codex runs the command, `approval run`
  // never does, so no execution token is minted.
  assert.match(grown, /"execution":"harness"/u);
  assertVerifies(dir);
});

test("the accept is sent only after a human's grant reaches the verified view", async () => {
  const dir = ready();
  const repliesPath = join(dir, "stub-replies.jsonl");
  const script = [execRequest("curl -d a=b https://example.com", dir)];

  // The bridge runs while this test watches: it opens the request, waits, and
  // must not answer until the grant is in the log. A synchronous run could only
  // show the timeout.
  const child = spawn(
    process.execPath,
    [
      CLI_ENTRY,
      "codex",
      "bridge",
      "--prompt",
      "do the thing",
      "--dir",
      dir,
      "--wait",
      "30s",
      "--interval",
      "200ms",
      "--json",
      "--",
      process.execPath,
      STUB,
    ],
    {
      cwd: dir,
      env: {
        ...process.env,
        APPROVAL_STUB_SCRIPT: JSON.stringify(script),
        APPROVAL_STUB_REPLIES: repliesPath,
      },
    },
  );
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", () => {});

  // Wait for the question to exist, then answer it. Until the grant lands the
  // stub has received nothing: the reply is what this test is timing.
  const key = await waitForRequestKey(dir, 20_000);
  assert.equal(repliesOf(repliesPath).some((entry) => entry["kind"] === "reply"), false,
    "the bridge answered before the question was decided");

  const granted = runCli(["grant", key, "--as", "human:alice"], dir);
  assert.equal(granted.code, 0, granted.stderr);

  const code = await new Promise<number>((done) => {
    child.on("exit", (status) => {
      done(status ?? -1);
    });
  });
  assert.equal(code, 0, stdout);

  const line = stdout
    .split("\n")
    .find((candidate) => candidate.trim().startsWith("{") && candidate.includes('"answers"'));
  assert.ok(line !== undefined, `no bridge report in:\n${stdout}`);
  const report = JSON.parse(line) as BridgeReport;
  const answer = report.answers[0] as BridgeAnswerRow;
  assert.equal(answer.outcome, "accept");
  assert.match(answer.detail, /^granted: /u);

  // The grant was SPENT before the accept was sent: an approval this bridge
  // carried cannot be carried a second time.
  assert.match(rawLog(dir), /"event":"approval\.granted"/u);
  assert.match(rawLog(dir), /"event":"execution\.started"/u);
  assertVerifies(dir);
});

test("a rejected call and newly granted retry stay separate in one bridge session", async () => {
  const dir = ready();
  const repliesPath = join(dir, "retry-replies.jsonl");
  const command = "curl -d a=b https://example.com";
  const first = execRequest(command, dir) as { method: string; params: Record<string, unknown> };
  const second = execRequest(command, dir) as { method: string; params: Record<string, unknown> };
  first.params["itemId"] = "rejected-call";
  second.params["itemId"] = "approved-retry";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APPROVAL_STUB_SCRIPT: JSON.stringify([first, second]),
    APPROVAL_STUB_REPLIES: repliesPath,
  };
  delete env.APPROVAL_HUMAN;
  const child = spawn(process.execPath, [CLI_ENTRY, "codex", "bridge", "--prompt", "retry",
    "--dir", dir, "--wait", "30s", "--interval", "100ms", "--json",
    "--", process.execPath, STUB], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  const exited = new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? -1)));

  const firstRequests = await waitForRequestCount(dir, 1);
  const firstKey = firstRequests[0]?.["action_key"];
  assert.ok(typeof firstKey === "string");
  assert.equal(repliesOf(repliesPath).some((row) => row["kind"] === "reply"), false);
  const rejected = runCli(["reject", firstKey, "--as", "human:alice"], dir);
  assert.equal(rejected.code, 0, rejected.stderr);

  const requests = await waitForRequestCount(dir, 2);
  const secondKey = requests[1]?.["action_key"];
  assert.ok(typeof secondKey === "string");
  assert.notEqual(secondKey, firstKey);
  const beforeGrant = repliesOf(repliesPath).filter((row) => row["kind"] === "reply");
  assert.equal(beforeGrant.length, 1, "the retry received a stale rejection or grant");
  assert.deepEqual(beforeGrant[0]?.["result"], { decision: "decline" });
  const granted = runCli(["grant", secondKey, "--as", "human:alice"], dir);
  assert.equal(granted.code, 0, granted.stderr);

  assert.equal(await exited, 0, output);
  const replies = repliesOf(repliesPath).filter((row) => row["kind"] === "reply");
  assert.deepEqual(replies.map((row) => row["result"]), [{ decision: "decline" }, { decision: "accept" }]);
  const starts = logRecords(dir).filter((row) => row["event"] === "execution.started");
  assert.deepEqual(starts.map((row) => row["action_key"]), [secondKey]);
  assertVerifies(dir);
});

test("cancelling a mixed adopted and new multi-class call withdraws only its new request", () => {
  const dir = ready();
  const command = "curl -d a=b https://example.com && npm install left-pad";
  const plan = {
    logPath: join(dir, LOG), root: dir, options: { policy: { dir } },
    actor: "agent:codex-bridge", workspace: dir, waitMs: 1, intervalMs: 1,
  };
  const streams = { out: (_value: string) => {}, err: (_value: string) => {} };
  const params = (itemId: string) => ({
    threadId: "thread-mixed", turnId: "turn-1", itemId, command, cwd: dir,
  });
  const first = decideExecRequest(streams, plan, params("first-call"));
  assert.equal(first.verdict.permission, "deny");
  const opened = logRecords(dir).filter((row) => row["event"] === "approval.requested");
  assert.equal(opened.length, 2, "fixture must exercise two manual classes");
  const adoptedKey = opened[0]?.["action_key"];
  const withdrawnKey = opened[1]?.["action_key"];
  assert.ok(typeof adoptedKey === "string" && typeof withdrawnKey === "string");
  assert.notEqual(adoptedKey, withdrawnKey);
  const task = opened[1]?.["task"];
  assert.ok(typeof task === "string");
  const withdrawn = runCli(["withdraw", task, "--action", withdrawnKey, "--as", plan.actor,
    "--reason", "cancelled"], dir);
  assert.equal(withdrawn.code, 0, withdrawn.stderr);

  const second = decideExecRequest(streams, { ...plan, waitMs: 30_000 }, params("second-call"), {
    cancelled: () => logRecords(dir).filter((row) => row["event"] === "approval.requested").length >= 3,
    pause: (_ms: number) => {},
  });
  assert.equal(second.verdict.permission, "deny");
  if (second.verdict.permission === "deny") assert.equal(second.verdict.code, "hook-withdrawn");
  const records = logRecords(dir);
  const requests = records.filter((row) => row["event"] === "approval.requested");
  assert.equal(requests.length, 3);
  const newKey = requests[2]?.["action_key"];
  assert.ok(typeof newKey === "string");
  assert.notEqual(newKey, adoptedKey);
  assert.notEqual(newKey, withdrawnKey);
  const withdrawals = records.filter((row) => row["event"] === "approval.withdrawn");
  assert.deepEqual(withdrawals.map((row) => row["action_key"]).sort(), [newKey, withdrawnKey].sort());
  assert.equal(withdrawals.some((row) => row["action_key"] === adoptedKey), false);
  const humanGrant = runCli(["grant", adoptedKey, "--as", "human:alice"], dir);
  assert.equal(humanGrant.code, 0, humanGrant.stderr);
  const staleGrant = runCli(["grant", newKey, "--as", "human:alice"], dir);
  assert.notEqual(staleGrant.code, 0);
  assert.match(staleGrant.stderr + staleGrant.stdout, /request-withdrawn/u);
  assert.equal(existsSync(join(dir, `${LOG}.lock`)), false);
  assertVerifies(dir);
});

test("an app-server exit cancels a pending human wait, withdraws its own request and wakes a long poll", async () => {
  const dir = ready();
  const repliesPath = join(dir, "cancel-replies.jsonl");
  const pidPath = join(dir, "cancel-stub.pid");
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    APPROVAL_STUB_SCRIPT: JSON.stringify([execRequest("curl -d a=b https://example.com", dir)]),
    APPROVAL_STUB_REPLIES: repliesPath,
    APPROVAL_STUB_PID_PATH: pidPath,
    APPROVAL_STUB_STAY_OPEN: "1",
  };
  delete childEnv.APPROVAL_HUMAN;
  const child = spawn(process.execPath, [CLI_ENTRY, "codex", "bridge", "--prompt", "wait",
    "--dir", dir, "--wait", "30s", "--interval", "30s", "--json",
    "--", process.execPath, STUB], { cwd: dir, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  await waitForRequestKey(dir, 20_000);
  const stubPid = Number(readFileSync(pidPath, "utf8").trim());
  const stoppedAt = Date.now();
  process.kill(stubPid, "SIGKILL");
  const result = await exited;
  assert.equal(result.signal, null, output);
  assert.notEqual(result.code, 0, output);
  assert.ok(Date.now() - stoppedAt < 5_000, `cancellation did not wake the 30s poll:\n${output}`);
  assert.match(output, /bridge-server-exited/u);
  assert.equal(repliesOf(repliesPath).some((entry) => entry["kind"] === "reply"), false,
    "a gate result was sent after the app-server exited");
  assert.match(rawLog(dir), /"event":"approval\.withdrawn"/u);
  assert.doesNotMatch(rawLog(dir), /"event":"execution\.started"/u);
  assert.equal(existsSync(join(dir, `${LOG}.lock`)), false, "cooperative cancellation left an append lock");
  assertVerifies(dir);
});

test("SIGINT during a pending human wait cooperatively withdraws before the bridge exits", async () => {
  const dir = ready();
  const repliesPath = join(dir, "signal-replies.jsonl");
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    APPROVAL_STUB_SCRIPT: JSON.stringify([execRequest("curl -d a=b https://example.com", dir)]),
    APPROVAL_STUB_REPLIES: repliesPath,
    APPROVAL_STUB_STAY_OPEN: "1",
  };
  delete childEnv.APPROVAL_HUMAN;
  const child = spawn(process.execPath, [CLI_ENTRY, "codex", "bridge", "--prompt", "wait",
    "--dir", dir, "--wait", "30s", "--interval", "30s", "--json",
    "--", process.execPath, STUB], { cwd: dir, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  await waitForRequestKey(dir, 20_000);
  const stoppedAt = Date.now();
  child.kill("SIGINT");
  const result = await exited;
  assert.equal(result.signal, null, output);
  assert.notEqual(result.code, 0, output);
  assert.ok(Date.now() - stoppedAt < 5_000, `SIGINT did not wake the 30s poll:\n${output}`);
  assert.match(output, /interrupted by SIGINT/u);
  assert.equal(repliesOf(repliesPath).some((entry) => entry["kind"] === "reply"), false);
  assert.match(rawLog(dir), /"event":"approval\.withdrawn"/u);
  assert.equal(existsSync(join(dir, `${LOG}.lock`)), false);
  assertVerifies(dir);
});

test("a matching notification during a human wait does not restart the silence deadline", async () => {
  const dir = ready();
  const repliesPath = join(dir, "notification-replies.jsonl");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APPROVAL_STUB_SCRIPT: JSON.stringify([execRequest("curl -d a=b https://example.com", dir)]),
    APPROVAL_STUB_REPLIES: repliesPath,
    APPROVAL_STUB_STAY_OPEN: "1",
    APPROVAL_STUB_WHILE_WAITING: JSON.stringify([{ delayMs: 300, notify: "item/started", params: {
      threadId: "thread-1", turnId: "turn-1", item: { id: "unrelated-message", type: "agentMessage" },
    } }]),
  };
  delete env.APPROVAL_HUMAN;
  const child = spawn(process.execPath, [CLI_ENTRY, "codex", "bridge", "--prompt", "wait",
    "--dir", dir, "--wait", "30s", "--interval", "100ms", "--lifecycle-timeout", "200ms", "--json",
    "--", process.execPath, STUB], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  const exited = new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? -1)));
  const key = await waitForRequestKey(dir, 20_000);
  await delay(700);
  assert.equal(repliesOf(repliesPath).some((row) => row["kind"] === "reply"), false);
  assert.equal(child.exitCode, null, output);
  const grant = runCli(["grant", key, "--as", "human:alice"], dir);
  assert.equal(grant.code, 0, grant.stderr);
  assert.equal(await exited, 0, output);
  assert.deepEqual(repliesOf(repliesPath).find((row) => row["kind"] === "reply")?.["result"], { decision: "accept" });
  assertVerifies(dir);
});

test("a turn ending while its gate worker is active cancels the worker and sends no late answer", () => {
  const dir = ready();
  const { run, report, replies } = bridge(
    dir,
    [execRequest("curl -d a=b https://example.com", dir)],
    ["--interval", "30s"],
    { APPROVAL_STUB_END_WHILE_WAITING: "1", APPROVAL_STUB_STAY_OPEN: "1" },
  );
  assert.notEqual(run.code, 0, run.stdout + run.stderr);
  assert.equal(report.code, "bridge-turn-failed");
  assert.equal(replies.some((entry) => entry["kind"] === "reply"), false);
  assert.doesNotMatch(rawLog(dir), /"event":"execution\.(completed|failed|indeterminate)"/u);
  assert.equal(existsSync(join(dir, `${LOG}.lock`)), false);
  assertVerifies(dir);
});

test("an autonomous class appends its execution record and answers without asking", () => {
  const dir = ready();
  const before = rawLog(dir);
  const { report } = bridge(dir, [execRequest("cat README.md", dir)]);

  assert.equal((report.answers[0] as BridgeAnswerRow).outcome, "accept");
  const grown = rawLog(dir).slice(before.length);
  // An autonomous action has no approval lifecycle; what it has is the charge.
  assert.doesNotMatch(grown, /"event":"approval\.requested"/u);
  assert.match(grown, /"event":"execution\.started"/u);
  assertVerifies(dir);
});

// ---------------------------------------------------------------------------
// AC3 — human-only and unbound requests are declined at once, with the code
// ---------------------------------------------------------------------------

test("a human-only class is declined at once, with the gate's own code, and nothing is appended", () => {
  const dir = ready();
  const before = rawLog(dir);
  // Writing into the log directory classifies `log.mutate`, which this policy
  // reserves to human hands.
  const { report } = bridge(dir, [
    execRequest(`echo x > ${join(dir, ".approval", "log", "events.jsonl")}`, dir),
  ]);

  const answer = report.answers[0] as BridgeAnswerRow;
  assert.equal(answer.outcome, "decline");
  assert.equal(answer.code, "hook-class-human-only", answer.detail);
  // No request was opened: there is no decision anybody could make.
  assert.equal(rawLog(dir), before, "a human-only refusal appended something");
});

test("an exec request missing cwd or command is declined bridge-request-unbound", () => {
  const dir = ready();
  const before = rawLog(dir);
  const { report } = bridge(dir, [
    {
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", command: "cat README.md" },
    },
  ]);

  const answer = report.answers[0] as BridgeAnswerRow;
  assert.equal(answer.outcome, "decline");
  assert.equal(answer.code, "bridge-request-unbound");
  assert.match(answer.detail, /cwd/u);
  assert.equal(rawLog(dir), before, "an unbound request appended something");
});

test("a file-change request is declined bridge-file-change-unbound: no content, no approval", () => {
  const dir = ready();
  const before = rawLog(dir);
  const { report } = bridge(dir, [itemFileChangeRequest("item-2")]);

  const answer = report.answers[0] as BridgeAnswerRow;
  assert.equal(answer.outcome, "decline");
  assert.equal(answer.code, "bridge-file-change-unbound");
  // No `item/started` for that id ever reached this client, so the request is
  // an identifier and nothing else. This is the refusal the verb has answered
  // since APRV-361, and APRV-379 left it exactly here for that case.
  assert.match(answer.detail, /no item\/started for it reached this client/u);
  assert.equal(rawLog(dir), before);
});

// ---------------------------------------------------------------------------
// APRV-363 — the legacy request carries its change inline, so it can be bound
// ---------------------------------------------------------------------------

/** The legacy `applyPatchApproval`, whose `fileChanges` ride on the request. */
function legacyPatchRequest(
  changes: Record<string, unknown>,
  cwd: string | null,
  key = "grantRoot",
): ScriptEntry {
  return {
    method: "applyPatchApproval",
    params: {
      conversationId: "thread-1",
      turnId: "turn-1",
      callId: "call-7",
      fileChanges: changes,
      reason: null,
      ...(cwd === null ? {} : { [key]: cwd }),
      availableDecisions: ["approved", "denied"],
    },
  };
}

test("APRV-363: a legacy patch approval is classified by its paths and binds the content it arrived with", () => {
  // SPEC.md is protected in this policy and `policy.edit` is manual, so the
  // change is REGISTERED and waits, which is what makes the bound payload
  // readable. Nobody grants it, so the wait runs out and the answer is no.
  const dir = ready(
    POLICY.replace("classes:", "protected_paths:\n  - SPEC.md\nclasses:\n  policy.edit:\n    autonomy: manual"),
  );
  const before = rawLog(dir);
  const changes = {
    "SPEC.md": { update: { unified_diff: "@@ -1 +1 @@\n-one\n+two\n" } },
  };
  const { report } = bridge(dir, [legacyPatchRequest(changes, dir)]);

  const answer = report.answers[0] as BridgeAnswerRow;
  assert.equal(answer.outcome, "decline");
  assert.equal(answer.code, "hook-timeout", answer.detail);
  // Nothing was re-rendered: the class comes from the PATH the server named.
  const grown = rawLog(dir).slice(before.length);
  assert.match(grown, /"event":"approval\.requested"/u);
  assert.match(grown, /"class":"policy\.edit"/u);
  assert.match(grown, /"execution":"harness"/u);

  // AC1: the bound material names the paths and carries the digest of the
  // change AS RECEIVED, so a grant binds the bytes the server sent.
  const stored = readdirSync(join(dir, ".approval", "payloads"))
    .map((entry) => readFileSync(join(dir, ".approval", "payloads", entry), "utf8"))
    .join("\n");
  assert.match(stored, /"paths":\["SPEC\.md"\]/u);
  assert.match(stored, /"content_sha256":"[0-9a-f]{64}"/u);
  assert.match(stored, /unified_diff/u);
  assertVerifies(dir);
});

test("APRV-363: a legacy patch approval with an ordinary path is answered without a human", () => {
  const dir = ready();
  const before = rawLog(dir);
  const { report } = bridge(dir, [
    legacyPatchRequest({ "notes.md": { add: { content: "hello\n" } } }, dir, "cwd"),
  ]);

  const answer = report.answers[0] as BridgeAnswerRow;
  assert.equal(answer.outcome, "accept", answer.detail);
  // `files.write.workspace` is autonomous here, so there is no approval
  // lifecycle and the word came off the legacy vocabulary the request offered.
  assert.equal(answer.decision, "approved");
  const grown = rawLog(dir).slice(before.length);
  assert.doesNotMatch(grown, /"event":"approval\.requested"/u);
  assertVerifies(dir);
});

test("APRV-363: a change naming a path outside the directory the server gave is refused", () => {
  const dir = ready();
  const before = rawLog(dir);
  const { report } = bridge(dir, [
    legacyPatchRequest({ "../escape.md": { add: { content: "x\n" } } }, dir),
  ]);

  const answer = report.answers[0] as BridgeAnswerRow;
  assert.equal(answer.outcome, "decline");
  assert.equal(answer.code, "hook-io", answer.detail);
  assert.match(answer.detail, /resolves outside/u);
  assert.equal(rawLog(dir), before, "a refused change appended something");
});

test("APRV-363: a legacy patch approval with no directory is declined bridge-request-unbound", () => {
  const dir = ready();
  const before = rawLog(dir);
  const { report } = bridge(dir, [
    legacyPatchRequest({ "notes.md": { add: { content: "x\n" } } }, null),
  ]);

  const answer = report.answers[0] as BridgeAnswerRow;
  assert.equal(answer.outcome, "decline");
  assert.equal(answer.code, "bridge-request-unbound", answer.detail);
  assert.match(answer.detail, /cwd or grantRoot/u);
  assert.equal(rawLog(dir), before);
});

// ---------------------------------------------------------------------------
// APRV-379 — the item-based request names an item, and the content arrived on
// that item's own `item/started` frame
// ---------------------------------------------------------------------------

/**
 * The `item/started` frame the 2026-09-19 probe recorded, in its observed
 * shape.
 *
 * `changes` is an ARRAY of `{path, kind: {type}, diff}` and the path is
 * ABSOLUTE, which is what the capture in `docs/codex-app-server-bridge.md`
 * shows. Nothing here is a convenient simplification of it: a fixture in a
 * shape the server does not send is a suite agreeing with itself, which is the
 * APRV-380 lesson.
 */
function itemStarted(
  itemId: string,
  changes: unknown[],
  overrides: Record<string, unknown> = {},
): ScriptEntry {
  return {
    notify: "item/started",
    params: {
      item: { type: "fileChange", id: itemId, changes, status: "inProgress" },
      threadId: "thread-1",
      turnId: "turn-1",
      startedAtMs: 1789848549897,
      ...overrides,
    },
  };
}

/** The same item, completed, as the probe saw it repeated back. */
function itemCompleted(itemId: string, changes: unknown[]): ScriptEntry {
  return {
    notify: "item/completed",
    params: {
      item: { type: "fileChange", id: itemId, changes, status: "completed" },
      threadId: "thread-1",
      turnId: "turn-1",
      startedAtMs: 1789848549897,
      completedAtMs: 1789848549947,
    },
  };
}

/** One `add`, the only change kind the probe observed. */
function addChange(path: string, diff = "patched\n"): Record<string, unknown> {
  return { path, kind: { type: "add" }, diff };
}

/**
 * The item-based approval request, carrying exactly what the probe recorded:
 * an item id, a thread, a turn, a start time, a null reason and a null
 * `grantRoot`. No content, no `cwd`, no advertised decisions.
 */
function itemFileChangeRequest(
  itemId: string,
  overrides: Record<string, unknown> = {},
): ScriptEntry {
  return {
    method: "item/fileChange/requestApproval",
    params: {
      grantRoot: null,
      itemId,
      reason: null,
      startedAtMs: 1789848549897,
      threadId: "thread-1",
      turnId: "turn-1",
      ...overrides,
    },
  };
}

test("APRV-379: the change from item/started is what the request is decided against", () => {
  const dir = ready();
  const before = rawLog(dir);
  const target = join(dir, "probe-patch-marker.txt");
  // The observed order: the content, then the question about it, then the
  // completion once this client has answered.
  const { run, report } = bridge(dir, [
    itemStarted("exec-57f5bb5e", [addChange(target)]),
    itemFileChangeRequest("exec-57f5bb5e"),
    itemCompleted("exec-57f5bb5e", [addChange(target)]),
  ]);

  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  const answer = report.answers[0] as BridgeAnswerRow;
  // `files.write.workspace` is autonomous in this policy, so the change is
  // classified, charged and accepted without a human. Before APRV-379 this same
  // script answered `bridge-file-change-unbound`.
  assert.equal(answer.outcome, "accept", answer.detail);
  assert.equal(answer.code, null);
  const grown = rawLog(dir).slice(before.length);
  assert.doesNotMatch(grown, /"event":"approval\.requested"/u);
  assert.match(grown, /"event":"execution\.started"/u);
  assertVerifies(dir);
});

test("APRV-379: the payload binds the paths and the digest of the change as it arrived", () => {
  // SPEC.md is protected here and `policy.edit` is manual, so the change is
  // REGISTERED and waits, which is what makes the bound payload readable.
  // Nobody grants it, so the wait runs out and the answer is no.
  const dir = ready(
    POLICY.replace("classes:", "protected_paths:\n  - SPEC.md\nclasses:\n  policy.edit:\n    autonomy: manual"),
  );
  const before = rawLog(dir);
  const target = join(dir, "SPEC.md");
  const { report } = bridge(dir, [
    itemStarted("exec-aa", [addChange(target, "@@ -1 +1 @@\n-one\n+two\n")]),
    itemFileChangeRequest("exec-aa"),
  ]);

  const answer = report.answers[0] as BridgeAnswerRow;
  assert.equal(answer.outcome, "decline");
  assert.equal(answer.code, "hook-timeout", answer.detail);
  // The class came from the PATH the server named, through the same
  // protected-path rule every other file tool uses.
  const grown = rawLog(dir).slice(before.length);
  assert.match(grown, /"event":"approval\.requested"/u);
  assert.match(grown, /"class":"policy\.edit"/u);

  // AC2: the bound material names the path and carries the digest of the
  // change AS RECEIVED, and the change itself is in the shape the server sent
  // it — an array of entries, not a map this runtime rewrote it into.
  const stored = storedPayloads(dir);
  assert.match(stored, /"content_sha256":"[0-9a-f]{64}"/u);
  assert.match(stored, /"changes":\[\{/u);
  assert.match(stored, /"kind":\{"type":"add"\}/u);
  assert.match(stored, /-one\\n\+two/u);
  assert.ok(stored.includes(target), stored);
  assertVerifies(dir);
});

test("APRV-379: a change landing outside the directory the client named is refused", () => {
  const dir = ready();
  const before = rawLog(dir);
  const { report } = bridge(dir, [
    // An absolute path, and a real one, that is simply not in this thread's
    // workspace. The containment check is what decides, and it decides no.
    itemStarted("exec-bb", [addChange(join(scratch, "escape.md"))]),
    itemFileChangeRequest("exec-bb"),
  ]);

  const answer = report.answers[0] as BridgeAnswerRow;
  assert.equal(answer.outcome, "decline");
  assert.equal(answer.code, "hook-io", answer.detail);
  assert.match(answer.detail, /resolves outside/u);
  assert.equal(rawLog(dir), before, "a refused change appended something");
});

test("APRV-379: an item id that names something other than a fileChange is unbound", () => {
  const dir = ready();
  const before = rawLog(dir);
  const { report } = bridge(dir, [
    // `userMessage` was one of the other item types the probe saw on the wire.
    {
      notify: "item/started",
      params: {
        item: { type: "userMessage", id: "exec-cc", text: "do the thing" },
        threadId: "thread-1",
        turnId: "turn-1",
      },
    },
    itemFileChangeRequest("exec-cc"),
  ]);

  const answer = report.answers[0] as BridgeAnswerRow;
  assert.equal(answer.outcome, "decline");
  assert.equal(answer.code, "bridge-file-change-unbound", answer.detail);
  assert.match(answer.detail, /recorded as "userMessage"/u);
  assert.equal(rawLog(dir), before);
});

test("APRV-379: a fileChange item carrying no change set is unbound", () => {
  const dir = ready();
  const before = rawLog(dir);
  const { report } = bridge(dir, [
    itemStarted("exec-dd", []),
    itemFileChangeRequest("exec-dd"),
  ]);

  const answer = report.answers[0] as BridgeAnswerRow;
  assert.equal(answer.outcome, "decline");
  assert.equal(answer.code, "bridge-file-change-unbound", answer.detail);
  assert.match(answer.detail, /carried no change set/u);
  assert.equal(rawLog(dir), before);
});

test("APRV-379: a request naming another thread than the frame is unbound", () => {
  const dir = ready();
  const before = rawLog(dir);
  const { report } = bridge(dir, [
    itemStarted("exec-ee", [addChange(join(dir, "notes.md"))]),
    itemFileChangeRequest("exec-ee", { threadId: "thread-other" }),
  ]);

  const answer = report.answers[0] as BridgeAnswerRow;
  assert.equal(answer.outcome, "decline");
  assert.equal(answer.code, "bridge-request-mismatch", answer.detail);
  assert.match(answer.detail, /active thread and turn/u);
  assert.equal(rawLog(dir), before);
});

test("APRV-379: a request naming another turn than the frame is unbound", () => {
  const dir = ready();
  const before = rawLog(dir);
  const { report } = bridge(dir, [
    itemStarted("exec-ff", [addChange(join(dir, "notes.md"))]),
    itemFileChangeRequest("exec-ff", { turnId: "turn-other" }),
  ]);

  const answer = report.answers[0] as BridgeAnswerRow;
  assert.equal(answer.outcome, "decline");
  assert.equal(answer.code, "bridge-request-mismatch", answer.detail);
  assert.match(answer.detail, /active thread and turn/u);
  assert.equal(rawLog(dir), before);
});

test("APRV-379: an item that completed BEFORE the question gets its own code", () => {
  const dir = ready();
  const before = rawLog(dir);
  const target = join(dir, "notes.md");
  const { report } = bridge(dir, [
    // The timestamp-order case: the change finished, and only then was this
    // client asked about it. The content correlates perfectly, and that is
    // exactly why this is not `bridge-file-change-unbound`.
    itemStarted("exec-gg", [addChange(target)]),
    itemCompleted("exec-gg", [addChange(target)]),
    itemFileChangeRequest("exec-gg"),
  ]);

  const answer = report.answers[0] as BridgeAnswerRow;
  assert.equal(answer.outcome, "decline");
  assert.equal(answer.code, "bridge-file-change-already-completed", answer.detail);
  assert.match(answer.detail, /arrived BEFORE the approval request/u);
  // Nothing was registered: an effect that already happened is not an action to
  // open a request about.
  assert.equal(rawLog(dir), before);
});

test("APRV-379: the completion frame does not overwrite the content the question was asked about", () => {
  const dir = ready();
  const target = join(dir, "notes.md");
  const { report } = bridge(dir, [
    itemStarted("exec-hh", [addChange(target, "first\n")]),
    itemFileChangeRequest("exec-hh"),
    // A completion naming a DIFFERENT change set, after the answer. The
    // decision above was made against the frame this client was holding when
    // the question arrived, and this frame cannot reach back and change it.
    itemCompleted("exec-hh", [addChange(target, "second\n")]),
  ]);

  const answer = report.answers[0] as BridgeAnswerRow;
  assert.equal(answer.outcome, "accept", answer.detail);
  const stored = storedPayloads(dir);
  if (stored.length > 0) assert.doesNotMatch(stored, /second/u);
  assertVerifies(dir);
});

test("a server request with no reading is declined bridge-unknown-request", () => {
  const dir = ready();
  const { report } = bridge(dir, [{ method: "item/somethingNew/requestApproval", params: {} }]);

  const answer = report.answers[0] as BridgeAnswerRow;
  assert.equal(answer.outcome, "decline");
  assert.equal(answer.code, "bridge-unknown-request");
});

// ---------------------------------------------------------------------------
// APRV-362 — the payload names the words, not only their rendering
// ---------------------------------------------------------------------------

/** Everything the payload store holds for this case, as one string. */
function storedPayloads(dir: string): string {
  const store = join(dir, ".approval", "payloads");
  return existsSync(store)
    ? readdirSync(store)
        .map((entry) => readFileSync(join(store, entry), "utf8"))
        .join("\n")
    : "";
}

// ---------------------------------------------------------------------------
// APRV-380: the shape a real Codex session actually sends
// ---------------------------------------------------------------------------

test("APRV-380: a login-shell exec is decided, and the payload still binds the outer argv", () => {
  const dir = ready();
  // The shape the 2026-09-18 probe recorded on EVERY exec request: a login
  // shell with the whole model command as one quoted argument. Until APRV-380
  // the bridge declined every one of these `hook-opaque`, and this suite passed
  // only because its fixtures used bare commands — a suite agreeing with
  // itself about traffic that does not exist.
  const { run, report } = bridge(dir, [
    execRequest("/bin/zsh -lc 'curl -d a=b https://example.com'", dir),
  ]);

  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  const answer = report.answers[0] as BridgeAnswerRow;
  // `network.call` is manual in this policy and nobody grants it, so the wait
  // runs out. What matters is that it was CLASSIFIED: the old answer was
  // `hook-opaque` before any policy was consulted.
  assert.equal(answer.code, "hook-timeout", answer.detail);

  // AC3: the payload binds the OUTER argv and command, exactly as APRV-362
  // built them. The inner script is what was classified and never what is bound.
  const stored = storedPayloads(dir);
  assert.match(stored, /"command":"\/bin\/zsh -lc 'curl -d a=b https:\/\/example\.com'"/u);
  assert.match(stored, /"argv":\["\/bin\/zsh","-lc","curl -d a=b https:\/\/example\.com"\]/u);
  assert.match(rawLog(dir), /"class":"network\.call"/u);
  assertVerifies(dir);
});

test("APRV-380: a login-shell exec outside the narrow shape is still declined opaque", () => {
  const dir = ready();
  const before = rawLog(dir);
  const { report } = bridge(dir, [
    // A shell nested inside the script: one level of unwrap, by construction.
    execRequest("/bin/zsh -lc 'bash -lc \"curl -d a=b https://example.com\"'", dir),
  ]);

  const answer = report.answers[0] as BridgeAnswerRow;
  assert.equal(answer.outcome, "decline");
  assert.equal(answer.code, "hook-opaque", answer.detail);
  assert.equal(rawLog(dir), before, "an opaque command appended something");
});

test("APRV-362: the registered payload carries the received string and the argv beside it", () => {
  const dir = ready();
  // `network.call` is manual in this policy, so the action is REGISTERED and
  // waits, which is what makes the bound payload readable. Nobody grants it.
  const { report } = bridge(dir, [
    execRequest("curl -d 'a=b c' https://example.com", dir),
  ]);

  const answer = report.answers[0] as BridgeAnswerRow;
  assert.equal(answer.outcome, "decline");
  assert.equal(answer.code, "hook-timeout", answer.detail);

  // AC1: both accounts of the call are in the bound material. The string is the
  // bytes that arrived; the argv is the words the kernel will receive, and the
  // quoted third word is one word rather than three.
  const stored = storedPayloads(dir);
  assert.match(stored, /"command":"curl -d 'a=b c' https:\/\/example\.com"/u);
  assert.match(stored, /"argv":\["curl","-d","a=b c","https:\/\/example\.com"\]/u);
  assertVerifies(dir);
});

test("APRV-362: a legacy argv array is rendered word by word, never concatenated", () => {
  const dir = ready();
  const { report } = bridge(dir, [
    {
      method: "execCommandApproval",
      params: {
        conversationId: "thread-1",
        turnId: "turn-1",
        callId: "call-9",
        command: ["curl", "-d", "a=b c", "https://example.com"],
        cwd: dir,
        reason: null,
      },
    },
  ]);

  assert.equal((report.answers[0] as BridgeAnswerRow).code, "hook-timeout");
  // The old join produced `curl -d a=b c https://example.com`, which is one
  // more word than the kernel will ever see. The rendering keeps the argv's
  // shape, and the argv itself is bound beside it.
  const stored = storedPayloads(dir);
  assert.match(stored, /"command":"curl -d 'a=b c' https:\/\/example\.com"/u);
  assert.match(stored, /"argv":\["curl","-d","a=b c","https:\/\/example\.com"\]/u);
  assertVerifies(dir);
});

test("APRV-362: a command string that is not the rendering of an argv is declined", () => {
  const dir = ready();
  const before = rawLog(dir);
  // A join emits bare words and single-quoted ones, never a double quote, so
  // this string did not come from joining the words that will run.
  const { report } = bridge(dir, [execRequest('echo "hello world"', dir)]);

  const answer = report.answers[0] as BridgeAnswerRow;
  assert.equal(answer.outcome, "decline");
  assert.equal(answer.code, "bridge-command-unbound", answer.detail);
  assert.match(answer.detail, /double quote/u);
  assert.equal(rawLog(dir), before, "an unbindable command appended something");
});

test("APRV-362: an unreadable command string is declined, and nothing is classified", () => {
  const dir = ready();
  const before = rawLog(dir);
  const { report } = bridge(dir, [
    execRequest("echo 'oops", dir),
    execRequest("echo one  two", dir),
  ]);

  const quoted = report.answers[0] as BridgeAnswerRow;
  const spaced = report.answers[1] as BridgeAnswerRow;
  assert.equal(quoted.code, "bridge-command-unbound", quoted.detail);
  assert.match(quoted.detail, /never closed/u);
  // Separation a join does not produce: the argv is readable, and that the
  // string came from a join is not, so it is refused rather than guessed at.
  assert.equal(spaced.code, "bridge-command-unbound", spaced.detail);
  assert.match(spaced.detail, /one space each/u);
  assert.equal(rawLog(dir), before);
});

test("APRV-362: a request carrying only whitespace is still the missing-field refusal", () => {
  const dir = ready();
  // A `command` that names no words at all is an absent command, and the code
  // that says a field is missing is the one that fits.
  const { report } = bridge(dir, [execRequest("   ", dir)]);

  const answer = report.answers[0] as BridgeAnswerRow;
  assert.equal(answer.code, "bridge-request-unbound", answer.detail);
  assert.match(answer.detail, /command/u);
});

// ---------------------------------------------------------------------------
// The thread is started under the one policy that asks about everything
// ---------------------------------------------------------------------------

test("thread/start pins approvalPolicy untrusted and a read-only sandbox", () => {
  const dir = ready();
  const { replies } = bridge(dir, [execRequest("cat README.md", dir)]);
  const started = replies.find((entry) => entry["kind"] === "thread/start");
  assert.ok(started !== undefined, `thread/start was never sent: ${JSON.stringify(replies)}`);
  const params = started["params"] as Record<string, unknown>;
  // `unless-trusted` is the source name and the server refuses it; `untrusted`
  // is the wire name, established by the 2026-09-18 probe.
  assert.equal(params["approvalPolicy"], "untrusted");
  assert.equal(params["sandbox"], "read-only");
  assert.equal(params["cwd"], dir);
});

test("APRV-366: the accepted thread params are recorded, and an unechoed pin says so", () => {
  const dir = ready();
  const { run, report } = bridge(dir, [execRequest("cat README.md", dir)]);

  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  // AC1: what went on the wire is in the report, beside the thread it made.
  assert.equal(report.thread.id, "thread-1");
  assert.equal(report.thread.cwd, dir);
  assert.deepEqual(report.thread.requested, {
    approvalPolicy: "untrusted",
    sandbox: "read-only",
  });
  // The stub echoes no policy, as the observed 0.155.0 server echoes none. That
  // is NOT a stop: a client that demanded an echo could not run against the
  // server this verb exists for. What it is, is a claim the report keeps
  // narrow. Since APRV-364 the narrow claim has a second and stronger source:
  // the probe was ASKED about, so the pin is confirmed by observation while the
  // server itself still reported nothing.
  assert.equal(report.thread.effective.approvalPolicy, null);
  assert.equal(report.thread.confirmed, "observed");
  assert.equal(report.answers.length, 1);
});

test("APRV-366: a server that echoes the pin back reports the echo, and APRV-364 outranks it", () => {
  const dir = ready();
  const { run, report } = bridge(dir, [execRequest("cat README.md", dir)], [], {
    APPROVAL_STUB_THREAD_RESULT: JSON.stringify({ approvalPolicy: "untrusted" }),
  });

  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  // The echo is still recorded, exactly as APRV-366 recorded it.
  assert.equal(report.thread.effective.approvalPolicy, "untrusted");
  // And the SOURCE is the observation, because a thing that happened outranks a
  // thing the server said about itself. `reported` is what this field would say
  // had the probe not been asked about; the void case below shows it.
  assert.equal(report.thread.confirmed, "observed");
  assert.equal(report.answers.length, 1);
});

test("APRV-366: a refused thread/start stops the bridge, answers nothing, and appends nothing", () => {
  const dir = ready();
  // The error the real server gave the 2026-09-18 probe for a variant it does
  // not know, which is how a refusal of the VALUE arrives.
  const { run, report } = bridge(dir, [execRequest("cat README.md", dir)], [], {
    APPROVAL_STUB_THREAD_ERROR: JSON.stringify({
      code: -32602,
      message:
        "unknown variant `unless-trusted`, expected one of `untrusted`, `on-request`, `granular`, `never`",
    }),
  });

  // AC2: a distinct code, and the server's own words carried through.
  assert.notEqual(run.code, 0);
  assert.equal(report.ok, false);
  assert.equal(report.code, "bridge-thread-start-refused");
  assert.match(report.reason, /unknown variant/u);
  assert.equal(report.answers.length, 0);
  assert.equal(report.thread.id, null);
  assert.equal(report.thread.confirmed, "unconfirmed");
  // Nothing was asked of the gate, because no question was ever reached.
  assert.equal(rawLog(dir).includes("approval.requested"), false);
});

test("APRV-366: a thread reporting another effective policy stops the bridge", () => {
  const dir = ready();
  const { run, report } = bridge(dir, [execRequest("cat README.md", dir)], [], {
    APPROVAL_STUB_THREAD_RESULT: JSON.stringify({ approvalPolicy: "on-request" }),
  });

  assert.notEqual(run.code, 0);
  assert.equal(report.code, "bridge-approval-policy-mismatch");
  assert.equal(report.thread.effective.approvalPolicy, "on-request");
  assert.equal(report.thread.confirmed, "unconfirmed");
  assert.equal(report.answers.length, 0);
  // Why it stops rather than gating what it can see: under `on-request` an
  // unknown part of the session never produces a question, so a run that
  // answered everything it was asked would prove nothing about the session.
  assert.match(report.reason, /on-request/u);
  assert.equal(rawLog(dir).includes("approval.requested"), false);
});

test("APRV-366: the same mismatch reported on a thread notification stops it too", () => {
  const dir = ready();
  const { run, report } = bridge(dir, [execRequest("cat README.md", dir)], [], {
    APPROVAL_STUB_THREAD_STARTED: JSON.stringify({
      thread: { id: "thread-1", approvalPolicy: "never" },
    }),
  });

  assert.notEqual(run.code, 0);
  assert.equal(report.code, "bridge-approval-policy-mismatch");
  assert.equal(report.thread.effective.approvalPolicy, "never");
  assert.equal(report.answers.length, 0);
});

test("APRV-366: the stop codes are their own closed vocabulary, disjoint from the declines", () => {
  assert.deepEqual([...BRIDGE_STOP_CODES].sort(), [
    "bridge-approval-policy-mismatch",
    "bridge-auto-reviewer-active",
    "bridge-preflight-void",
    "bridge-server-exited",
    "bridge-server-silent",
    "bridge-thread-start-refused",
    "bridge-turn-failed",
  ]);
  assert.equal(new Set(BRIDGE_STOP_CODES).size, BRIDGE_STOP_CODES.length);
  // Disjoint on purpose: a decline is an answer to one approval request and the
  // turn carries on, a stop ends the session. The conformance union
  // `bridge_refusal_codes` is documented as the first of those.
  for (const code of BRIDGE_STOP_CODES) {
    assert.equal((BRIDGE_REFUSAL_CODES as readonly string[]).includes(code), false, code);
  }
});

// ---------------------------------------------------------------------------
// APRV-364 — the preflight probe, and the auto-reviewer
// ---------------------------------------------------------------------------

test("APRV-364: the probe turn runs first, is asked about, and is declined without the gate", () => {
  const dir = ready();
  // The real turn asks about a MANUAL class, so its own registration reaches
  // the payload store and the probe's absence from it is a fact about the
  // probe rather than about an empty store. Nobody grants it; the wait runs out.
  const { run, report, replies } = bridge(dir, [
    execRequest("curl -d a=b https://example.com", dir),
  ]);

  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  // AC1: a question about one command reached this client, and that is what the
  // report claims — no more.
  assert.equal(report.preflight.outcome, "asked");
  assert.equal(report.preflight.command, "true");
  assert.equal(report.preflight.turnId, "turn-preflight");
  assert.equal(report.thread.confirmed, "observed");
  // The frames ride only on a void stop; this run established its fact.
  assert.equal(report.preflight.frames, undefined);

  // The probe was DECLINED on the wire. A probe this client approved would be a
  // probe that ran, and the point of it is the question rather than the effect.
  const probe = replies.find((entry) => entry["kind"] === "preflight-reply");
  assert.ok(probe !== undefined, `the probe was never answered: ${JSON.stringify(replies)}`);
  assert.deepEqual(probe["result"], { decision: "decline" });
  assert.equal(report.preflight.decision, "decline");

  // It never reached the gate: nothing about `true` was registered, requested
  // or bound, so no human could have been asked about the probe. The real
  // turn's command IS bound, which is what makes the absence a fact about the
  // probe rather than about an empty store.
  const stored = storedPayloads(dir);
  assert.equal(stored.includes('"command":"true"'), false);
  assert.match(stored, /"command":"curl -d a=b https:\/\/example\.com"/u);
  assert.equal(rawLog(dir).includes('"command":"true"'), false);

  // And the real turn ran after it, decided exactly as it was before APRV-364.
  assert.equal(report.answers.length, 1);
  assert.equal((report.answers[0] as BridgeAnswerRow).code, "hook-timeout");
  assertVerifies(dir);
});

test("APRV-364: the probe turn is the FIRST turn, and the operator's prompt is the second", () => {
  const dir = ready();
  const { replies } = bridge(dir, [execRequest("cat README.md", dir)]);
  const starts = replies.filter((entry) => entry["kind"] === "turn/start");
  assert.equal(starts.length, 2);
  assert.equal(starts[0]?.["turn"], "preflight");
  assert.equal(starts[1]?.["turn"], "live");
  // The probe's prompt names the one command and forbids the rest, so a void
  // outcome is rare; it names the operator's prompt nowhere.
  const probePrompt = JSON.stringify((starts[0] as Record<string, unknown>)["params"]);
  assert.match(probePrompt, /Run exactly one shell command: true/u);
  assert.equal(probePrompt.includes("do the thing"), false);
  assert.match(JSON.stringify((starts[1] as Record<string, unknown>)["params"]), /do the thing/u);
});

test("APRV-364: a probe that RAN without asking stops the bridge under the policy mismatch", () => {
  const dir = ready();
  const { run, report } = bridge(dir, [execRequest("cat README.md", dir)], [], {
    APPROVAL_STUB_PREFLIGHT: "executed",
  });

  assert.notEqual(run.code, 0);
  assert.equal(report.ok, false);
  assert.equal(report.code, "bridge-approval-policy-mismatch");
  assert.equal(report.preflight.outcome, "executed");
  assert.equal(report.thread.confirmed, "unconfirmed");
  // The real turn never started, so nothing was answered and nothing was asked
  // of the gate: a session that did not ask about one command is not a session
  // this verb will sit in front of.
  assert.equal(report.answers.length, 0);
  assert.equal(rawLog(dir).includes("approval.requested"), false);
  assert.match(report.reason, /ran and no approval request/u);
});

test("APRV-364: a probe turn that ran NO command is void, carries its frames, and is not a pass", () => {
  const dir = ready();
  const { run, report } = bridge(dir, [execRequest("cat README.md", dir)], [], {
    APPROVAL_STUB_PREFLIGHT: "void",
    // The server echoes the pin, so this case also shows the `reported` source
    // the observation would otherwise outrank.
    APPROVAL_STUB_THREAD_RESULT: JSON.stringify({ approvalPolicy: "untrusted" }),
  });

  assert.notEqual(run.code, 0);
  assert.equal(report.code, "bridge-preflight-void");
  assert.equal(report.preflight.outcome, "void");
  // An echo is not an observation, and the report says which it had.
  assert.equal(report.thread.effective.approvalPolicy, "untrusted");
  assert.equal(report.thread.confirmed, "reported");
  assert.equal(report.answers.length, 0);
  assert.equal(rawLog(dir).includes("approval.requested"), false);
  // The evidence for a fact that could not be established is the turn itself,
  // verbatim: this is also how the real item shape gets recorded here.
  assert.ok(Array.isArray(report.preflight.frames));
  assert.equal(
    JSON.stringify(report.preflight.frames).includes("agentMessage"),
    true,
    JSON.stringify(report.preflight.frames),
  );
  assert.match(report.reason, /run the verb again/u);
});

test("APRV-364: an autoApprovalReview notification stops the run under its own code", () => {
  const dir = ready();
  const { run, report } = bridge(dir, [execRequest("cat README.md", dir)], [], {
    APPROVAL_STUB_PREFLIGHT: "auto-review",
  });

  assert.notEqual(run.code, 0);
  assert.equal(report.code, "bridge-auto-reviewer-active");
  assert.equal(report.answers.length, 0);
  assert.equal(rawLog(dir).includes("approval.requested"), false);
  // The notification is carried verbatim in the report as well as in the log.
  assert.match(report.reason, /autoApprovalReview/u);
  assert.match(report.reason, /item-preflight/u);

  // APRV-378: exactly one record, appended through the real append path before
  // the stop, naming the source, the question in Codex's own terms and the
  // verdict the reviewer reached. A stop with nothing behind it is the shape of
  // claim this project is built against.
  const preempted = rawLog(dir)
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record["event"] === "audit.question_preempted");
  assert.equal(preempted.length, 1, rawLog(dir));
  const record = preempted[0] as Record<string, unknown>;
  assert.equal(record["actor"], "system:gate");
  const payload = record["payload"] as Record<string, unknown>;
  assert.equal(payload["source"], "codex-auto-reviewer");
  assert.equal(payload["verdict"], "accept");
  assert.deepEqual(payload["question"], {
    id: "item-preflight",
    method: "item/autoApprovalReview/completed",
    thread: "thread-1",
    turn: "turn-preflight",
  });
  assertVerifies(dir);
});

test("APRV-378: a session that sees no auto-reviewer appends no such record", () => {
  const dir = ready();
  const { run } = bridge(dir, [execRequest("cat README.md", dir)]);

  assert.equal(run.code, 0, "the healthy session should have run to the end");
  // The absence is the other half of the claim: this record means something
  // only if an ordinary session never writes one.
  assert.equal(rawLog(dir).includes("audit.question_preempted"), false);
  assertVerifies(dir);
});

test("APRV-364: the auto-review reader matches the recorded names, and only those", () => {
  assert.equal(isAutoReviewNotification("item/autoApprovalReview/started"), true);
  assert.equal(isAutoReviewNotification("item/autoApprovalReview/completed"), true);
  // Case-folded and matched on the substring: a reviewer notification this
  // runtime failed to recognise would be a session run with a reviewer in front
  // of the gate, and over-matching costs only a stop an operator can read.
  assert.equal(isAutoReviewNotification("item/AutoApprovalReview/completed"), true);
  assert.equal(isAutoReviewNotification("item/commandExecution/requestApproval"), false);
  assert.equal(isAutoReviewNotification("turn/completed"), false);
});

test("APRV-364: a command item is recognised by its type or its command, and nothing else is", () => {
  assert.equal(namesCommandExecution({ item: { type: "commandExecution" } }), true);
  assert.equal(namesCommandExecution({ item: { itemType: "command_execution" } }), true);
  assert.equal(namesCommandExecution({ item: { type: "agentMessage", command: "true" } }), true);
  assert.equal(namesCommandExecution({ item: { type: "agentMessage", text: "hi" } }), false);
  assert.equal(namesCommandExecution({ turnId: "turn-1" }), false);
  assert.equal(namesCommandExecution(null), false);
});

test("APRV-366: the effective policy is read from named places, never from a stray field", () => {
  assert.equal(effectiveApprovalPolicy({ approvalPolicy: "untrusted" }), "untrusted");
  assert.equal(effectiveApprovalPolicy({ thread: { approvalPolicy: "never" } }), "never");
  assert.equal(effectiveApprovalPolicy({ config: { approval_policy: "granular" } }), "granular");
  assert.equal(effectiveApprovalPolicy({ threadId: "thread-1" }), null);
  // A value this deep is some other structure's business. It can stop a
  // session, so it is read from places whose meaning is known and nowhere else.
  assert.equal(
    effectiveApprovalPolicy({ item: { detail: { settings: { approvalPolicy: "never" } } } }),
    null,
  );
});

// ---------------------------------------------------------------------------
// Unit cases for the vocabulary, driven without a server
// ---------------------------------------------------------------------------

test("advertisedDecisions finds the list wherever the request carries it", () => {
  assert.deepEqual(advertisedDecisions({ availableDecisions: ["accept", "decline"] }), [
    "accept",
    "decline",
  ]);
  assert.deepEqual(
    advertisedDecisions({ outer: { nested: { someDecisions: ["approved"] } } }),
    ["approved"],
  );
  assert.deepEqual(advertisedDecisions({ command: "ls" }), []);
});

test("chooseDecision never matches a prefix, so acceptWithAmendment is not an accept", () => {
  const offered = { availableDecisions: ["acceptWithExecpolicyAmendment", "acceptForSession"] };
  // Neither advertised word is one this runtime will send, so it falls back to
  // its own. A prefix match would have sent `acceptWithExecpolicyAmendment`,
  // which carries an amendment nobody approved.
  assert.deepEqual(chooseDecision(offered, "accept"), {
    decision: "accept",
    decisionSource: "fallback",
  });
});

test("APRV-367: cancel and abort are never sent as a denial", () => {
  // The decline side of the prefix rule, and the one that matters most: both
  // advertised words mean "stop the turn", which is a different act from "no to
  // this action", so neither is a word this client will send. It falls back.
  const offered = { availableDecisions: ["cancel", "abort"] };
  assert.deepEqual(chooseDecision(offered, "decline"), {
    decision: "decline",
    decisionSource: "fallback",
  });
});

test("APRV-367: the encoder produces the two words and nothing else", () => {
  // Every word this runtime names round-trips.
  for (const word of [...ACCEPT_WORDS, ...DECLINE_WORDS]) {
    assert.deepEqual(encodeDecision(word), { decision: word });
    assert.equal(isBridgeDecisionWord(word), true);
  }
  // And every word it does not name is refused rather than encoded. Each of
  // these is a value the TYPE already makes unconstructible, so this is the
  // half of the rule that survives a caller the types do not reach.
  for (const word of [
    "acceptForSession",
    "acceptWithExecpolicyAmendment",
    "cancel",
    "abort",
    "Accept",
    "",
  ]) {
    assert.equal(encodeDecision(word), null, word);
    assert.equal(isBridgeDecisionWord(word), false, word);
  }
  assert.equal(isBridgeDecisionWord(undefined), false);
  assert.equal(isBridgeDecisionWord({ decision: "accept" }), false);
});

test("APRV-367: what goes on the wire is this runtime's own spelling of the word", () => {
  const dir = ready();
  // The server advertises a capitalised spelling. It is offering the word, so
  // the match holds, and what is sent is the spelling whose type is the closed
  // vocabulary rather than the string the server happened to use.
  const { run, replies } = bridge(dir, [
    execRequest("cat README.md", dir, ["Accept", "Decline", "acceptForSession"]),
  ]);
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  const reply = replies.find((entry) => entry["kind"] === "reply");
  assert.ok(reply !== undefined, JSON.stringify(replies));
  assert.deepEqual(reply["result"], { decision: "accept" });
});

test("the refusal codes are a closed, distinct vocabulary", () => {
  assert.deepEqual([...BRIDGE_REFUSAL_CODES].sort(), [
    "bridge-command-unbound",
    "bridge-file-change-already-completed",
    "bridge-file-change-unbound",
    "bridge-request-mismatch",
    "bridge-request-unbound",
    "bridge-unknown-request",
  ]);
  assert.equal(new Set(BRIDGE_REFUSAL_CODES).size, BRIDGE_REFUSAL_CODES.length);
});

test("failed turn and child exit after an answer both report failure", () => {
  for (const end of ["failed", "exit"]) {
    const dir = ready();
    const { run, report } = bridge(dir, [execRequest("cat README.md", dir)], [], {
      APPROVAL_STUB_LIVE_END: end,
    });
    assert.notEqual(run.code, 0, end);
    assert.equal(report.ok, false);
    assert.equal(report.code, end === "failed" ? "bridge-turn-failed" : "bridge-server-exited");
    assert.equal(report.answers.length, 1);
    assertVerifies(dir);
  }
});

test("turn/completed carrying failed status cannot report success", () => {
  const dir = ready();
  const { run, report } = bridge(dir, [execRequest("cat README.md", dir)], [], {
    APPROVAL_STUB_COMPLETED_STATUS: "failed",
  });
  assert.notEqual(run.code, 0);
  assert.equal(report.ok, false);
  assert.equal(report.code, "bridge-turn-failed");
  assert.equal(report.answers[0]?.executionOutcome, "unknown");
  assertVerifies(dir);
});

test("stale and duplicate approval questions never enter the gate", () => {
  const dir = ready();
  const good = execRequest("cat README.md", dir);
  const stale = execRequest("cat stale.md", dir);
  if ("params" in stale) stale.params = { ...stale.params, turnId: "turn-preflight" };
  const { report } = bridge(dir, [good, good, stale]);
  assert.equal(report.answers[0]?.outcome, "accept");
  assert.equal(report.answers[1]?.code, "bridge-request-mismatch");
  assert.equal(report.answers[2]?.code, "bridge-request-mismatch");
  const starts = rawLog(dir).split("\n").filter((line) => line.includes('"event":"execution.started"'));
  assert.equal(starts.length, 1);
  assertVerifies(dir);
});

test("duplicate item starts cannot substitute file-change content", () => {
  const dir = ready();
  const target = join(dir, "notes.md");
  const { report } = bridge(dir, [
    itemStarted("duplicate-file", [addChange(target, "first\n")]),
    itemStarted("duplicate-file", [addChange(target, "second\n")]),
    itemFileChangeRequest("duplicate-file"),
  ]);
  assert.equal(report.answers[0]?.code, "bridge-file-change-unbound");
  assert.match(report.answers[0]?.detail ?? "", /started more than once/u);
  assertVerifies(dir);
});

test("conflicting thread aliases on item/started cannot supply file approval content", () => {
  const dir = ready();
  const target = join(dir, "conflicted-start.md");
  const { report, replies } = bridge(dir, [
    itemStarted("conflicted-file", [addChange(target)], { conversationId: "foreign-thread" }),
    itemFileChangeRequest("conflicted-file"),
  ]);
  assert.equal(report.answers.length, 1);
  assert.equal(report.answers[0]?.outcome, "decline");
  assert.equal(report.answers[0]?.code, "bridge-file-change-unbound");
  assert.deepEqual(replies.find((row) => row["kind"] === "reply")?.["result"], { decision: "decline" });
  assert.equal(logRecords(dir).some((row) => row["event"] === "execution.started"), false);
  assertVerifies(dir);
});

test("item update during a pending file approval cancels the stale worker verdict", async () => {
  const dir = ready(POLICY.replace("files.write.workspace:\n    autonomy: autonomous", "files.write.workspace:\n    autonomy: manual"));
  const itemId = "changing-file";
  const target = join(dir, "changing.md");
  const repliesPath = join(dir, "updated-item-replies.jsonl");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APPROVAL_STUB_SCRIPT: JSON.stringify([
      itemStarted(itemId, [addChange(target, "before\n")]),
      itemFileChangeRequest(itemId),
    ]),
    APPROVAL_STUB_REPLIES: repliesPath,
    APPROVAL_STUB_STAY_OPEN: "1",
    APPROVAL_STUB_WHILE_WAITING: JSON.stringify([{ delayMs: 300, notify: "item/updated", params: {
      threadId: "thread-1", turnId: "turn-1",
      item: { id: itemId, type: "fileChange", changes: [addChange(target, "after\n")], status: "inProgress" },
    } }]),
  };
  delete env.APPROVAL_HUMAN;
  const child = spawn(process.execPath, [CLI_ENTRY, "codex", "bridge", "--prompt", "edit",
    "--dir", dir, "--wait", "30s", "--interval", "30s", "--json",
    "--", process.execPath, STUB], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  const exited = new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? -1)));
  await waitForRequestKey(dir, 20_000);
  assert.notEqual(await exited, 0, output);
  assert.equal(repliesOf(repliesPath).some((row) => row["kind"] === "reply"), false);
  assert.doesNotMatch(rawLog(dir), /"event":"execution\.started"/u);
  assert.equal(existsSync(join(dir, `${LOG}.lock`)), false);
  assertVerifies(dir);
});

test("a missing thread on turn completion cannot end the owned turn successfully", () => {
  const dir = ready();
  const { run, report } = bridge(dir, [
    { notify: "turn/completed", params: { turnId: "turn-1", turn: { id: "turn-1", status: "completed" } } },
  ], ["--lifecycle-timeout", "100ms"], {
    APPROVAL_STUB_SILENCE_AFTER_SCRIPT: "1", APPROVAL_STUB_STAY_OPEN: "1",
  });
  assert.notEqual(run.code, 0, run.stdout + run.stderr);
  assert.equal(report.ok, false);
  assert.equal(report.turns[0]?.status, "interrupted");
  assertVerifies(dir);
});

test("conflicting thread aliases cannot complete the owned turn", () => {
  const dir = ready();
  const { run, report } = bridge(dir, [
    { notify: "turn/completed", params: { threadId: "thread-1", conversationId: "foreign-thread",
      turnId: "turn-1", turn: { id: "turn-1", status: "completed" } } },
  ], ["--lifecycle-timeout", "100ms"], {
    APPROVAL_STUB_SILENCE_AFTER_SCRIPT: "1", APPROVAL_STUB_STAY_OPEN: "1",
  });
  assert.notEqual(run.code, 0, run.stdout + run.stderr);
  assert.equal(report.ok, false);
  assert.notEqual(report.turns[0]?.status, "completed");
  assertVerifies(dir);
});

test("conflicting thread aliases on agent output never render that message", () => {
  const dir = ready();
  const script = [
    { notify: "item/completed", params: { threadId: "thread-1", conversationId: "foreign-thread",
      turnId: "turn-1", item: { id: "conflicted-message", type: "agentMessage",
        text: "forbidden conflicted message" } } },
    { notify: "item/completed", params: { threadId: "thread-1", turnId: "turn-1",
      item: { id: "owned-message", type: "agentMessage", text: "visible owned message" } } },
  ];
  const run = runCli(["codex", "bridge", "--prompt", "render", "--dir", dir,
    "--", process.execPath, STUB], dir, { APPROVAL_STUB_SCRIPT: JSON.stringify(script) });
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.doesNotMatch(run.stdout, /forbidden conflicted message/u);
  assert.match(run.stdout, /visible owned message/u);
  assertVerifies(dir);
});

for (const [name, params] of [
  ["nested turn id", { threadId: "thread-1", turnId: "turn-1",
    turn: { id: "foreign-turn", status: "completed" } }],
  ["turn_id alias", { threadId: "thread-1", turnId: "turn-1", turn_id: "foreign-turn",
    turn: { id: "turn-1", status: "completed" } }],
] as const) {
  test(`conflicting ${name} cannot complete the owned turn`, () => {
    const dir = ready();
    const { run, report } = bridge(dir, [
      { notify: "turn/completed", params },
    ], ["--lifecycle-timeout", "100ms"], {
      APPROVAL_STUB_SILENCE_AFTER_SCRIPT: "1", APPROVAL_STUB_STAY_OPEN: "1",
    });
    assert.notEqual(run.code, 0, run.stdout + run.stderr);
    assert.equal(report.ok, false);
    assert.notEqual(report.turns[0]?.status, "completed");
    assertVerifies(dir);
  });
}

test("conflicting approval request thread aliases are declined before gate intake", () => {
  const dir = ready();
  const request = execRequest("curl -d a=b https://example.com", dir);
  assert.ok("params" in request);
  request.params = { ...request.params, conversationId: "foreign-thread" };
  const { report, replies } = bridge(dir, [request]);
  assert.equal(report.answers.length, 1);
  assert.equal(report.answers[0]?.outcome, "decline");
  assert.equal(report.answers[0]?.code, "bridge-request-mismatch");
  assert.deepEqual(replies.find((row) => row["kind"] === "reply")?.["result"], { decision: "decline" });
  assert.equal(logRecords(dir).filter((row) => row["event"] === "approval.requested").length, 0);
  assertVerifies(dir);
});

for (const duplicate of ["initialize", "thread/start"]) {
  test(`duplicate ${duplicate} response cannot replay bridge startup`, () => {
    const dir = ready();
    const { run, replies } = bridge(dir, [execRequest("cat README.md", dir)], [], {
      APPROVAL_STUB_DUPLICATE_RESPONSE: duplicate,
    });
    assert.notEqual(run.code, 0, run.stdout + run.stderr);
    assert.equal(replies.filter((row) => row["kind"] === "thread/start").length, 1);
    assert.equal(replies.filter((row) => row["turn"] === "preflight").length, duplicate === "initialize" ? 0 : 1);
    assert.equal(replies.filter((row) => row["turn"] === "live").length, 0);
    assertVerifies(dir);
  });
}

test("malformed app-server stdout fails closed", () => {
  const dir = ready();
  const { run, report } = bridge(dir, [{ raw: "{broken-json" }, execRequest("cat README.md", dir)]);
  assert.notEqual(run.code, 0);
  assert.equal(report.ok, false);
  assert.match(report.reason, /invalid JSON frame/u);
  assert.equal(report.answers.length, 0);
  assertVerifies(dir);
});

test("initialize, thread, preflight and live-turn silence are bounded", () => {
  for (const stage of ["initialize", "thread", "preflight", "live"]) {
    const dir = ready();
    const { run, report } = bridge(dir, [], ["--lifecycle-timeout", "50ms"], {
      APPROVAL_STUB_SILENCE: stage,
      APPROVAL_STUB_STAY_OPEN: "1",
    });
    assert.notEqual(run.code, 0, stage);
    assert.equal(report.ok, false, stage);
    assert.equal(report.code, "bridge-server-silent", stage);
    assert.match(report.reason, /was silent/u, stage);
    assertVerifies(dir);
  }
});

test("interactive mode requires terminal stdin and refuses JSON", () => {
  const dir = ready();
  const tty = runCli(["codex", "bridge", "--interactive", "--dir", dir], dir);
  assert.notEqual(tty.code, 0);
  assert.match(tty.stderr, /requires a terminal/u);
  const json = runCli(["codex", "bridge", "--interactive", "--json", "--dir", dir], dir);
  assert.notEqual(json.code, 0);
  assert.match(json.stderr, /cannot be combined/u);
});

test("interactive terminal reuses one thread and preflight across two turns", () => {
  const dir = ready();
  const repliesPath = join(dir, "interactive-replies.jsonl");
  const turnScripts = [1, 2].map((number) => [
    { notify: "item/completed", params: { turnId: `turn-${number}`,
      item: { id: `missing-thread-${number}`, type: "agentMessage", text: `leak missing ${number}` } } },
    { notify: "item/completed", params: { threadId: "thread-other", turnId: `turn-${number}`,
      item: { id: `wrong-thread-${number}`, type: "agentMessage", text: `leak wrong ${number}` } } },
    { notify: "item/completed", params: { threadId: "thread-1", turnId: `turn-${number}`,
      item: { id: `answer-${number}`, type: "agentMessage", text: `answer ${number}` } } },
  ]);
  const ptyDriver = [
    "import os,pty,select,subprocess,sys,time",
    "master,slave=pty.openpty()",
    "child=subprocess.Popen(sys.argv[1:],stdin=slave,stdout=slave,stderr=slave)",
    "os.close(slave)",
    "seen=b''; sent=0; deadline=time.monotonic()+10",
    "while time.monotonic()<deadline:",
    "  readable,_,_=select.select([master],[],[],0.1)",
    "  if readable:",
    "    try: chunk=os.read(master,65536)",
    "    except OSError: break",
    "    if not chunk: break",
    "    seen+=chunk",
    "    while seen.count(b'codex> ')>sent:",
    "      sent+=1",
    "      os.write(master,[b'first\\n',b'second\\n',b'/quit\\n'][min(sent-1,2)])",
    "  if child.poll() is not None: break",
    "if child.poll() is None: child.kill()",
    "print(seen.decode('utf8','replace'))",
    "sys.exit(child.wait())",
  ].join("\n");
  const run = spawnSync("python3", ["-c", ptyDriver, process.execPath, CLI_ENTRY,
    "codex", "bridge", "--interactive", "--dir", dir, "--wait", "2s", "--interval", "200ms",
    "--", process.execPath, STUB], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, APPROVAL_STUB_TURN_SCRIPTS: JSON.stringify(turnScripts),
      APPROVAL_STUB_STAY_OPEN: "1", APPROVAL_STUB_REPLIES: repliesPath },
  });
  const output = run.stdout + run.stderr;
  assert.equal(run.status, 0, output);
  assert.match(output, /answer 1/u);
  assert.match(output, /answer 2/u);
  assert.doesNotMatch(output, /leak missing/u);
  assert.doesNotMatch(output, /leak wrong/u);
  const replies = repliesOf(repliesPath);
  assert.equal(replies.filter((entry) => entry["kind"] === "thread/start").length, 1);
  assert.equal(replies.filter((entry) => entry["turn"] === "preflight").length, 1);
  const live = replies.filter((entry) => entry["turn"] === "live");
  assert.equal(live.length, 2);
  assert.ok(live[0] !== undefined && live[1] !== undefined);
  assert.equal((live[0]["params"] as Record<string, unknown>)["threadId"], "thread-1");
  assert.equal((live[1]["params"] as Record<string, unknown>)["threadId"], "thread-1");
  assertVerifies(dir);
});

test("initial interactive prompt stays idle beyond the server silence deadline", () => {
  const dir = ready();
  const driver = [
    "import os,pty,select,subprocess,sys,time",
    "master,slave=pty.openpty()",
    "child=subprocess.Popen(sys.argv[1:],stdin=slave,stdout=slave,stderr=slave)",
    "os.close(slave)",
    "seen=b''; prompted=None; sent=False; deadline=time.monotonic()+8",
    "while time.monotonic()<deadline:",
    "  readable,_,_=select.select([master],[],[],0.05)",
    "  if readable:",
    "    try: seen+=os.read(master,65536)",
    "    except OSError: break",
    "  if b'codex> ' in seen and prompted is None: prompted=time.monotonic()",
    "  if prompted is not None and not sent and time.monotonic()-prompted>0.6:",
    "    os.write(master,b'/quit\\n'); sent=True",
    "  if child.poll() is not None: break",
    "if child.poll() is None: child.kill()",
    "print(seen.decode('utf8','replace'))",
    "sys.exit(child.wait())",
  ].join("\n");
  const run = spawnSync("python3", ["-c", driver, process.execPath, CLI_ENTRY,
    "codex", "bridge", "--interactive", "--dir", dir, "--lifecycle-timeout", "200ms",
    "--", process.execPath, STUB], {
    cwd: dir, encoding: "utf8", env: { ...process.env, APPROVAL_STUB_STAY_OPEN: "1" },
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /interactive session ended after 0 turn\(s\)/u);
  assertVerifies(dir);
});

test("SIGTERM cleans up an owned child that ignores graceful termination", async () => {
  const dir = ready();
  const pidPath = join(dir, "stub.pid");
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    APPROVAL_STUB_SCRIPT: "[]",
    APPROVAL_STUB_SILENCE: "live",
    APPROVAL_STUB_STAY_OPEN: "1",
    APPROVAL_STUB_IGNORE_SIGTERM: "1",
    APPROVAL_STUB_PID_PATH: pidPath,
  };
  delete childEnv.APPROVAL_HUMAN;
  const child = spawn(process.execPath, [CLI_ENTRY, "codex", "bridge", "--prompt", "wait",
    "--dir", dir, "--wait", "2s", "--interval", "200ms", "--lifecycle-timeout", "5s",
    "--", process.execPath, STUB], { cwd: dir, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  const deadline = Date.now() + 5_000;
  while (!existsSync(pidPath) && Date.now() < deadline) await delay(20);
  assert.equal(existsSync(pidPath), true, output);
  const stubPid = Number(readFileSync(pidPath, "utf8").trim());
  child.kill("SIGTERM");
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(result.signal, null, output);
  assert.notEqual(result.code, 0, output);
  assert.match(output, /interrupted by SIGTERM/u);
  await delay(50);
  let childGone = false;
  try {
    process.kill(stubPid, 0);
  } catch (cause) {
    childGone = (cause as NodeJS.ErrnoException).code === "ESRCH";
  }
  assert.equal(childGone, true, "the SIGTERM-ignoring app-server survived its owner");
  assertVerifies(dir);
});

test("EOF at an idle interactive prompt closes the owned child cleanly", () => {
  const dir = ready();
  const driver = [
    "import os,pty,select,subprocess,sys,time",
    "master,slave=pty.openpty()",
    "child=subprocess.Popen(sys.argv[1:],stdin=slave,stdout=slave,stderr=slave)",
    "os.close(slave)",
    "seen=b''; sent=False; deadline=time.monotonic()+10",
    "while time.monotonic()<deadline:",
    "  readable,_,_=select.select([master],[],[],0.1)",
    "  if readable:",
    "    try: chunk=os.read(master,65536)",
    "    except OSError: break",
    "    if not chunk: break",
    "    seen+=chunk",
    "    if b'codex> ' in seen and not sent:",
    "      os.write(master,b'\\x04'); sent=True",
    "  if child.poll() is not None: break",
    "if child.poll() is None: child.kill()",
    "print(seen.decode('utf8','replace'))",
    "sys.exit(child.wait())",
  ].join("\n");
  const run = spawnSync("python3", ["-c", driver, process.execPath, CLI_ENTRY,
    "codex", "bridge", "--interactive", "--dir", dir, "--wait", "2s", "--interval", "200ms",
    "--", process.execPath, STUB], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, APPROVAL_STUB_STAY_OPEN: "1" },
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /interactive session ended after 0 turn\(s\)/u);
  assertVerifies(dir);
});
