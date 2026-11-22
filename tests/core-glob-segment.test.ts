/**
 * The `.git` reader's glob match answers as its old expression did, in
 * bounded time (B-HOOK-GLOB-LINEAR).
 *
 * `globSegmentMatches` (src/core/command-class.ts) turned a pattern into one
 * anchored expression (`*` as `[^/]*`, letter case ignored) and a run of `*`
 * made the engine backtrack. It now tests each piece of that expression as a
 * one-character expression and walks the name once. The old function is
 * ported below, verbatim but for its name and the inlined
 * `isPatternSegment`, as the oracle.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { globSegmentMatches, mayNameGitDirectory } from "../src/core/command-class.js";

/** The matcher this replaced, from src/core/command-class.ts at a521a91d: the oracle. */
function oracleSegmentMatches(pattern: string, name: string): boolean {
  if (!/[*?[]/u.test(pattern)) return pattern.toLowerCase() === name.toLowerCase();
  if (name.startsWith(".") && (pattern.startsWith("*") || pattern.startsWith("?"))) return false;
  let source = "";
  for (let at = 0; at < pattern.length; at += 1) {
    const char = pattern[at] as string;
    if (char === "\\" && at + 1 < pattern.length) {
      at += 1;
      source += (pattern[at] as string).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "[") {
      // A bracket expression: a leading `!` or `^` negates it and a leading
      // `]` is a member; a POSIX class, equivalence class or collating
      // element (`[:alpha:]`, `[=g=]`, `[.g.]`) is skipped to its own close
      // and makes the expression match ANY one character, the strict side
      // (review of the second fold). Unclosed, the `[` is a literal.
      let close = at + 1;
      if (pattern[close] === "!" || pattern[close] === "^") close += 1;
      if (pattern[close] === "]") close += 1;
      let posix = false;
      while (close < pattern.length && pattern[close] !== "]") {
        const kind = pattern[close + 1];
        if (pattern[close] === "[" && (kind === ":" || kind === "=" || kind === ".")) {
          const end = pattern.indexOf(`${kind}]`, close + 2);
          if (end === -1) {
            posix = true;
            close = pattern.length;
            break;
          }
          posix = true;
          close = end + 2;
          continue;
        }
        close += 1;
      }
      if (close >= pattern.length) {
        // Unclosed: a literal `[`, unless a class inside it left the reading
        // uncertain, which the strict side reads as any characters.
        source += posix ? "[^/]*" : "\\[";
        if (posix) break;
        continue;
      }
      if (posix) {
        source += "[^/]";
        at = close;
        continue;
      }
      let body = pattern.slice(at + 1, close);
      const negated = body.startsWith("!") || body.startsWith("^");
      if (negated) body = body.slice(1);
      source += `[${negated ? "^" : ""}${body.replace(/[\\\]^]/gu, "\\$&")}]`;
      at = close;
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    }
  }
  try {
    return new RegExp(`^${source}$`, "iu").test(name);
  } catch {
    // A bracket expression this reader cannot turn into one: the strict side.
    return true;
  }
}

/** CPU milliseconds (user and system) spent in `run`. */
function cpuMs(run: () => void): number {
  const start = process.cpuUsage();
  run();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000;
}

/** mulberry32: a fixed-seed generator, so every run draws the same cases. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("equivalence: globSegmentMatches answers as the old expression on a fixed table", () => {
  const names = [
    "", ".git", ".GIT", ".Git", "git", ".gitx", "x.git", ".g", "a", "A", "z", "-", "!", "^", ".", "/", "a/b", "[", "]",
    "\\", "\n", "é", "É", "😀", "\u212a", "k", "K", "\u017f", "s", "S", ".hermes", "config", "HEAD", "hooks",
  ];
  const patterns = [
    "*", "**", "?", ".*", ".g*", ".g*t", ".[g]it", ".[G]IT", "[.]git", ".gi?", "*git", "?git", "[!a]*", "[^a]*",
    "[!.]*", "[]]", "[]a]", "[!]]", "[", "[a", "a[", "]", "[z-a]", "[a-z]", "[A-Z]*", "[a-]", "[-a]", "[[:alpha:]]",
    "[[:alpha:]", "[[=g=]]", "[[.g.]]", "x[[:", "[a[:alpha:]b]", "\\*", "\\?", "\\[", "\\", "a\\", "\\a*",
    "*/*", "[/]", "?\n", "*\n", "\u212a*", "[k]", "[\u212a]", "\u017f", "[s-t]", "é*", "[é]", "😀*", "[😀]",
    "\\😀", "\ud83d*", "*\ude00", "[\\]", "[\\]]", "[a\\-z]", "[$]", "(*)", "{a,b}", "a|b", "+*", "*.*",
  ];
  let checked = 0;
  for (const pattern of patterns) {
    for (const name of names) {
      assert.equal(globSegmentMatches(pattern, name), oracleSegmentMatches(pattern, name), `pattern ${JSON.stringify(pattern)} name ${JSON.stringify(name)}`);
      checked += 1;
    }
  }
  assert.ok(checked > 2_000, String(checked));
});

test("equivalence: globSegmentMatches answers as the old expression on seeded random cases", () => {
  const random = generator(0x9e7);
  const patternAlphabet = [
    "*", "*", "*", "?", "?", "[", "[", "]", "]", "!", "^", "-", ".", "g", "G", "i", "t", "a", "z", "/", "\\", "\\",
    "[:alpha:]", "[=g=]", "[.", ":", "\n", "é", "😀", "\ud83d", "\ude00", "\u212a", "k", "$", "(", "|",
  ];
  const nameAlphabet = [".", "g", "G", "i", "t", "a", "z", "k", "K", "/", "!", "-", "[", "]", "\\", "\n", "é", "😀", "\ud83d", "\ude00", "\u212a"];
  const pick = (alphabet: readonly string[]): string => alphabet[Math.floor(random() * alphabet.length)] as string;
  const draw = (alphabet: readonly string[], max: number): string => {
    let text = "";
    const length = Math.floor(random() * (max + 1));
    for (let index = 0; index < length; index += 1) text += pick(alphabet);
    return text;
  };
  let matched = 0;
  const cases = 6_000;
  for (let index = 0; index < cases; index += 1) {
    const pattern = draw(patternAlphabet, 8);
    const name = random() < 0.3 ? ".git" : draw(nameAlphabet, 7);
    const expected = oracleSegmentMatches(pattern, name);
    if (expected) matched += 1;
    assert.equal(globSegmentMatches(pattern, name), expected, `case ${String(index)}: pattern ${JSON.stringify(pattern)} name ${JSON.stringify(name)}`);
  }
  assert.ok(matched > 150, `matched ${String(matched)}`);

  // Names drawn to match, so the true side is tested as hard as the false.
  let agreedTrue = 0;
  for (let index = 0; index < cases; index += 1) {
    const pattern = draw(["*", "?", ".", "g", "I", "t", "[gG]", "[!.]", "[a-z]", "\\*"], 6);
    let name = "";
    for (const part of pattern.match(/\[[^\]]*\]|\\.|./gu) ?? []) {
      if (part === "*") name += draw(["g", "i", "T", "."], 3);
      else if (part === "?") name += pick(["g", "i", "T", "."]);
      else if (part.startsWith("[")) name += pick(["g", "G", "q", "."]);
      else if (part.startsWith("\\")) name += part.slice(1);
      else name += random() < 0.5 ? part.toUpperCase() : part;
    }
    const expected = oracleSegmentMatches(pattern, name);
    if (expected) agreedTrue += 1;
    assert.equal(globSegmentMatches(pattern, name), expected, `drawn match ${String(index)}: ${JSON.stringify(pattern)} ${JSON.stringify(name)}`);
  }
  assert.ok(agreedTrue > 1_000, `true answers ${String(agreedTrue)}`);
});

test("cost: a long `*` run is matched in bounded CPU time", () => {
  // 8 `*` and 12 `z` against a directory's names took 36.7 CPU s through the
  // hook on a521a91d. About 50 CPU ms here for all of these; the bound is 10x.
  const names = [".git", "auth.json", "package-lock.json", "a".repeat(255), `${"ab".repeat(127)}z`];
  const patterns = [
    `${"*".repeat(8)}${"z".repeat(12)}`,
    `${"*".repeat(240)}${"z".repeat(12)}`,
    `.${"*".repeat(2000)}${"z".repeat(12)}`,
    `${"?*".repeat(50_000)}`,
    `.${"*g".repeat(20_000)}`,
    `${"[[:alpha:]]*".repeat(5_000)}z`,
  ];
  const ms = cpuMs(() => {
    for (const pattern of patterns) {
      for (const name of names) globSegmentMatches(pattern, name);
      mayNameGitDirectory(`x/${pattern}/y`);
    }
  });
  assert.ok(ms < 500, `${ms.toFixed(1)} CPU ms, bound 500`);
});
