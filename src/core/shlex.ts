/**
 * Shell word splitting and joining, for the one place this runtime reads a
 * command as a RENDERING of an argv rather than as bytes it was handed
 * (APRV-362).
 *
 * ## Why this exists at all
 *
 * Every harness hook is handed a command as a string, and the classifier reads
 * that string. Codex's app-server is the exception: what it will execute is an
 * argv, and the item-based API delivers that argv already joined into one
 * string by `shlex_join` (`docs/codex-app-server-bridge.md`, question 1). A
 * bridge that classified the joined string without ever naming the argv would
 * be approving its own re-parse, and the gap between the two is where an
 * approval could authorize words nobody read.
 *
 * So the bridge names the argv, and these functions are how. They are pure,
 * total and exhaustively tested, which is what SPEC.md §11's deterministic-core
 * rule asks of anything a decision rests on.
 *
 * ## The grammar, and why it is narrower than a shell's
 *
 * This is `shlex`, not a shell. It knows three things: runs of whitespace
 * separate words, a single-quoted run is literal, and a backslash outside
 * quotes makes the next character literal. It does NOT know operators: `>`,
 * `|`, `&&` and `;` are ordinary characters in ordinary words. That is correct
 * here, because what is being un-joined is an argv and an argv has no
 * operators. The shell metacharacters in a real Codex call live INSIDE one word
 * (`/bin/zsh -lc 'printf x > f'`), and the hook's own classifier is what reads
 * that word as a script.
 *
 * A DOUBLE QUOTE outside a single-quoted run is refused rather than
 * interpreted. A join never emits one: a word needing protection comes back
 * single-quoted and a word not needing it comes back bare. So a bare `"` says
 * the string was not produced by joining an argv, and this runtime will not
 * guess whose escaping rules apply inside it. Refusing is the fail-closed
 * direction and it costs nothing a real server sends.
 *
 * ## The round trip, and the one thing it does not claim
 *
 * {@link shlexJoin} quotes a word when, and only when, {@link shlexSplit} would
 * otherwise read it as something else: an empty word, or one carrying
 * whitespace, a quote or a backslash. That makes
 * `shlexSplit(shlexJoin(argv)).argv` equal to `argv` for every argv, which is
 * the property {@link shlexRoundTrips} states and the bridge checks before it
 * binds either value.
 *
 * The converse is NOT claimed: `shlexJoin(shlexSplit(text).argv)` is a normal
 * form of `text`, not `text` itself. A counterpart is free to quote more
 * conservatively than this does (a join written for shell safety quotes `>` and
 * `:`, which this one leaves bare), and byte equality with the received string
 * would therefore mean pinning that counterpart's quoting predicate. This
 * repository has no record of it and cannot acquire one here, so demanding
 * equality would refuse traffic on a guess. What is demanded instead is
 * {@link ShlexSplit.joinShaped}: words separated by exactly one space, which
 * every join produces and which is checkable without knowing which characters
 * it chose to quote. The bridge records the received string and the argv side
 * by side so any remaining difference is visible rather than asserted away.
 */

/** Whitespace that separates words. Everything else is a word character. */
const SEPARATORS = new Set([" ", "\t", "\n", "\r", "\f", "\v"]);

/** A word must be quoted when a bare rendering would not read back as itself. */
const NEEDS_QUOTING = /[\s'"\\]/u;

export type ShlexSplit =
  | {
      ok: true;
      argv: string[];
      /**
       * Were the words separated by exactly one space each, with none before
       * the first or after the last?
       *
       * True of every string a join produces. False says the string reached
       * this runtime some other way, which is a fact about the counterpart
       * rather than about the argv, and the caller decides what to do with it.
       */
      joinShaped: boolean;
    }
  | { ok: false; reason: string };

/**
 * Split a joined command string into the argv it renders.
 *
 * Refuses rather than guessing on the three shapes whose reading is not agreed:
 * an unterminated single-quoted run, a trailing backslash with nothing to
 * escape, and a double quote outside a quoted run (see the module header).
 */
export function shlexSplit(text: string): ShlexSplit {
  const argv: string[] = [];
  let word = "";
  /** Distinct from `word.length > 0`: `''` is an empty word, not no word. */
  let started = false;
  let joinShaped = true;
  let index = 0;

  while (index < text.length) {
    const char = text[index] as string;
    if (SEPARATORS.has(char)) {
      // A separator before any word, one that is not a plain space, or a second
      // one in a row: all three are shapes a join does not emit.
      if (!started || char !== " " || SEPARATORS.has(text[index + 1] ?? "")) joinShaped = false;
      if (started) {
        argv.push(word);
        word = "";
        started = false;
      }
      index += 1;
      continue;
    }
    if (char === "'") {
      const close = text.indexOf("'", index + 1);
      if (close === -1) {
        return {
          ok: false,
          reason: `a single-quoted run opened at offset ${String(index)} is never closed`,
        };
      }
      word += text.slice(index + 1, close);
      started = true;
      index = close + 1;
      continue;
    }
    if (char === '"') {
      return {
        ok: false,
        reason: `a double quote at offset ${String(index)} is outside any quoted run, and a joined argv never carries one`,
      };
    }
    if (char === "\\") {
      if (index + 1 >= text.length) {
        return { ok: false, reason: "the string ends in a backslash with nothing to escape" };
      }
      word += text[index + 1] as string;
      started = true;
      index += 2;
      continue;
    }
    word += char;
    started = true;
    index += 1;
  }

  if (started) argv.push(word);
  else if (text.length > 0) joinShaped = false;
  return { ok: true, argv, joinShaped };
}

/**
 * Render an argv as one command string that {@link shlexSplit} reads back as
 * the same argv.
 *
 * Minimal quoting: a word is emitted bare unless it is empty or carries
 * whitespace, a quote or a backslash, in which case it is single-quoted with
 * the `'\''` idiom for an embedded quote. That idiom closes the run, escapes
 * one quote and opens the next, which is three pieces of ONE word rather than
 * three words, because nothing separates them.
 */
export function shlexJoin(argv: readonly string[]): string {
  return argv
    .map((word) =>
      word.length > 0 && !NEEDS_QUOTING.test(word) ? word : `'${word.split("'").join("'\\''")}'`,
    )
    .join(" ");
}

/**
 * Does `argv` survive a render-and-re-split cycle unchanged?
 *
 * True for every argv this module can render, and checked anyway at the one
 * call site that binds an argv to an approval: a parser bug here would bind
 * words nobody is going to run, and the cost of proving otherwise is one pass
 * over a short string.
 */
export function shlexRoundTrips(argv: readonly string[]): boolean {
  const back = shlexSplit(shlexJoin(argv));
  if (!back.ok || back.argv.length !== argv.length) return false;
  return back.argv.every((word, at) => word === argv[at]);
}
