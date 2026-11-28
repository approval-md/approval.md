/**
 * Review-b's N6 on #680: a word of unclosed `${a:-` made the path readers
 * slow. `collapseBracedVariables` read `\$\{NAME[^}]*\}` over the whole word,
 * so from every `${` with no `}` after it the scan ran to the word's end: the
 * square of its length. Through the hook a 1 MB redirect target took 105 CPU
 * seconds, and the same word as a read took longer still in the hook's own two
 * copies of the expression. A hook past its timeout lets the call proceed.
 * curl's `%output{` reader had the same shape.
 *
 * Each reader now stops at the last `}` of its text, where a closed form must
 * end. The answers are main's on every line: these tests hold the cost, and the
 * text the function returns.
 *
 * CPU time, not wall-clock time: this machine is shared. Each line takes under
 * 0.3 CPU s here; the old readers took 17 to 114 at these sizes. Once one line
 * passes the bound the later ones fail at once, so a slow build fails in about
 * a minute. Hermetic: HOME is a fixture directory; git runs only to make a
 * checkout, and no line is run.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { classifyForHook } from "../src/cli/hook.js";
import { classifyCommand, collapseBracedVariables } from "../src/core/command-class.js";
import { besidePlain } from "./cost-runner.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-braced-cost-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

const HOME = join(scratch, "home");
mkdirSync(HOME);
writeFileSync(join(HOME, ".gitconfig"), "[user]\n\tname = Cost Oracle\n\temail = oracle@example.invalid\n[init]\n\tdefaultBranch = main\n");
process.env["HOME"] = HOME;
process.env["GIT_CONFIG_NOSYSTEM"] = "1";
delete process.env["GIT_CONFIG_GLOBAL"];
delete process.env["GIT_DIR"];
delete process.env["GIT_WORK_TREE"];
delete process.env["CDPATH"];
delete process.env["HERMES_HOME"];

const GIT = spawnSync("git", ["--version"]).status === 0;
const skip = GIT ? false : "no git binary";

/** The most CPU seconds one classification may take here. */
const BOUND = 8;

/** CPU seconds (user and system) spent in `run`. */
function cpuSeconds(run: () => void): number {
  const start = process.cpuUsage();
  run();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1e6;
}

/** Every segment as `class rule`, pure; a refusal as `refused <code>`. */
function pure(command: string): string[] {
  const result = classifyCommand(command, []);
  return result.ok ? result.segments.map((segment) => `${segment.class} ${segment.rule}`) : [`refused ${result.code}`];
}

/** Set once a line has passed {@link BOUND}; the lines after it fail at once. */
let overBound: string | null = null;

/** Classify `command` through `via`, and fail if it took {@link BOUND} CPU seconds or an earlier line already did. */
function boundedLine(command: string, label: string, via: (text: string) => unknown): void {
  assert.equal(overBound, null, `${label}: not timed, an earlier line passed the bound (${String(overBound)})`);
  const seconds = cpuSeconds(() => {
    via(command);
  });
  // Measuring only (#720's list): this line's reading, printed before it is judged.
  console.log(`# cost-line: BRACED ${label}: ${seconds.toFixed(3)} CPU s (bound ${String(BOUND)}, not stretched; node ${process.version})`);
  // Measuring only (#720's list, step 3): a line within six times its bound
  // is read twice more beside three readings of a plain word of its length,
  // the least of each printed. Nothing here is asserted.
  if (seconds * 6 >= BOUND) console.log(`${besidePlain("BRACEDR", label, seconds, command, via)}; bound ${String(BOUND)}; node ${process.version}`);
  if (seconds >= BOUND) overBound = label;
  assert.ok(seconds < BOUND, `${label}: ${seconds.toFixed(2)} CPU s, bound ${String(BOUND)}`);
}

/** Main's expression, read over the whole text: what the function must still answer. */
function collapsedByTheWholeText(text: string): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}/gu, "${$1}");
}

// `git push --force` on its own line: the shell runs it before it meets the
// next line's unclosed `${`, so a hook that ran out of time let a push through.
const PUSH = "git push --force\n";

test("cost: a word of unclosed ${ is bounded as a write target (review-b's N6)", () => {
  // 500 KB: 17 to 27 CPU s with the whole-text read.
  for (const n of [10000, 100000]) {
    boundedLine(`${PUSH}echo x > ${"${a:-".repeat(n)}x`, `unclosed \${a:- run as a target, n=${String(n)}`, pure);
    boundedLine(`${PUSH}echo x > "${"${a:-".repeat(n)}x"`, `the same in double quotes, n=${String(n)}`, pure);
    boundedLine(`${PUSH}echo x > ${"${a".repeat(n)}`, `unclosed \${a run as a target, n=${String(n)}`, pure);
    boundedLine(`${PUSH}cat ${"${a:-".repeat(n)}x`, `unclosed \${a:- run as a read, n=${String(n)}`, pure);
    // Closed once at the very end: the first `${a` takes the whole word.
    boundedLine(`${PUSH}echo x > ${"${a:-".repeat(n)}x}`, `the run closed once at its end, n=${String(n)}`, pure);
    // Many closed forms, then the run: both halves in one word.
    boundedLine(`${PUSH}echo x > ${"${a:-b}".repeat(n)}${"${a:-".repeat(n)}`, `closed forms then the run, n=${String(n)}`, pure);
  }
});

test("cost: curl's %output{ reader is bounded", () => {
  // 1.2 MB: about 28 CPU s when each `%output{` looked ahead for its `}`.
  for (const n of [15000, 150000]) {
    boundedLine(`${PUSH}curl -w '${"%output{".repeat(n)}}' https://example.invalid`, `%output{ run closed once, n=${String(n)}`, pure);
    boundedLine(`${PUSH}curl -w '${"%output{".repeat(n)}' https://example.invalid`, `%output{ run never closed, n=${String(n)}`, pure);
    boundedLine(`${PUSH}curl -w '${"%output{a}".repeat(n)}%output{' https://example.invalid`, `closed forms then one open, n=${String(n)}`, pure);
  }
});

test("cost: through the hook, in a checkout, the same words are bounded", { skip }, () => {
  const repo = join(scratch, "repo");
  mkdirSync(repo, { recursive: true });
  const ran = spawnSync("git", ["init", "-q"], { cwd: repo, encoding: "utf8", env: process.env });
  assert.equal(ran.status, 0, ran.stderr);
  for (const [label, command] of [
    // The hook's own two readers (the credential pass) meet a read word:
    // 200 KB took about 18 CPU s there.
    ["unclosed ${a:- run as a read", `${PUSH}cat ${"${a:-".repeat(40000)}x`],
    ["unclosed ${a:- run as a read, in quotes", `${PUSH}cat "${"${a:-".repeat(40000)}x"`],
    ["unclosed ${a:- run as a target", `${PUSH}echo x > ${"${a:-".repeat(100000)}x`],
    ["%output{ run closed once", `${PUSH}curl -w '${"%output{".repeat(150000)}}' https://example.invalid`],
  ] as const) {
    boundedLine(command, `hook, ${label}`, (text) => classifyForHook(text, [], repo));
  }
});

test("collapseBracedVariables answers as the whole-text read did", () => {
  for (const [text, collapsed] of [
    ["${HERMES_HOME:-/x}/config.yaml", "${HERMES_HOME}/config.yaml"],
    ["${HERMES_HOME:-$HOME/.hermes}/.env", "${HERMES_HOME}/.env"],
    ["a/${OUT}/b", "a/${OUT}/b"],
    ["${a:-b}${c:-d}", "${a}${c}"],
    // A nested default closes at the first `}`, as the expression always read it.
    ["${a:-${b:-c}}", "${a}}"],
    // Unclosed: nothing after the last `}` changes, and with no `}` nothing does.
    ["${a:-", "${a:-"],
    ["${a:-b}/${c:-", "${a}/${c:-"],
    ["${a:-${b:-x", "${a:-${b:-x"],
    ["${a:-${b}tail", "${a}tail"],
    // Not a name: left as written.
    ["${:-x}", "${:-x}"],
    ["${1}", "${1}"],
    ["$HOME/x}", "$HOME/x}"],
    ["", ""],
  ] as const) {
    assert.equal(collapseBracedVariables(text), collapsed, text);
    assert.equal(collapseBracedVariables(text), collapsedByTheWholeText(text), text);
  }
  // Every short text over the characters that matter, against the whole-text read.
  const alphabet = ["$", "{", "}", "a", "_", "1", ":", "/"];
  let count = 0;
  const walk = (text: string, left: number): void => {
    assert.equal(collapseBracedVariables(text), collapsedByTheWholeText(text), text);
    count += 1;
    if (left > 0) for (const next of alphabet) walk(`${text}${next}`, left - 1);
  };
  walk("", 6);
  assert.equal(count, 299593);
});

test("the path readers answer as before on closed, unclosed and mixed words", () => {
  const WRITE = "files.write.workspace redirect-write";
  // A default's `/` does not split the home: the collapsed word is still the home's file.
  const home = pure("echo x >> ${HERMES_HOME:-/x}/.env");
  assert.deepEqual(home, pure("echo x >> ${HERMES_HOME}/.env"));
  assert.notDeepEqual(home, [WRITE]);
  // An unclosed form after it changes nothing before it.
  assert.deepEqual(pure("echo x >> ${HERMES_HOME:-/x}/.env${b:-"), pure("echo x >> ${HERMES_HOME}/.env${b:-"));
  assert.deepEqual(pure("echo x > ${OUT:-build}/log.txt"), [WRITE]);
  // curl: a closed `%output{…}` names its file; one left open names some file.
  const closed = pure("curl -w '%output{notes.txt}' https://example.invalid");
  const open = pure("curl -w '%output{notes.txt' https://example.invalid");
  const mixed = pure("curl -w '%output{notes.txt}%output{' https://example.invalid");
  assert.notDeepEqual(closed, open);
  assert.deepEqual(mixed, open);
  assert.deepEqual(pure("curl -w '}%output{a' https://example.invalid"), pure("curl -w '%output{a' https://example.invalid"));
  // No `%output{` at all, with a `}` or without one: curl writes no file by it.
  const plain = pure("curl https://example.invalid");
  assert.deepEqual(pure("curl -w 'done' https://example.invalid"), plain);
  assert.deepEqual(pure("curl -w '%{http_code}' https://example.invalid"), plain);
  assert.notDeepEqual(open, plain);
});
