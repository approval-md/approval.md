/**
 * The live draw's relay child (APRV-208).
 *
 * ## Why a child process exists at all
 *
 * `core/gate.ts`'s request path is synchronous from end to end — `request`
 * returns a value, the hook's wait loop sleeps synchronously — and Node has no
 * synchronous Unix-socket client. APRV-188 hit the same wall and answered it
 * with a published file, because the thing it needed (the log's verified head)
 * is a fact the daemon can publish in advance. A live draw is not: the question
 * contains bytes that did not exist when the daemon last woke up. It has to be
 * asked.
 *
 * So: one `spawnSync` of this file, about 20-40 ms of Node start, paid only by a
 * `supervised-live` class in a process with no sampling secret. It is off the
 * pass-through path entirely.
 *
 * ## What it is allowed to do
 *
 * Open a socket, write one line, read one line, print it. That is the whole
 * remit, and it is written to be worth nothing if it were replaced wholesale:
 * it holds no secret, appends nothing, decides nothing, and the parent
 * VALIDATES every field of what it relays (`core/live-draw.ts`'s
 * `parseDrawAnswer`) rather than trusting it. A hostile relay can refuse to
 * answer — which gates the action, which is the safe direction — and can put
 * nothing past the parent that the daemon's MAC does not cover.
 *
 * ## The protocol
 *
 * `argv[2]` is the socket path. stdin is one JSON line, the question. stdout is
 * one JSON line: `{"ok":true,"answer":{...}}` verbatim from the daemon, or
 * `{"ok":false,"reason":"...","detail":"..."}` with one of
 * `core/live-draw.ts`'s refusal reasons. Exit code is always 0: the parent
 * reads the line, not the status.
 */

import { connect } from "node:net";
import { readFileSync } from "node:fs";

import {
  DRAW_TIMEOUT_MS,
  type DrawRefusalReason,
} from "../core/live-draw.js";

function say(body: unknown): void {
  process.stdout.write(`${JSON.stringify(body)}\n`);
}

function refuse(reason: DrawRefusalReason, detail: string): void {
  say({ ok: false, reason, detail });
}

function main(): void {
  const socketPath = process.argv[2];
  if (socketPath === undefined || socketPath.length === 0) {
    refuse("draw-daemon-absent", "the draw relay was given no socket path");
    return;
  }

  let question: string;
  try {
    question = readFileSync(0, "utf8").trim();
  } catch (cause) {
    refuse(
      "draw-answer-invalid",
      `the relay could not read the question: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return;
  }
  if (question.length === 0) {
    refuse("draw-answer-invalid", "the relay was given no question");
    return;
  }

  let settled = false;
  let buffer = "";
  const socket = connect(socketPath);
  socket.setEncoding("utf8");
  socket.setTimeout(DRAW_TIMEOUT_MS);

  const settle = (body: unknown): void => {
    if (settled) return;
    settled = true;
    say(body);
    socket.destroy();
  };

  socket.on("connect", () => {
    socket.write(`${question}\n`);
  });
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline < 0) {
      // A daemon that never terminates its line is a daemon that has not
      // answered. The 8 KB ceiling is the same one the server applies to the
      // question, and a reply past it is not this protocol's.
      if (buffer.length > 8192) {
        settle({ ok: false, reason: "draw-answer-invalid", detail: "the answer had no line ending" });
      }
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.slice(0, newline));
    } catch {
      settle({ ok: false, reason: "draw-answer-invalid", detail: "the daemon did not answer with JSON" });
      return;
    }
    const body = parsed as Record<string, unknown>;
    if (body["ok"] === false) {
      settle({
        ok: false,
        reason: "draw-answer-invalid",
        detail: typeof body["detail"] === "string" ? body["detail"] : "the daemon refused the question",
      });
      return;
    }
    settle({ ok: true, answer: parsed });
  });
  socket.on("timeout", () => {
    settle({
      ok: false,
      reason: "draw-daemon-stale",
      detail: `no answer within ${String(DRAW_TIMEOUT_MS)}ms; the daemon is listening but not serving`,
    });
  });
  socket.on("error", (cause: Error) => {
    settle({
      ok: false,
      reason: "draw-daemon-stale",
      detail: `the draw socket could not be reached: ${cause.message}`,
    });
  });
  socket.on("close", () => {
    settle({
      ok: false,
      reason: "draw-daemon-stale",
      detail: "the daemon closed the connection without answering",
    });
  });
}

main();
