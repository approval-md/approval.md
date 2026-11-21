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
  // A length and plain expansions do not move. (A transforming operator on a
  // variable the line does not set is strict now: point i below.)
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

test("security review f: an operator after a special parameter is read as the operator", () => {
  // `$!` and `$#` with a default word: `-` is the operator, not part of a name.
  assert.deepEqual(pure("echo x >> ${!-.git}/config"), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> ${!-.g}it/config"), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> ${#-.git}/config"), [DIR_WRITE]);
  // An indirection with an operator after it counts, the strict side.
  assert.deepEqual(pure("echo x >> ${!REF:-.git}/config"), [DIR_WRITE]);
  // `${!-}` and `${#-}` are an indirection and a length of `$-`.
  assert.deepEqual(pure('echo x > "out/${#-}.txt"'), [REDIRECT]);
  // A length and a plain indirection stay unknown values.
  assert.deepEqual(pure('echo x > "${#X}.txt"'), [REDIRECT]);
  assert.deepEqual(pure('echo x > "out/${!REF}.txt"'), [REDIRECT]);
  assert.deepEqual(pure('echo x > "out/${#arr[@]}.txt"'), [REDIRECT]);
});

test("security review g: removal and substring count when .git is spelled through quotes or escapes", () => {
  assert.deepEqual(pure("G='.gi''tx'; echo x >> ${G%x}/config"), [ASSIGNMENT, DIR_WRITE]);
  assert.deepEqual(pure("G=.gi\"t\"x; echo x >> ${G%x}/config"), [ASSIGNMENT, DIR_WRITE]);
  assert.deepEqual(pure("G=$'\\x2egitx'; echo x >> ${G%x}/config"), [ASSIGNMENT, DIR_WRITE]);
  assert.deepEqual(pure("G=$'\\x2egitx'; echo x >> ${G:0:4}/config"), [ASSIGNMENT, DIR_WRITE]);
  // A line that holds no .git keeps a removal an unknown value.
  assert.deepEqual(pure('f=a.txt; echo x > "${f%.txt}.log"'), [ASSIGNMENT, REDIRECT]);
});

test("security review h: removal and substring count after an assignment that is no plain literal", () => {
  // `${D%x}` is `.gi?`, a pattern `.git` matches.
  assert.deepEqual(pure("D=.gi?x; echo x >> ${D%x}/config"), [ASSIGNMENT, DIR_WRITE]);
  assert.deepEqual(pure("D='.gi*x'; echo x >> ${D%x}/config"), [ASSIGNMENT, DIR_WRITE]);
  assert.deepEqual(pure("D=$(cat name.txt); echo x >> ${D%x}/config"), [ASSIGNMENT, DIR_WRITE]);
  assert.deepEqual(pure("D=.gi?x; cd ${D:0:4} && echo x >> config"), [ASSIGNMENT, READ_SHELL, DIR_WRITE]);
  // Plain literal values that hold no .git keep a removal an unknown value.
  assert.deepEqual(pure('f=notes.txt; echo x > "${f%.txt}.log"'), [ASSIGNMENT, REDIRECT]);
});

test("security review i: a transforming expansion counts unless its value is a known literal and its result no .git", () => {
  // A variable the line does not set, a positional, a special parameter, an
  // array element: the value is unknown, so the result is too.
  assert.deepEqual(pure('echo x > "${f%.txt}.log"'), [DIR_WRITE]);
  assert.deepEqual(pure('echo x > "${f/.txt/.md}"'), [DIR_WRITE]);
  assert.deepEqual(pure('echo x > "out/${NAME,,}.txt"'), [DIR_WRITE]);
  assert.deepEqual(pure('echo x > "out/${f: -3}.txt"'), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> ${@#x}/config"), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> ${A[0]%x}/config"), [DIR_WRITE]);
  assert.deepEqual(pure('echo x > "${1%.md}.html"'), [DIR_WRITE]);
  // Set by `set --`, a `for` loop or `read`: those lines are refused already.
  assert.deepEqual(pure("set -- .gitx; echo x >> ${1%x}/config"), ["refused unclassified"]);
  assert.deepEqual(pure("for D in .gi?x; do echo x >> ${D%x}/config; done"), ["refused unclassified"]);
  // A known literal is worked out: to .git it counts, to anything else not.
  assert.deepEqual(pure("G=.GITX; echo x >> ${G,,}/config"), [ASSIGNMENT, DIR_WRITE]);
  assert.deepEqual(pure('f=notes.txt; echo x > "${f%.*}.log"'), [ASSIGNMENT, REDIRECT]);
  assert.deepEqual(pure('f=report.txt; echo x > "out/${f/.txt/.md}"'), [ASSIGNMENT, REDIRECT]);
  assert.deepEqual(pure('OUT=build/; echo x > "${OUT%/}/y"'), [ASSIGNMENT, REDIRECT]);
  assert.deepEqual(pure('n=abcdef; echo x > "out/${n:0:3}.txt"'), [ASSIGNMENT, REDIRECT]);
  // Assigned twice, or after its use, it is not known.
  assert.deepEqual(pure('f=a.txt; f=b.txt; echo x > "${f%.txt}.log"'), [ASSIGNMENT, ASSIGNMENT, DIR_WRITE]);
  assert.deepEqual(pure('echo x > "${f%.txt}.log"; f=a.txt'), [DIR_WRITE, ASSIGNMENT]);
});

test("security review j and k: forms the evaluator does not model are strict", () => {
  // j: an empty pattern anchored at the start or end adds text.
  assert.deepEqual(pure("D=it; echo x >> ${D/#/.g}/config"), [ASSIGNMENT, DIR_WRITE]);
  assert.deepEqual(pure("D=.gi; echo x >> ${D/%/t}/config"), [ASSIGNMENT, DIR_WRITE]);
  // k: an offset is arithmetic (`010` is 8), so only a plain decimal is worked out.
  assert.deepEqual(pure("D=xxxxxxxx.git; echo x >> ${D:010}/config"), [ASSIGNMENT, DIR_WRITE]);
  assert.deepEqual(pure("D=xxxxxxxx.git; echo x >> ${D:0x8}/config"), [ASSIGNMENT, DIR_WRITE]);
  assert.deepEqual(pure("D=xxxxxxxx.git; echo x >> ${D:4+4}/config"), [ASSIGNMENT, DIR_WRITE]);
  // A range in a pattern follows the locale: strict.
  assert.deepEqual(pure('f=notes.txt; echo x > "${f%[a-z].txt}.log"'), [ASSIGNMENT, DIR_WRITE]);
  // A plain decimal is worked out.
  assert.deepEqual(pure('n=abcdef; echo x > "out/${n:1:2}.txt"'), [ASSIGNMENT, REDIRECT]);
});

test("security review l: a value, pattern or new text outside ASCII is strict", () => {
  assert.deepEqual(pure("D=\u00e9.git; echo x >> ${D:1}/config"), [ASSIGNMENT, DIR_WRITE]);
  assert.deepEqual(pure('f=r\u00e9sum\u00e9.txt; echo x > "${f%.txt}.log"'), [ASSIGNMENT, DIR_WRITE]);
  assert.deepEqual(pure('f=notes.txt; echo x > "${f/.txt/.\u00e9}"'), [ASSIGNMENT, DIR_WRITE]);
  assert.deepEqual(pure("G=.GIT\u00c9; echo x > ${G,,}/f"), [ASSIGNMENT, DIR_WRITE]);
});

test("security review m: shell options and extglob forms are strict", () => {
  assert.deepEqual(pure('f=notes.txt; echo x > "${f/@(notes)/x}.log"'), [ASSIGNMENT, DIR_WRITE]);
  assert.deepEqual(pure('f=notes.txt; echo x > "${f%+(.txt)}.log"'), [ASSIGNMENT, DIR_WRITE]);
  // A line that sets a shell option is refused already; nothing on it is known either.
  assert.deepEqual(pure('f=notes.txt; shopt -s nocasematch; echo x > "${f%.txt}.log"'), ["refused unclassified"]);
  assert.deepEqual(pure('f=notes.txt; set -o noglob; echo x > "${f%.txt}.log"'), ["refused unclassified"]);
});

test("security review n: an expansion that assigns makes a name unknown", () => {
  // The review's line is refused already (`:` has no rule).
  assert.deepEqual(pure("D=x; : ${D:=.git}; echo x >> ${D%q}/config"), ["refused unclassified"]);
  // `${D:=y}` sets D again, so `${D%q}` no longer has a known value.
  assert.deepEqual(pure('D=x; echo "${D:=y}" > out.txt; echo x >> ${D%q}/config'), [ASSIGNMENT, REDIRECT, DIR_WRITE]);
  assert.deepEqual(pure('D=x; echo "${D=y}" > out.txt; echo x >> ${D%q}/config'), [ASSIGNMENT, REDIRECT, DIR_WRITE]);
  // Without it the value is known and the result no .git.
  assert.deepEqual(pure('D=x; echo "${D}" > out.txt; echo x >> ${D%q}/config'), [ASSIGNMENT, REDIRECT, REDIRECT]);
  // The line-level fallback, kept: a line that holds .git keeps a removal
  // strict even where the evaluator works it out to no .git.
  assert.deepEqual(pure("G=x.gitx; echo x >> ${G#x}/config"), [ASSIGNMENT, DIR_WRITE]);
});

test("security review o: any bracket expression in a pattern is strict", () => {
  assert.deepEqual(pure('f=notes.txt; echo x > "${f%[]a-z].txt}.log"'), [ASSIGNMENT, DIR_WRITE]);
  assert.deepEqual(pure('f=notes.txt; echo x > "${f%[.]txt}.log"'), [ASSIGNMENT, DIR_WRITE]);
  // `*` and `?` are still worked out.
  assert.deepEqual(pure('f=notes.txt; echo x > "${f%.t?t}.log"'), [ASSIGNMENT, REDIRECT]);
});
