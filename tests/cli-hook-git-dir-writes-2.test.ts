/**
 * APRV-518, second review fold: three more ways a write reaches `.git`, and
 * the tests that pin the disk pass's letter case and link reading.
 *
 * S1: a glob or brace target (`.gi?/config`, `.g{i,}t/config`) is read as a
 * pattern, and `.git` matching it is `git-dir-write`; through the hook a
 * pattern that does not spell `.git` is expanded on disk (`l*k` through a
 * link to `.git`).
 * S2: git's own options that write a file (`--output=`, `apply
 * --directory=`, `worktree add <path>`, `clone <dir>`) are write targets.
 * S3: on a line that spells `.git` in an assignment, a substitution or a
 * quoted string, a target that expands, or a relative one after a directory
 * change the text cannot place, is `git-dir-write`.
 * N1: the disk pass's letter case (a link to another checkout's `.GIT`, a
 * git directory named in another case) and a link whose own text holds
 * `.git`. N2: a copy or move of a tree that carries a `.git` entry.
 *
 * Ordinary lines do not move. Hermetic: HOME is a fixture directory; git runs
 * only to make checkouts.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-git-dir-writes-2-")));
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
// S1: glob and brace targets
// ---------------------------------------------------------------------------

test("S1: a glob or brace target that .git matches is git-dir-write, any letter case", () => {
  assert.deepEqual(pure("echo x >> .gi?/config"), [DIR_WRITE]);
  assert.deepEqual(pure("cp /tmp/x .g*t/hooks/pre-push"), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> .[g]it/config"), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> .g{i,}t/config"), [DIR_WRITE]);
  assert.deepEqual(pure("cd .gi? && echo x >> config"), [READ_SHELL, DIR_WRITE]);
  for (const command of ["echo x > .{f..h}it/config", "echo x > .G[I]T/config", "cd .GI? && echo x > config", "echo x > {a,.git}/config"]) {
    assert.ok(pure(command).includes(DIR_WRITE), command);
  }
  // GLOB-WRITE (22 Nov 2026): `.g*` also matches `.grok`, whose `hooks/` is the
  // Grok hook organ, so the stricter `policy.core` answers this one.
  // The `.git` reader's class rides beside it (review-b S1: no class is taken away).
  assert.deepEqual(pure("tee -a sub/.g*/hooks/pre-push"), ["policy.core protected-path", "vcs.history.rewrite git-dir-write"]);
});

test("S1: ordinary glob and brace lines do not move", () => {
  assert.deepEqual(pure("rm *.log"), ["files.delete.out_of_scope rm-unreadable-path"]);
  assert.deepEqual(pure("cp src/*.ts out/"), ["files.write.workspace workspace-write"]);
  assert.deepEqual(pure("echo x > out/{a,b}.txt"), ["files.write.workspace redirect-write"]);
  assert.deepEqual(pure("ls .g*"), [READ_SHELL]);
  // `*` and `?` never match a leading dot by default, as the shell's expansion requires.
  assert.deepEqual(pure("cd * && echo x > f"), [READ_SHELL, "files.write.workspace redirect-write"]);
  // A WRITE target's leading `?` may, under dotglob or globdots set in a
  // profile (lead ruling, CLAIMS L61492 and L61497): `.git/config`.
  // Main's class rides beside the raise (lead ruling L61926).
  assert.deepEqual(pure("echo x > ?git/config"), [DIR_WRITE, "files.write.workspace redirect-write"]);
  assert.deepEqual(pure("rm -f .*.swp"), ["files.delete.out_of_scope rm-unreadable-path"]);
  // A `?` beside a `-` (a URL's query) is an ordinary pattern, never an error read as a match.
  assert.deepEqual(pure("echo x > out?a-b.txt"), ["files.write.workspace redirect-write"]);
  assert.deepEqual(pure('curl -s --url "${B:-https://x.example/v1}/venues?id=3fa85f64-5717&limit=100"'), ["network.call web-write"]);
});

test("S1 hook: a pattern is expanded on disk and each match walked; one it cannot expand is judged by its text", { skip: skip || (process.getuid?.() === 0 ? "root reads a mode-000 directory" : false) }, () => {
  const repo = checkout();
  symlinkSync(".git", join(repo, "link"));
  writeFileSync(join(repo, "a.log"), "");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.ts"), "");
  assert.deepEqual(hook("echo x >> l*k/config", repo), [DIR_WRITE, LISTED]);
  assert.deepEqual(hook("echo x >> {li,x}nk/config", repo), [DIR_WRITE, LISTED]);
  assert.deepEqual(hook("cd l?nk && echo x >> config", repo), [READ_SHELL, DIR_WRITE, LISTED]);
  assert.deepEqual(hook("cp /tmp/x lin[k]/hooks/pre-push", repo), [DIR_WRITE, LISTED]);
  // Ordinary lines in the same checkout do not move.
  assert.deepEqual(hook("rm *.log", repo), ["files.delete.out_of_scope rm-unreadable-path"]);
  assert.deepEqual(hook("cp src/*.ts out/", repo), ["files.write.workspace workspace-write"]);
  assert.deepEqual(hook("echo x > out/{a,b}.txt", repo), ["files.write.workspace redirect-write"]);
  // A parent it cannot read: by the text, a pattern naming no .git stays a possible target.
  const locked = join(repo, "locked");
  mkdirSync(join(locked, "in"), { recursive: true });
  chmodSync(locked, 0o000);
  try {
    // A SURE target that cannot be expanded is judged the strict way; a
    // possible one (a header value) by its text, which names no .git.
    // Main's write segment rides beside the raise (lead ruling L61926), and
    // the disk pass's entry is shown in its place too: two entries. The write
    // pass adds its unreadable entry beside them (design v4).
    assert.deepEqual(hook("echo x > locked/*/config", repo), [DIR_WRITE, DIR_WRITE, UNREADABLE]);
    assert.deepEqual(hook("echo x > locked/*/.g?t/config", repo), [DIR_WRITE, UNREADABLE]);
    assert.ok(!hook("wget --header=locked/*/x https://example.invalid/x", repo).includes(DIR_WRITE));
  } finally {
    chmodSync(locked, 0o755);
  }
});

test("S1 review: a directory listing is read whole; thousands of matches do not move an ordinary line", { skip }, () => {
  const repo = checkout();
  const logs = join(repo, "logs");
  mkdirSync(logs);
  for (let at = 0; at < 5000; at += 1) writeFileSync(join(logs, `f${String(at)}.log`), "");
  assert.deepEqual(hook("rm logs/*.log", repo), ["files.delete.out_of_scope rm-unreadable-path"]);
  // The source is inside the checkout: an absolute `/tmp` source is out of the
  // write scope wherever the checkout itself sits under `/tmp` (a Linux runner).
  writeFileSync(join(repo, "seed.txt"), "");
  assert.deepEqual(hook("cp seed.txt logs/*.log", repo), ["files.write.workspace workspace-write"]);
  // Among them, one link into .git is still found.
  symlinkSync("../.git/config", join(logs, "zz.log"));
  assert.deepEqual(hook("cp seed.txt logs/*.log", repo), [DIR_WRITE, LISTED]);
});

test("S1 review: an entry whose own name holds a glob character is a real match", { skip }, () => {
  const repo = checkout();
  symlinkSync(".git", join(repo, "a*b"));
  assert.deepEqual(hook("cd a*b && echo x >> config", repo), [READ_SHELL, DIR_WRITE, LISTED]);
  // Matched by another pattern, so only the real listing names it.
  assert.deepEqual(hook("cd a?b && echo x >> config", repo), [READ_SHELL, DIR_WRITE, LISTED]);
  assert.deepEqual(hook("echo x >> a*b/config", repo), [DIR_WRITE, LISTED]);
  // A pattern that matches nothing, under a listing that is not empty, is
  // never "no target and nothing unknown": the hook says it cannot place it.
  const { notes } = classifyForHook("cd q*z && echo x > f", [], repo);
  assert.ok(notes.some((note) => /matches nothing here/u.test(note)), notes.join(" | "));
});

test("S1 review: a matching directory at the last segment is walked, so a git directory under another name is seen", { skip }, () => {
  const at = root();
  git(at, "init", "-q", "--separate-git-dir=wstore", "repo");
  const repo = join(at, "repo");
  assert.deepEqual(hook("cp /tmp/x ../w*/", repo), [DIR_WRITE]);
  assert.deepEqual(hook("cp /tmp/x ../ws?ore", repo), [DIR_WRITE]);
  // A directory that is no git directory does not move.
  mkdirSync(join(at, "work"));
  assert.ok(!hook("cp /tmp/x ../wo*/", repo).includes(DIR_WRITE));
});

test("S1 review: a bracket expression with a POSIX class, an equivalence class or a collating element may match", () => {
  for (const command of [
    "echo x > .[[:alpha:]]it/config",
    "echo x > [[:punct:]]git/config",
    "echo x > .[=g=]it/config",
    "echo x > .[.g.]it/config",
    "echo x > .[]g]it/config",
    "echo x > .[!x]it/config",
    "echo x > .[[:alpha:]/config",
  ]) {
    assert.deepEqual(pure(command), [DIR_WRITE], command);
  }
  assert.deepEqual(pure("echo x > out[1].txt"), ["files.write.workspace redirect-write"]);
  assert.deepEqual(pure("echo x > [[:alpha:]]*.txt"), ["files.write.workspace redirect-write"]);
});

// ---------------------------------------------------------------------------
// S2: git's own options that write a file
// ---------------------------------------------------------------------------

test("S2: git's own write options are write targets; the verbs without a row stay refused", () => {
  assert.deepEqual(pure("git log -1 --format='[core]%n hooksPath = /tmp/h' --output=.git/config"), [DIR_WRITE]);
  assert.deepEqual(pure("git diff --output=.git/hooks/pre-push"), [DIR_WRITE]);
  for (const command of [
    "git diff --output .git/hooks/pre-push",
    "git show --output=.GIT/config HEAD",
    "git stash show --output=.git/x",
    "git apply --directory=.git/hooks p.patch",
    "git apply --build-fake-ancestor=.git/index x.patch",
    "git worktree add .git/hooks lane",
    "git clone /x/r.git .git/hooks",
    "git clone --separate-git-dir=.git/x /x/r.git y",
    "cd .git && git diff --output=hooks/pre-push",
  ]) {
    assert.ok(pure(command).includes(DIR_WRITE), command);
  }
  assert.deepEqual(pure("git format-patch -o .git/hooks x"), ["refused unclassified"]);
  assert.deepEqual(pure("git archive -o .git/x.tar HEAD"), ["refused unclassified"]);
});

test("S2 review: a long write option is read by any prefix git may take", () => {
  for (const command of [
    "git log --outp=.git/config",
    "git log --out .git/config",
    "git diff --ou=.git/hooks/pre-push",
    "git apply --dir=.git/hooks p.patch",
    "git apply --directo .git/hooks p.patch",
    "git apply --build=.git/index p.patch",
    "git clone --sep=.git/x /x/r.git y",
    "git log --o=.git/config",
    "git log --o .git/config",
    "git apply --d=.git/hooks p.patch",
    "git apply --b=.git/index p.patch",
    "git clone --s=.git/x /x/r.git y",
    "sort --o .git/config x",
    "sort --o=.git/config x",
  ]) {
    assert.ok(pure(command).includes(DIR_WRITE), command);
  }
  assert.deepEqual(pure("git diff --output-indicator-new=x"), ["read.shell git-read"]);
  assert.deepEqual(pure("git log --out=out.txt"), ["read.shell git-read"]);
});

test("real git, S2 review: which abbreviations of --output git 2.50.1 writes through", { skip }, (t) => {
  const repo = checkout();
  const tried: string[] = [];
  for (const [spelling, file] of [
    ["--output=", "a0"],
    ["--outpu=", "a1"],
    ["--outp=", "a2"],
    ["--out=", "a3"],
    ["--ou=", "a4"],
    ["--o=", "a5"],
  ] as const) {
    const ran = spawnSync("git", ["log", "-1", `${spelling}${file}`], { cwd: repo, encoding: "utf8", env: process.env });
    const wrote = existsSync(join(repo, file));
    tried.push(`${spelling}${file}: exit ${String(ran.status)}, ${wrote ? "wrote the file" : "no file"}${ran.stderr.trim() === "" ? "" : ` (${ran.stderr.trim().split("\n")[0] ?? ""})`}`);
  }
  const separate = spawnSync("git", ["log", "-1", "--out", "a6"], { cwd: repo, encoding: "utf8", env: process.env });
  tried.push(`log --out a6: exit ${String(separate.status)}, ${existsSync(join(repo, "a6")) ? "wrote the file" : "no file"}`);
  for (const [verb, spelling, file] of [
    ["diff", "--outp=", "b1"],
    ["show", "--outp=", "b2"],
  ] as const) {
    const ran = spawnSync("git", [verb, `${spelling}${file}`], { cwd: repo, encoding: "utf8", env: process.env });
    tried.push(`${verb} ${spelling}${file}: exit ${String(ran.status)}, ${existsSync(join(repo, file)) ? "wrote the file" : "no file"}`);
  }
  // `git apply` and `git clone` parse their options with git's option parser:
  // an abbreviation is either taken or refused as an unknown option.
  for (const args of [
    ["apply", "--dire=sub", "--check", "/dev/null"],
    ["apply", "--d=sub", "--check", "/dev/null"],
    ["apply", "--build=fake", "--check", "/dev/null"],
    ["apply", "--b=fake", "--check", "/dev/null"],
    ["clone", "--sep=sepdir", join(repo, "no-such-repo"), "cl"],
    ["clone", "--s=sepdir", join(repo, "no-such-repo"), "cl"],
  ]) {
    const ran = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: process.env });
    const refused = /unknown option|unrecognized|ambiguous option/u.test(ran.stderr);
    tried.push(`${args.slice(0, 2).join(" ")}: exit ${String(ran.status)}, ${refused ? "option refused" : "option taken"} (${ran.stderr.trim().split("\n")[0] ?? ""})`);
  }
  for (const line of tried) t.diagnostic(line);
  assert.ok(existsSync(join(repo, "a0")), tried.join(" | "));
});

test("S2: ordinary git lines do not move", () => {
  assert.deepEqual(pure("git log --oneline"), ["read.shell git-read"]);
  assert.deepEqual(pure("git diff --stat"), ["read.shell git-read"]);
  assert.deepEqual(pure("git show --output=out.txt HEAD"), ["read.shell git-read"]);
  assert.deepEqual(pure("git format-patch -o patches/ -1"), ["refused unclassified"]);
  assert.deepEqual(pure("git worktree add ../wt main"), ["vcs.commit.branch git-write"]);
  assert.deepEqual(pure("git clone /x/r.git"), ["network.call git-clone"]);
  assert.deepEqual(pure("git log --git-dir=.git"), ["read.shell git-read"]);
});

test("S2 hook: a git output option is walked on disk like any other write", { skip }, () => {
  const repo = checkout();
  symlinkSync(".git", join(repo, "g"));
  assert.deepEqual(hook("git diff --output=g/hooks/pre-push", repo), [DIR_WRITE, LISTED]);
  assert.deepEqual(hook("git log -1 --output g/config", repo), [DIR_WRITE, LISTED]);
  assert.deepEqual(hook("git diff --output=out.diff", repo), ["read.shell git-read"]);
});

// ---------------------------------------------------------------------------
// S3: a variable or a substitution set on the same line
// ---------------------------------------------------------------------------

test("S3: a line that spells .git indirectly makes an expanding or unplaceable relative write git-dir-write", () => {
  assert.deepEqual(pure("D=.git; cd $D && echo x >> config"), ["read.shell assignment", READ_SHELL, DIR_WRITE]);
  assert.deepEqual(pure('echo x >> "$(echo .git)/config"'), [DIR_WRITE]);
  assert.deepEqual(pure("D=.git; echo x >> $D/config"), ["read.shell assignment", DIR_WRITE]);
  assert.deepEqual(pure("D=.git; cd $D; cp /tmp/x hooks/pre-push"), ["read.shell assignment", READ_SHELL, DIR_WRITE]);
  assert.deepEqual(pure('D=$PWD/.GIT/hooks; echo x > "$D/pre-push"'), ["read.shell assignment", DIR_WRITE]);
});

test("S3 review: an assignment's value is judged as a pattern", () => {
  assert.deepEqual(pure("D=.gi?; cd $D && echo x >> config"), ["read.shell assignment", READ_SHELL, DIR_WRITE]);
  assert.deepEqual(pure("D=.g{i,}t; cd $D && echo x >> config"), ["read.shell assignment", READ_SHELL, DIR_WRITE]);
  assert.deepEqual(pure("D='.[g]it'; cd $D && echo x >> config"), ["read.shell assignment", READ_SHELL, DIR_WRITE]);
  assert.deepEqual(pure('echo x >> "$(echo .gi?)/config"'), [DIR_WRITE]);
  // Known limit: a value built from several expansions cannot be judged.
  assert.deepEqual(pure("A=.g; B=it; cd $A$B && echo x >> config"), ["read.shell assignment", "read.shell assignment", READ_SHELL, "files.write.workspace redirect-write"]);
});

test("S3: lines that do not spell .git, or carry it only in a payload to a literal target, do not move", () => {
  assert.deepEqual(pure('echo "see .git/config" > notes.txt'), ["files.write.workspace redirect-write"]);
  for (const cd of ['cd "$D"', "cd $D", "cd -", "cd +1", "cd a b", "cd ~user", "cd *"]) {
    assert.deepEqual(pure(`${cd} && echo x > f`), [READ_SHELL, "files.write.workspace redirect-write"], cd);
  }
  assert.deepEqual(pure('D=build; cd $D && echo x > f'), ["read.shell assignment", READ_SHELL, "files.write.workspace redirect-write"]);
  assert.deepEqual(pure('echo x > "$OUT"'), ["files.write.workspace redirect-write"]);
  assert.deepEqual(pure("echo node_modules >> .gitignore"), ["files.write.workspace redirect-write"]);
});

// ---------------------------------------------------------------------------
// N1: the disk pass's letter case and link text
// ---------------------------------------------------------------------------

test("N1: a link to another checkout's .GIT is a git directory (APFS folds case)", { skip }, () => {
  const at = root();
  const repo = checkout(at);
  const other = checkout(at, "other");
  if (!existsSync(join(other, ".GIT"))) return; // a case-sensitive file system: nothing to fold
  symlinkSync("../other/.GIT", join(repo, "o"));
  assert.deepEqual(hook("echo x >> o/config", repo), [DIR_WRITE, LISTED]);
});

test("N1: a git directory named in another case is the git directory", { skip }, () => {
  const at = root();
  git(at, "init", "-q", "--separate-git-dir=store", "repo");
  const repo = join(at, "repo");
  if (!existsSync(join(at, "STORE"))) return;
  assert.deepEqual(pure("echo x >> ../STORE/config"), ["files.write.workspace redirect-write"]);
  assert.deepEqual(hook("echo x >> ../STORE/config", repo), [DIR_WRITE]);
});

test("N1: a link whose own text goes through .git counts, though it lands outside", { skip }, () => {
  const repo = checkout();
  symlinkSync(".git/../notes", join(repo, "l"));
  assert.deepEqual(hook("echo x > l", repo), [DIR_WRITE]);
});

// ---------------------------------------------------------------------------
// N2: a tree that carries a .git entry
// ---------------------------------------------------------------------------

test("N2: a copy or move of a tree that carries .git at its top is git-dir-write", { skip }, () => {
  const at = root();
  const repo = checkout(at);
  checkout(at, "tree");
  for (const command of ["cp -R ../tree/. .", "cp -a ../tree/ .", "mv ../tree/.git .", "cp -R -t . ../tree/.", "rsync -a ../tree/ ."]) {
    assert.ok(hook(command, repo).includes(DIR_WRITE), command);
  }
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "a.txt"), "");
  assert.deepEqual(hook("cp -R src/ build/", repo), ["files.write.workspace workspace-write"]);
  // A checkout as the DESTINATION is no source: copying a file into a nested one does not move.
  checkout(repo, "vendored");
  assert.ok(!hook("cp a.txt vendored", repo).includes(DIR_WRITE));
});

test("#682's continuation cost line: a word repeated in a segment is placed once, and the first hit is the same one", { skip }, () => {
  // `cp README.md d*/APPROVA?.md` x 4,000 walked every repeat on the disk, in
  // each name reading: 3.6 to 9 CPU s against a bound of 8. A repeat lands
  // where its first copy landed, so only the walks are saved.
  const at = root();
  const repo = checkout(at);
  checkout(at, "tree");
  symlinkSync(".git", join(repo, "link"));
  mkdirSync(join(repo, "d1"));
  writeFileSync(join(repo, "seed.txt"), "");
  const many = (word: string, n: number): string => `${word} `.repeat(n);
  const noteOf = (command: string): string => classifyForHook(command, [], repo).notes.find((note) => note.startsWith("git-dir-write:")) ?? "";
  // A target after many repeated sources still lands in .git, and the note
  // names it, as with one copy of the repeat. The write pass (#695) lists the
  // git directory beside it, as on main.
  for (const n of [1, 2000]) {
    const command = `cp seed.txt ${many("d*/x", n)}l*k/config`;
    assert.deepEqual(hook(command, repo), [DIR_WRITE, LISTED], `n=${String(n)}`);
    assert.match(noteOf(command), /writes l\*k\/config, which lands at .*\/\.git\/config, inside a git directory/u, `n=${String(n)}`);
  }
  // A repeated tree source that carries .git is found, before or after other repeats.
  for (const command of [`cp -R ${many("../tree/.", 2000)}.`, `cp -R ${many("d*/", 2000)}${many("../t*e/.", 3)}.`]) {
    assert.ok(hook(command, repo).includes(DIR_WRITE), command.slice(0, 40));
  }
  // Repeated ordinary words do not move. The write pass (#695) reads no more
  // patterns than its bound in one segment, so 2,000 of them are unreadable
  // to it, as on main.
  assert.deepEqual(hook(`cp seed.txt ${many("d*/x", 2000)}out/`, repo), ["files.write.workspace workspace-write", UNREADABLE]);
  // A redirection repeated: each is a sure target; the first that lands in .git answers.
  assert.deepEqual(hook(`echo x ${many("> d*/y", 500)}> l?nk/config`, repo).filter((entry) => entry === DIR_WRITE).length > 0, true);
});

test("#682's rm_dot_names cost line: a pattern is read from the disk once per directory it is expanded from, and every segment is still judged", () => {
  // `rm -rf ./*; ` x 833 expanded `./*` and walked each of its entries again
  // for every classified segment of every repeat (each class the glob guard
  // names is its own segment with the same text): 1.3 to 1.55 times main's
  // CPU s. The disk does not change while the hook judges a line, so each
  // expansion (by directory AND word) and each walk is read once per pass,
  // and its answer reused. Only the reads are saved: every segment is
  // judged, from every directory it may run in.
  const at = root();
  mkdirSync(join(at, "sub"));
  mkdirSync(join(at, "other", ".git"), { recursive: true });
  writeFileSync(join(at, "a.txt"), "");
  // `./*` from `at` lands nowhere near a git directory; from `sub`, its link
  // `l` lands in one.
  symlinkSync("../other/.git", join(at, "sub", "l"));
  // The segments as the pass walks them, each with whether it was raised.
  const walked = (command: string): { text: string; raised: boolean }[] => {
    const result = classifyForHook(command, [], at).result;
    assert.ok(result.ok, command.slice(0, 40));
    const out: { text: string; raised: boolean }[] = [];
    for (const segment of result.segments) {
      if (segment.rule === "git-dir-write") (out.at(-1) as { raised: boolean }).raised = true;
      else out.push({ text: segment.text, raised: false });
    }
    return out;
  };
  const raisedTexts = (command: string): string[] => [...new Set(walked(command).filter((each) => each.raised).map((each) => each.text))].sort();
  // Each repeat its own text (a plain name `n<i>` after the same pattern),
  // so each one's answer can be read apart from the others.
  const repeats = (from: number, n: number): string[] => Array.from({ length: n }, (_, index) => `rm -rf ./* n${String(from + index)}`);
  for (const n of [1, 2, 400]) {
    const afterCd = repeats(n, n);
    const segments = walked([...repeats(0, n), "cd sub", ...afterCd].join("; "));
    const cd = segments.findIndex((each) => each.text === "cd sub");
    // Walked before the `cd`, from `at` alone: none raised. Every repeat
    // after it, from `at` AND `sub`, is raised, not only the first, so the
    // expansion from `at` is never reused for `sub` (keyed by its
    // directory). (A class the classifier appends after the whole line,
    // `files.delete.out_of_scope` here, is walked after the `cd` too, as on
    // main: that answer is not this pass's to read.)
    assert.deepEqual(segments.slice(0, cd).filter((each) => each.raised), [], `n=${String(n)}`);
    const raisedAfter = new Set(segments.slice(cd + 1).filter((each) => each.raised).map((each) => each.text));
    assert.deepEqual(afterCd.filter((text) => !raisedAfter.has(text)), [], `n=${String(n)}`);
  }
  // A different word from the same directory is its own expansion.
  assert.deepEqual(raisedTexts("rm -rf ./*; rm -rf sub/*"), ["rm -rf sub/*"]);
  assert.deepEqual(raisedTexts("rm -rf sub/*; rm -rf ./*; rm -rf sub/*"), ["rm -rf sub/*"]);
});
