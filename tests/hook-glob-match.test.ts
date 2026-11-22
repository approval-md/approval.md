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
