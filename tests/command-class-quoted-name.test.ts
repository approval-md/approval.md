/**
 * An assignment-shaped word with a quoted or escaped name is a command word
 * (APRV-523).
 *
 * bash decides whether a word in front of a command is an assignment on the
 * word as written, before quote removal: the name, an optional subscript, the
 * `+` and the `=` must carry no quoting or escaping character. A word whose
 * name is quoted, or carries a backslash, is the program bash runs, named by
 * the whole word, and the next word is that program's first argument. The
 * classifier applied its assignment grammar to the dequoted text, so it read
 * past such a word and judged the next word as the program: the two disagreed
 * about what runs.
 *
 * The fix reads the grammar on the source spelling. A segment whose
 * assignment-shaped words bash would not all take as assignments is
 * `unclassified`, and the segment shapes the hook and the channels read name
 * the word bash runs as the binary.
 *
 * Nothing here runs a command. The fixtures follow the placeholder style of
 * tests/command-class-git-env.test.ts (`n=5`, `/tmp/x/cat`), and the hook test
 * runs `approval hook claude-code` on Bash JSON events, which only classifies.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { classifyCommand, commandSegmentShapes, commandSegmentWords } from "../src/core/command-class.js";

/** dist/tests/x.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
/** dist/tests/x.test.js -> the repository's own APPROVAL.md */
const REPO_POLICY = fileURLToPath(new URL("../../APPROVAL.md", import.meta.url));

/**
 * Every way of writing `NAME=value` so that bash runs it as a command word: the
 * name in double or single quotes, a backslash in front of it, a quote opened
 * inside it, the `=` quoted or escaped, the whole word quoted, and the quoted
 * name with the append operator or a subscript.
 */
function quotedSpellings(word: string): string[] {
  const equals = word.indexOf("=");
  const name = word.slice(0, equals);
  const value = word.slice(equals + 1);
  return [
    `"${name}"=${value}`,
    `'${name}'=${value}`,
    `\\${name}=${value}`,
    `${name.slice(0, 1)}"${name.slice(1)}"=${value}`,
    `${name}"="${value}`,
    `${name}\\=${value}`,
    `"${name}=${value}"`,
    `"${name}"+=${value}`,
    `"${name}"[0]=${value}`,
  ];
}

/** Plain assignments whose spelling, in front of these tails, the classifier answers. */
const SOURCES = ["n=5", "LANG=C", "GIT_PAGER=cat", "n=/tmp/x/cat"] as const;
const TAILS = ["ls", "cat f", "wc -l f", "git log", "git status"] as const;

/** The tails a source's plain spelling is answered in front of: git takes only its allow-list (APRV-521). */
function tailsOf(source: string): readonly string[] {
  const gitAllowed = source === "LANG=C" || source === "GIT_PAGER=cat";
  return TAILS.filter((tail) => gitAllowed || !tail.startsWith("git "));
}

function answer(command: string): string {
  const result = classifyCommand(command);
  return result.ok ? result.segments.map((segment) => `${segment.class}/${segment.rule}`).join(" ") : `refused/${result.code}`;
}

function failure(command: string): { code: string; detail: string } {
  const result = classifyCommand(command);
  assert.equal(result.ok, false, `${command} must be refused, got ${answer(command)}`);
  return result as { code: string; detail: string };
}

test("the plain spellings are answered (the controls)", () => {
  for (const source of SOURCES) {
    for (const tail of tailsOf(source)) {
      const command = `${source} ${tail}`;
      assert.equal(classifyCommand(command).ok, true, `${command}: ${answer(command)}`);
    }
  }
  assert.equal(answer("n=5"), "read.shell/assignment");
});

test("a quoted or escaped name in front of a command is unclassified", () => {
  for (const source of SOURCES) {
    for (const spelling of quotedSpellings(source)) {
      for (const tail of tailsOf(source)) {
        const command = `${spelling} ${tail}`;
        const refused = failure(command);
        assert.equal(refused.code, "unclassified", command);
        assert.match(refused.detail, /quoted or escaped is a command word/u, command);
      }
    }
  }
});

test("a quoted or escaped name on its own, or after a real assignment, is unclassified", () => {
  for (const source of SOURCES) {
    for (const spelling of quotedSpellings(source)) {
      for (const command of [spelling, `m=6 ${spelling} ls`, `${spelling}; ls`, `ls && ${spelling}`, `echo "$(${spelling} ls)"`]) {
        assert.equal(failure(command).code, "unclassified", command);
      }
    }
  }
});

test("a quoted value, or a quoted subscript, keeps the word an assignment", () => {
  // The value may be quoted: bash removes the quotes and assigns.
  for (const [quoted, plain] of [
    ['n="5" ls', "n=5 ls"],
    ["n='5' ls", "n=5 ls"],
    ["n='a b' ls", "n=5 ls"],
    ['GIT_PAGER="cat" git log', "GIT_PAGER=cat git log"],
    ["GIT_PAGER='cat' git log", "GIT_PAGER=cat git log"],
    ['LANG="C" cat f', "LANG=C cat f"],
  ] as const) {
    assert.equal(answer(quoted), answer(plain), quoted);
    assert.equal(classifyCommand(quoted).ok, true, quoted);
  }
  // A quoted subscript is an assignment to bash, and a subscripted one is
  // refused as before (APRV-521), with its own detail.
  const subscript = failure('n["k"]=5 ls');
  assert.equal(subscript.code, "unclassified");
  assert.match(subscript.detail, /append or subscripted assignment/u);
});

test("the same word as an argument, or a word both readings call a command, is unchanged", () => {
  assert.equal(answer('ls "n"=5'), answer("ls n=5"));
  assert.equal(answer("echo \\n=5"), answer("echo n=5"));
  // A brace or a `$` in the name: neither grammar reads an assignment there.
  for (const command of ["{n}=5 ls", "n$x=5 ls"]) {
    const refused = failure(command);
    assert.equal(refused.code, "unclassified", command);
    assert.match(refused.detail, /^no rule for /u, command);
  }
});

test("a protected redirect still answers first, as for the plain spelling", () => {
  const plain = classifyCommand("n=5 cat f > APPROVAL.md");
  assert.equal(plain.ok, true);
  for (const spelling of quotedSpellings("n=5")) {
    const command = `${spelling} cat f > APPROVAL.md`;
    assert.equal(classifyCommand(command).ok, true, command);
    assert.equal(answer(command), answer("n=5 cat f > APPROVAL.md"), command);
  }
});

test("the segment shapes name the word bash runs as the binary", () => {
  for (const spelling of quotedSpellings("n=5")) {
    const command = `${spelling} ls -l`;
    const words = commandSegmentWords(command);
    assert.ok(words !== null && words.length === 1, command);
    assert.notEqual(words[0]?.bin, "ls", command);
    assert.deepEqual(words[0]?.args.slice(-2), ["ls", "-l"], command);
    const shapes = commandSegmentShapes(command);
    assert.ok(shapes !== null && shapes.length === 1, command);
    assert.equal(shapes[0]?.bin, words[0]?.bin, command);
    assert.deepEqual(shapes[0]?.args, words[0]?.args, command);
  }
  assert.equal(commandSegmentWords('"n"=5 ls -l')?.[0]?.bin, "n=5");
  // The plain and quoted-value spellings still name the real program.
  for (const command of ["n=5 ls -l", 'n="5" ls -l', "n=5 m='a b' ls -l"]) {
    assert.equal(commandSegmentWords(command)?.[0]?.bin, "ls", command);
    assert.equal(commandSegmentShapes(command)?.[0]?.bin, "ls", command);
  }
  // A quoted name on its own is a segment with a binary.
  assert.equal(commandSegmentWords('"n"=5')?.length, 1);
  assert.equal(commandSegmentWords("n=5")?.length, 0);
});

test("review-b N6: a substitution, a mid-name backslash, an escaped + and a continuation in the name are unclassified", () => {
  // A `$(…)` in the name: the dequoted text drops it and reads an assignment;
  // bash, seeing a `$` in the name, runs the word.
  // A backslash inside the name, and one in front of the `+` of an append.
  // A backslash-newline inside the name: refused, the fail-closed choice.
  for (const command of ["n$(printf m)=5 ls", "n\\m=5 ls", "n\\+=5 ls", "n\\\nm=5 ls"]) {
    const refused = failure(command);
    assert.equal(refused.code, "unclassified", JSON.stringify(command));
    assert.match(refused.detail, /quoted or escaped is a command word/u, JSON.stringify(command));
  }
  // The control: the same name unescaped is an assignment.
  assert.equal(answer("nm=5 ls"), answer("n=5 ls"));
});

test("review-b S1: a login-shell wrapper unwraps only the system's shell, named as written", () => {
  // The controls: a bare shell name or a system-bin path keeps the route
  // (APRV-380), and so does a quoted bare name, which bash runs as that name.
  for (const command of [
    "bash -c 'ls'",
    "sh -lc 'ls'",
    "/bin/bash -c 'ls'",
    "/usr/bin/sh -lc 'ls'",
    "/usr/local/bin/zsh -lc 'ls'",
    "\"bash\" -c 'ls'",
  ]) {
    assert.equal(answer(command), "read.shell/read-shell", command);
  }
  // The control row with a class of its own: the route hands back the inner
  // script's class, the same for a bare name and a system-bin path.
  const written = classifyCommand("bash -lc 'rm f'");
  assert.equal(written.ok, true);
  assert.equal(answer("/bin/bash -lc 'rm f'"), answer("bash -lc 'rm f'"));
  assert.equal(answer("/usr/bin/sh -c 'rm f'"), answer("rm f"));
  // Its deny row: the same script under a path-spelled shell stays wrapped.
  assert.equal(failure("x/bash -lc 'rm f'").code, "opaque");
  // An assignment-shaped first word whose value ends in a shell name: with a
  // quoted or escaped name bash runs the whole word, and the segment is
  // refused as any other quoted-name segment is.
  for (const spelling of quotedSpellings("n=x/bash")) {
    for (const flag of ["-c", "-lc"]) {
      const command = `${spelling} ${flag} 'ls'`;
      const refused = failure(command);
      assert.equal(refused.code, "unclassified", command);
      assert.match(refused.detail, /quoted or escaped is a command word/u, command);
    }
  }
  // A real assignment in front of the flag: bash runs the flag word, so it is no wrapper.
  assert.equal(failure("n=x/bash -c 'ls'").code, "unclassified");
  // A path outside the system-bin directories is whatever program sits there.
  for (const command of ["x/bash -c 'ls'", "./zsh -c 'ls'", "/tmp/x/bash -c 'ls'", "/tmp/x/bin/sh -lc 'ls'"]) {
    assert.equal(failure(command).code, "opaque", command);
  }
  // The segment shapes the hook reads: no unwrapped script for such a word.
  for (const command of ["\"n\"=x/bash -c 'ls'", "x/bash -c 'ls'"]) {
    const shape = commandSegmentShapes(command)?.[0];
    assert.ok(shape !== undefined, command);
    assert.equal(shape.script, null, command);
    assert.equal(shape.opaqueShell, true, command);
  }
  assert.equal(commandSegmentShapes("bash -c 'ls'")?.[0]?.script, "ls");
});

// ---------------------------------------------------------------------------
// The hook refuses under this repository's APPROVAL.md
// ---------------------------------------------------------------------------

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-quoted-name-")));
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function runCli(args: string[], cwd: string, input = ""): { code: number; stdout: string; stderr: string } {
  const env = { ...process.env };
  delete env["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], { cwd, encoding: "utf8", env, input });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function verdict(dir: string, command: string): { permission: string; reason: string } {
  const event = JSON.stringify({
    session_id: "s-quoted-name",
    transcript_path: "/dev/null",
    cwd: dir,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "read-only listing" },
  });
  const run = runCli(["hook", "claude-code"], dir, event);
  assert.equal(run.code, 0, `hook must exit 0 with a verdict: ${run.stderr}`);
  const output = (JSON.parse(run.stdout) as Record<string, Record<string, unknown>>)["hookSpecificOutput"];
  assert.ok(output !== undefined, run.stdout);
  return { permission: String(output["permissionDecision"]), reason: String(output["permissionDecisionReason"]) };
}

function logText(dir: string): string {
  const path = join(dir, ".approval", "log", "events.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

test("hook: under this repository's policy a quoted or escaped name is refused and logs nothing", () => {
  const dir = join(scratch, "repo-policy");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), readFileSync(REPO_POLICY, "utf8"), "utf8");
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);

  const refused = [
    '"n"=5 ls',
    "'n'=5 cat f",
    "\\n=/tmp/x/cat ls",
    'n"="/tmp/x/cat wc -l f',
    "n\\=5 ls",
    '"n=5" ls',
    '"GIT_PAGER"=cat git log',
    "\\LANG=C git status",
    '"n"=5',
    '"n"=5; ls',
    "\"n\"=x/bash -c 'ls'",
  ];
  for (const command of refused) {
    const before = logText(dir);
    const decided = verdict(dir, command);
    assert.notEqual(decided.permission, "allow", `${command}: ${decided.reason}`);
    assert.match(decided.reason, /^hook-unclassified: /u, command);
    assert.equal(logText(dir), before, `${command} must append nothing to the log`);
  }

  // The controls: the plain and quoted-value spellings still run unattended.
  for (const command of ["n=5 ls", 'n="5" ls', "GIT_PAGER=cat git log", 'GIT_PAGER="cat" git log']) {
    const read = verdict(dir, command);
    assert.equal(read.permission, "allow", `${command}: ${read.reason}`);
    assert.match(read.reason, /^autonomous: read\.shell/u, command);
  }
});
