/**
 * git global options that take a value leave the command unclassified
 * (APRV-520).
 *
 * The hole: the classifier reads a git subcommand as the first positional
 * after `git`. A global option that consumes the NEXT argv word (`-C <path>`,
 * `-c <name>=<value>`, `--git-dir <path>`, ...) makes that first positional the
 * option's value, so `git -C status push --force origin main` (a force push run
 * in the directory `status`) classified as `read.shell` and ran unattended, and
 * `git -C commit reset --hard` classified as a plain commit.
 *
 * The fix does not re-derive the subcommand. Any value-taking global, separate
 * or `=`-joined, and any flag in global position this classifier does not
 * know, leaves the segment `unclassified`, which the hook refuses. The
 * zero-value globals (`--no-pager`, `-p`, `--bare`, ...) are skipped exactly as
 * before, and the options after the subcommand belong to the subcommand.
 *
 * The git semantics are argued from git 2.50.1's documented global option
 * table (git(1)) and the option strings in its `handle_options`; nothing here
 * runs git.
 *
 * The last test is a differential against the classifier of the base commit,
 * gated on `APPROVAL_DIFF_BASE` (a path to that build's
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

/** git 2.50.1 globals that consume the next argv word (`--super-prefix`: older gits). */
const SEPARATE_VALUE = [
  "-C",
  "-c",
  "--config-env",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--attr-source",
  "--shallow-file",
] as const;

/** The `=`-joined long spellings, each with a value. */
const JOINED_VALUE = [
  "--config-env=core.pager=PAGER",
  "--git-dir=.git",
  "--git-dir=status",
  "--work-tree=.",
  "--namespace=status",
  "--super-prefix=sub/",
  "--attr-source=HEAD",
  "--exec-path=/tmp/x",
] as const;

/** Zero-value globals, skipped as before. */
const ZERO_VALUE = [
  "-p",
  "--paginate",
  "-P",
  "--no-pager",
  "--no-replace-objects",
  "--no-lazy-fetch",
  "--bare",
  "--literal-pathspecs",
  "--no-literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--no-optional-locks",
  "--no-advice",
] as const;

/** Values that spell a subcommand (the hole), plus ordinary ones. */
const VALUES = ["status", "log", "add", "commit", "push", "reset", "rebase", "branch", ".", "core.pager=cat"] as const;

/** The dangerous subcommands an attacker would hide behind a value. */
const DANGEROUS = ["push --force origin main", "reset --hard", "rebase main", "branch -D lane"] as const;

/** Ordinary subcommands, read and write. */
const ORDINARY = ["status", "log", "push origin lane", "commit -m x", "add .", "diff"] as const;

function failure(command: string): { code: string; detail: string } {
  const result = classifyCommand(command);
  assert.equal(result.ok, false, `expected ${JSON.stringify(command)} to be refused, got ${JSON.stringify(result)}`);
  if (result.ok) throw new Error("unreachable");
  return { code: result.code, detail: result.detail };
}

function assertUnclassified(command: string, names: string): void {
  const { code, detail } = failure(command);
  assert.equal(code, "unclassified", `${command}: ${detail}`);
  assert.ok(detail.includes(names), `${command}: detail ${JSON.stringify(detail)} should name ${names}`);
}

function only(command: string): { class: string; rule: string } {
  const result = classifyCommand(command);
  assert.equal(result.ok, true, `expected ${JSON.stringify(command)} to classify, got ${JSON.stringify(result)}`);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.segments.length, 1, command);
  const segment = result.segments[0] as { class: string; rule: string };
  return { class: segment.class, rule: segment.rule };
}

// ---------------------------------------------------------------------------
// Criterion 1: the hole, and every separate-value global alone
// ---------------------------------------------------------------------------

test("the two reported spellings are unclassified", () => {
  assertUnclassified("git -C status push --force origin main", "git -C <value>");
  assertUnclassified("git -C commit reset --hard", "git -C <value>");
});

for (const global of SEPARATE_VALUE) {
  test(`separate-value global ${global}: unclassified before every subcommand, whatever the value`, () => {
    for (const value of VALUES) {
      for (const tail of [...DANGEROUS, ...ORDINARY]) {
        assertUnclassified(`git ${global} ${value} ${tail}`, `git ${global} <value>`);
      }
    }
    // With no subcommand after it at all, and with nothing after the option.
    assertUnclassified(`git ${global} status`, `git ${global} <value>`);
    assertUnclassified(`git ${global}`, `git ${global} <value>`);
  });
}

// ---------------------------------------------------------------------------
// Criterion 2: the =-joined long spellings
// ---------------------------------------------------------------------------

for (const global of JOINED_VALUE) {
  test(`joined global ${global}: unclassified`, () => {
    const prefix = global.slice(0, global.indexOf("=") + 1);
    for (const tail of [...DANGEROUS, ...ORDINARY]) {
      assertUnclassified(`git ${global} ${tail}`, `git ${prefix}<value>`);
    }
  });
}

// ---------------------------------------------------------------------------
// Criterion 3: combinations
// ---------------------------------------------------------------------------

test("combinations: a value global anywhere in global position refuses the segment", () => {
  const combos = [
    "git --no-pager -C status push --force origin main",
    "git -p -c core.pager=cat -C log reset --hard",
    "git -C . -C status push --force origin main",
    "git --git-dir .git --work-tree status push --force origin main",
    "git -c status -c log rebase main",
    "git --namespace add --attr-source commit branch -D lane",
    "git --config-env core.pager=PAGER status push --force origin main",
    "git --bare --git-dir=status log push --force origin main",
    "git --no-optional-locks --shallow-file log reset --hard",
    "git -P --super-prefix status rebase main",
  ];
  for (const command of combos) {
    const { code } = failure(command);
    assert.equal(code, "unclassified", command);
  }
});

test("combinations: the refusal holds inside a compound line and a substitution", () => {
  for (const command of [
    "git status && git -C status push --force origin main",
    "cd lane; git -C commit reset --hard",
    "echo $(git -C log push --force origin main)",
    "git -C status push --force origin main | cat",
  ]) {
    assert.equal(classifyCommand(command).ok, false, command);
  }
});

// ---------------------------------------------------------------------------
// Criterion 4: unknown or unparseable globals are unclassified
// ---------------------------------------------------------------------------

test("a flag in global position this classifier does not know is unclassified", () => {
  for (const unknown of [
    "-Cstatus", // git compares `-C` whole: this is an unknown option to git
    "-cstatus",
    "--paginat", // no prefix abbreviation for globals
    "--git-dirx",
    "--frobnicate",
    "--", // git: "unknown option: --"
    "-$X", // an expansion: `X=C` makes it `-C`
    "--$X",
  ]) {
    for (const tail of ["status push --force origin main", "log", "commit reset --hard"]) {
      const command = `git ${unknown} ${tail}`;
      assertUnclassified(command, "git global option");
    }
  }
});

// ---------------------------------------------------------------------------
// Criterion 5: regressions, nothing else moved
// ---------------------------------------------------------------------------

test("plain git subcommands classify as before", () => {
  const expected: readonly (readonly [string, string, string])[] = [
    ["git status", "read.shell", "git-read"],
    ["git log", "read.shell", "git-read"],
    ["git log --oneline -5", "read.shell", "git-read"],
    ["git diff HEAD~1", "read.shell", "git-read"],
    ["git push origin lane", "vcs.push.branch", "git-push-branch"],
    ["git push origin main", "vcs.push.main", "git-push-main"],
    ["git push --force origin main", "vcs.history.rewrite", "git-push-force"],
    ["git reset --hard", "vcs.history.rewrite", "git-reset-hard"],
    ["git reset HEAD~1", "vcs.commit.branch", "git-reset"],
    ["git rebase main", "vcs.history.rewrite", "git-rewrite"],
    ["git branch -D lane", "vcs.commit.branch", "git-branch-write"],
    ["git branch", "read.shell", "git-branch-read"],
    ["git commit -m x", "vcs.commit.branch", "git-commit"],
    ["git add .", "vcs.commit.branch", "git-write"],
    ["git fetch origin", "read.vcs.remote", "git-remote-read"],
  ];
  for (const [command, cls, rule] of expected) {
    assert.deepEqual(only(command), { class: cls, rule }, command);
  }
});

test("zero-value globals are skipped exactly as before", () => {
  for (const global of ZERO_VALUE) {
    assert.deepEqual(only(`git ${global} status`), { class: "read.shell", rule: "git-read" }, global);
    assert.deepEqual(only(`git ${global} log`), { class: "read.shell", rule: "git-read" }, global);
    assert.deepEqual(
      only(`git ${global} push --force origin main`),
      { class: "vcs.history.rewrite", rule: "git-push-force" },
      global,
    );
    assert.deepEqual(only(`git ${global} reset --hard`), { class: "vcs.history.rewrite", rule: "git-reset-hard" }, global);
  }
  assert.deepEqual(only("git --no-pager -p --bare push origin lane"), { class: "vcs.push.branch", rule: "git-push-branch" });
});

test("options after the subcommand belong to the subcommand", () => {
  // `-C` and `-c` are subcommand options too; only global position is read.
  assert.deepEqual(only("git commit -C HEAD"), { class: "vcs.commit.branch", rule: "git-commit" });
  assert.deepEqual(only("git grep -C 3 needle"), { class: "read.shell", rule: "git-read" });
  assert.deepEqual(only("git log -c"), { class: "read.shell", rule: "git-read" });
  assert.deepEqual(only("git diff --git-dir x"), { class: "read.shell", rule: "git-read" });
});

test("the version and help spellings keep their old answers", () => {
  // git stops reading globals at these; the classifier keeps what it said.
  const version = failure("git --version");
  assert.equal(version.code, "unclassified");
  assert.equal(version.detail, "no rule for git");
  assert.equal(failure("git -v").detail, "no rule for git");
  assert.equal(failure("git --help").detail, "no rule for git");
});

// ---------------------------------------------------------------------------
// Criterion 6: the hook refuses under this repository's APPROVAL.md
// ---------------------------------------------------------------------------

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-git-globals-")));
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
    session_id: "s-git-globals",
    transcript_path: "/dev/null",
    cwd,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "read-only status check" },
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

test("hook: under this repository's policy every value-global spelling is refused and logs nothing", () => {
  const dir = join(scratch, "repo-policy");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), readFileSync(REPO_POLICY, "utf8"), "utf8");
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);

  const refused = [
    "git -C status push --force origin main",
    "git -C commit reset --hard",
    "git -c log rebase main",
    "git --git-dir add branch -D lane",
    "git --work-tree status push --force origin main",
    "git --namespace log push --force origin main",
    "git --attr-source status reset --hard",
    "git --config-env commit push --force origin main",
    "git --super-prefix status push --force origin main",
    "git --shallow-file log reset --hard",
    "git --git-dir=.git push --force origin main",
    "git --no-pager -C status push --force origin main",
    "git -$X status push --force origin main",
  ];
  for (const command of refused) {
    const before = logText(dir);
    const decided = verdict(dir, command);
    assert.notEqual(decided.permission, "allow", `${command}: ${decided.reason}`);
    assert.match(decided.reason, /^hook-unclassified: /u, command);
    assert.equal(logText(dir), before, `${command} must append nothing to the log`);
    assert.doesNotMatch(logText(dir), /autonomous/u, command);
  }

  // The control: a plain read still runs unattended under the same policy.
  const read = verdict(dir, "git status");
  assert.equal(read.permission, "allow", read.reason);
  assert.match(read.reason, /^autonomous: read\.shell/u);
  const push = verdict(dir, "git push origin lane");
  assert.equal(push.permission, "allow", push.reason);
  assert.match(push.reason, /vcs\.push\.branch/u);
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

const CORPUS_ALPHABET: readonly string[] = [
  ...SEPARATE_VALUE,
  ...JOINED_VALUE,
  ...ZERO_VALUE,
  "--html-path",
  "--exec-path",
  "--list-cmds=main",
  "--version",
  "--help",
  "-v",
  "-h",
  "-Cstatus",
  "--paginat",
  "--",
  "-$X",
  ...VALUES,
];

const CORPUS_TAILS: readonly string[] = [...DANGEROUS, ...ORDINARY, "", "tag v1", "tag -l", "clone x", "fetch origin"];

function* corpus(depth: number): Generator<{ command: string; tail: string }> {
  for (const prefix of prefixes(CORPUS_ALPHABET, depth)) {
    for (const tail of CORPUS_TAILS) {
      yield { command: ["git", ...prefix, tail].filter((word) => word !== "").join(" "), tail };
    }
  }
}

/** Does the line carry, in global position, a word the fix refuses? */
function carriesRefusedGlobal(command: string): boolean {
  for (const word of command.split(" ").slice(1)) {
    if (!word.startsWith("-") || ["-h", "--help", "-v", "--version"].includes(word)) return false;
    if ((ZERO_VALUE as readonly string[]).includes(word)) continue;
    if (["--html-path", "--man-path", "--info-path", "--exec-path"].includes(word)) continue;
    if (word.startsWith("--list-cmds=")) continue;
    return true;
  }
  return false;
}

function same(a: CommandClassification, b: CommandClassification): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

test("differential: stricter-only against the base classifier", async (t) => {
  const basePath = process.env["APPROVAL_DIFF_BASE"];
  if (basePath === undefined || basePath === "") {
    t.skip("APPROVAL_DIFF_BASE is not set (path to the base build's dist/src/core/command-class.js)");
    return;
  }
  const base = (await import(pathToFileURL(basePath).href)) as { classifyCommand: (command: string) => CommandClassification };
  const depth = Number(process.env["APPROVAL_DIFF_DEPTH"] ?? "2");
  const counts = { total: 0, unchanged: 0, okToRefused: 0, refusedToRefused: 0, loosened: 0, reclassified: 0, baseDiffersFromTail: 0 };
  const okToRefusedBy = new Map<string, number>();
  const problems: string[] = [];
  for (const { command, tail } of corpus(depth)) {
    counts.total += 1;
    const before = base.classifyCommand(command);
    const now = classifyCommand(command);
    if (same(before, now)) {
      counts.unchanged += 1;
      continue;
    }
    if (!carriesRefusedGlobal(command)) problems.push(`moved without a refused global: ${command}`);
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
      // Diagnostic only: the base answer differs from what the tail alone
      // (`git push --force origin main`) answers, i.e. the global moved it.
      if (tail !== "") {
        const alone = base.classifyCommand(`git ${tail}`);
        if (!alone.ok || alone.classes.join("+") !== key) counts.baseDiffersFromTail += 1;
      }
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
  const hole = base.classifyCommand("git -C status push --force origin main");
  assert.equal(hole.ok, true, "the base classifier answered the hole");
});
