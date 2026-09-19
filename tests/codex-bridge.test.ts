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
  BRIDGE_REFUSAL_CODES,
  BRIDGE_STOP_CODES,
  advertisedDecisions,
  chooseDecision,
  effectiveApprovalPolicy,
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

interface ScriptEntry {
  method: string;
  params?: Record<string, unknown>;
}

interface BridgeAnswerRow {
  method: string;
  outcome: "accept" | "decline";
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
  confirmed: boolean;
}

interface BridgeReport {
  ok: boolean;
  reason: string;
  /** Present only when the run STOPPED on one of the stop codes (APRV-366). */
  code?: string;
  thread: BridgeThreadRow;
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
      params: { threadId: "thread-1", itemId: "item-1", command: "cat README.md" },
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
  const { report } = bridge(dir, [
    {
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-2",
        startedAtMs: 0,
        reason: null,
        grantRoot: null,
      },
    },
  ]);

  const answer = report.answers[0] as BridgeAnswerRow;
  assert.equal(answer.outcome, "decline");
  assert.equal(answer.code, "bridge-file-change-unbound");
  assert.match(answer.detail, /APRV-363/u);
  assert.equal(rawLog(dir), before);
});

test("a server request with no reading is declined bridge-unknown-request", () => {
  const dir = ready();
  const { report } = bridge(dir, [{ method: "item/somethingNew/requestApproval", params: {} }]);

  const answer = report.answers[0] as BridgeAnswerRow;
  assert.equal(answer.outcome, "decline");
  assert.equal(answer.code, "bridge-unknown-request");
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
  // narrow, and `confirmed: false` is the whole of the difference.
  assert.equal(report.thread.effective.approvalPolicy, null);
  assert.equal(report.thread.confirmed, false);
  assert.equal(report.answers.length, 1);
});

test("APRV-366: a server that echoes the pin back is recorded as confirmed", () => {
  const dir = ready();
  const { run, report } = bridge(dir, [execRequest("cat README.md", dir)], [], {
    APPROVAL_STUB_THREAD_RESULT: JSON.stringify({ approvalPolicy: "untrusted" }),
  });

  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  assert.equal(report.thread.effective.approvalPolicy, "untrusted");
  assert.equal(report.thread.confirmed, true);
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
  assert.equal(report.thread.confirmed, false);
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
  assert.equal(report.thread.confirmed, false);
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
    "bridge-thread-start-refused",
  ]);
  assert.equal(new Set(BRIDGE_STOP_CODES).size, BRIDGE_STOP_CODES.length);
  // Disjoint on purpose: a decline is an answer to one approval request and the
  // turn carries on, a stop ends the session. The conformance union
  // `bridge_refusal_codes` is documented as the first of those.
  for (const code of BRIDGE_STOP_CODES) {
    assert.equal((BRIDGE_REFUSAL_CODES as readonly string[]).includes(code), false, code);
  }
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

test("the refusal codes are a closed, distinct vocabulary", () => {
  assert.deepEqual([...BRIDGE_REFUSAL_CODES].sort(), [
    "bridge-file-change-unbound",
    "bridge-request-unbound",
    "bridge-unknown-request",
  ]);
  assert.equal(new Set(BRIDGE_REFUSAL_CODES).size, BRIDGE_REFUSAL_CODES.length);
});
