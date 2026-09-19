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
 * Every reply it receives is appended to `APPROVAL_STUB_REPLIES` as one JSON
 * line, so a test reads what the bridge actually sent rather than what the
 * bridge said it sent. Frames carry no `jsonrpc` member, per the protocol.
 */

import { appendFileSync } from "node:fs";

const script = JSON.parse(process.env["APPROVAL_STUB_SCRIPT"] ?? "[]");
const repliesPath = process.env["APPROVAL_STUB_REPLIES"] ?? null;

let buffer = "";
let next = 0;
let nextId = 1000;

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
  const id = nextId;
  nextId += 1;
  write({ id, method: entry.method, params: entry.params ?? {} });
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
      write({ id: frame.id, result: { threadId: "thread-1" } });
      continue;
    }
    if (frame.method === "turn/start") {
      write({ id: frame.id, result: { turnId: "turn-1" } });
      advance();
      continue;
    }
    // Anything else carrying an id and no method is a REPLY to one of the
    // requests above: record it, then ask the next question.
    if (frame.id !== undefined && frame.method === undefined) {
      record({ kind: "reply", id: frame.id, result: frame.result ?? null });
      advance();
    }
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});
