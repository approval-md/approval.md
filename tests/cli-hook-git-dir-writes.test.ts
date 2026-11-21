/**
 * APRV-518 review fold: writes into a git directory that the literal text of
 * the target does not show (S1), and option values that carry the target (S2).
 *
 * S1, pure: a relative write after a literal `cd` (or `pushd`) into `.git` is
 * `git-dir-write`, and so is a bare redirection (`> .git/config`). S1, hook:
 * every write target is judged where the disk lands it: the hook's own
 * directory inside `.git`, a symlink to `.git` that exists beforehand, a
 * linked worktree's git directory and a `--separate-git-dir`.
 *
 * S2: `curl -o.git/config`, `wget -O.git/hooks/pre-push`, `cp -t .git/hooks`,
 * `tar -C.git` and their separate and `--long=` forms.
 *
 * Ordinary lines do not move: `cd sub && echo x > notes.txt`, `> out.log`.
 * Hermetic: HOME is a fixture directory; git runs only to make checkouts.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { classifyForHook } from "../src/cli/hook.js";
import { classifyCommand } from "../src/core/command-class.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-git-dir-writes-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

const HOME = join(scratch, "home");
mkdirSync(HOME);
writeFileSync(join(HOME, ".gitconfig"), "[user]\n\tname = Dir Oracle\n\temail = oracle@example.invalid\n[init]\n\tdefaultBranch = main\n");
process.env["HOME"] = HOME;
process.env["GIT_CONFIG_NOSYSTEM"] = "1";
delete process.env["GIT_CONFIG_GLOBAL"];
delete process.env["GIT_DIR"];
delete process.env["GIT_WORK_TREE"];

const GIT = spawnSync("git", ["--version"]).status === 0;
const skip = GIT ? false : "no git binary";

function git(cwd: string, ...args: string[]): void {
  const ran = spawnSync("git", args, { cwd, encoding: "utf8", env: process.env });
  assert.equal(ran.status, 0, `git ${args.join(" ")}: ${ran.stderr}`);
}

/** Every segment as `class rule`, pure. */
function pure(command: string): string[] {
  const result = classifyCommand(command, []);
  assert.equal(result.ok, true, `${command}: ${JSON.stringify(result)}`);
  return result.ok ? result.segments.map((segment) => `${segment.class} ${segment.rule}`) : [];
}

/** Every segment as `class rule`, through the hook's refinements, in `cwd`. */
function hook(command: string, cwd: string): string[] {
  const result = classifyForHook(command, [], cwd).result;
  assert.equal(result.ok, true, `${command}: ${JSON.stringify(result)}`);
  return result.ok ? result.segments.map((segment) => `${segment.class} ${segment.rule}`) : [];
}

const DIR_WRITE = "vcs.history.rewrite git-dir-write";
const CONFIG_WRITE = "vcs.history.rewrite git-config-file-write";

let cases = 0;
function checkout(): string {
  cases += 1;
  const dir = join(scratch, `case-${String(cases)}`, "repo");
  mkdirSync(join(dir, "sub"), { recursive: true });
  git(dir, "init", "-q");
  git(dir, "commit", "-q", "--allow-empty", "-m", "c0");
  return dir;
}

// ---------------------------------------------------------------------------
// S1, pure
// ---------------------------------------------------------------------------

test("S1 (P13, P14): a relative write after a cd into .git is git-dir-write", () => {
  assert.deepEqual(pure("cd .git && printf '[remote \"origin\"]\\n\\tmirror = true\\n' >> config"), ["read.shell read-shell", DIR_WRITE]);
  assert.deepEqual(pure("cd .git/hooks && cp /tmp/x pre-push && chmod +x pre-push"), ["read.shell read-shell", DIR_WRITE, DIR_WRITE]);
  for (const command of [
    "cd .GIT && tee config",
    "cd /repo/.git && echo x > config",
    "cd ./.git; rm index.lock",
    "cd sub && cd ../.git && echo x >> config",
    "cd sub/.git && cp a config",
    "cd .git; bash -c 'echo x > config'",
    "cd .git/hooks && wget https://example.invalid/pre-push",
    "cd .git && > config",
  ]) {
    assert.ok(pure(command).includes(DIR_WRITE), `${command}: ${pure(command).join(", ")}`);
  }
});

test("S1: a bare redirection is a write to its target and takes the same rules", () => {
  assert.deepEqual(pure("> .git/config"), [DIR_WRITE]);
  assert.deepEqual(pure(">> .GIT/hooks/pre-push"), [DIR_WRITE]);
  assert.deepEqual(pure(">> ~/.gitconfig"), [CONFIG_WRITE]);
  assert.deepEqual(pure("> out.log"), ["files.write.workspace redirect-write"]);
});

test("S1: ordinary lines do not move, and a cd that cannot be followed moves nothing", () => {
  assert.deepEqual(pure("cd sub && echo x > notes.txt"), ["read.shell read-shell", "files.write.workspace redirect-write"]);
  assert.deepEqual(pure("cd .git && echo x > ../notes.txt"), ["read.shell read-shell", "files.write.workspace redirect-write"]);
  assert.deepEqual(pure("cd .git/.. && echo x > config"), ["read.shell read-shell", "files.write.workspace redirect-write"]);
  assert.deepEqual(pure("cd .git && ls && cat config"), ["read.shell read-shell", "read.shell read-shell", "read.shell read-shell"]);
  // `cd "$D"`, `cd -`: where the shell went is unknown, so a relative write is judged as written.
  assert.deepEqual(pure('cd "$D" && echo x > config'), ["read.shell read-shell", "files.write.workspace redirect-write"]);
  assert.deepEqual(pure("cd - && echo x > config"), ["read.shell read-shell", "files.write.workspace redirect-write"]);
});

// ---------------------------------------------------------------------------
// S2: option values that carry the write target
// ---------------------------------------------------------------------------

test("S2 (P15, P16, P17): curl and wget output options, attached, separate and long", () => {
  for (const command of [
    "curl -o.git/config https://example.invalid/x",
    "curl -o .git/config https://example.invalid/x",
    "curl --output=.git/config https://example.invalid/x",
    "curl --output .git/config https://example.invalid/x",
    "curl -so.git/config https://example.invalid/x",
    "wget -O.git/hooks/pre-push https://example.invalid/x",
    "wget -O .git/hooks/pre-push https://example.invalid/x",
    "wget --output-document=.git/hooks/pre-push https://example.invalid/x",
    "wget -P.git/hooks https://example.invalid/pre-push",
    "wget --directory-prefix=.git/hooks https://example.invalid/pre-push",
  ]) {
    assert.deepEqual(pure(command), [DIR_WRITE], command);
  }
  assert.deepEqual(pure("curl -o~/.gitconfig https://example.invalid/x"), [CONFIG_WRITE]);
});

test("S2: -t, -C and their long forms, attached and separate", () => {
  for (const command of [
    "cp x -t .git/hooks",
    "cp -t.git/hooks x",
    "cp -t .git/hooks x",
    "cp --target-directory=.git/hooks x",
    "mv -t.git/hooks x",
    "mv x -t .git/hooks",
    "mv --target-directory=.git/hooks x",
    "ln -st.git/hooks /tmp/x",
    "tar -xf a.tar -C .git",
    "tar -xf a.tar -C.git",
    "tar -xfC a.tar .git",
    "tar --directory=.git -xf a.tar",
  ]) {
    assert.deepEqual(pure(command), [DIR_WRITE], command);
  }
  assert.deepEqual(pure("cp -t ~/.config/git x"), [CONFIG_WRITE]);
});

test("S2: an operand's `key=value` value is read for the path it names", () => {
  assert.deepEqual(pure("make DESTDIR=.git/hooks install"), [DIR_WRITE]);
  assert.deepEqual(pure("npm test -- outfile=.git/hooks/pre-push"), [DIR_WRITE]);
});

test("S2 (P69): commands with no row stay refused, whatever their options", () => {
  for (const command of ["install -m 755 /tmp/x .git/hooks/pre-push", "install -t .git/hooks x", "dd of=.git/config"]) {
    const result = classifyCommand(command, []);
    assert.equal(result.ok, false, command);
  }
});

test("S2: an option value that names no git directory does not move", () => {
  assert.deepEqual(pure("cp -t.gitx/hooks x"), ["files.write.workspace workspace-write"]);
  assert.deepEqual(pure("tar -xf a.tar -C build"), ["files.write.workspace tar-extract"]);
  assert.deepEqual(pure("curl -o out.json https://example.invalid/x"), ["read.web web-read"]);
});

// ---------------------------------------------------------------------------
// S1, the hook: where the disk lands a write
// ---------------------------------------------------------------------------

test("S1 hook: a hook whose own directory is inside .git makes every relative write git-dir-write", { skip }, () => {
  const repo = checkout();
  const hooks = join(repo, ".git", "hooks");
  assert.deepEqual(hook("cp /tmp/x pre-push", hooks), [DIR_WRITE]);
  assert.deepEqual(hook("echo x > config", join(repo, ".git")), ["vcs.history.rewrite git-dir-write"]);
  assert.deepEqual(hook("cd .. && printf x >> config", hooks), ["read.shell read-shell", DIR_WRITE]);
});

test("S1 hook: a symlink to .git that exists beforehand is followed", { skip }, () => {
  const repo = checkout();
  symlinkSync(".git", join(repo, "g"));
  assert.deepEqual(pure("echo x >> g/config"), ["files.write.workspace redirect-write"]);
  assert.deepEqual(hook("echo x >> g/config", repo), [DIR_WRITE]);
  assert.deepEqual(hook("cp /tmp/x g/hooks/pre-push", repo), [DIR_WRITE]);
  assert.deepEqual(hook("cd ./g && echo x >> config", repo), ["read.shell read-shell", DIR_WRITE]);
  // A bare name is tried from the hook's directory (and each CDPATH entry), so it is followed too.
  assert.deepEqual(hook("cd g && echo x >> config", repo), ["read.shell read-shell", DIR_WRITE]);
});

test("S1 hook: a separate git directory and a linked worktree's git directory are git directories", { skip }, () => {
  cases += 1;
  const root = join(scratch, `case-${String(cases)}`);
  mkdirSync(root);
  git(root, "init", "-q", "--separate-git-dir=store", "repo");
  const repo = join(root, "repo");
  git(repo, "commit", "-q", "--allow-empty", "-m", "c0");
  assert.deepEqual(hook("printf x >> ../store/config", repo), [DIR_WRITE]);
  assert.deepEqual(hook(`cp /tmp/x ${join(root, "store", "hooks", "pre-push")}`, repo), [DIR_WRITE]);
  // A linked worktree: its git directory lives under the main checkout's.
  const main = checkout();
  git(main, "worktree", "add", "-q", "--detach", "../wt");
  const wt = join(main, "..", "wt");
  assert.deepEqual(hook(`printf x >> ${join(main, ".git", "worktrees", "wt", "config.worktree")}`, wt), [DIR_WRITE]);
});

test("S1 hook: ordinary writes in a checkout do not move", { skip }, () => {
  const repo = checkout();
  assert.deepEqual(hook("cd sub && echo x > notes.txt", repo), ["read.shell read-shell", "files.write.workspace redirect-write"]);
  assert.deepEqual(hook("> out.log", repo), ["files.write.workspace redirect-write"]);
  assert.deepEqual(hook("cp a b", repo), ["files.write.workspace workspace-write"]);
  assert.deepEqual(hook("mkdir -p build && cp src.txt build/", repo), ["files.write.workspace workspace-write", "files.write.workspace workspace-write"]);
  // A cd the hook cannot follow adds no directory: the write is judged from the hook's own.
  assert.deepEqual(hook('cd "$D" && echo x > config', repo), ["read.shell read-shell", "files.write.workspace redirect-write"]);
});

// ---------------------------------------------------------------------------
// The security review of the fold: four ways past the hook's disk reading
// ---------------------------------------------------------------------------

test("review 1: a dangling symlink into .git is written through, so the write is git-dir-write", { skip }, () => {
  const repo = checkout();
  // The link exists; its target does not yet. A redirect creates the target.
  symlinkSync(".git/hooks/pre-push", join(repo, "hookfile"));
  assert.deepEqual(hook("printf '#!/bin/sh' > hookfile", repo), [DIR_WRITE]);
  symlinkSync(join(repo, ".git", "hooks", "nope", "x"), join(repo, "deep"));
  assert.deepEqual(hook("cp /tmp/x deep", repo), [DIR_WRITE]);
  // A dangling link elsewhere is an ordinary write.
  symlinkSync("build/out.txt", join(repo, "outlink"));
  assert.deepEqual(hook("echo x > outlink", repo), ["files.write.workspace redirect-write"]);
});

test("review 2: a bare-name cd is followed from the hook's directory and each CDPATH entry; an unknown cd is a known limit", { skip }, () => {
  const repo = checkout();
  symlinkSync(".git", join(repo, "g"));
  const elsewhere = join(repo, "..", "elsewhere");
  mkdirSync(elsewhere);
  const saved = process.env["CDPATH"];
  process.env["CDPATH"] = repo;
  try {
    assert.deepEqual(hook("cd g && echo x >> config", elsewhere), ["read.shell read-shell", DIR_WRITE]);
  } finally {
    if (saved === undefined) delete process.env["CDPATH"];
    else process.env["CDPATH"] = saved;
  }
  assert.deepEqual(hook("cd -L .git && echo x >> config", repo), ["read.shell read-shell", DIR_WRITE]);
  // Known limit: a target the text cannot give adds no directory, and the
  // write is judged from the others (the write-scope pass ignores every cd).
  assert.deepEqual(hook('cd "$D" && echo x >> config', repo), ["read.shell read-shell", "files.write.workspace redirect-write"]);
  assert.deepEqual(hook("cd - && echo x >> config", repo), ["read.shell read-shell", "files.write.workspace redirect-write"]);
});

test("review 3: `..` after a symlink is applied to the physical directory, as the kernel applies it", { skip }, () => {
  const repo = checkout();
  symlinkSync(".git/hooks", join(repo, "l"));
  // Textually `l/../config` is `config`; physically it is `.git/config`.
  assert.deepEqual(pure("echo x >> l/../config"), ["files.write.workspace redirect-write"]);
  assert.deepEqual(hook("echo x >> l/../config", repo), [DIR_WRITE]);
  assert.deepEqual(hook("cd l/.. && echo x >> config", repo), ["read.shell read-shell", DIR_WRITE]);
  // And the other way: textually inside .git, physically not.
  mkdirSync(join(repo, "real"));
  symlinkSync(join(repo, "real"), join(repo, ".git", "out"));
  assert.deepEqual(hook("echo x > sub/notes.txt", repo), ["files.write.workspace redirect-write"]);
});

// ---------------------------------------------------------------------------
// A note from the same review: `HOME=… cd` is not followed by the push pass
// ---------------------------------------------------------------------------

test("a cd behind an assignment (P48) cannot be followed: the push is unreadable", { skip }, () => {
  const repo = checkout();
  git(repo, "checkout", "-q", "-b", "lane");
  const result = classifyForHook(`HOME=${repo} cd && git push origin HEAD`, [], repo).result;
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const push = result.segments.find((segment) => segment.text.startsWith("git push"));
  assert.equal(push?.rule, "git-push-config-unreadable");
  assert.equal(push?.class, "release.publish");
});
