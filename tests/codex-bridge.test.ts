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
  // The follow-up that would let it be approved, once the shape of the frame
  // the content arrives on is recorded (APRV-363 landed the legacy half).
  assert.match(answer.detail, /APRV-379/u);
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
    "bridge-file-change-unbound",
    "bridge-request-unbound",
    "bridge-unknown-request",
  ]);
  assert.equal(new Set(BRIDGE_REFUSAL_CODES).size, BRIDGE_REFUSAL_CODES.length);
});
