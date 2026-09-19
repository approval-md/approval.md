/**
 * Shell word splitting and joining (APRV-362).
 *
 * Every expectation here is a hand-written literal. A splitter checked against
 * its own joiner agrees with itself and proves nothing, so the argv of each
 * string below is written out, and the property sweep at the end is the only
 * place the two functions are pointed at each other.
 *
 * The strings marked "observed" are the shapes the 2026-09-18 Codex app-server
 * probe recorded (`docs/codex-app-server-bridge.md`, question 1); the rest are
 * the quoting edge cases the bridge has to have an answer for.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { shlexJoin, shlexRoundTrips, shlexSplit } from "../src/core/shlex.js";

/** The argv of a string this module accepts, or a failure. */
function argvOf(text: string): string[] {
  const split = shlexSplit(text);
  assert.equal(split.ok, true, split.ok ? "" : split.reason);
  assert.ok(split.ok);
  return split.argv;
}

test("a bare command splits on whitespace", () => {
  assert.deepEqual(argvOf("cat README.md"), ["cat", "README.md"]);
  assert.deepEqual(argvOf("ls"), ["ls"]);
  assert.deepEqual(argvOf(""), []);
});

test("observed: the probe's own request binds the three words it renders", () => {
  // The exact string the 2026-09-18 probe recorded on every exec request. The
  // shell metacharacter lives INSIDE the third word, which is the whole shape
  // of a real Codex exec: the argv has no operators, the script does.
  assert.deepEqual(argvOf("/bin/zsh -lc 'printf marker > probe-command-marker.txt'"), [
    "/bin/zsh",
    "-lc",
    "printf marker > probe-command-marker.txt",
  ]);
});

test("a single-quoted run is literal, including the characters a shell would read", () => {
  assert.deepEqual(argvOf("git commit -m 'fix: spaces and $VARS and `ticks`'"), [
    "git",
    "commit",
    "-m",
    "fix: spaces and $VARS and `ticks`",
  ]);
  // A double quote INSIDE a quoted run is an ordinary character.
  assert.deepEqual(argvOf(`sh -c 'echo "hi"'`), ["sh", "-c", 'echo "hi"']);
});

test("the '\\'' idiom is three pieces of one word, not three words", () => {
  assert.deepEqual(argvOf("cat 'it'\\''s.txt'"), ["cat", "it's.txt"]);
  assert.deepEqual(argvOf("'a'\\''b'\\''c'"), ["a'b'c"]);
});

test("an empty word survives as an empty word", () => {
  assert.deepEqual(argvOf("''"), [""]);
  assert.deepEqual(argvOf("printf '' x"), ["printf", "", "x"]);
});

test("a redirection character is an ordinary word character, because an argv has no operators", () => {
  assert.deepEqual(argvOf("echo x > out.txt"), ["echo", "x", ">", "out.txt"]);
  assert.deepEqual(argvOf("a | b && c ; d"), ["a", "|", "b", "&&", "c", ";", "d"]);
});

test("a heredoc marker rides inside the quoted script, newlines and all", () => {
  assert.deepEqual(argvOf("bash -lc 'cat <<EOF\nline\nEOF'"), [
    "bash",
    "-lc",
    "cat <<EOF\nline\nEOF",
  ]);
});

test("a backslash outside quotes escapes the next character", () => {
  assert.deepEqual(argvOf("echo a\\ b"), ["echo", "a b"]);
  assert.deepEqual(argvOf("echo \\'"), ["echo", "'"]);
});

// ---------------------------------------------------------------------------
// The three refusals, each with the repair it implies
// ---------------------------------------------------------------------------

test("a double quote outside a quoted run is refused, never interpreted", () => {
  const split = shlexSplit('echo "hello world"');
  assert.equal(split.ok, false);
  assert.ok(!split.ok);
  assert.match(split.reason, /double quote/u);
});

test("an unterminated single-quoted run is refused", () => {
  const split = shlexSplit("echo 'oops");
  assert.equal(split.ok, false);
  assert.ok(!split.ok);
  assert.match(split.reason, /never closed/u);
});

test("a trailing backslash with nothing to escape is refused", () => {
  const split = shlexSplit("echo trailing\\");
  assert.equal(split.ok, false);
  assert.ok(!split.ok);
  assert.match(split.reason, /backslash/u);
});

// ---------------------------------------------------------------------------
// joinShaped: a fact about the counterpart, reported rather than assumed
// ---------------------------------------------------------------------------

test("a string a join produced is join-shaped", () => {
  for (const text of [
    "cat README.md",
    "/bin/zsh -lc 'printf marker > probe-command-marker.txt'",
    "curl -d a=b https://example.com",
    "''",
    "ls",
  ]) {
    const split = shlexSplit(text);
    assert.ok(split.ok);
    assert.equal(split.joinShaped, true, text);
  }
});

test("redundant or non-space separation is not join-shaped", () => {
  for (const text of ["echo  two  spaces", " leading", "trailing ", "tab\tseparated", "   "]) {
    const split = shlexSplit(text);
    assert.ok(split.ok);
    // The argv is still readable; what is false is that a join produced these
    // bytes, which is a fact about the counterpart and the caller's to act on.
    assert.equal(split.joinShaped, false, text);
  }
});

// ---------------------------------------------------------------------------
// The join, and the one property the bridge rests on
// ---------------------------------------------------------------------------

test("the join quotes a word exactly when a bare one would read back as something else", () => {
  assert.equal(shlexJoin(["cat", "README.md"]), "cat README.md");
  assert.equal(shlexJoin(["echo", "hello world"]), "echo 'hello world'");
  assert.equal(shlexJoin(["cat", "it's.txt"]), "cat 'it'\\''s.txt'");
  assert.equal(shlexJoin(["printf", ""]), "printf ''");
  assert.equal(shlexJoin(["a", 'say "hi"']), `a 'say "hi"'`);
  assert.equal(shlexJoin(["a", "back\\slash"]), "a 'back\\slash'");
  // Operators and colons are left bare: this renders an argv, not a script.
  assert.equal(shlexJoin(["echo", ">", "https://x.test"]), "echo > https://x.test");
});

test("the legacy argv form is rendered, not concatenated", () => {
  // The whole point of the join. `["bash","-lc","rm -rf build"].join(" ")`
  // hands a classifier `bash -lc rm -rf build`, which is four more words than
  // the kernel will ever see and a different command.
  assert.equal(shlexJoin(["bash", "-lc", "rm -rf build"]), "bash -lc 'rm -rf build'");
  assert.deepEqual(argvOf(shlexJoin(["bash", "-lc", "rm -rf build"])), [
    "bash",
    "-lc",
    "rm -rf build",
  ]);
});

test("every argv survives a render-and-re-split cycle, and its rendering is join-shaped", () => {
  // The property the bridge checks before it binds an argv to an approval.
  // Three positions over an alphabet of every character class the splitter
  // treats specially, which is 1331 argvs.
  const alphabet = ["a", " ", "'", '"', "\\", ">", "", "\n", "=", ":", "-"];
  let checked = 0;
  for (const first of alphabet) {
    for (const second of alphabet) {
      for (const third of alphabet) {
        const argv = [first + second, third, second + third + first];
        const back = shlexSplit(shlexJoin(argv));
        assert.ok(back.ok, `${JSON.stringify(argv)} rendered to something unreadable`);
        assert.deepEqual(back.argv, argv);
        assert.equal(back.joinShaped, true, JSON.stringify(argv));
        assert.equal(shlexRoundTrips(argv), true, JSON.stringify(argv));
        checked += 1;
      }
    }
  }
  assert.equal(checked, 1331);
});
