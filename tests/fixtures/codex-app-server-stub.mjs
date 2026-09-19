/**
 * A stand-in for `codex app-server`, speaking the shape the 2026-09-18 probe
 * recorded (APRV-361).
 *
 * It is not a model and it runs nothing. It answers `initialize` and
 * `thread/start`, then, on `turn/start`, sends the approval requests its script
 * names and waits for each reply before sending the next — which is what the
 * real server does, and what makes "the effect never happened before the
 * answer" a thing a test can assert.
 *
 * The script comes from `APPROVAL_STUB_SCRIPT`, a JSON array of requests:
 *
 *   [{"method": "...", "params": {...}}, ...]
 *
 * An entry spelled `{"notify": "...", "params": {...}}` is sent as a
 * NOTIFICATION instead: no id, nothing waited for, and the script moves on at
 * once (APRV-379). That is what lets a case send the `item/started` that
 * carries a file change, then the approval request that refers to it by item
 * id, then the `item/completed` — the order the 2026-09-19 probe recorded.
 *
 * Every reply it receives is appended to `APPROVAL_STUB_REPLIES` as one JSON
 * line, so a test reads what the bridge actually sent rather than what the
 * bridge said it sent. Frames carry no `jsonrpc` member, per the protocol. The
 * preflight turn's own reply is recorded as `preflight-reply` rather than
 * `reply`, so a test asking what the REAL turn was answered is not handed the
 * probe's decline (APRV-364).
 *
 * Three more knobs, all additive, for the approval-policy pin (APRV-366). Unset,
 * every one of them leaves the stub behaving exactly as it did:
 *
 *   APPROVAL_STUB_THREAD_ERROR    JSON error object: `thread/start` is refused
 *                                 with it, as the real server refuses an
 *                                 approval policy variant it does not know.
 *   APPROVAL_STUB_THREAD_RESULT   JSON object merged into `thread/start`'s
 *                                 result, for a server that reports its own
 *                                 effective settings.
 *   APPROVAL_STUB_THREAD_STARTED  JSON object sent as a `thread/started`
 *                                 notification's params after the thread is
 *                                 started, which is where the real server
 *                                 narrates the thread it just made.
 *
 * ## The preflight turn (APRV-364)
 *
 * The bridge runs a PROBE turn before the real one, so this stub answers two
 * `turn/start` requests: the first is the probe and the second carries the
 * script above. What the first one does is `APPROVAL_STUB_PREFLIGHT`, one of
 * four words, and the default is the healthy case so every pre-APRV-364 test
 * reads exactly as it did:
 *
 *   asked        (default) one exec approval request for the probe command,
 *                then the turn completes once the bridge answers it. This is
 *                what a server under `untrusted` with no auto-reviewer does.
 *   executed     the command ran and nothing asked: `item/started` and
 *                `item/completed` for a commandExecution item, then the turn
 *                completes. The session is not under `untrusted`, whatever the
 *                server said about it.
 *   void         the turn completes having run no command at all, which is the
 *                model answering in prose.
 *   auto-review  an `item/autoApprovalReview/completed` notification: something
 *                else answered the question before this client saw it.
 */

import { appendFileSync } from "node:fs";

const script = JSON.parse(process.env["APPROVAL_STUB_SCRIPT"] ?? "[]");
const repliesPath = process.env["APPROVAL_STUB_REPLIES"] ?? null;
const threadError = JSON.parse(process.env["APPROVAL_STUB_THREAD_ERROR"] ?? "null");
const threadResult = JSON.parse(process.env["APPROVAL_STUB_THREAD_RESULT"] ?? "null");
const threadStarted = JSON.parse(process.env["APPROVAL_STUB_THREAD_STARTED"] ?? "null");
const preflight = process.env["APPROVAL_STUB_PREFLIGHT"] ?? "asked";

let buffer = "";
let next = 0;
let nextId = 1000;
/** Which turn the next `turn/start` is: the probe, then the real one. */
let turns = 0;
const PREFLIGHT_TURN = "turn-preflight";
/** The id of the probe's own approval request, so its reply is not a script reply. */
let probeRequestId = null;

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function record(frame) {
  if (repliesPath === null) return;
  appendFileSync(repliesPath, `${JSON.stringify(frame)}\n`, "utf8");
}

/** Send the next scripted request, or end the turn when the script runs out. */
function advance() {
  if (next >= script.length) {
    write({ method: "turn/completed", params: { turnId: "turn-1" } });
    // The real server stays alive; this one has nothing left to say, and a
    // process that lingered would make every test wait out a kill.
    setTimeout(() => {
      process.exit(0);
    }, 50);
    return;
  }
  const entry = script[next];
  next += 1;
  // A NOTIFICATION: sent with no id, so nothing is waiting for a reply and the
  // script continues immediately (APRV-379). The recursion is the script's own
  // length deep and a script is a handful of entries.
  if (typeof entry.notify === "string") {
    write({ method: entry.notify, params: entry.params ?? {} });
    advance();
    return;
  }
  const id = nextId;
  nextId += 1;
  write({ id, method: entry.method, params: entry.params ?? {} });
}

/** The probe turn, in whichever of the four shapes the case asked for. */
function runPreflight() {
  if (preflight === "asked") {
    probeRequestId = nextId;
    nextId += 1;
    write({
      id: probeRequestId,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: PREFLIGHT_TURN,
        itemId: "item-preflight",
        command: "true",
        cwd: process.cwd(),
        availableDecisions: ["accept", "decline"],
      },
    });
    return;
  }
  if (preflight === "executed") {
    write({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: PREFLIGHT_TURN,
        item: { id: "item-preflight", type: "commandExecution", command: "true" },
      },
    });
    write({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: PREFLIGHT_TURN,
        item: { id: "item-preflight", type: "commandExecution", command: "true", exitCode: 0 },
      },
    });
    write({ method: "turn/completed", params: { turnId: PREFLIGHT_TURN } });
    return;
  }
  if (preflight === "auto-review") {
    write({
      method: "item/autoApprovalReview/completed",
      params: {
        threadId: "thread-1",
        turnId: PREFLIGHT_TURN,
        itemId: "item-preflight",
        decision: "accept",
        source: "agent",
      },
    });
    write({ method: "turn/completed", params: { turnId: PREFLIGHT_TURN } });
    return;
  }
  // `void`: the model answered in prose and ran nothing.
  write({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: PREFLIGHT_TURN,
      item: { id: "item-prose", type: "agentMessage", text: "nothing to run" },
    },
  });
  write({ method: "turn/completed", params: { turnId: PREFLIGHT_TURN } });
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline === -1) return;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length === 0) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }

    if (frame.method === "initialize") {
      write({ id: frame.id, result: { userAgent: "codex-app-server-stub" } });
      continue;
    }
    if (frame.method === "initialized") continue;
    if (frame.method === "thread/start") {
      record({ kind: "thread/start", params: frame.params ?? {} });
      if (threadError !== null) {
        write({ id: frame.id, error: threadError });
        continue;
      }
      write({ id: frame.id, result: { threadId: "thread-1", ...threadResult } });
      if (threadStarted !== null) write({ method: "thread/started", params: threadStarted });
      continue;
    }
    if (frame.method === "turn/start") {
      turns += 1;
      if (turns === 1) {
        record({ kind: "turn/start", turn: "preflight", params: frame.params ?? {} });
        write({ id: frame.id, result: { turnId: PREFLIGHT_TURN } });
        runPreflight();
        continue;
      }
      record({ kind: "turn/start", turn: "live", params: frame.params ?? {} });
      write({ id: frame.id, result: { turnId: "turn-1" } });
      advance();
      continue;
    }
    // Anything else carrying an id and no method is a REPLY to one of the
    // requests above: record it, then ask the next question.
    if (frame.id !== undefined && frame.method === undefined) {
      if (frame.id === probeRequestId) {
        // Recorded under its own kind, so a test looking for "reply" still
        // finds the answers the REAL turn got and never the probe's decline.
        record({ kind: "preflight-reply", id: frame.id, result: frame.result ?? null });
        // The probe was answered, so the probe turn is over. The real turn is
        // the bridge's to start.
        probeRequestId = null;
        write({ method: "turn/completed", params: { turnId: PREFLIGHT_TURN } });
        continue;
      }
      record({ kind: "reply", id: frame.id, result: frame.result ?? null });
      advance();
    }
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});
