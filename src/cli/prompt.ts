/**
 * Terminal prompts — the one place this CLI reads from a human (APRV-74).
 *
 * Two of these three functions existed already, privately, inside
 * `cli/amend.ts`: a synchronous line reader and the `[y/N]` question built on
 * it. `approval setup` needs both, plus a third that `amend` never needed — a
 * reader that does not echo — and three copies of a raw-mode byte loop is two
 * too many. So they live here, `amend` imports the line reader, and the
 * no-echo one is written once, in the open, where it can be read.
 *
 * ## Synchronous, on purpose
 *
 * `readSync(0, …)` rather than `readline/promises`. Every verb in this CLI
 * returns an exit code from a synchronous function, and the two that do not
 * (`channel`, `daemon`) are asynchronous because they hold a socket open, not
 * because they ask a question. A prompt that forced `setup identity` to become
 * a promise would be an async CLI shape adopted for the sake of one line of
 * input.
 *
 * ## The no-echo reader, and what it is worth
 *
 * {@link readSecret} puts the terminal in raw mode and reads one byte at a
 * time, printing nothing — not even asterisks, which leak a length. It restores
 * the terminal in a `finally`, including on the abort paths, because a shell
 * left in raw mode after a Ctrl-C is a broken session and the operator's next
 * act would be to close the window.
 *
 * What it defends is a secret in a scrollback buffer, a `script` capture, or a
 * screen share. What it does not defend is a compromised terminal, a keylogger,
 * or the process itself: the value is a `string` in this process's heap the
 * instant it is complete, exactly as `approval vault set`'s stdin value is. The
 * design point that matters more is upstream of this file — wherever a secret
 * can be collected by a helper's OWN prompt, `setup` delegates to that helper
 * and this function is never called (see `cli/setup.ts`, "the token never
 * enters our process").
 *
 * **Ctrl-C is a distinct result, not an exception and not an empty string.** An
 * aborted prompt must be distinguishable from an empty answer by the caller, so
 * that "the human changed their mind" stores nothing and exits, while "the
 * human pressed Enter" is an ordinary validation failure. Collapsing the two is
 * how a half-configured keystore entry gets written.
 *
 * Nothing here throws, and nothing here ever writes the value it read to any
 * stream.
 */

import { readSync } from "node:fs";

import type { Streams } from "./main.js";

/** The result of a no-echo read. `aborted` is Ctrl-C or Ctrl-D, distinctly. */
export type SecretRead =
  | { ok: true; value: string }
  | { ok: false; reason: "aborted" };

const CTRL_C = 0x03;
const CTRL_D = 0x04;
const BACKSPACE = 0x08;
const DELETE = 0x7f;
const CR = 0x0d;
const LF = 0x0a;

/**
 * One line from stdin, synchronously. `null` at EOF.
 *
 * Hoisted verbatim from `cli/amend.ts` (APRV-74), which is why it reads bytes
 * rather than using a stream: it is called from inside a synchronous command
 * function, after output has already been written, and it must not consume more
 * of stdin than the line it was asked for.
 */
export function readLineFromStdin(): string | null {
  const buffer = Buffer.alloc(1);
  const chars: string[] = [];
  for (;;) {
    let read = 0;
    try {
      read = readSync(0, buffer, 0, 1, null);
    } catch {
      return chars.length === 0 ? null : chars.join("");
    }
    if (read === 0) return chars.length === 0 ? null : chars.join("");
    const char = buffer.toString("utf8");
    if (char === "\n") return chars.join("");
    if (char !== "\r") chars.push(char);
  }
}

/**
 * A UTF-8 character's worth of bytes, popped off the end of `bytes`.
 *
 * Backspace deletes a CHARACTER, so the continuation bytes (`10xxxxxx`) of a
 * multi-byte sequence come off together with their lead byte. A loop that
 * popped one byte would leave a truncated sequence in the buffer and turn a
 * passphrase containing an accented letter into one the operator cannot retype.
 */
function popCharacter(bytes: number[]): void {
  while (bytes.length > 0) {
    const byte = bytes[bytes.length - 1] as number;
    bytes.pop();
    if ((byte & 0xc0) !== 0x80) return;
  }
}

/**
 * Read a secret with no echo. See the module doc for what this is worth.
 *
 * The byte loop, in full: `\r` or `\n` ends the read; DEL (0x7f) and BS (0x08)
 * remove the last character and echo nothing (no cursor movement — there is
 * nothing on screen to erase); Ctrl-C aborts always; Ctrl-D aborts only on an
 * empty buffer, which is EOF's meaning everywhere else in a shell and which
 * leaves the "Ctrl-D at the end of a typed line" case as an ordinary end. Every
 * other byte accumulates.
 *
 * Raw mode is restored in a `finally`, and a newline is printed after, so the
 * caller's next output starts on its own line whichever way the read ended.
 */
export function readSecret(streams: Streams, prompt: string): SecretRead {
  streams.out(prompt);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw === true;
  const buffer = Buffer.alloc(1);
  const bytes: number[] = [];

  try {
    stdin.setRawMode(true);
    for (;;) {
      let read = 0;
      try {
        read = readSync(0, buffer, 0, 1, null);
      } catch (cause) {
        // EAGAIN on a tty means "nothing to read yet", not "end of input".
        if ((cause as NodeJS.ErrnoException).code === "EAGAIN") continue;
        return { ok: false, reason: "aborted" };
      }
      if (read === 0) {
        return bytes.length === 0
          ? { ok: false, reason: "aborted" }
          : { ok: true, value: Buffer.from(bytes).toString("utf8") };
      }
      const byte = buffer[0] as number;
      if (byte === CR || byte === LF) {
        return { ok: true, value: Buffer.from(bytes).toString("utf8") };
      }
      if (byte === CTRL_C) return { ok: false, reason: "aborted" };
      if (byte === CTRL_D && bytes.length === 0) return { ok: false, reason: "aborted" };
      if (byte === DELETE || byte === BACKSPACE) {
        popCharacter(bytes);
        continue;
      }
      if (byte === CTRL_D) continue;
      bytes.push(byte);
    }
  } finally {
    try {
      stdin.setRawMode(wasRaw);
    } catch {
      /* the terminal went away; there is nothing left to restore it to */
    }
    streams.out("\n");
    bytes.length = 0;
  }
}

/**
 * The three ways `setup` talks to a human, as an interface.
 *
 * A seam, for the reason every other seam in this codebase exists: the
 * alternative is a test suite that needs a terminal. Tests pass a scripted
 * prompter and assert on what was asked as well as on what was done, which is
 * how "Ctrl-C mid-secret stores nothing" becomes a test rather than a claim.
 */
export interface Prompter {
  /** A question with a typed answer. `null` at EOF. */
  readLine(prompt: string): string | null;
  /** A question whose answer is not echoed. */
  readSecret(prompt: string): SecretRead;
  /** `[y/N]` (or `[Y/n]`). Anything unrecognised takes the default. */
  confirm(prompt: string, defaultNo?: boolean): boolean;
}

/**
 * The real prompter, or `null` when stdin is not a terminal.
 *
 * Refusing to construct is deliberate: a prompter that fell back to reading a
 * pipe would let a CI job answer `setup`'s confirmations by feeding it a
 * heredoc, and "a human was asked" is the entire content of these questions.
 * Callers check `process.stdin.isTTY` themselves and print the non-interactive
 * alternative; this is the second lock on the same door.
 */
export function createPrompter(streams: Streams): Prompter | null {
  if (process.stdin.isTTY !== true) return null;
  return {
    readLine(prompt: string): string | null {
      streams.out(prompt);
      return readLineFromStdin();
    },
    readSecret(prompt: string): SecretRead {
      return readSecret(streams, prompt);
    },
    confirm(prompt: string, defaultNo = true): boolean {
      streams.out(`${prompt} ${defaultNo ? "[y/N]" : "[Y/n]"} `);
      const answer = (readLineFromStdin() ?? "").trim().toLowerCase();
      if (answer.length === 0) return !defaultNo;
      return answer === "y" || answer === "yes";
    },
  };
}
