/**
 * Environment assignments in front of git fail closed (APRV-521).
 *
 * The hole: the classifier skipped every `NAME=value` word in front of the
 * binary and classified `git` by its subcommand alone. git(1)'s ENVIRONMENT
 * section is mostly variables that run a program, repoint the repository or
 * its configuration, or write a file, so `GIT_PAGER=<cmd> git log` ran `<cmd>`
 * as an autonomous `read.shell`, and `GIT_DIR=x git status` read another
 * repository under the same answer.
 *
 * The fix is a closed allow-list. A git segment preceded by any assignment is
 * `unclassified` unless every assignment is one git(1) shows to be harmless:
 * `GIT_TERMINAL_PROMPT=0`, `GIT_PAGER=cat`, `PAGER=cat`, `GIT_EDITOR=true|:`,
 * `EDITOR=true|:`, `VISUAL=true|:` (APRV-433's list), and the locale and zone
 * with a plain value. A variable git could inherit that the command line's own
 * shell sets (a bare `NAME=value`, `export`, `declare -x`, `printf -v`,
 * `${NAME:=value}`) makes every git segment on the line `unclassified` too.
 *
 * The git semantics are argued from git 2.50.1's git(1) and git-config(1)
 * ENVIRONMENT sections; nothing here runs git, and no test sets any of these
 * variables for a real process. The hook test runs `approval hook claude-code`
 * on Bash JSON events, which only classifies.
 *
 * The last test is a differential against the classifier of the base commit
 * (PR #651's head), gated on `APPROVAL_DIFF_BASE` (a path to that build's
 * `dist/src/core/command-class.js`). It asserts the change is stricter-only
 * over a generated corpus and reports the counts.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { classifyCommand, type CommandClassification } from "../src/core/command-class.js";

/** dist/tests/x.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
/** dist/tests/x.test.js -> the repository's own APPROVAL.md */
const REPO_POLICY = fileURLToPath(new URL("../../APPROVAL.md", import.meta.url));

// ---------------------------------------------------------------------------
// The tables under test, restated from git(1) rather than imported
// ---------------------------------------------------------------------------

/**
 * Every variable the brief lists, plus the rest of git(1)'s ENVIRONMENT
 * section that names a program, a path or a repository, and a few that a
 * program git starts reads (the pager's LESS*, the loader's LD_* / DYLD_*,
 * bash's BASH_ENV). Each with a value it could plausibly carry.
 */
const STEERING: readonly string[] = [
  "GIT_PAGER=evil",
  "GIT_PAGER=less",
  "GIT_PAGER=/tmp/x/pager",
  "GIT_DIR=/tmp/x/.git",
  "GIT_DIR=status",
  "GIT_WORK_TREE=/tmp/x",
  "GIT_COMMON_DIR=/tmp/x",
  "GIT_CONFIG_COUNT=1",
  "GIT_CONFIG_KEY_0=core.pager",
  "GIT_CONFIG_VALUE_0=evil",
  "GIT_CONFIG_PARAMETERS='core.pager'='evil'",
  "GIT_CONFIG_GLOBAL=/tmp/x/config",
  "GIT_CONFIG_SYSTEM=/tmp/x/config",
  "GIT_CONFIG_NOSYSTEM=1",
  "GIT_CONFIG=/tmp/x/config",
  "GIT_EXEC_PATH=/tmp/x",
  "GIT_SSH=/tmp/x/ssh",
  "GIT_SSH_COMMAND=evil",
  "GIT_SSH_VARIANT=ssh",
  "GIT_EDITOR=vi",
  "GIT_SEQUENCE_EDITOR=evil",
  "GIT_ASKPASS=/tmp/x/askpass",
  "GIT_EXTERNAL_DIFF=evil",
  "GIT_INDEX_FILE=/tmp/x/index",
  "GIT_OBJECT_DIRECTORY=/tmp/x",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES=/tmp/x",
  "GIT_NAMESPACE=x",
  "GIT_CEILING_DIRECTORIES=/tmp",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM=1",
  "GIT_ATTR_SOURCE=HEAD",
  "GIT_TRACE=/tmp/x/trace",
  "GIT_TRACE=1",
  "GIT_TRACE_PACKET=/tmp/x/trace",
  "GIT_TRACE_PERFORMANCE=/tmp/x/trace",
  "GIT_TRACE_SETUP=/tmp/x/trace",
  "GIT_TRACE_CURL=/tmp/x/trace",
  "GIT_TRACE2=/tmp/x/trace",
  "GIT_TRACE2_EVENT=/tmp/x/trace",
  "GIT_TRACE2_PERF=/tmp/x/trace",
  "GIT_AUTHOR_NAME=x",
  "PAGER=evil",
  "PAGER=less",
  "EDITOR=evil",
  "VISUAL=evil",
  "LESS=-R",
  "LESSOPEN='|evil'",
  "LESSCLOSE=evil",
  "HOME=/tmp/x",
  "XDG_CONFIG_HOME=/tmp/x",
  "PATH=/tmp/x",
  "LD_PRELOAD=/tmp/x.so",
  "DYLD_INSERT_LIBRARIES=/tmp/x.dylib",
  "BASH_ENV=/tmp/x",
  "TMPDIR=/tmp/x",
  "SSH_ASKPASS=/tmp/x",
  "FOO=1",
];

/** Spellings one character or one quoting away from an allowed word. */
const NEAR_MISSES: readonly string[] = [
  "GIT_PAGER=Cat",
  "GIT_PAGER=/bin/cat",
  "GIT_PAGER='cat -v'",
  "GIT_PAGER=",
  'GIT_PAGER="$X"',
  "GIT_PAGER=$X",
  "GIT_PAGER=$(echo cat)",
  "GIT_TERMINAL_PROMPT=false",
  "GIT_TERMINAL_PROMPT=00",
  "GIT_TERMINAL_PROMPT=1",
  "GIT_EDITOR=/usr/bin/true",
  "GIT_EDITOR='true x'",
  "GIT_EDITOR=::",
  "EDITOR=/tmp/x/true",
  "PAGER=/bin/cat",
  "LANG=/tmp/x",
  "LANG=../x",
  "LANG=C/../x",
  "LC_ALL=./x",
  "LC_ALL=$X",
  "LC_MESSAGES=",
  "LC_FOO=C",
  "LANGUAGE=en",
  "TZ=/etc/x",
  "TZ=:/etc/x",
  "TZ=../x",
  "TZ=$X",
  "TZDIR=/tmp/x",
];

/** The allow-list, as words that classify exactly as the bare subcommand does. */
const ALLOWED: readonly string[] = [
  "GIT_TERMINAL_PROMPT=0",
  "GIT_PAGER=cat",
  "GIT_PAGER='cat'",
  'GIT_PAGER="cat"',
  "PAGER=cat",
  "GIT_EDITOR=true",
  "GIT_EDITOR=:",
  "EDITOR=true",
  "EDITOR=:",
  "VISUAL=true",
  "VISUAL=:",
  "LANG=C",
  "LANG=en_US.UTF-8",
  "LC_ALL=C",
  "LC_ALL=C.UTF-8",
  "LC_MESSAGES=POSIX",
  "LC_CTYPE=sr_RS@latin",
  "LC_TIME=en_GB.UTF-8",
  "TZ=UTC",
  "TZ=Asia/Kolkata",
  "TZ=:Europe/London",
  "TZ=EST5EDT",
];

const READS = ["log", "status", "diff", "show", "log --oneline -5", "diff HEAD~1"] as const;
const WRITES = [
  "commit -m x",
  "add .",
  "push origin lane",
  "push --force origin main",
  "reset --hard",
  "rebase main",
  "checkout lane",
  "branch -D lane",
  "fetch origin",
  "tag v1",
  "config core.pager evil",
] as const;

function failure(command: string): { code: string; detail: string } {
  const result = classifyCommand(command);
  assert.equal(result.ok, false, `expected ${JSON.stringify(command)} to be refused, got ${JSON.stringify(result)}`);
  if (result.ok) throw new Error("unreachable");
  return { code: result.code, detail: result.detail };
}

function assertUnclassified(command: string, names?: string): void {
  const { code, detail } = failure(command);
  assert.equal(code, "unclassified", `${command}: ${detail}`);
  if (names !== undefined) {
    assert.ok(detail.includes(names), `${command}: detail ${JSON.stringify(detail)} should name ${names}`);
  }
}

function nameOf(word: string): string {
  return word.slice(0, word.indexOf("="));
}

// ---------------------------------------------------------------------------
// Criterion 1: every listed variable alone, before reads and writes
// ---------------------------------------------------------------------------

test("the reported spellings are unclassified", () => {
  assertUnclassified("GIT_PAGER=evil git log", "GIT_PAGER=");
  assertUnclassified("GIT_DIR=x git status", "GIT_DIR=");
  assertUnclassified("GIT_PAGER=evil git show HEAD", "GIT_PAGER=");
});

for (const word of STEERING) {
  test(`${word}: unclassified in front of every git subcommand`, () => {
    for (const tail of [...READS, ...WRITES]) {
      assertUnclassified(`${word} git ${tail}`, `${nameOf(word)}=… in front of git`);
      assertUnclassified(`${word} /usr/bin/git ${tail}`, `${nameOf(word)}=… in front of git`);
    }
    assertUnclassified(`${word} git`, `${nameOf(word)}=… in front of git`);
  });
}

test("near misses of the allow-list are unclassified", () => {
  // A backtick substitution is refused earlier, as opaque.
  assert.equal(failure("GIT_PAGER=`echo cat` git log").code, "opaque");
  for (const word of NEAR_MISSES) {
    for (const tail of [...READS, ...WRITES]) {
      const { code } = failure(`${word} git ${tail}`);
      assert.equal(code, "unclassified", `${word} git ${tail}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Criterion 2: combinations
// ---------------------------------------------------------------------------

test("combinations: one refused word among allowed ones refuses the segment", () => {
  for (const bad of [...STEERING, ...NEAR_MISSES]) {
    for (const command of [
      `GIT_PAGER=cat ${bad} git log`,
      `${bad} GIT_PAGER=cat git log`,
      `GIT_TERMINAL_PROMPT=0 LANG=C ${bad} TZ=UTC git status`,
      `${bad} ${bad} git diff`,
      `GIT_PAGER=cat ${bad} git push origin lane`,
      `${bad} GIT_EDITOR=true git rebase main`,
    ]) {
      assert.equal(failure(command).code, "unclassified", command);
    }
  }
  // A repeated name: the shell keeps the last, and either way one is refused.
  assertUnclassified("GIT_PAGER=cat GIT_PAGER=evil git log", "GIT_PAGER=");
  assertUnclassified("GIT_PAGER=evil GIT_PAGER=cat git log", "GIT_PAGER=");
});

test("combinations: the refusal holds in compound lines, pipelines, substitutions and wrappers", () => {
  for (const command of [
    "git status && GIT_PAGER=evil git log",
    "cd lane; GIT_DIR=x git status",
    "GIT_PAGER=evil git log | cat",
    "echo $(GIT_PAGER=evil git log)",
    'echo "$(GIT_DIR=x git status)"',
    "bash -lc 'GIT_PAGER=evil git log'",
    "GIT_PAGER=evil approval sandbox -- git log",
    "GIT_PAGER=evil git -C . status",
    "GIT_PAGER=evil git --no-pager log",
  ]) {
    assert.equal(failure(command).code, "unclassified", command);
  }
});

// ---------------------------------------------------------------------------
// Criterion 3: the env / command / exec wrapper forms
// ---------------------------------------------------------------------------

test("wrapper forms that set or clear the environment are refused", () => {
  for (const wrapper of [
    "env GIT_PAGER=evil",
    "env GIT_DIR=x",
    "env -i",
    "env -i GIT_PAGER=evil",
    "env -u GIT_DIR",
    "env --",
    "env GIT_PAGER=cat",
    "command",
    "command -p",
    "GIT_PAGER=evil command",
    "exec",
    "exec -a x",
    "GIT_PAGER=evil exec",
    "builtin",
    "nohup",
    "time",
    "timeout 5",
    "sudo",
    "sudo GIT_PAGER=evil",
    "doas",
    "nice",
    "xargs",
  ]) {
    for (const tail of ["log", "status", "push --force origin main"]) {
      const command = `${wrapper} git ${tail}`;
      const result = classifyCommand(command);
      assert.equal(result.ok, false, `${command}: ${JSON.stringify(result)}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Criterion 4: the line's own shell setting a variable git inherits
// ---------------------------------------------------------------------------

test("export, declare, printf -v and ${NAME:=} of a git-read variable refuse the git segments", () => {
  const writes = [
    "export GIT_PAGER=evil",
    "export GIT_DIR=/tmp/x",
    "export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=evil",
    "export PAGER=evil",
    "export EDITOR=evil",
    "export HOME=/tmp/x",
    "export XDG_CONFIG_HOME=/tmp/x",
    "export GIT_PAGER",
    "export -n GIT_PAGER",
    "export GIT_PAGER=cat",
    "declare -x GIT_PAGER=evil",
    "typeset -x GIT_SSH_COMMAND=evil",
    "readonly GIT_DIR=x",
    "local GIT_DIR=x",
    "set -a",
    "GIT_PAGER=evil",
    "GIT_DIR=/tmp/x",
    "GIT_SSH_COMMAND=evil",
    "PAGER=evil",
    "HOME=/tmp/x",
    "XDG_CONFIG_HOME=/tmp/x",
    "LESSOPEN='|evil'",
    "GIT_PAGER=evil GIT_DIR=x",
    "((GIT_X=1))",
    "printf -v GIT_PAGER %s evil",
    "printf -vGIT_PAGER %s evil",
    "echo ${GIT_PAGER:=evil}",
    "echo ${GIT_DIR=x}",
    "GIT_PAGER=evil :",
  ];
  for (const write of writes) {
    for (const tail of ["log", "status", "diff", "show", "commit -m x", "push origin lane"]) {
      for (const command of [
        `${write}; git ${tail}`,
        `${write} && git ${tail}`,
        `${write}\ngit ${tail}`,
        `${write}; echo "$(git ${tail})"`,
        `${write}; cat x; git ${tail}`,
        // A loop body runs again after its own later assignment.
        `git ${tail}; ${write}`,
      ]) {
        assert.equal(failure(command).code, "unclassified", command);
      }
    }
  }
});

test("a line-scoped write names the variable when nothing else refuses first", () => {
  assertUnclassified("printf -v GIT_PAGER %s evil; git log", "after GIT_PAGER is set on the same command line");
  assertUnclassified("echo ${GIT_PAGER:=evil}; git log", "after GIT_PAGER is set on the same command line");
  assertUnclassified("echo ${GIT_DIR=x}; git status", "after GIT_DIR is set on the same command line");
  assertUnclassified("git log; echo ${GIT_PAGER:=evil}", "after GIT_PAGER is set on the same command line");
  assertUnclassified("echo ${PAGER:=evil}; echo $(git log)", "after PAGER is set on the same command line");
  // The bare assignment answers for itself.
  assertUnclassified("GIT_PAGER=evil; git log", "the assignment GIT_PAGER=");
});

test("an assignment that does not reach the line's shell, or a variable git does not read, leaves git alone", () => {
  // A prefix assignment belongs to its own (non-special) command.
  assert.deepEqual(classifyCommand("GIT_PAGER=evil echo hi; git log").ok && classifyCommand("GIT_PAGER=evil echo hi; git log"), {
    ok: true,
    segments: [
      { text: "GIT_PAGER=evil echo hi", class: "read.shell", rule: "read-shell" },
      { text: "git log", class: "read.shell", rule: "git-read" },
    ],
    classes: ["read.shell"],
  });
  // An ordinary script variable is not one git reads.
  const ordinary = classifyCommand("n=5; git log -n 5");
  assert.equal(ordinary.ok, true, JSON.stringify(ordinary));
  assert.deepEqual(ordinary.ok ? ordinary.classes : [], ["read.shell"]);
  // A bare allowed word is harmless on its own line too.
  const allowed = classifyCommand("GIT_PAGER=cat; git log");
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
});

// ---------------------------------------------------------------------------
// Criterion 5: the allow-list still passes
// ---------------------------------------------------------------------------

function answer(command: string): string {
  const result = classifyCommand(command);
  return result.ok ? result.segments.map((segment) => `${segment.class}/${segment.rule}`).join(" ") : `refused/${result.code}`;
}

test("every allow-listed word classifies exactly as the bare subcommand", () => {
  for (const word of ALLOWED) {
    for (const tail of [...READS, ...WRITES]) {
      const bare = answer(`git ${tail}`);
      // `push` reads every GIT_* assignment as steering its configuration
      // (APRV-517) and answers the stricter rewrite; that stays as it was.
      const pushSteered = tail.startsWith("push") && word.startsWith("GIT_");
      const expected = pushSteered ? "vcs.history.rewrite/git-push-unreadable" : bare;
      assert.equal(answer(`${word} git ${tail}`), expected, `${word} git ${tail}`);
    }
  }
});

test("allow-listed words combine, and pass through a sandbox wrapper", () => {
  assert.equal(
    answer("GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat GIT_EDITOR=true LANG=C LC_ALL=C.UTF-8 TZ=UTC git log"),
    "read.shell/git-read",
  );
  assert.equal(answer("GIT_EDITOR=true git commit --amend --no-edit"), "vcs.history.rewrite/git-commit-amend");
  assert.equal(answer("GIT_EDITOR=: git rebase main"), "vcs.history.rewrite/git-rewrite");
  assert.equal(answer("PAGER=cat git push origin lane"), "vcs.push.branch/git-push-branch");
  assert.equal(answer("GIT_PAGER=cat approval sandbox -- git log"), answer("approval sandbox -- git log"));
});

// ---------------------------------------------------------------------------
// Criterion 6: the hook refuses under this repository's APPROVAL.md
// ---------------------------------------------------------------------------

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-git-env-")));
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

function bashEvent(cwd: string, command: string): string {
  return JSON.stringify({
    session_id: "s-git-env",
    transcript_path: "/dev/null",
    cwd,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "read-only log check" },
  });
}

function verdict(dir: string, command: string): { permission: string; reason: string } {
  const run = runCli(["hook", "claude-code"], dir, bashEvent(dir, command));
  assert.equal(run.code, 0, `hook must exit 0 with a verdict: ${run.stderr}`);
  const output = (JSON.parse(run.stdout) as Record<string, Record<string, unknown>>)["hookSpecificOutput"];
  assert.ok(output !== undefined, run.stdout);
  return { permission: String(output["permissionDecision"]), reason: String(output["permissionDecisionReason"]) };
}

function logText(dir: string): string {
  const path = join(dir, ".approval", "log", "events.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

test("hook: under this repository's policy every steering spelling is refused and logs nothing", () => {
  const dir = join(scratch, "repo-policy");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), readFileSync(REPO_POLICY, "utf8"), "utf8");
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);

  const refused = [
    "GIT_PAGER=evil git log",
    "GIT_DIR=/tmp/x/.git git status",
    "GIT_WORK_TREE=/tmp/x git diff",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=evil git show",
    "GIT_CONFIG_PARAMETERS='core.pager'='evil' git log",
    "GIT_EXEC_PATH=/tmp/x git status",
    "GIT_SSH_COMMAND=evil git fetch origin",
    "GIT_EXTERNAL_DIFF=evil git diff",
    "GIT_TRACE=/tmp/x/trace git status",
    "PAGER=evil git log",
    "HOME=/tmp/x git log",
    "XDG_CONFIG_HOME=/tmp/x git log",
    "GIT_PAGER=cat GIT_DIR=x git log",
    "GIT_PAGER=evil; git log",
    "printf -v GIT_PAGER %s evil; git log",
    "echo ${GIT_PAGER:=evil}; git log",
    "GIT_PAGER=evil git push origin lane",
  ];
  for (const command of refused) {
    const before = logText(dir);
    const decided = verdict(dir, command);
    assert.notEqual(decided.permission, "allow", `${command}: ${decided.reason}`);
    assert.match(decided.reason, /^hook-unclassified: /u, command);
    assert.equal(logText(dir), before, `${command} must append nothing to the log`);
    assert.doesNotMatch(logText(dir), /autonomous/u, command);
  }

  // The wrapper and export spellings are refused too (opaque or unclassified).
  for (const command of ["env GIT_PAGER=evil git log", "export GIT_PAGER=evil; git log", "command git log"]) {
    const decided = verdict(dir, command);
    assert.notEqual(decided.permission, "allow", `${command}: ${decided.reason}`);
    assert.match(decided.reason, /^hook-(?:unclassified|opaque): /u, command);
  }

  // The controls: plain and allow-listed reads still run unattended.
  for (const command of ["git log", "GIT_PAGER=cat git log", "GIT_TERMINAL_PROMPT=0 LC_ALL=C git status"]) {
    const read = verdict(dir, command);
    assert.equal(read.permission, "allow", `${command}: ${read.reason}`);
    assert.match(read.reason, /^autonomous: read\.shell/u, command);
  }
});

// ---------------------------------------------------------------------------
// Criterion 7: stricter-only against the base classifier, with counts
// ---------------------------------------------------------------------------

/** Every prefix of length 0..max over the alphabet. */
function* prefixes(alphabet: readonly string[], max: number): Generator<string[]> {
  let frontier: string[][] = [[]];
  yield [];
  for (let length = 1; length <= max; length += 1) {
    const next: string[][] = [];
    for (const prefix of frontier) {
      for (const token of alphabet) {
        const argv = [...prefix, token];
        next.push(argv);
        yield argv;
      }
    }
    frontier = next;
  }
}

/** One steering word per variable, every near miss, every allowed word. */
const CORPUS_ALPHABET: readonly string[] = [
  ...new Map(STEERING.map((word) => [nameOf(word), word])).values(),
  ...NEAR_MISSES,
  ...ALLOWED,
];

const CORPUS_TAILS: readonly string[] = [
  ...READS,
  ...WRITES,
  "",
  "--no-pager log",
  "-C . status",
  "push --delete origin lane",
];

/** Writes the line's shell makes, placed before (or after) a git segment. */
const LINE_WRITES: readonly string[] = [
  ...STEERING.map((word) => `export ${word}`),
  ...STEERING,
  ...NEAR_MISSES.filter((word) => !word.includes("$(") && !word.includes("`")),
  ...ALLOWED,
  ...ALLOWED.map((word) => `export ${word}`),
  "printf -v GIT_PAGER %s evil",
  "printf -v n %s 5",
  "echo ${GIT_PAGER:=evil}",
  "echo ${n:=5}",
  "n=5",
  "b=lane",
];

function* corpus(depth: number): Generator<string> {
  for (const prefix of prefixes(CORPUS_ALPHABET, depth)) {
    for (const tail of CORPUS_TAILS) {
      yield [...prefix, "git", tail].filter((word) => word !== "").join(" ");
    }
  }
  for (const write of LINE_WRITES) {
    for (const tail of CORPUS_TAILS) {
      const git = ["git", tail].filter((word) => word !== "").join(" ");
      yield `${write}; ${git}`;
      yield `${write} && ${git}`;
      yield `${git}; ${write}`;
      yield `${write}; echo "$(${git})"`;
    }
  }
}

function same(a: CommandClassification, b: CommandClassification): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The allow-list, restated: does the line carry a word the fix refuses? */
function carriesRefusedEnvironment(command: string): boolean {
  const exact = new Set(["GIT_TERMINAL_PROMPT=0", "GIT_PAGER=cat", "PAGER=cat", "GIT_EDITOR=true", "GIT_EDITOR=:", "EDITOR=true", "EDITOR=:", "VISUAL=true", "VISUAL=:"]);
  const harmless = (word: string): boolean => {
    const unquoted = word.replace(/^([A-Z_]+=)(['"])(.*)\2$/u, "$1$3");
    if (exact.has(unquoted)) return true;
    if (/^TZ=(?::?[A-Za-z_][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*|[A-Z]{3,}\d(?:[A-Z]{3,})?)$/u.test(unquoted)) return true;
    return /^(?:LANG|LC_(?:ALL|COLLATE|CTYPE|MESSAGES|MONETARY|NUMERIC|TIME))=[A-Za-z][A-Za-z0-9_@.-]*$/u.test(unquoted) && !unquoted.includes("..");
  };
  const words = command.split(/[\s;&]+/u).filter((word) => word !== "");
  const gitAt = words.indexOf("git");
  // A prefix word in front of git.
  if (words.slice(0, Math.max(gitAt, 0)).some((word) => /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word) && !harmless(word))) return true;
  // A line write (export, bare, printf -v, ${NAME:=}) of a variable git reads.
  return /(?:^|[;&]\s*|export )(?:GIT_|PAGER|EDITOR|VISUAL|LESS|HOME|XDG_|PATH|LD_|DYLD_|BASH_ENV|TMPDIR|SSH_ASKPASS|LANG|LC_|TZ)/u.test(command) ||
    /printf -v GIT_|\$\{GIT_/u.test(command);
}

test("differential: stricter-only against the base classifier", async (t) => {
  const basePath = process.env["APPROVAL_DIFF_BASE"];
  if (basePath === undefined || basePath === "") {
    t.skip("APPROVAL_DIFF_BASE is not set (path to the base build's dist/src/core/command-class.js)");
    return;
  }
  const base = (await import(pathToFileURL(basePath).href)) as { classifyCommand: (command: string) => CommandClassification };
  const depth = Number(process.env["APPROVAL_DIFF_DEPTH"] ?? "2");
  const counts = { total: 0, unchanged: 0, okToRefused: 0, refusedToRefused: 0, loosened: 0, reclassified: 0 };
  const okToRefusedBy = new Map<string, number>();
  const problems: string[] = [];
  for (const command of corpus(depth)) {
    counts.total += 1;
    const before = base.classifyCommand(command);
    const now = classifyCommand(command);
    if (same(before, now)) {
      counts.unchanged += 1;
      continue;
    }
    if (!carriesRefusedEnvironment(command)) problems.push(`moved without a refused assignment: ${command}`);
    if (now.ok && !before.ok) {
      counts.loosened += 1;
      problems.push(`loosened: ${command}`);
    } else if (now.ok && before.ok) {
      counts.reclassified += 1;
      problems.push(`reclassified: ${command}`);
    } else if (!now.ok && before.ok) {
      counts.okToRefused += 1;
      const key = before.classes.join("+");
      okToRefusedBy.set(key, (okToRefusedBy.get(key) ?? 0) + 1);
      if (now.code !== "unclassified") problems.push(`refused as ${now.code}: ${command}`);
    } else {
      counts.refusedToRefused += 1;
    }
  }
  t.diagnostic(`depth ${String(depth)}: ${JSON.stringify(counts)}`);
  t.diagnostic(`ok -> unclassified by base class: ${JSON.stringify(Object.fromEntries([...okToRefusedBy].sort()))}`);
  assert.deepEqual(problems.slice(0, 20), []);
  assert.equal(counts.loosened, 0);
  assert.equal(counts.reclassified, 0);
  // The hole is in the corpus and the base classifier had it.
  const hole = base.classifyCommand("GIT_PAGER=evil git log");
  assert.equal(hole.ok, true, "the base classifier answered the hole");
  assert.ok(counts.okToRefused > 0);
});
