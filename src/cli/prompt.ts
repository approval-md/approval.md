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
 *
 * ## A bad answer is a question asked again, not a mangled command line (APRV-90)
 *
 * {@link askUntil} is the loop every typed question in `setup` runs through. It
 * exists because the first shipped build treated a wrong answer to a PROMPT the
 * way it treats a wrong flag on an argv: exit 2 with the whole help page under
 * it. Observed on 2026-08-18, `setup identity` printed `human identity
 * (human:<id>):`, the operator typed `carter`, and forty lines of help came
 * back. A prompt has already told the human what it wants; when the answer does
 * not fit, the useful reply is one line saying which part did not fit, followed
 * by the same question.
 *
 * Three ends, and they are different on purpose:
 *
 * - **accepted** — the validator's parsed value, which may be a NORMALISED form
 *   of what was typed (`carter` → `human:carter`) rather than the bytes;
 * - **aborted** — `readLine` returned `null`, which is Ctrl-D (and, for the
 *   scripted prompter, the modelled Ctrl-C). Nothing is stored, and the caller
 *   exits with a one-line reason and NO help page, because there was no command
 *   line for a help page to be about;
 * - **exhausted** — {@link DEFAULT_MAX_ATTEMPTS} answers in a row failed
 *   validation. Bounded rather than infinite so that a prompt driven by
 *   something that is not a person (a stuck script, a terminal replaying bytes)
 *   terminates instead of looping forever.
 *
 * ## EAGAIN is "not yet", never "end of input" (APRV-84)
 *
 * Every caller checks `process.stdin.isTTY` before it prompts, and merely
 * touching `process.stdin` on a terminal has libuv put fd 0 into non-blocking
 * mode. From then on a `readSync(0, …)` issued before the human has typed
 * fails with EAGAIN instead of waiting. The first shipped line reader treated
 * every error as EOF, so `approval setup identity` on a macOS terminal printed
 * "no identity was entered" the instant the prompt appeared. Both readers now
 * go through {@link readByteBlocking}, which sleeps a few milliseconds on
 * EAGAIN and tries again, and treats nothing else as "wait".
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
export function readLineFromStdin(read: ByteReader = readByteBlocking): string | null {
  const buffer = Buffer.alloc(1);
  const chars: string[] = [];
  for (;;) {
    let count = 0;
    try {
      count = read(buffer);
    } catch {
      return chars.length === 0 ? null : chars.join("");
    }
    if (count === 0) return chars.length === 0 ? null : chars.join("");
    const char = buffer.toString("utf8");
    if (char === "\n") return chars.join("");
    if (char !== "\r") chars.push(char);
  }
}

/** One byte of stdin into `buffer[0]`; returns the count read (0 at EOF). */
export type ByteReader = (buffer: Buffer) => number;

/** How long to sleep between EAGAIN retries. Short enough that a keystroke feels immediate. */
const EAGAIN_NAP_MS = 5;
const napCell = new Int32Array(new SharedArrayBuffer(4));

/**
 * One byte from fd 0, blocking, whatever mode libuv left the descriptor in.
 *
 * EAGAIN means the terminal has nothing yet: nap and retry (`Atomics.wait` is
 * the one synchronous sleep JavaScript has, and it keeps the wait from being a
 * hot loop). Every other error propagates, and 0 bytes is EOF, exactly as with
 * `readSync` itself.
 */
export function readByteBlocking(buffer: Buffer): number {
  for (;;) {
    try {
      return readSync(0, buffer, 0, 1, null);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EAGAIN") throw cause;
      Atomics.wait(napCell, 0, 0, EAGAIN_NAP_MS);
    }
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
export function readSecret(streams: Streams, prompt: string, read: ByteReader = readByteBlocking): SecretRead {
  streams.out(prompt);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw === true;
  const buffer = Buffer.alloc(1);
  const bytes: number[] = [];

  try {
    stdin.setRawMode(true);
    for (;;) {
      let count = 0;
      try {
        count = read(buffer);
      } catch {
        // EAGAIN never reaches here (readByteBlocking waits it out); anything else is the terminal going away.
        return { ok: false, reason: "aborted" };
      }
      if (count === 0) {
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

// ---------------------------------------------------------------------------
// Asking again (APRV-90)
// ---------------------------------------------------------------------------

/**
 * How many failed answers to one question before the loop gives up. See the
 * module doc: bounded so that a prompt nobody is answering terminates.
 */
export const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * A validator's verdict on one typed answer.
 *
 * `value` is the PARSED form, not the bytes: a validator is where `carter`
 * becomes `human:carter` and `"2"` becomes the second choice, so the caller
 * never re-derives from the string what the validator already decided.
 * `reason` is the single line the operator is shown before the question comes
 * back, so it names what was wrong and nothing else.
 */
export type AnswerVerdict<T> = { ok: true; value: T } | { ok: false; reason: string };

/** How {@link askUntil} ended. `attempts` is how many answers were read. */
export type AskOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "aborted" | "exhausted"; attempts: number };

/**
 * Ask until the answer validates, the human gives up, or the attempts run out.
 *
 * The reason line goes to STDOUT, indented, because it is part of the
 * conversation and not a diagnostic about a command: it is read by the person
 * at the terminal, in between their answer and the next prompt. A caller turns
 * an `aborted` or `exhausted` outcome into its own one-line refusal; nothing
 * here prints a help page (see the module doc).
 */
export function askUntil<T>(
  streams: Streams,
  prompter: Prompter,
  question: string,
  validate: (answer: string) => AnswerVerdict<T>,
  options: { maxAttempts?: number } = {},
): AskOutcome<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  for (let attempts = 1; ; attempts += 1) {
    const answer = prompter.readLine(question);
    // Ctrl-D at the prompt, or the terminal going away. Distinct from an empty
    // line, which is an ordinary answer a validator may accept or refuse.
    if (answer === null) return { ok: false, reason: "aborted", attempts };
    const verdict = validate(answer);
    if (verdict.ok) return { ok: true, value: verdict.value };
    // The reason is printed for the LAST attempt too: an operator who has just
    // run out of tries is owed the same sentence as one who has not.
    streams.out(`  ${verdict.reason}\n`);
    if (attempts >= maxAttempts) return { ok: false, reason: "exhausted", attempts };
  }
}
