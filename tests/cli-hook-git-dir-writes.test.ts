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
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { classifyForHook } from "../src/cli/hook.js";
import { classifyCommand } from "../src/core/command-class.js";

// Design v4 (writes outside the workspace): a write onto the guarded list (a
// git hooks folder) or to a target the hook cannot read carries
// files.write.guarded BESIDE its own class; the class asserted here stands.
const LISTED = "files.write.guarded write-guarded";
const UNREADABLE = "files.write.guarded write-unreadable";

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

/**
 * Every segment as `class rule`, through the hook's refinements, in `cwd`.
 * The disk pass ADDS a `git-dir-write` entry beside the segment it raises
 * (same text); this shows that entry in the segment's place, and the test
 * "the disk pass adds its class beside the segment's own" pins the pair.
 */
function hook(command: string, cwd: string): string[] {
  const result = classifyForHook(command, [], cwd).result;
  assert.equal(result.ok, true, `${command}: ${JSON.stringify(result)}`);
  if (!result.ok) return [];
  const shown: string[] = [];
  for (const [at, segment] of result.segments.entries()) {
    const next = result.segments[at + 1];
    if (next !== undefined && next.text === segment.text && next.rule === "git-dir-write") continue;
    shown.push(`${segment.class} ${segment.rule}`);
  }
  return shown;
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
  assert.deepEqual(hook("cp /tmp/x pre-push", hooks), [DIR_WRITE, LISTED]);
  assert.deepEqual(hook("echo x > config", join(repo, ".git")), ["vcs.history.rewrite git-dir-write"]);
  assert.deepEqual(hook("cd .. && printf x >> config", hooks), ["read.shell read-shell", DIR_WRITE, LISTED]);
});

test("S1 hook: the disk pass adds its class beside the segment's own, so later passes still judge the segment", { skip }, () => {
  const repo = checkout();
  symlinkSync(".git", join(repo, "g"));
  const result = classifyForHook("echo x >> g/config", [], repo).result;
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.segments.map((segment) => `${segment.class} ${segment.rule}`),
    ["files.write.workspace redirect-write", DIR_WRITE],
  );
  // From a hook directory inside .git, the segment keeps its own class beside the added one.
  const deleted = classifyForHook("rm -rf old", [], join(repo, ".git", "hooks")).result;
  assert.equal(deleted.ok, true);
  if (!deleted.ok) return;
  assert.deepEqual(
    deleted.segments.map((segment) => `${segment.class} ${segment.rule}`),
    ["files.write.workspace rm-workspace", DIR_WRITE],
  );
});

test("S1 hook: a symlink to .git that exists beforehand is followed", { skip }, () => {
  const repo = checkout();
  symlinkSync(".git", join(repo, "g"));
  assert.deepEqual(pure("echo x >> g/config"), ["files.write.workspace redirect-write"]);
  assert.deepEqual(hook("echo x >> g/config", repo), [DIR_WRITE]);
  assert.deepEqual(hook("cp /tmp/x g/hooks/pre-push", repo), [DIR_WRITE, LISTED]);
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

test("S2 hook: every tail of an option cluster is a candidate, a bare name included", { skip }, () => {
  const repo = checkout();
  symlinkSync(".git/hooks", join(repo, "hooks"));
  // `-vthooks`: the value of -t is the bare name `hooks`, the link into .git/hooks.
  assert.deepEqual(hook("cp /tmp/x -vthooks", repo), [DIR_WRITE, LISTED]);
  assert.deepEqual(hook("tar -xf a.tar -Chooks", repo), [DIR_WRITE]);
  // Inside .git, a bare tail lands there too.
  assert.deepEqual(pure("cd .git && cp /tmp/x -vthooks"), ["read.shell read-shell", DIR_WRITE]);
  assert.ok(hook("cd .git && cp /tmp/x -vthooks", repo).includes(DIR_WRITE));
  // The accepted cost of the strict side: a tail that is no value but names such a link.
  symlinkSync(".git/hooks", join(repo, "l"));
  assert.deepEqual(hook("cp -vt/tmp/av-approval x.py", repo), [DIR_WRITE]);
  // A cluster none of whose tails lands in a git directory does not move.
  assert.deepEqual(hook("cp -vt/tmp/build x.py", repo), ["files.write.workspace workspace-write"]);
});

test("S1 hook: a sure write target the hook cannot place is judged the strict way; a possible one as text", { skip: skip || (process.getuid?.() === 0 ? "root reads a mode-000 directory" : false) }, () => {
  const repo = checkout();
  // A mode-000 directory: lstat below it says EACCES, so whether a link to .git is there cannot be known.
  const locked = join(repo, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  try {
    assert.deepEqual(hook("echo x > locked/f", repo), [DIR_WRITE]);
    assert.deepEqual(hook("cp a locked/f", repo), [DIR_WRITE]);
    assert.deepEqual(hook("curl -o locked/f https://example.invalid/x", repo), [DIR_WRITE]);
    // Every curl and wget option that names a file it writes is a sure target.
    for (const command of [
      "curl -so locked/f https://example.invalid/x",
      "curl -sSo locked/f https://example.invalid/x",
      "curl --output-dir locked/sub -O https://example.invalid/f",
      "curl --output-dir=locked/sub -O https://example.invalid/f",
      "wget -o locked/log https://example.invalid/x",
      "wget -a locked/log https://example.invalid/x",
      "wget -qo locked/log https://example.invalid/x",
      "wget --output-file=locked/log https://example.invalid/x",
      "wget --append-output locked/log https://example.invalid/x",
    ]) {
      assert.deepEqual(hook(command, repo), [DIR_WRITE], command);
    }
    // A word that is only a possible target (a wget header value) is judged by its text: no .git, no move.
    assert.deepEqual(hook("wget --header=locked/f https://example.invalid/x", repo), ["read.web web-read"]);
  } finally {
    chmodSync(locked, 0o755);
  }
  // A name over 255 bytes: ENAMETOOLONG. A redirection target is sure ...
  assert.deepEqual(hook(`echo x > ${"a".repeat(300)}`, repo), [DIR_WRITE]);
  // ... a curl -d payload is not: the ordinary long-payload line does not move.
  assert.deepEqual(hook(`curl -X POST https://example.invalid/x -d ${"x".repeat(400)}`, repo), ["network.call web-write"]);
  // A link loop cannot be placed, whatever names it.
  symlinkSync("loop2", join(repo, "loop1"));
  symlinkSync("loop1", join(repo, "loop2"));
  assert.deepEqual(hook("echo x > loop1/f", repo), [DIR_WRITE, UNREADABLE]);
});

test("S1 hook: a possible target that cannot be placed falls back to its text, against the known git directories too", { skip: skip || (process.getuid?.() === 0 ? "root reads a mode-000 directory" : false) }, () => {
  cases += 1;
  const root = join(scratch, `case-${String(cases)}`);
  mkdirSync(root);
  git(root, "init", "-q", "--separate-git-dir=store", "repo");
  const repo = join(root, "repo");
  const locked = join(repo, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  try {
    // The header value is no sure target, and nothing below `locked` can be
    // walked (EACCES); by its text it lies in the separate git directory,
    // which the classifier cannot know, or has a `.git` segment.
    assert.deepEqual(pure("wget --header=locked/x/../../../store/config https://example.invalid/x"), ["read.web web-read"]);
    assert.deepEqual(hook("wget --header=locked/x/../../../store/config https://example.invalid/x", repo), [DIR_WRITE]);
    assert.deepEqual(hook("wget --header=locked/x/../../.git/config https://example.invalid/x", repo), [DIR_WRITE]);
    // By its text elsewhere: no move.
    assert.deepEqual(hook("wget --header=locked/x/../../notes https://example.invalid/x", repo), ["read.web web-read"]);
  } finally {
    chmodSync(locked, 0o755);
  }
});

test("S1 hook: ordinary writes in a checkout do not move", { skip }, () => {
  const repo = checkout();

  assert.deepEqual(hook("cd sub && echo x > notes.txt", repo), ["read.shell read-shell", "files.write.workspace redirect-write"]);
  assert.deepEqual(hook("> out.log", repo), ["files.write.workspace redirect-write"]);
  assert.deepEqual(hook("cp a b", repo), ["files.write.workspace workspace-write"]);
  assert.deepEqual(hook("mkdir -p build && cp src.txt build/", repo), ["files.write.workspace workspace-write", "files.write.workspace workspace-write"]);
  // A cd the hook cannot follow adds no directory: the write is judged from the hook's own.
  assert.deepEqual(hook('cd "$D" && echo x > config', repo), ["read.shell read-shell", "files.write.workspace redirect-write", UNREADABLE]);
});

// ---------------------------------------------------------------------------
// The security review of the fold: four ways past the hook's disk reading
// ---------------------------------------------------------------------------

test("review 1: a dangling symlink into .git is written through, so the write is git-dir-write", { skip }, () => {
  const repo = checkout();
  // The link exists; its target does not yet. A redirect creates the target.
  symlinkSync(".git/hooks/pre-push", join(repo, "hookfile"));
  assert.deepEqual(hook("printf '#!/bin/sh' > hookfile", repo), [DIR_WRITE, LISTED]);
  symlinkSync(join(repo, ".git", "hooks", "nope", "x"), join(repo, "deep"));
  assert.deepEqual(hook("cp /tmp/x deep", repo), [DIR_WRITE, LISTED]);
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
  assert.deepEqual(hook('cd "$D" && echo x >> config', repo), ["read.shell read-shell", "files.write.workspace redirect-write", UNREADABLE]);
  assert.deepEqual(hook("cd - && echo x >> config", repo), ["read.shell read-shell", "files.write.workspace redirect-write", UNREADABLE]);
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
// The second review: cd is followed only where its landing is certain
// ---------------------------------------------------------------------------

/** The hook's classes and notes for a line, in `cwd`. */
function hookWithNotes(command: string, cwd: string): { classes: string[]; notes: string[] } {
  const refined = classifyForHook(command, [], cwd);
  assert.equal(refined.result.ok, true, `${command}: ${JSON.stringify(refined.result)}`);
  return {
    classes: refined.result.ok ? refined.result.segments.map((segment) => `${segment.class} ${segment.rule}`) : [],
    notes: refined.notes,
  };
}

const CANNOT_PLACE = /which this hook cannot place; it is judged from the directories it can name \(known limit\)/u;

test("round 2, (1): a certain cd is judged at both landings, the logical one (cd -L) and the physical one (cd -P)", { skip }, () => {
  const repo = checkout();
  symlinkSync(".git", join(repo, "g"));
  const deep = join(repo, "..", "other", "deep");
  mkdirSync(deep, { recursive: true });
  symlinkSync(deep, join(repo, "x"));
  // Logically `x/../g` is `g`, which is .git; physically it is other/g, which is nothing.
  assert.deepEqual(hook("cd x/../g && echo x >> config", repo), ["read.shell read-shell", DIR_WRITE]);
  assert.deepEqual(hook("cd -L x/../g && echo x >> config", repo), ["read.shell read-shell", DIR_WRITE]);
  const physical = hookWithNotes("cd -P x/../g && echo x >> config", repo);
  assert.deepEqual(physical.classes, ["read.shell read-shell", "files.write.workspace redirect-write"]);
  assert.equal(physical.notes.length, 0, "-P is a certain form");
  // And the physical landing alone: l -> .git/hooks, so `l/..` is physically .git.
  symlinkSync(".git/hooks", join(repo, "l"));
  assert.deepEqual(hook("cd l/.. && echo x >> config", repo), ["read.shell read-shell", DIR_WRITE]);
});

test("round 2, (2): after a segment that may change HOME, CDPATH, OLDPWD or PWD, a bare-name or no-argument cd cannot be placed", { skip }, () => {
  const repo = checkout();
  // Most such segments have no row and refuse the whole line before any pass.
  for (const command of [
    "export CDPATH=/x; cd sub && echo x > notes.txt",
    "CDPATH=/x; cd sub && echo x > notes.txt",
    "unset HOME; cd && echo x > notes.txt",
    "declare -x HOME=/x; cd ~/sub && echo x > notes.txt",
    "set -a; cd sub && echo x > notes.txt",
    ". ./env.sh; cd sub && echo x > notes.txt",
  ]) {
    assert.equal(classifyForHook(command, [], repo).result.ok, false, command);
  }
  // The ones that classify (a bare PWD= or OLDPWD= assignment) cannot be placed.
  for (const command of ["PWD=/x; cd sub && echo x > notes.txt", "PWD=/x; cd ./sub && echo x > notes.txt", "OLDPWD=/x; cd && echo x > notes.txt"]) {
    const { classes, notes } = hookWithNotes(command, repo);
    assert.ok(classes.includes("files.write.workspace redirect-write"), `${command}: ${classes.join(", ")}`);
    assert.ok(notes.some((note) => CANNOT_PLACE.test(note)), `${command}: ${notes.join(" | ")}`);
  }
  // Without such a segment the same cd is certain, and nothing is said.
  assert.deepEqual(hookWithNotes("cd sub && echo x > notes.txt", repo).notes, []);
  // A landing it can still name is judged: `cd g` from here is .git, whatever CDPATH became.
  symlinkSync(".git", join(repo, "g"));
  assert.ok(hookWithNotes("PWD=/x; cd g && echo x >> config", repo).classes.includes(DIR_WRITE));
});

test("round 2, (3): forms the hook does not model are unknown, never placed", { skip }, () => {
  const repo = checkout();
  // A glob is expanded on disk (second review): with two matches it is unknown.
  mkdirSync(join(repo, "sub2"));
  for (const command of [
    "cd a b && echo x > f",
    "cd +1 && echo x > f",
    "cd -2 && echo x > f",
    "cd - && echo x > f",
    'cd "$D" && echo x > f',
    "cd $D && cp a f",
    "cd ~nobody && rm f",
    "cd * && tee f",
  ]) {
    const { classes, notes } = hookWithNotes(command, repo);
    assert.equal(classes[0], "read.shell read-shell", command);
    assert.ok(!classes.includes(DIR_WRITE), `${command}: ${classes.join(", ")}`);
    assert.ok(notes.some((note) => CANNOT_PLACE.test(note)), `${command}: ${notes.join(" | ")}`);
  }
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
