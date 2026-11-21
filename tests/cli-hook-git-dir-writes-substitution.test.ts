/**
 * APRV-518, a `.git` path spelled by a substitution: two spellings the line
 * rule (second review, S3) did not count.
 *
 * Rule 1, git's own answer: a substitution body that runs `git rev-parse`
 * with an option that prints the git directory or a path in it
 * (`--git-dir`, `--absolute-git-dir`, `--git-common-dir`, `--git-path`,
 * `--resolve-git-dir`, `--shared-index-path`) names `.git`.
 * Rule 2, a spelling split across a substitution's edge: a word whose
 * literal text and a substitution's output can join into a `.git` segment
 * (`$(printf .gi)t`, `.g$(printf it)`, `$(printf .)git`, `.$(echo g)it`)
 * names `.git`.
 *
 * On such a line a target that expands, or a relative one after a `cd` the
 * text cannot place, is `git-dir-write`, in the pure classifier and so
 * through the hook. Ordinary substitutions do not move. Hermetic: HOME is a
 * fixture directory; git runs only to make checkouts, and no line is run.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { classifyForHook } from "../src/cli/hook.js";
import { classifyCommand } from "../src/core/command-class.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-git-dir-writes-subst-")));
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

/** Every segment as `class rule`, through the hook's refinements, in `cwd`. */
function hook(command: string, cwd: string): string[] {
  const result = classifyForHook(command, [], cwd).result;
  return result.ok ? result.segments.map((segment) => `${segment.class} ${segment.rule}`) : [`refused ${result.code}`];
}

const DIR_WRITE = "vcs.history.rewrite git-dir-write";
const READ_SHELL = "read.shell read-shell";
const ASSIGNMENT = "read.shell assignment";
const REDIRECT = "files.write.workspace redirect-write";

let cases = 0;
function checkout(): string {
  cases += 1;
  const dir = join(scratch, `case-${String(cases)}`, "repo");
  mkdirSync(join(dir, "src"), { recursive: true });
  git(dir, "init", "-q");
  git(dir, "commit", "-q", "--allow-empty", "-m", "c0");
  return dir;
}

// ---------------------------------------------------------------------------
// Rule 1: git's own answer
// ---------------------------------------------------------------------------

test("rule 1: a cd into git rev-parse's git directory, then a relative write, is git-dir-write", () => {
  assert.deepEqual(pure('cd "$(git rev-parse --git-dir)" && echo x >> config'), [READ_SHELL, DIR_WRITE]);
  assert.deepEqual(pure('cd "$(git rev-parse --git-path hooks)" && cp hook.sh pre-push'), [READ_SHELL, DIR_WRITE]);
  assert.deepEqual(pure("cd $(git rev-parse --git-dir) && echo x >> config"), [READ_SHELL, DIR_WRITE]);
  assert.deepEqual(pure('cd "$(git rev-parse --git-dir)"; echo x >> config'), [READ_SHELL, DIR_WRITE]);
  assert.deepEqual(pure('cd "$(git rev-parse --git-dir)/hooks" && cp hook.sh pre-push'), [READ_SHELL, DIR_WRITE]);
});

test("rule 1: a target built from git rev-parse's git directory is git-dir-write", () => {
  assert.deepEqual(pure('echo x >> "$(git rev-parse --git-dir)/config"'), [DIR_WRITE]);
  assert.deepEqual(pure('echo x >> "$(git rev-parse --git-dir)"/config'), [DIR_WRITE]);
  assert.deepEqual(pure("D=$(git rev-parse --git-dir); echo x > $D/config"), [ASSIGNMENT, DIR_WRITE]);
  assert.deepEqual(pure('mkdir -p "$(git rev-parse --git-path hooks)"'), [DIR_WRITE]);
});

test("rule 1: every option that prints the git directory or a path in it counts", () => {
  for (const option of [
    "--git-dir",
    "--absolute-git-dir",
    "--git-common-dir",
    "--git-path hooks",
    "--resolve-git-dir sub/.gitfile",
    "--shared-index-path",
    "--path-format=absolute --git-dir",
    "--git-d",
    "--git-$(echo dir)",
  ]) {
    assert.deepEqual(pure(`cd "$(git rev-parse ${option})" && echo x >> config`), [READ_SHELL, DIR_WRITE], option);
  }
  // Inside a shell the line wraps: the script reads its own text.
  assert.deepEqual(pure("bash -lc 'cd \"$(git rev-parse --git-dir)\" && echo x >> config'"), [READ_SHELL, DIR_WRITE]);
});

test("rule 1: git rev-parse with an option that is not the git directory does not move", () => {
  for (const option of ["--short HEAD", "--abbrev-ref HEAD", "--show-toplevel", "--show-cdup", "--verify HEAD", '"$REF"', "--short=$N HEAD"]) {
    assert.deepEqual(pure(`cd "$(git rev-parse ${option})" && echo x > notes.txt`), [READ_SHELL, REDIRECT], option);
  }
  assert.deepEqual(pure('echo x > "$(git rev-parse --short HEAD)".txt'), [REDIRECT]);
  assert.deepEqual(pure("B=$(git rev-parse --abbrev-ref HEAD); echo x > out/$B.txt"), [ASSIGNMENT, REDIRECT]);
  assert.deepEqual(pure("echo x > $(git rev-parse --show-toplevel)/src/x"), [REDIRECT]);
  assert.deepEqual(pure('cd "$(git rev-parse --show-toplevel)/src" && echo x >> a.ts'), [READ_SHELL, REDIRECT]);
  // Reading the git directory, or writing its name to a literal file, writes nothing in it.
  assert.deepEqual(pure('cat "$(git rev-parse --git-dir)/config"'), [READ_SHELL]);
  assert.deepEqual(pure('echo "$(git rev-parse --git-dir)" > notes.txt'), [REDIRECT]);
});

test("rule 1: forms that were already strict stay so", () => {
  // The backtick form is refused, as every backtick is.
  assert.deepEqual(pure("cd `git rev-parse --git-dir` && echo x >> config"), ["refused opaque"]);
  // A copy to a target the text cannot settle is the protected class already.
  assert.deepEqual(pure('cp hook.sh "$(git rev-parse --git-path hooks)/pre-push"'), ["policy.core copy-target-unknown"]);
  // --show-toplevel joined with a literal .git was counted by its own text.
  assert.deepEqual(pure('echo x >> "$(git rev-parse --show-toplevel)/.git/config"'), [DIR_WRITE]);
});

// ---------------------------------------------------------------------------
// Rule 2: a spelling split across a substitution's edge
// ---------------------------------------------------------------------------

test("rule 2: literal text and a substitution's output that join into .git name it", () => {
  assert.deepEqual(pure("cd $(printf .gi)t && echo x >> config"), [READ_SHELL, DIR_WRITE]);
  assert.deepEqual(pure("echo x >> $(printf .gi)t/config"), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> .g$(printf it)/config"), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> $(printf .)git/config"), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> .$(echo g)it/config"), [DIR_WRITE]);
  assert.deepEqual(pure('cd "$(printf .gi)t" && echo x >> config'), [READ_SHELL, DIR_WRITE]);
  assert.deepEqual(pure("cd .g$(printf it) && echo x >> config"), [READ_SHELL, DIR_WRITE]);
  assert.deepEqual(pure("D=$(printf .gi)t; echo x >> $D/config"), [ASSIGNMENT, DIR_WRITE]);
  assert.deepEqual(pure("D=a:.g$(printf it); cd $D && echo x >> config"), [ASSIGNMENT, READ_SHELL, DIR_WRITE]);
  // A glob or brace beside the substitution is read the broad way.
  assert.deepEqual(pure("echo x >> .g$(printf i)?/config"), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> .g{x,$(printf it)}/config"), [DIR_WRITE]);
  // git's own write option, and a script a shell wrapper runs.
  assert.deepEqual(pure("git log --output=.g$(printf it)/config"), [DIR_WRITE]);
  assert.deepEqual(pure("bash -lc 'cd $(printf .gi)t && echo x >> config'"), [READ_SHELL, DIR_WRITE]);
  // The backtick form was refused before and is still.
  assert.deepEqual(pure("echo x >> `printf .gi`t/config"), ["refused opaque"]);
});

test("rule 2: a word with a substitution whose literal text cannot join into .git does not move", () => {
  assert.deepEqual(pure("echo x > out/$(date +%F).txt"), [REDIRECT]);
  assert.deepEqual(pure("echo x > $(date +%s).dat"), [REDIRECT]);
  assert.deepEqual(pure("echo x > report-$(date +%F)-v1.txt"), [REDIRECT]);
  assert.deepEqual(pure("cp a $(pwd)/build/x"), ["policy.core copy-target-unknown"]);
  assert.deepEqual(pure('echo x > "$(mktemp -d)"/f'), ["refused unclassified"]);
  assert.deepEqual(pure("cp a v$(cat VERSION).tgz"), ["policy.core copy-target-unknown"]);
  assert.deepEqual(pure("V=v$(cat VERSION); echo x > out/$V.txt"), [ASSIGNMENT, REDIRECT]);
  assert.deepEqual(pure('cd "$(pwd)/build" && echo x > f'), [READ_SHELL, REDIRECT]);
});

// ---------------------------------------------------------------------------
// The unknown-cd limit
// ---------------------------------------------------------------------------

test("known limit: a cd through a variable set in an earlier call still cannot be placed", () => {
  assert.deepEqual(pure("cd $VAR && echo x >> config"), [READ_SHELL, REDIRECT]);
  assert.deepEqual(pure('cd "$D" && echo x > f'), [READ_SHELL, REDIRECT]);
});

// ---------------------------------------------------------------------------
// Through the hook, in a real checkout
// ---------------------------------------------------------------------------

test("hook: both spellings are git-dir-write in a checkout, and ordinary lines do not move", { skip }, () => {
  const repo = checkout();
  for (const command of [
    'cd "$(git rev-parse --git-dir)" && echo x >> config',
    'cd "$(git rev-parse --git-path hooks)" && cp hook.sh pre-push',
    'echo x >> "$(git rev-parse --git-dir)/config"',
    "D=$(git rev-parse --git-dir); echo x > $D/config",
    'cd "$(git rev-parse --absolute-git-dir)" && echo x >> config',
    "cd $(printf .gi)t && echo x >> config",
    "echo x >> $(printf .gi)t/config",
    "echo x >> .g$(printf it)/config",
    "echo x >> $(printf .)git/config",
    "echo x >> .$(echo g)it/config",
  ]) {
    assert.ok(hook(command, repo).includes(DIR_WRITE), command);
  }
  assert.deepEqual(hook("echo x > out/$(date +%F).txt", repo), [REDIRECT]);
  assert.deepEqual(hook('cd "$(git rev-parse --show-toplevel)" && echo x > notes.txt', repo), [READ_SHELL, REDIRECT]);
  assert.deepEqual(hook('echo x > "$(git rev-parse --short HEAD)".txt', repo), [REDIRECT]);
  assert.deepEqual(hook("B=$(git rev-parse --abbrev-ref HEAD); echo x > out/$B.txt", repo), [ASSIGNMENT, REDIRECT]);
  assert.deepEqual(hook("echo x > src/$(date +%s).log", repo), [REDIRECT]);
});
