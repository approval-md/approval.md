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
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  assert.deepEqual(pure("sort -t, -k1 x"), [READ_SHELL]);
  assert.deepEqual(pure("sed -f s.sed x"), ["read.shell sed-read"]);
});

test("B review: a sed script is not parsed; with a w or W, its words and the rest of each w's line are possible targets", () => {
  for (const command of [
    'sed -n "w .git/config" x',
    'sed -n "/a[/]b/w .git/config" x',
    'sed -e ":a;w .git/config" x',
    'sed -n "w .git/my config" x',
    'sed "s/a/b/w .git/config" x',
    'sed -n "1~2w .git/x" f',
    'sed -n "/a/{w .git/x\n}" f',
  ]) {
    assert.deepEqual(pure(command), [DIR_WRITE], command);
  }
  // No w or W, or no .git among the possible targets: nothing moves.
  for (const command of [
    'sed -n "/word/p" x',
    'sed "s/w/v/" x',
    'sed -e "s/a/b/" -e "/w/d" x',
    'sed "y/abc/xyw/" x',
    'sed -n "5,10p" x',
    'sed "s/www/x/" file',
    'sed -n "/word/p" .git/config',
    'sed -n "w out.txt" x',
    'sed -n "1e echo" f',
  ]) {
    assert.deepEqual(pure(command), ["read.shell sed-read"], command);
  }
  assert.deepEqual(pure('sed -i "" "s/old/new/" src/w.ts'), ["files.write.workspace sed-in-place"]);
  // A script file cannot be read from the line (a known limit).
  assert.deepEqual(pure("sed -f s.sed x"), ["read.shell sed-read"]);
});

test("B review hook: a sed write through a link to .git, a name with blanks kept whole", { skip }, () => {
  const repo = checkout();
  symlinkSync(".git", join(repo, "l"));
  assert.deepEqual(hook('sed -n "w l/config" x', repo), [DIR_WRITE]);
  assert.deepEqual(hook('sed -n "w l/my config" x', repo), [DIR_WRITE]);
  mkdirSync(join(repo, "my dir"));
  symlinkSync("../.git", join(repo, "my dir", "g"));
  assert.deepEqual(hook('sed -n "w my dir/g/config" x', repo), [DIR_WRITE]);
  assert.deepEqual(hook('sed -n "w out.txt" x', repo), ["read.shell sed-read"]);
});

test("B review: a sed name is judged both as literal text and as a shell word; either finding .git is a hit", { skip }, () => {
  // As a shell word: an unquoted script word is expanded before sed sees it.
  assert.deepEqual(pure("sed -n -e w.g{i,}t/config x"), [DIR_WRITE]);
  // `.gi?` as a shell pattern names .git: the strict answer, kept.
  assert.deepEqual(pure("sed -n 'w .gi?/config' x"), [DIR_WRITE]);
  const repo = checkout();
  assert.deepEqual(hook("sed -n -e w.g{i,}t/config x", repo), [DIR_WRITE]);
  assert.deepEqual(hook("sed -n 'w .gi?/config' x", repo), [DIR_WRITE]);
  // As literal text: a directory literally named `l$x`, linked to .git.
  symlinkSync(".git", join(repo, "l$x"));
  assert.deepEqual(hook("sed -n 'w l$x/config' x", repo), [DIR_WRITE]);
  // The tag is the sed name's, not its text's: a redirection spelled the same
  // is a shell pattern, a hit when .git matches it ...
  assert.deepEqual(hook("sed -n 'w .g*t/x' f > .g*t/x", repo), [DIR_WRITE]);
  // ... and expanded on disk otherwise.
  symlinkSync(".git", join(repo, "link"));
  assert.deepEqual(hook("sed -n 'w l*k/x' f > l*k/x", repo), [DIR_WRITE]);
  // The sed name as a shell word is expanded on disk too: only the hook sees this.
  assert.deepEqual(pure("sed -n 'w l*k/config' x"), ["read.shell sed-read"]);
  assert.deepEqual(hook("sed -n 'w l*k/config' x", repo), [DIR_WRITE]);
  // Only the literal reading sees a directory literally named `{a,b}` ...
  symlinkSync(".git", join(repo, "{a,b}"));
  assert.deepEqual(hook("sed -n 'w {a,b}/config' x", repo), [DIR_WRITE]);
  // ... and, with no disk, a relative name with a `$` after `cd .git`.
  assert.deepEqual(pure("cd .git && sed -n 'wco$nfig' x"), [READ_SHELL, DIR_WRITE]);
  // Only the script's words (rule 3b) see `l/config` in `w out;l/config`.
  symlinkSync(".git", join(repo, "l"));
  assert.deepEqual(hook('sed -n "w out;l/config" x', repo), [DIR_WRITE]);
  // The shell still expands `$D` inside double quotes before sed sees it (S3).
  assert.deepEqual(pure('D=.git; sed -n "w $D/config" x'), ["read.shell assignment", DIR_WRITE]);
});

test("B review: ordinary sed lines do not move, pure and in a plain checkout", { skip }, () => {
  const repo = checkout();
  for (const command of [
    'sed "s/w/v/" x',
    'sed -n "/word/p" x',
    'sed "y/abc/xyw/" x',
    'sed -n "5,10p" x',
    'sed "s/www/x/" file',
    'sed "s/{a,b}/x/" f',
    'sed "s/*w*/x/" f',
  ]) {
    assert.deepEqual(pure(command), ["read.shell sed-read"], command);
    assert.deepEqual(hook(command, repo), ["read.shell sed-read"], command);
  }
  assert.deepEqual(pure('sed -i "" "s/old/new/" src/w.ts'), ["files.write.workspace sed-in-place"]);
});

test("review: wget's long output options are read by any prefix, on disk too", { skip }, () => {
  const repo = checkout();
  symlinkSync(".git", join(repo, "g"));
  assert.deepEqual(hook("wget --output-doc=g/config https://example.invalid/x", repo), [DIR_WRITE]);
  assert.deepEqual(hook("wget --output-f g/log https://example.invalid/x", repo), [DIR_WRITE]);
  assert.ok(!hook("wget --output-doc=out.html https://example.invalid/x", repo).includes(DIR_WRITE));
  // An abbreviated output option is a SURE target: one under a directory
  // that cannot be read is judged the strict way.
  if (process.getuid?.() !== 0) {
    const locked = join(repo, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      assert.deepEqual(hook("wget --output-doc=locked/sub/f https://example.invalid/x", repo), [DIR_WRITE]);
    } finally {
      chmodSync(locked, 0o755);
    }
  }
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
