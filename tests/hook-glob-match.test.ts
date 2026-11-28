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
 *
 * Where the old expression read a form unlike the shell (review-b's FINDING
 * on 8c91e702: `[!x]` and `[^x]` were literal members, so
 * `cat ~/.hermes/[!x]uth.json` was not a credential read), the reader now
 * matches at least what the shell opens: a negated class is compared with
 * bash, zsh and dash themselves (where installed), and every other changed
 * form matches at least what the old expression matched.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ratioJudged, type RatioRule, runner } from "./cost-runner.js";

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

/**
 * How the oracle holds for `pattern`: `"negated"` when it holds `[!` or `[^`
 * (the old expression read those as members; tested against the shells
 * below), `"equal"` when it holds none of the forms the reader now reads more
 * widely (see src/core/glob-match.ts), else `"wider"`: the reader matches
 * every name the old expression matched, and maybe more. Conservative: a
 * pattern may be called `"wider"` and still answer equal.
 */
function oracleHolds(pattern: string): "negated" | "equal" | "wider" {
  if (pattern.includes("[!") || pattern.includes("[^")) return "negated";
  if (/[\\()|<>#~^]/u.test(pattern)) return "wider";
  const chars = Array.from(pattern);
  for (let at = 0; at < chars.length; at += 1) {
    if (chars[at] !== "[") continue;
    const close = chars.indexOf("]", at + 1);
    if (close === -1) return "equal"; // unclosed: any name, before and after
    const body = chars.slice(at + 1, close);
    if (body.length === 0 || body.includes("[") || body.includes("?")) return "wider";
    // A `-` between members is a range, which may now hold more.
    if (body.slice(1, -1).includes("-") || (body.length > 1 && body[0] === "*" && body[1] === "-")) return "wider";
    at = close;
  }
  return "equal";
}

/** Did the old expression fail to build for `pattern`, and fall back to `^.*$` (the strict side)? */
function oracleFellBack(pattern: string): boolean {
  return pattern !== "*" && oracleGlobRegex(pattern).source === "^.*$";
}

/**
 * {@link oracleHolds} for one name: a letter now matches either case
 * (nocaseglob, case-insensitive volumes), and a pattern the old expression
 * could not build now matches a name with a line terminator too (codex on
 * 83f30bdc), so either makes an `"equal"` pattern `"wider"` for that name.
 */
function holdsFor(pattern: string, name: string): "negated" | "equal" | "wider" {
  const holds = oracleHolds(pattern);
  if (holds !== "equal") return holds;
  if (/[A-Z]/u.test(pattern + name)) return "wider";
  if (oracleFellBack(pattern) && /[\n\r\u2028\u2029]/u.test(name)) return "wider";
  return "equal";
}

/**
 * Assert the reader against the oracle as {@link holdsFor} says; true when it
 * was compared for equality. A negated pattern is held to the old expression
 * where that was strict (it fell back to any name: `[!z-a]`), and to the
 * shells everywhere else (the negation tests below).
 */
function againstOracle(pattern: string, name: string, label: string): boolean {
  const holds = holdsFor(pattern, name);
  const expected = oracleGlobRegex(pattern).test(name);
  const actual = globPattern(pattern).test(name);
  if (holds === "negated") {
    if (oracleFellBack(pattern) && expected) assert.equal(actual, true, `${label} (negated: the old expression fell back to any name)`);
    return false;
  }
  if (holds === "equal") {
    assert.equal(actual, expected, label);
    return true;
  }
  if (expected) assert.equal(actual, true, `${label} (wider: still matches what the old expression matched)`);
  return false;
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
    for (const name of names) {
      if (againstOracle(pattern, name, `pattern ${JSON.stringify(pattern)} name ${JSON.stringify(name)}`)) checked += 1;
    }
  }
  assert.ok(checked > 1_600, String(checked));
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
  let equal = 0;
  const cases = 6_000;
  for (let index = 0; index < cases; index += 1) {
    const pattern = draw(patternAlphabet, 9);
    const name = draw(nameAlphabet, 8);
    const oracle = oracleGlobRegex(pattern);
    if (holdsFor(pattern, name) !== "equal") {
      againstOracle(pattern, name, `case ${String(index)}: pattern ${JSON.stringify(pattern)} name ${JSON.stringify(name)}`);
      continue;
    }
    equal += 1;
    if (oracle.source === "^.*$" && pattern !== "*") invalid += 1;
    const expected = oracle.test(name);
    if (expected) matched += 1;
    assert.equal(globPattern(pattern).test(name), expected, `case ${String(index)}: pattern ${JSON.stringify(pattern)} name ${JSON.stringify(name)}`);
  }
  // The draw reaches both answers and the refused-pattern fallback.
  assert.ok(equal > 1_500, `compared for equality ${String(equal)}`);
  assert.ok(matched > 100, `matched ${String(matched)}`);
  assert.ok(invalid > 100, `invalid ${String(invalid)}`);

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
    if (!againstOracle(pattern, name, `drawn match ${String(index)}: ${JSON.stringify(pattern)} ${JSON.stringify(name)}`)) continue;
    if (expected) agreedTrue += 1;
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
      if (!againstOracle(pattern, name, `pattern ${JSON.stringify(pattern)} name ${JSON.stringify(name)}`)) continue;
      checked += 1;
      if (expected) matched += 1;
    }
  }
  assert.ok(checked > 20_000, String(checked));
  assert.ok(matched > 2_000, `matched ${String(matched)}`);
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
  // Measuring only (#720's list): the reading, printed before it is judged.
  console.log(`# cost-line: HGM long patterns: ${ms.toFixed(1)} CPU ms (bound 1000, not stretched; node ${process.version})`);
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
  // Measuring only (#720's list): the reading, printed before it is judged.
  console.log(`# cost-line: HGM class of many members: ${ms.toFixed(1)} CPU ms (bound 500, not stretched; node ${process.version})`);
  assert.ok(ms < 500, `${ms.toFixed(1)} CPU ms, bound 500`);
  // The merged ranges still answer as the members do.
  const mixed = globPattern("[zb-dz-za-ab-c0-9_]");
  for (const [name, expected] of [["a", true], ["d", true], ["e", false], ["z", true], ["5", true], ["_", true], ["y", false]] as const) {
    assert.equal(mixed.test(name), expected, name);
  }
});

/**
 * The unclosed `[` compile block's RATIO rule (#720's list), CPU ms. The plain
 * patterns cost more than the run (an unclosed `[` ends the compile): CI read
 * 0.43 at most (run 46145131980, attempts 1 and 2, node 22), so R is 2; the
 * control's figure is its largest least reading there. The walk, a rescan from
 * every `[`, took 35 CPU ms on bfa73710 where this block takes 9 and its
 * control 4: about 9 times the control, half of it 4.4.
 */
const UNCLOSED_RULE: RatioRule = { ratioBound: 2, controlCi: 17.3, most: 3 };

test("cost: a run of unclosed `[` compiles in one pass", () => {
  const ms = cpuMs(() => {
    for (const length of [2_000, 20_000, 200_000]) {
      const compiled = globPattern("[".repeat(length));
      assert.equal(compiled.test(".git"), true, String(length)); // the refused expression matched every name
    }
  });
  // The hook's reader never rescanned (an unclosed `[` ends the compile):
  // about 9 CPU ms here, 35 on bfa73710; the bound is 10x.
  // Since #720 the block is held by the RATIO rule ({@link UNCLOSED_RULE}),
  // not by the 100 CPU ms, which is printed (CI read 36.2 of it with the
  // code unchanged): the block read twice more beside three readings of
  // plain patterns of the same lengths, the least of each judged. globPattern
  // keeps what it compiled, keyed on the pattern, so each reading adds
  // `round` to each length: a pattern never compiled before, as the first
  // reading had.
  {
    let round = 0;
    const block = (unit: string): void => {
      round += 1;
      for (const length of [2_000, 20_000, 200_000]) globPattern(unit.repeat(length + round)).test(".git");
    };
    const calls = [ms];
    const plains: number[] = [];
    for (let again = 0; again < 2; again += 1) {
      plains.push(cpuMs(() => block("a")));
      calls.push(cpuMs(() => block("[")));
    }
    plains.push(cpuMs(() => block("a")));
    const least = Math.min(...calls);
    const leastPlain = Math.min(...plains);
    const ratio = least / Math.max(leastPlain, 0.001);
    const { controlBound, lineOver, controlOver } = ratioJudged(ratio, leastPlain, UNCLOSED_RULE, runner().factor);
    console.log(
      `# cost-line: HGM unclosed bracket run: ${least.toFixed(1)} CPU ms (the least of 3, calls ${calls.map((x) => x.toFixed(1)).join(" ")}; control ${leastPlain.toFixed(2)}, ratio ${ratio.toFixed(2)} of ${String(UNCLOSED_RULE.ratioBound)}; the control's own bound ${controlBound.toFixed(2)}; the fixed 100 is printed, not asserted; ${runner().line})`,
    );
    assert.ok(!lineOver, `the block: ${least.toFixed(1)} CPU ms, ${ratio.toFixed(2)} times its control, bound ${String(UNCLOSED_RULE.ratioBound)}`);
    assert.ok(!controlOver, `the control: ${leastPlain.toFixed(2)} CPU ms, its own bound ${controlBound.toFixed(2)}`);
  }
});

/**
 * Each shell's script: from the directory `$1`, expand every pattern in the
 * file `$2` (one a line, unquoted, never split) and print the matches as one
 * line, each followed by `/`. bash and zsh drop a pattern that matches
 * nothing (nullglob); dash keeps it as written, so only existing names count
 * (no name holds `[`, so a pattern is never itself a name).
 */
const SHELL_SCRIPTS: ReadonlyArray<{ shell: string; args: (script: string) => string[]; script: string }> = [
  {
    shell: "bash",
    args: (script) => ["--norc", "--noprofile", "-c", script, "glob"],
    script: [
      "shopt -s nullglob",
      'cd "$1" || exit 3',
      'while IFS= read -r p; do IFS=; set -- $p; unset IFS; for f in "$@"; do printf "%s/" "$f"; done; printf "\\n"; done < "$2"',
    ].join("\n"),
  },
  {
    shell: "zsh",
    args: (script) => ["-f", "-c", script, "glob"],
    script: [
      "setopt nullglob",
      'cd "$1" || exit 3',
      'while IFS= read -r p; do ( for f in ${~p}; do printf "%s/" "$f"; done ) 2>/dev/null; printf "\\n"; done < "$2"',
    ].join("\n"),
  },
  {
    shell: "dash",
    args: (script) => ["-c", script, "glob"],
    script: [
      'cd "$1" || exit 3',
      'while IFS= read -r p; do IFS=; for f in $p; do [ -e "$f" ] && printf "%s/" "$f"; done; unset IFS; printf "\\n"; done < "$2"',
    ].join("\n"),
  },
];

/**
 * What `shell` expands each pattern to in `dir`, in the C locale, or `null`
 * when that shell is not installed (bash is required: CI has it).
 */
function shellExpansions(shell: (typeof SHELL_SCRIPTS)[number], dir: string, patternsFile: string, count: number): Set<string>[] | null {
  const run = spawnSync(shell.shell, shell.args(shell.script).concat([dir, patternsFile]), {
    encoding: "utf8",
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", LC_ALL: "C", HOME: dir },
    timeout: 60_000,
  });
  if (run.error !== undefined && (run.error as NodeJS.ErrnoException).code === "ENOENT") return null;
  assert.equal(run.error, undefined, `${shell.shell}: ${String(run.error)}`);
  assert.equal(run.status, 0, `${shell.shell} exit ${String(run.status)}: ${run.stderr}`);
  const lines = run.stdout.split("\n").slice(0, count);
  assert.equal(lines.length, count, `${shell.shell} printed ${String(lines.length)} lines for ${String(count)} patterns`);
  return lines.map((line) => new Set(line.split("/").filter((name) => name.length > 0)));
}

test("negation: every `[!...]` and `[^...]` matches at least what bash, zsh and dash open, and is one character (review-b's FINDING)", () => {
  const random = generator(0x682f);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  // Made-up names in a scratch directory: no leading `.` (the shells never
  // match one with a class; the reader does, the strict side), no `[`, `\\`
  // or `/`. A case-insensitive file system folds `A` into `a`: the names
  // tested are what the directory lists.
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-glob-shell-")));
  try {
    const dir = join(scratch, "names");
    const nameAlphabet = ["a", "b", "e", "x", "z", "A", "Z", "1", "9", ".", "-", "_", "!", "^", "]", "*", "?", ":", "~"];
    const wanted = new Set<string>(nameAlphabet.filter((char) => char !== "."));
    for (const name of ["auth.json", "env", "xuth.json", "a.b", "e-x", "1_a"]) wanted.add(name);
    while (wanted.size < 160) {
      let name = pick(nameAlphabet.filter((char) => char !== "."));
      const length = Math.floor(random() * 4);
      for (let index = 0; index < length; index += 1) name += pick(nameAlphabet);
      wanted.add(name);
    }
    mkdirSync(dir);
    for (const name of wanted) writeFileSync(join(dir, name), "", "utf8");
    const names = readdirSync(dir);

    // Shapes the shells read alike: members, a leading `]`, ranges within one
    // ASCII group, the POSIX classes, never a lone `-` between members.
    // (`~`, `#` and the like make any name: zsh extended glob.)
    const members = ["a", "b", "e", "x", "A", "1", ".", "_", "!", "^", "*", "?", ":"];
    const ranges = ["a-e", "b-x", "A-Z", "0-9", "1-5", "x-z", "e-e"];
    const classes = ["[:alpha:]", "[:digit:]", "[:upper:]", "[:lower:]", "[:punct:]", "[:alnum:]", "[:space:]", "[:xdigit:]"];
    const negatedClass = (): string => {
      let body = random() < 0.15 ? "]" : random() < 0.1 ? "-" : "";
      const items = 1 + Math.floor(random() * 3);
      for (let index = 0; index < items; index += 1) {
        const kind = random();
        body += kind < 0.55 ? pick(members) : kind < 0.8 ? pick(ranges) : pick(classes);
      }
      if (random() < 0.1) body += "-";
      return `[!${body}]`;
    };
    const patterns: string[] = [];
    for (let index = 0; index < 400; index += 1) {
      let pattern = pick(["", "", "*", "?", "a", "x", "au"]) + negatedClass();
      if (random() < 0.3) pattern += pick(["", "*", "?"]) + negatedClass();
      pattern += pick(["", "", "*", "?", "e", "*e", "th.json", "nv"]);
      // Some `[^...]`, which dash reads with `^` as a member.
      if (index % 5 === 0) pattern = pattern.replace("[!", "[^");
      patterns.push(pattern);
    }
    const patternsFile = join(scratch, "patterns.txt");
    writeFileSync(patternsFile, `${patterns.join("\n")}\n`, "utf8");

    const results = SHELL_SCRIPTS.map((shell) => ({ shell: shell.shell, sets: shellExpansions(shell, dir, patternsFile, patterns.length) }));
    assert.ok(results[0]?.sets !== null && results[0]?.sets !== undefined, "bash is required for this test");
    let shellMatches = 0;
    let lengthChecked = 0;
    for (const [index, pattern] of patterns.entries()) {
      const compiled = globPattern(pattern);
      const ours = new Set(names.filter((name) => compiled.test(name)));
      for (const { shell, sets } of results) {
        if (sets === null) continue;
        shellMatches += (sets[index] as Set<string>).size;
        for (const name of sets[index] as Set<string>) {
          assert.ok(ours.has(name), `${shell} opens ${JSON.stringify(name)} for ${JSON.stringify(pattern)}; the reader does not`);
        }
      }
      // Each class is still one character: a pattern with no `*` matches
      // only names of its own length (the class not read as a run).
      // (`[!]`, `[^]`, a `?` or `[` inside a class, and a class the old
      // expression could not build, such as `[^-1]`, make any name.)
      if (!pattern.includes("*") && !/\[[!^]\]/u.test(pattern) && !/\[[^\]]*[?[]/u.test(pattern) && !oracleFellBack(pattern)) {
        const length = Array.from(pattern.replace(/\[[!^]\]?[^\]]*\]/gu, "c")).length;
        for (const name of ours) assert.equal(Array.from(name).length, length, `${JSON.stringify(pattern)} matched ${JSON.stringify(name)}`);
        lengthChecked += 1;
      }
    }
    assert.ok(shellMatches > 2_000, `the shells matched ${String(shellMatches)} names in all`);
    assert.ok(lengthChecked > 60, `length checked ${String(lengthChecked)}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("codex on 83f30bdc: a reversed range is the old fallback, negated or not, and the fallback matches every name", () => {
  // The old expression could not build these and matched every name; a
  // negated class must not narrow that to one character.
  for (const pattern of ["[!z-a]", "[^z-a]", "[z-a]", "[!b-a]x", "[^-!]", "*[!z-a]"]) {
    for (const name of ["auth.json", ".env", ".env.local", "vault.enc", "keys", "hermes-agent", "a", "a\nb"]) {
      assert.equal(globPattern(pattern).test(name), true, `${pattern} ${JSON.stringify(name)}`);
    }
  }
  // An undecided form matches a name with a line terminator, as the old
  // expression did for these two (a class holding the newline, a `?`).
  assert.equal(globPattern("[~\n]").test("\n"), true);
  assert.equal(globPattern("p#\n?").test("p#\n1"), true);
  assert.equal(globPattern("p#\n?").test("p#\n"), true);
  // A valid negated class is still one character.
  assert.equal(globPattern("[!a-z]").test("auth.json"), false);
  assert.equal(globPattern("[!a-z]uth.json").test("auth.json"), true);
});

test("negation: the forms the shells read apart, or this reader does not model, match any name", () => {
  // The lead's ruling (L60812): strict where it cannot decide. Each of these
  // can open auth.json in some shell, locale or option set.
  for (const pattern of [
    "[![:foo:]]uth.json", // an unknown class: zsh matches every character
    "[!A-c]uth.json", // across groups: bash 3.2 under en_US.UTF-8 opens auth.json
    "[!_-b]uth.json",
    "[!z-a]uth.json", // reversed
    "[![=a=]]uth.json",
    "[![.a.]]uth.json",
    "[![:alpha:]-z]uth.json",
    "[!a[]uth.json",
    "[!xuth.json", // unclosed
    "[^]x]uth.json", // the shells close it in different places
    "[]a]uth.json",
    "[a[]uth.json",
    "[a?]uth.json",
    "[A-H]uth.json", // bash 3.2 under en_US.UTF-8 reads h into it
    "[_-b]uth.json",
    "[\\x]uth.json",
    "\\auth.json",
    "@(a)uth.json",
    "!(x)uth.json",
    "(a|x)uth.json",
    "^x*",
    "*~x",
    "a#uth.json",
    "<1-2>auth.json",
  ]) {
    assert.equal(globPattern(pattern).test("auth.json"), true, pattern);
  }
  // `[!x]` and `[^x]` are any one character: dash reads `^` as a member, and
  // `[\\!a]` (an escaped `!`, a member to every shell) reaches this reader
  // as `[!a]`, the lexer having removed the backslash.
  for (const pattern of ["[^a]uth.json", "[!a]uth.json", "[!a-z]uth.json", "[!b-za]uth.json"]) {
    assert.equal(globPattern(pattern).test("auth.json"), true, pattern);
    assert.equal(globPattern(pattern).test("aauth.json"), false, `${pattern}: one character`);
  }
  // A letter matches either case (nocaseglob).
  for (const pattern of ["?UTH.JSON", "[A]uth.json", "AUTH.json", "[a-c]UTH.json"]) {
    assert.equal(globPattern(pattern).test("auth.json"), true, pattern);
  }
});
