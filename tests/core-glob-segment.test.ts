/**
 * The `.git` reader's glob match answers as its old expression did, in
 * bounded time (B-HOOK-GLOB-LINEAR, kept after #680).
 *
 * `globSegmentMatches` (src/core/command-class.ts) turned a pattern into one
 * anchored expression (`*` as `[^/]*`, letter case ignored) and a run of `*`
 * made the engine backtrack. #680 (APRV-518) replaced it with its own walk
 * over a pattern's elements, reading a run of unclosed `[` once and judging
 * a pattern past 1,024 glob characters to match (the strict side). These
 * tests hold that walk to the old expression: the old function is ported
 * below, verbatim but for its name and the inlined `isPatternSegment`, as
 * the oracle, on patterns well under that limit, and the cost cases bound it
 * on both sides of the limit.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { globSegmentMatches, mayNameGitDirectory } from "../src/core/command-class.js";
import { foldNameLower } from "../src/core/name-fold.js";

/** The matcher this replaced, from src/core/command-class.ts at a521a91d: the oracle. */
function oracleSegmentMatches(pattern: string, name: string): boolean {
  // A literal segment compares as #688 folds a guarded name (`name-fold.ts`):
  // `ſ` opens `s` on APFS. The rest is the expression at a521a91d.
  if (!/[*?[]/u.test(pattern)) return foldNameLower(pattern) === foldNameLower(name);
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

/**
 * Hold the reader to the oracle: equal, except that a pattern holding `[^`
 * or `[!` may match more (review-b's FINDING on #682: dash reads `^` as a
 * member, so `.gi[^t]` names `.git` there; review-b's M-A on 83f30bdc: an
 * escaped `!` reaches the reader as `[!t]`, a member to every shell; the
 * reader now reads both as any one character, and `[^]`, `[!]` as any
 * name). It still matches every name the oracle matched.
 */
function assertAsOracle(pattern: string, name: string, label: string): boolean {
  const expected = oracleSegmentMatches(pattern, name);
  const actual = globSegmentMatches(pattern, name);
  if (pattern.includes("[^") || pattern.includes("[!")) {
    if (expected) assert.equal(actual, true, `${label} (wider)`);
  } else {
    assert.equal(actual, expected, label);
  }
  return expected;
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
      assertAsOracle(pattern, name, `pattern ${JSON.stringify(pattern)} name ${JSON.stringify(name)}`);
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
    if (assertAsOracle(pattern, name, `case ${String(index)}: pattern ${JSON.stringify(pattern)} name ${JSON.stringify(name)}`)) matched += 1;
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
    if (assertAsOracle(pattern, name, `drawn match ${String(index)}: ${JSON.stringify(pattern)} ${JSON.stringify(name)}`)) agreedTrue += 1;
  }
  assert.ok(agreedTrue > 1_000, `true answers ${String(agreedTrue)}`);
});

/**
 * Bracket shapes (codex S1 and caveat 2 on #682): malformed and POSIX
 * brackets, `[]...]`, `[!...]`, `[^...]` and reversed ranges, each joined
 * with stars and with one another. Patterns are one to four fragments drawn
 * with a fixed seed; each is tested against a fixed list of names and against
 * two names spelled from the pattern itself, so a literal `[` or `]` is
 * matched as often as it is missed.
 */
const BRACKET_FRAGMENTS = [
  "*", "**", "?", "[", "[[", "]", "[]", "[]a]", "[]]", "[!a]", "[^a]", "[!]", "[^]]", "[!]a]", "[a-c]", "[c-a]",
  "[a-]", "[-a]", "[[:alpha:]]", "[[:alpha:]", "[[=g=]]", "[[.g.]]", "[[:", ":]", "=]", "[a", "a]", "[a[b]",
  "[*]", "[?]", "[.]", "[!.]", "g", "G", ".", "a", "\\[", "\\*", "\\]", "[\\]", "[z-a]*", "*[", "[*",
];
const BRACKET_NAMES = [
  "", ".git", ".GIT", "git", "a", "A", "b", "c", "g", "z", ".", "]", "[", "[]", "!", "^", "-", ":", "*", "?", "\\",
  "a]", "[a", "ab", "abc", "ga", "]a", "[a-c]", "/", "a/b", "\n", "é",
];

/** A name spelled from `pattern`: `*` as `fill`, `?` as `one`, everything else as written. */
function spelled(pattern: string, fill: string, one: string): string {
  return pattern.replace(/\*/gu, fill).replace(/\?/gu, one);
}

test("equivalence: bracket shapes joined with stars answer as the old expression", () => {
  const random = generator(0x683);
  let checked = 0;
  let matched = 0;
  for (let index = 0; index < 4_000; index += 1) {
    let pattern = "";
    const parts = 1 + Math.floor(random() * 4);
    for (let part = 0; part < parts; part += 1) pattern += BRACKET_FRAGMENTS[Math.floor(random() * BRACKET_FRAGMENTS.length)] as string;
    for (const name of [...BRACKET_NAMES, spelled(pattern, "ab", "g"), spelled(pattern, "", "a")]) {
      const expected = assertAsOracle(pattern, name, `pattern ${JSON.stringify(pattern)} name ${JSON.stringify(name)}`);
      checked += 1;
      if (expected) matched += 1;
    }
  }
  assert.ok(checked === 4_000 * (BRACKET_NAMES.length + 2), String(checked));
  assert.ok(matched > 5_000, `matched ${String(matched)}`);
});

test("negation: `[^...]` names `.git` wherever dash would open it (review-b's FINDING on #682)", () => {
  // dash reads `[^t]` as the members `^` and `t`: `.gi[^t]` opens `.git`.
  // bash and zsh negate it: `.gi[^a]` opens `.git`. Both are now names of it.
  for (const word of [".gi[^t]", ".gi[^a]", ".g[^]i]t", ".gi[^t]/config", "x/.g[^x]t/HEAD"]) {
    assert.equal(mayNameGitDirectory(word), true, word);
  }
  // A class the old expression could not build stays the strict unknown
  // (codex on 83f30bdc): `[^z-a]` names `.git`, as it did before.
  assert.equal(globSegmentMatches("[^z-a]", ".git"), true);
  assert.equal(mayNameGitDirectory("[^z-a]"), true);
  assert.equal(mayNameGitDirectory("x/[^z-a]/HEAD"), true);
  // `[!...]` too: `.gi[\\!t]` reaches the reader as `.gi[!t]` (review-b's
  // M-A on 83f30bdc), and every shell opens `.git` for it.
  for (const word of [".gi[!t]", ".gi[!a]", ".g[!i]t/config", "[!z-a]git"]) assert.equal(mayNameGitDirectory(word), true, word);
  assert.equal(globSegmentMatches(".gi[!t]x", ".git"), false);
});

test("cost: a long `*` run is matched in bounded CPU time", () => {
  // 8 `*` and 12 `z` against a directory's names took 36.7 CPU s through the
  // hook on a521a91d. The 240 and 1,000 `*` cases are under #680's 1,024
  // limit, so they are walked; the rest are past it and judged to match.
  // About 15 CPU ms here for all of these; the bound is 30x.
  const names = [".git", "auth.json", "package-lock.json", "a".repeat(255), `${"ab".repeat(127)}z`];
  const patterns = [
    `${"*".repeat(8)}${"z".repeat(12)}`,
    `${"*".repeat(240)}${"z".repeat(12)}`,
    `.${"*".repeat(1_000)}${"z".repeat(12)}`,
    `.${"*".repeat(2_000)}${"z".repeat(12)}`,
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
  // Measuring only (#720's list): the reading, printed before it is judged.
  console.log(`# cost-line: CGS long star run: ${ms.toFixed(1)} CPU ms (bound 500, not stretched; node ${process.version})`);
  assert.ok(ms < 500, `${ms.toFixed(1)} CPU ms, bound 500`);
});

test("cost: a run of unclosed `[` is scanned once, not once per `[` (codex S1 on #682)", () => {
  // Each `[` scanned to the end of the pattern: n(n-1)/2 steps, 28 CPU ms at
  // n = 2,000 and 2.3 CPU s at 20,000 on bfa73710 (14 s at 50,000). #680
  // reads a run once (1,000 here, under its limit) and judges a pattern past
  // 1,024 glob characters without reading it. About 5 CPU ms here for all of
  // these; the bound is 100x.
  const ms = cpuMs(() => {
    for (const length of [1_000, 2_000, 20_000, 50_000]) {
      for (const pattern of ["[".repeat(length), `*${"[".repeat(length)}*`, `${"[!".repeat(length / 2)}`, `${"[[:".repeat(length / 3)}`]) {
        globSegmentMatches(pattern, ".git");
        globSegmentMatches(pattern, "x");
        mayNameGitDirectory(`a/${pattern}/b`);
      }
    }
  });
  // Measuring only (#720's list): the reading, printed before it is judged.
  console.log(`# cost-line: CGS unclosed bracket runs: ${ms.toFixed(1)} CPU ms (bound 500, not stretched; node ${process.version})`);
  assert.ok(ms < 500, `${ms.toFixed(1)} CPU ms, bound 500`);
});

test("cost: a class of many members is matched in bounded CPU time", () => {
  const names = Array.from({ length: 20 }, (_, index) => `${"a".repeat(5_000)}Y${String(index)}`);
  const ms = cpuMs(() => {
    for (const members of [5_000, 50_000]) {
      for (const name of names) assert.equal(globSegmentMatches(`*[${"z".repeat(members)}]X`, name), false);
    }
  });
  // A guard: the `.git` reader tests each character with one cached
  // one-character expression, so this was never P x N. About 7 CPU ms here
  // (#680's walk); the bound is 20x.
  // Measuring only (#720's list): the reading, printed before it is judged.
  console.log(`# cost-line: CGS class of many members: ${ms.toFixed(1)} CPU ms (bound 150, not stretched; node ${process.version})`);
  assert.ok(ms < 150, `${ms.toFixed(1)} CPU ms, bound 150`);
});
