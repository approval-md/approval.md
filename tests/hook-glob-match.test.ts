/**
 * The hook's glob match runs in bounded time and answers as the old
 * expression did (B-HOOK-GLOB-LINEAR).
 *
 * `globRegex` compiled a glob component to an anchored regular expression,
 * and a component of many `*` made the engine backtrack: `cat` with 240 `*`
 * and 12 `z` ran the credential pass past Claude Code's 60 s hook timeout,
 * and a hook stopped by its timeout lets the call through. `globPattern`
 * replaces it with a set-of-positions match. These tests hold it to the old
 * expression's answer (ported below as the oracle) over a fixed table and a
 * few thousand seeded random cases, and bound one test of a long pattern.
 * tests/hook-glob-cost.test.ts bounds the hook's passes, through hook.ts only.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { globPattern } from "../src/core/glob-match.js";

/** The matcher this replaced, verbatim from src/cli/hook.ts at a521a91d: the oracle. */
function oracleGlobRegex(component: string): RegExp {
  let source = "";
  for (const char of component) {
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else if (char === "[" || char === "]") source += char;
    else source += char.replace(/[.+^${}()|\\]/gu, "\\$&");
  }
  try {
    return new RegExp(`^${source}$`, "u");
  } catch {
    return /^.*$/u;
  }
}

/** CPU milliseconds (user and system) spent in `run`: a shared runner's wall clock is no bound. */
function cpuMs(run: () => void): number {
  const start = process.cpuUsage();
  run();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000;
}

test("equivalence: globPattern answers as the old expression on a fixed table", () => {
  const names = [
    "", ".env", ".env.local", ".op.env", "auth.json", "env", "vault.enc", "keys", "config.yaml", "config.yml",
    "shell-hooks-allowlist.json", "agent-hooks", "approval", "scripts", "hermes-agent", "plugins", "profiles",
    ".hermes", ".approval", "p", "a", "z", "-", "!", "^", ".", "*", "?", "[", "]", "\\", "a\nb", "\n", "é", "😀",
    "file.txt", "x.ts",
  ];
  const patterns = [
    "*", "**", "?", "*.*", ".*", ".e*", "*env", "*en?", ".env*", "a*", "*a", "a*b", "*.json", "[ae]*", "[a-z]*",
    "[!a]*", "[^a]*", "[]", "[]a]", "]", "[", "[a", "a]", "[z-a]", "[a-]", "[-a]", "[--z]", "[a-b-c]", "[a--c]",
    "[a-b--z]", "[?]", "[*]", "[[]", "[.]", "[\\]", "[$^]", "*\n*", "?\n", "\\", "$", "(", "{a,b}", "a|b", "+",
    "h*", "p*", "[hp]*", "hermes-*", "plu*", "agent-h*", "*.yam?", "?*?*?", "*?", "?*", "é*", "*😀", "[é😀]",
    "[a-é]", "[😀-a]", "auth.jso[n]", ".op.en[v]", "[.]env", "keys*", "*[sy]", "*z", "z*",
  ];
  let checked = 0;
  for (const pattern of patterns) {
    const oracle = oracleGlobRegex(pattern);
    const ours = globPattern(pattern);
    for (const name of names) {
      assert.equal(ours.test(name), oracle.test(name), `pattern ${JSON.stringify(pattern)} name ${JSON.stringify(name)}`);
      checked += 1;
    }
  }
  assert.ok(checked > 2_000, String(checked));
});

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

test("equivalence: globPattern answers as the old expression on seeded random cases", () => {
  const random = generator(0x522);
  const patternAlphabet = [
    "*", "*", "*", "?", "?", "[", "[", "]", "]", "-", "-", "!", "^", ".", "a", "b", "e", "z", "\\", "\n", "\r", "é",
    "😀", "$", "(", "{", "|", "+", " ", "\ud800",
  ];
  const nameAlphabet = ["a", "b", "e", "z", ".", "-", "*", "?", "[", "]", "!", "^", "\n", "é", "😀", "\\", "$", " ", "\ud800"];
  const pick = (alphabet: readonly string[]): string => alphabet[Math.floor(random() * alphabet.length)] as string;
  const draw = (alphabet: readonly string[], max: number): string => {
    let text = "";
    const length = Math.floor(random() * (max + 1));
    for (let index = 0; index < length; index += 1) text += pick(alphabet);
    return text;
  };
  let matched = 0;
  let invalid = 0;
  const cases = 6_000;
  for (let index = 0; index < cases; index += 1) {
    const pattern = draw(patternAlphabet, 9);
    const name = draw(nameAlphabet, 8);
    const oracle = oracleGlobRegex(pattern);
    if (oracle.source === "^.*$" && pattern !== "*") invalid += 1;
    const expected = oracle.test(name);
    if (expected) matched += 1;
    assert.equal(globPattern(pattern).test(name), expected, `case ${String(index)}: pattern ${JSON.stringify(pattern)} name ${JSON.stringify(name)}`);
  }
  // The draw reaches both answers and the refused-pattern fallback.
  assert.ok(matched > 300, `matched ${String(matched)}`);
  assert.ok(invalid > 300, `invalid ${String(invalid)}`);

  // Names drawn to match: a pattern's own characters, with each `*` and `?`
  // replaced by a short run, so the true side is tested as hard as the false.
  let agreedTrue = 0;
  for (let index = 0; index < cases; index += 1) {
    const pattern = draw(["*", "?", "a", "b", "e", ".", "-", "[ab]", "[a-e]", "[!.]"], 7);
    let name = "";
    for (const part of pattern.match(/\[[^\]]*\]|./gu) ?? []) {
      if (part === "*") name += draw(["a", "b", "e", "."], 3);
      else if (part === "?") name += pick(["a", "b", "e", "."]);
      else if (part.startsWith("[")) name += pick(["a", "b", "e", "!", "."]);
      else name += part;
    }
    const expected = oracleGlobRegex(pattern).test(name);
    if (expected) agreedTrue += 1;
    assert.equal(globPattern(pattern).test(name), expected, `drawn match ${String(index)}: ${JSON.stringify(pattern)} ${JSON.stringify(name)}`);
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
  const random = generator(0x682);
  let checked = 0;
  let matched = 0;
  for (let index = 0; index < 4_000; index += 1) {
    let pattern = "";
    const parts = 1 + Math.floor(random() * 4);
    for (let part = 0; part < parts; part += 1) pattern += BRACKET_FRAGMENTS[Math.floor(random() * BRACKET_FRAGMENTS.length)] as string;
    for (const name of [...BRACKET_NAMES, spelled(pattern, "ab", "g"), spelled(pattern, "", "a")]) {
      const expected = oracleGlobRegex(pattern).test(name);
      assert.equal(globPattern(pattern).test(name), expected, `pattern ${JSON.stringify(pattern)} name ${JSON.stringify(name)}`);
      checked += 1;
      if (expected) matched += 1;
    }
  }
  assert.ok(checked === 4_000 * (BRACKET_NAMES.length + 2), String(checked));
  assert.ok(matched > 5_000, `matched ${String(matched)}`);
});

test("cost: one test of a long pattern is bounded, whatever it holds", () => {
  const long = [
    "*".repeat(100_000),
    "?*".repeat(50_000),
    `${"*a".repeat(50_000)}b`,
    `${"[ab]*".repeat(20_000)}z`,
    "[".repeat(100_000),
  ];
  const names = ["auth.json", ".env.local", "a".repeat(255), `${"ab".repeat(127)}z`];
  const ms = cpuMs(() => {
    for (const pattern of long) {
      const compiled = globPattern(pattern);
      for (const name of names) compiled.test(name);
    }
  });
  // About 125 CPU ms here for five 100,000-character patterns (the compile is
  // linear in the pattern); the bound is 8x that.
  assert.ok(ms < 1_000, `${ms.toFixed(1)} CPU ms, bound 1,000`);
});

test("cost: a class of many members is one binary search a character (codex caveat 2 on #682)", () => {
  // Testing a character against every member was P x N comparisons a name:
  // on bfa73710 these 20 names took 206 CPU ms at P = 5,000 and 1,956 for
  // both sizes. About 55 CPU ms here for both (7 at P = 5,000; the rest is
  // sorting 50,000 members once); the bound is 9x that.
  const names = Array.from({ length: 20 }, (_, index) => `${"a".repeat(5_000)}Y${String(index)}`);
  const ms = cpuMs(() => {
    for (const members of [5_000, 50_000]) {
      const compiled = globPattern(`*[${"z".repeat(members)}]X`);
      for (const name of names) assert.equal(compiled.test(name), false);
    }
  });
  assert.ok(ms < 500, `${ms.toFixed(1)} CPU ms, bound 500`);
  // The merged ranges still answer as the members do.
  const mixed = globPattern("[zb-dz-za-ab-c0-9_]");
  for (const [name, expected] of [["a", true], ["d", true], ["e", false], ["z", true], ["5", true], ["_", true], ["y", false]] as const) {
    assert.equal(mixed.test(name), expected, name);
  }
});

test("cost: a run of unclosed `[` compiles in one pass", () => {
  const ms = cpuMs(() => {
    for (const length of [2_000, 20_000, 200_000]) {
      const compiled = globPattern("[".repeat(length));
      assert.equal(compiled.test(".git"), true, String(length)); // the refused expression matched every name
    }
  });
  // The hook's reader never rescanned (an unclosed `[` ends the compile):
  // about 9 CPU ms here, 35 on bfa73710; the bound is 10x.
  assert.ok(ms < 100, `${ms.toFixed(1)} CPU ms, bound 100`);
});
