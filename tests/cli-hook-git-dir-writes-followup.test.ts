/**
 * APRV-518 follow-up: a read with a redirection elsewhere, and read-class
 * commands that write a file through one of their own words.
 *
 * A: `cat .git/HEAD > /tmp/x` reads `.git` and writes `/tmp/x`; only the
 * redirection target is a write, so it is the workspace write 0.4.8 called
 * it. A redirection INTO `.git` stays `git-dir-write`, and so does a
 * non-read with a `.git` operand.
 * B: `sort -o`, `uniq <in> <out>`, sed's `w` command and `s///w` flag, and
 * `tree -o` name a file they write; that file takes the `.git` rules, text
 * and disk. Their class is otherwise unchanged (`sort -o out.txt in.txt`
 * stays a read).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { classifyForHook } from "../src/cli/hook.js";
import { classifyCommand } from "../src/core/command-class.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-git-dir-writes-followup-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

const HOME = join(scratch, "home");
mkdirSync(HOME);
writeFileSync(join(HOME, ".gitconfig"), "[user]\n\tname = Dir Oracle\n\temail = oracle@example.invalid\n[init]\n\tdefaultBranch = main\n");
process.env["HOME"] = HOME;
process.env["GIT_CONFIG_NOSYSTEM"] = "1";
delete process.env["GIT_CONFIG_GLOBAL"];
delete process.env["GIT_DIR"];
delete process.env["GIT_WORK_TREE"];
delete process.env["CDPATH"];

const GIT = spawnSync("git", ["--version"]).status === 0;
const skip = GIT ? false : "no git binary";

function git(cwd: string, ...args: string[]): void {
  const ran = spawnSync("git", args, { cwd, encoding: "utf8", env: process.env });
  assert.equal(ran.status, 0, `git ${args.join(" ")}: ${ran.stderr}`);
}

/** Every segment as `class rule`, pure; a refusal as `refused <code>`. */
function pure(command: string): string[] {
  const result = classifyCommand(command, []);
  return result.ok ? result.segments.map((segment) => `${segment.class} ${segment.rule}`) : [`refused ${result.code}`];
}

/**
 * Every segment as `class rule`, through the hook's refinements, in `cwd`,
 * with the disk pass's `git-dir-write` entry shown in its segment's place.
 */
function hook(command: string, cwd: string): string[] {
  const result = classifyForHook(command, [], cwd).result;
  if (!result.ok) return [`refused ${result.code}`];
  const shown: string[] = [];
  for (const [at, segment] of result.segments.entries()) {
    const next = result.segments[at + 1];
    if (next !== undefined && next.text === segment.text && next.rule === "git-dir-write") continue;
    shown.push(`${segment.class} ${segment.rule}`);
  }
  return shown;
}

const DIR_WRITE = "vcs.history.rewrite git-dir-write";
const READ_SHELL = "read.shell read-shell";

let cases = 0;
function root(): string {
  cases += 1;
  const dir = join(scratch, `case-${String(cases)}`);
  mkdirSync(dir);
  return dir;
}
function checkout(at: string = root(), name = "repo"): string {
  const dir = join(at, name);
  mkdirSync(join(dir, "sub"), { recursive: true });
  git(dir, "init", "-q");
  git(dir, "commit", "-q", "--allow-empty", "-m", "c0");
  return dir;
}


// ---------------------------------------------------------------------------
// A: a read with a redirection elsewhere
// ---------------------------------------------------------------------------

test("A: a read of .git whose redirection writes elsewhere is the workspace write 0.4.8 called it", () => {
  for (const command of [
    "cat .git/HEAD > /tmp/x",
    "ls .git/hooks > list.txt",
    "du -sh .git > size.txt",
    "wc -l .git/HEAD > n.txt",
    'grep -r foo ".git/config" > out.txt',
  ]) {
    assert.deepEqual(pure(command), ["files.write.workspace redirect-write"], command);
  }
});

test("A: a redirection into .git, and a non-read with a .git operand, stay git-dir-write", () => {
  for (const command of ["cat x > .git/config", "ls >> .git/hooks/pre-push", "cat x > .gi?/config", "cp .git/config /tmp/c", "tar -czf b.tgz .git", "rm .git/index.lock"]) {
    assert.deepEqual(pure(command), [DIR_WRITE], command);
  }
  assert.deepEqual(pure("cd .git && cat ../x > config"), [READ_SHELL, DIR_WRITE]);
  assert.deepEqual(pure("D=.git; cat x > $D/config"), ["read.shell assignment", DIR_WRITE]);
});

test("A hook: the disk pass agrees, a read's own words are no write targets", { skip }, () => {
  const repo = checkout();
  symlinkSync(".git", join(repo, "g"));
  assert.deepEqual(hook("cat .git/HEAD > list.txt", repo), ["files.write.workspace redirect-write"]);
  assert.deepEqual(hook("cat g/HEAD > list.txt", repo), ["files.write.workspace redirect-write"]);
  assert.deepEqual(hook("cat x > g/config", repo), [DIR_WRITE]);
  assert.deepEqual(hook("cp g/config /tmp/c", repo), [DIR_WRITE]);
});

// ---------------------------------------------------------------------------
// B: read-class commands that write through a word
// ---------------------------------------------------------------------------

test("B: a read's own output word takes the .git rules", () => {
  for (const command of [
    "sort x -o .git/config",
    "sort x --output=.git/config",
    "sort -o.git/config x",
    "uniq a .git/config",
    'sed -n "w .git/config" x',
    "sort -uo .git/config x",
    "sort --out .git/config x",
    "uniq -f 1 a .git/config",
    'sed "s/a/b/w .git/x" y',
    'sed -e "1w .git/x" -e p y',
    'sed -ne "/x/w .git/y" z',
    "tree -o .git/x",
    "sort -o .git/config x > out.txt",
  ]) {
    assert.deepEqual(pure(command), [DIR_WRITE], command);
  }
  assert.deepEqual(pure("cd .git && sort -o config x"), [READ_SHELL, DIR_WRITE]);
});

test("B: the same commands writing elsewhere, or not writing, do not move", () => {
  assert.deepEqual(pure("sort -o out.txt in.txt"), [READ_SHELL]);
  assert.deepEqual(pure("uniq a b"), [READ_SHELL]);
  assert.deepEqual(pure('sed -n "w out.txt" x'), ["read.shell sed-read"]);
  assert.deepEqual(pure('sed -n "/word/p" x'), ["read.shell sed-read"]);
  assert.deepEqual(pure('sed "s/w/v/" x'), ["read.shell sed-read"]);
  // A `w` inside an address or a pattern is no write command, even before `.git`.
  assert.deepEqual(pure('sed -n "/w .git/p" x'), ["read.shell sed-read"]);
  assert.deepEqual(pure('sed "s/w .git/x/" y'), ["read.shell sed-read"]);
  assert.deepEqual(pure("sort -t, -k1 x"), [READ_SHELL]);
  assert.deepEqual(pure("sed -f s.sed x"), ["read.shell sed-read"]);
});

test("B hook: a read's output word is walked on disk", { skip }, () => {
  const repo = checkout();
  symlinkSync(".git", join(repo, "g"));
  assert.deepEqual(hook("sort x -o g/config", repo), [DIR_WRITE]);
  assert.deepEqual(hook("uniq a g/config", repo), [DIR_WRITE]);
  assert.deepEqual(hook('sed -n "w g/config" x', repo), [DIR_WRITE]);
  assert.deepEqual(hook("sort -o out.txt in.txt", repo), [READ_SHELL]);
  assert.deepEqual(hook('sed -n "/word/p" g/config', repo), ["read.shell sed-read"]);
});
