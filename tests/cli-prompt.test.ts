/**
 * The raw stdin readers in `cli/prompt.ts` (APRV-84).
 *
 * `cli-setup.test.ts` drives every setup verb through a scripted `Prompter`,
 * which is right for the verbs and blind to the readers underneath them. These
 * tests are for the readers: the byte loop of the line reader through an
 * injected `ByteReader`, and `readByteBlocking` itself against a real terminal
 * whose fd 0 libuv has switched to non-blocking, which is the shape of the
 * `setup identity` bug the task fixed. That last case runs under `script(1)`
 * because a pipe never yields EAGAIN; it is skipped, loudly, where `script` is
 * absent.
 *
 * APRV-90 added a third subject, one level up from the bytes: `askUntil`, the
 * loop that turns a wrong answer into the same question rather than into an
 * exit code. Its cases drive a `Prompter` directly, because what they are about
 * is the loop's arithmetic — how many times it asks, what it prints between
 * asks, and which of the three ends it reaches.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import {
  DEFAULT_MAX_ATTEMPTS,
  askUntil,
  readLineFromStdin,
  type AnswerVerdict,
  type ByteReader,
  type Prompter,
} from "../src/cli/prompt.js";
import type { Streams } from "../src/cli/main.js";

/** A reader that hands out `bytes` one at a time, then EOF. */
function scripted(bytes: number[]): ByteReader {
  const queue = [...bytes];
  return (buffer) => {
    if (queue.length === 0) return 0;
    buffer[0] = queue.shift() as number;
    return 1;
  };
}

test("readLineFromStdin: a line ends at LF, drops CR, keeps everything before", () => {
  const read = scripted([...Buffer.from("human:carter\r\nnext")]);
  assert.equal(readLineFromStdin(read), "human:carter");
  assert.equal(readLineFromStdin(read), "next", "EOF after bytes is a final line");
  assert.equal(readLineFromStdin(read), null, "EOF with nothing read is null");
});

test("readLineFromStdin: a reader that throws mid-line ends the line, and at start is null", () => {
  let calls = 0;
  const flaky: ByteReader = (buffer) => {
    calls += 1;
    if (calls === 1) {
      buffer[0] = 0x61;
      return 1;
    }
    throw new Error("terminal went away");
  };
  assert.equal(readLineFromStdin(flaky), "a");
  assert.equal(readLineFromStdin(flaky), null);
});

test("readByteBlocking: EAGAIN on a non-blocking tty waits for the keystroke instead of reporting EOF", () => {
  const which = spawnSync("sh", ["-c", "command -v expect"], { encoding: "utf8" });
  if (which.status !== 0) {
    console.log("# skip: expect(1) not available; readByteBlocking tty case not run");
    return;
  }
  // Touching process.stdin on a tty is what flips fd 0 to non-blocking, and
  // the keystrokes arrive half a second later, so the first readSync calls see
  // EAGAIN. `expect` supplies the pty; `script(1)` would not do, because on
  // macOS it sends EOT the moment its own stdin is a pipe.
  const program = [
    "process.stdin.isTTY;",
    "const { readLineFromStdin } = await import(process.argv[1]);",
    "const line = readLineFromStdin();",
    "process.stdout.write('LINE=' + JSON.stringify(line) + '\\n');",
  ].join(" ");
  // This file runs from dist/tests/, so the compiled reader is a sibling tree.
  const modulePath = new URL("../src/cli/prompt.js", import.meta.url).href;
  const script = [
    `spawn node --input-type=module -e {${program}} {${modulePath}}`,
    "sleep 0.5",
    'send "typed-late\\r"',
    "expect eof",
  ].join("; ");
  const run = spawnSync("expect", ["-c", script], { encoding: "utf8", timeout: 15_000 });
  assert.match(run.stdout, /LINE="typed-late"/, `stdout: ${run.stdout}\nstderr: ${run.stderr}`);
});

// ---------------------------------------------------------------------------
// askUntil (APRV-90)
// ---------------------------------------------------------------------------

/** A prompter whose `readLine` answers from a script. Nothing else is used. */
function lineScript(answers: Array<string | null>): { prompter: Prompter; asked: string[] } {
  const queue = [...answers];
  const asked: string[] = [];
  const prompter: Prompter = {
    readLine(prompt) {
      asked.push(prompt);
      if (queue.length === 0) throw new Error(`askUntil asked once too often: ${prompt}`);
      return queue.shift() ?? null;
    },
    readSecret() {
      throw new Error("askUntil must not read a secret");
    },
    confirm() {
      throw new Error("askUntil must not ask for a confirmation");
    },
  };
  return { prompter, asked };
}

/** Captured output, and the `Streams` that fills it. */
function capture(): { out: string[]; streams: Streams } {
  const out: string[] = [];
  return { out, streams: { out: (text) => out.push(text), err: () => undefined } };
}

/** One rule, standing in for the real ones: parse, refuse with a sentence. */
function evenNumber(answer: string): AnswerVerdict<number> {
  const value = Number.parseInt(answer.trim(), 10);
  if (!Number.isInteger(value)) {
    return { ok: false, reason: `${JSON.stringify(answer)} is not a number` };
  }
  if (value % 2 !== 0) return { ok: false, reason: `${String(value)} is odd` };
  return { ok: true, value };
}

test("askUntil: a bad answer is one line and the same question, and the value is the PARSED one", () => {
  const { prompter, asked } = lineScript(["x", "3", "4"]);
  const { out, streams } = capture();
  const outcome = askUntil(streams, prompter, "n: ", evenNumber);

  assert.deepEqual(outcome, { ok: true, value: 4 });
  assert.deepEqual(asked, ["n: ", "n: ", "n: "], "the question is repeated verbatim");
  // One line per failure, and nothing else: no help page, no exit.
  assert.deepEqual(out, [`  "x" is not a number\n`, "  3 is odd\n"]);
});

test("askUntil: EOF aborts immediately, with nothing parsed", () => {
  const { prompter, asked } = lineScript(["3", null]);
  const { out, streams } = capture();
  const outcome = askUntil(streams, prompter, "n: ", evenNumber);

  assert.deepEqual(outcome, { ok: false, reason: "aborted", attempts: 2 });
  assert.equal(asked.length, 2);
  assert.deepEqual(out, ["  3 is odd\n"], "an abort added a reason of its own");
});

test("askUntil: the attempt bound ends it, and the last reason is still printed", () => {
  const { prompter } = lineScript(["1", "3", "5", "7", "9", "11"]);
  const { out, streams } = capture();
  const outcome = askUntil(streams, prompter, "n: ", evenNumber);

  assert.deepEqual(outcome, { ok: false, reason: "exhausted", attempts: DEFAULT_MAX_ATTEMPTS });
  assert.equal(out.length, DEFAULT_MAX_ATTEMPTS);
  assert.equal(out[DEFAULT_MAX_ATTEMPTS - 1], "  9 is odd\n");
});

test("askUntil: the bound is caller-settable, and one attempt is a legitimate bound", () => {
  const { prompter, asked } = lineScript(["1"]);
  const { streams } = capture();
  const outcome = askUntil(streams, prompter, "n: ", evenNumber, { maxAttempts: 1 });
  assert.deepEqual(outcome, { ok: false, reason: "exhausted", attempts: 1 });
  assert.equal(asked.length, 1);
});
