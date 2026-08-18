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
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { readLineFromStdin, type ByteReader } from "../src/cli/prompt.js";

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
