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
  // An output may hold a `/`: `.git` may begin inside one (`x/.gi` + `t`) or
  // end inside one (`.g` + `it/x`), past literal text around it.
  assert.deepEqual(pure("echo x >> x$(printf /.gi)t/config"), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> .g$(printf it/)config"), [DIR_WRITE]);
  // A glob or brace beside the substitution is read the broad way.
  assert.deepEqual(pure("echo x >> .g$(printf i)?/config"), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> .g{x,$(printf it)}/config"), [DIR_WRITE]);
  // git's own write option, and a script a shell wrapper runs.
  assert.deepEqual(pure("git log --output=.g$(printf it)/config"), [DIR_WRITE]);
  assert.deepEqual(pure("bash -lc 'cd $(printf .gi)t && echo x >> config'"), [READ_SHELL, DIR_WRITE]);
  // The backtick form was refused before and is still.
  assert.deepEqual(pure("echo x >> `printf .gi`t/config"), ["refused opaque"]);
});

test("both rules inside a substitution body: the body is read as a line of its own", () => {
  assert.deepEqual(pure('echo x >> "$(echo $(printf .gi)t)/config"'), [DIR_WRITE]);
  assert.deepEqual(pure("D=$(echo .g$(printf it)); cd $D && echo x >> config"), [ASSIGNMENT, READ_SHELL, DIR_WRITE]);
  assert.deepEqual(pure('D=$(cd "$(git rev-parse --git-dir)" && pwd); echo x >> $D/config'), [ASSIGNMENT, DIR_WRITE]);
  assert.deepEqual(pure('echo x > "$(echo $(date +%F))".txt'), [REDIRECT]);
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

// ---------------------------------------------------------------------------
// Review of the substitution fold: S1, an escape that decodes to .git
// ---------------------------------------------------------------------------

test("S1: an ANSI-C quoted string whose escapes decode to .git names it", () => {
  assert.deepEqual(pure("echo x >> $'\\x2egit'/config"), [DIR_WRITE]);
  assert.deepEqual(pure("cd $'\\x2egit' && echo x >> config"), [READ_SHELL, DIR_WRITE]);
  assert.deepEqual(pure("tee -a $'\\x2egit/config' < f"), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> $'.\\147it/config'"), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> $'\\56git/config'"), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> $'\\u002egit'/config"), [DIR_WRITE]);
  // Joined to the word's own text on either side.
  assert.deepEqual(pure("echo x >> .g$'\\x69't/config"), [DIR_WRITE]);
  // Inside double quotes the shell leaves `$'…'` as written: read anyway, the strict side.
  assert.deepEqual(pure("echo x >> \"$'\\x2egit'/config\""), [DIR_WRITE]);
});

test("S1: a substitution body whose escapes decode to .git names it", () => {
  assert.deepEqual(pure("echo x >> \"$(printf '\\x2egit')/config\""), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> \"$(printf '\\056git')/config\""), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> \"$(echo -e '\\0056git')/config\""), [DIR_WRITE]);
  assert.deepEqual(pure("cd \"$(printf '\\x2egit')\" && echo x >> config"), [READ_SHELL, DIR_WRITE]);
});

test("S1: escapes that do not decode to .git do not move", () => {
  assert.deepEqual(pure("printf $'a\\tb\\n' > out.tsv"), [REDIRECT]);
  assert.deepEqual(pure("printf '\\x41\\n' > out.txt"), [REDIRECT]);
  assert.deepEqual(pure("echo \"$(printf '%s\\n' a b)\" > out.txt"), [REDIRECT]);
  assert.deepEqual(pure("git commit -m $'subject\\n\\nbody about .gitignore'"), ["vcs.commit.branch git-commit"]);
  assert.deepEqual(pure("sed -i '' $'s/a/b/' file.txt"), ["files.write.workspace sed-in-place"]);
});

// ---------------------------------------------------------------------------
// Review of the substitution fold: S2, the word a parameter expansion carries
// ---------------------------------------------------------------------------

test("S2: a parameter expansion that may expand to .git names it", () => {
  assert.deepEqual(pure("echo x >> ${VAR:-.git}/config"), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> ${VAR-.git}/config"), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> ${VAR:=.git}/config"), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> ${VAR:+.git}/config"), [DIR_WRITE]);
  assert.deepEqual(pure('echo x >> "${VAR:-.git}/config"'), [DIR_WRITE]);
  assert.deepEqual(pure("cd ${VAR:-.git} && echo x >> config"), [READ_SHELL, DIR_WRITE]);
  assert.deepEqual(pure('cd "${VAR:-.git}" && echo x >> config'), [READ_SHELL, DIR_WRITE]);
  // A pattern, a nested expansion, a substitution body, a split spelling.
  assert.deepEqual(pure("echo x >> ${VAR:-.gi?}/config"), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> ${A:-${B:-.git}}/config"), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> $(echo ${VAR:-.git})/config"), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> ${VAR:-.g$(printf it)}/config"), [DIR_WRITE]);
});

test("S2: a parameter expansion whose word is not .git does not move", () => {
  assert.deepEqual(pure('echo x > "${OUT:-build}/log.txt"'), [REDIRECT]);
  assert.deepEqual(pure('echo x > "${1:-out}.txt"'), [REDIRECT]);
  assert.deepEqual(pure('echo x > "${DIR:-.}/out.txt"'), [REDIRECT]);
  assert.deepEqual(pure("echo x > ${TMPDIR:-/tmp}/x.log"), [REDIRECT]);
  assert.deepEqual(pure('echo x > "${XDG_CONFIG_HOME:-$HOME/.config}/app/f"'), [REDIRECT]);
  // `:?` prints its word as an error and carries no value.
  assert.deepEqual(pure("echo x >> ${VAR:?.git}/config"), [REDIRECT]);
});

// ---------------------------------------------------------------------------
// Review of the substitution fold: S3, outputs that only together spell .git
// ---------------------------------------------------------------------------

test("known limit: two outputs that together spell .git are not read", () => {
  // Each body alone spells no .git, and a piece made only of outputs is not
  // judged: reading the bodies' joined output is left (S3).
  assert.deepEqual(pure('echo x >> "$(printf .g)$(printf it)/config"'), [REDIRECT]);
  assert.deepEqual(pure('cd "$(printf .g)$(printf it)" && echo x >> config'), [READ_SHELL, REDIRECT]);
});

test("hook: the S1 and S2 spellings are git-dir-write in a checkout", { skip }, () => {
  const repo = checkout();
  for (const command of [
    "echo x >> $'\\x2egit'/config",
    "cd $'\\x2egit' && echo x >> config",
    "echo x >> \"$(printf '\\x2egit')/config\"",
    "echo x >> ${VAR:-.git}/config",
    "cd ${VAR:-.git} && echo x >> config",
  ]) {
    assert.ok(hook(command, repo).includes(DIR_WRITE), command);
  }
  assert.deepEqual(hook("printf $'a\\tb\\n' > out.tsv", repo), [REDIRECT]);
  assert.deepEqual(hook('echo x > "${OUT:-build}/log.txt"', repo), [REDIRECT]);
});

// ---------------------------------------------------------------------------
// Security review of the S1 and S2 folds, points a to e: each only stricter
// ---------------------------------------------------------------------------

test("security review a: every ANSI-C piece of a word is decoded and joined, quotes removed", () => {
  assert.deepEqual(pure("echo x >> $'\\x2e'g''$'\\x69'\"t\"/config"), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> $'\\x2e'\"g\"\"i\"\"t\"/config"), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> $'\\x2e'gi\"t\"/config"), [DIR_WRITE]);
  // A glob where the word is unquoted, and an output beside the string.
  assert.deepEqual(pure("cd $'\\x2eg'i? && echo x >> config"), [READ_SHELL, DIR_WRITE]);
  assert.deepEqual(pure("echo x >> $'\\x2e'$(printf git)/config"), [DIR_WRITE]);
  // A decoded `.` that is no segment's start is no `.git`.
  assert.deepEqual(pure("echo x > a$'\\x2e'gitx"), [REDIRECT]);
});

test("security review b: quotes are tracked, and a quote that does not close is the strict side", () => {
  // `$'` inside single quotes is text the shell leaves as written.
  assert.deepEqual(pure("echo '$'\"'\"'\\x2egit' > \"$D\""), [REDIRECT]);
  // The lexer and the shell disagree on `\'` inside `$'…'`: unreadable, strict.
  assert.deepEqual(pure("echo $'x\\'' ' > \"$D\""), [DIR_WRITE]);
});

test("security review c: what printf or echo prints is read with quotes removed", () => {
  assert.deepEqual(pure("echo x >> \"$(printf '\\x2e''git')/config\""), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> \"$(printf '%sgit' .)/config\""), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> \"$(printf '%s' .g it)/config\""), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> \"$(printf '\\x2e%s' git)/config\""), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> \"$(echo -e '\\x2e'\"git\")/config\""), [DIR_WRITE]);
  // Two segments print in turn; an argument the text cannot read is an unknown output.
  assert.deepEqual(pure('echo x >> "$(printf .g; printf it)/config"'), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> \"$(printf '%s%s' .g \"$X\")/config\""), [DIR_WRITE]);
  // Printed text that cannot make .git does not move.
  assert.deepEqual(pure("echo x > \"$(printf '%03d' 7).txt\""), [REDIRECT]);
  assert.deepEqual(pure('echo "$(date +%F; echo .txt)" > out.txt'), [REDIRECT]);
  assert.deepEqual(pure("echo x > \"$(printf '%s-%s' \"$a\" \"$b\").txt\""), [REDIRECT]);
});

test("security review d: the other parameter expansion operators", () => {
  // A replacement's new text sits between unknown runs of the value.
  assert.deepEqual(pure("G=xgit; echo x >> ${G/x/.}/config"), [ASSIGNMENT, DIR_WRITE]);
  assert.deepEqual(pure("echo x >> ${G//a/.}/config"), [DIR_WRITE]);
  // Removal and substring, on a line whose text holds .git.
  assert.deepEqual(pure("G=.gitx; echo x >> ${G%x}/config"), [ASSIGNMENT, DIR_WRITE]);
  assert.deepEqual(pure("G=.gitx; echo x >> ${G:0:4}/config"), [ASSIGNMENT, DIR_WRITE]);
  // @E decodes escapes the value may hold.
  assert.deepEqual(pure("X='\\x2egit'; echo x >> ${X@E}/config"), [ASSIGNMENT, DIR_WRITE]);
  // Ordinary uses do not move.
  assert.deepEqual(pure('echo x > "${f%.txt}.log"'), [REDIRECT]);
  assert.deepEqual(pure('echo x > "${f/.txt/.md}"'), [REDIRECT]);
  assert.deepEqual(pure('echo x > "out/${NAME,,}.txt"'), [REDIRECT]);
  assert.deepEqual(pure('echo x > "${#X}.txt"'), [REDIRECT]);
  assert.deepEqual(pure('echo x > "${name}.${ext}"'), [REDIRECT]);
});

test("security review e: a nested expansion in an operator's word is an output that joins", () => {
  assert.deepEqual(pure("echo x >> ${A:-.g${B}t}/config"), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> .g${A:-i}t/config"), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> ${A:-.g$(printf i)t}/config"), [DIR_WRITE]);
  assert.deepEqual(pure('echo x > "${OUT:-${HOME}/out}/f"'), [REDIRECT]);
  assert.deepEqual(pure('echo x > "${OUT:-out}.${EXT:-txt}"'), [REDIRECT]);
});
