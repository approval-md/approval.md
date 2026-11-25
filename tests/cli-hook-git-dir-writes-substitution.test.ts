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

// Design v4 (writes outside the workspace): a write to a target the hook
// cannot read (a command substitution) carries files.write.guarded BESIDE its
// own class; the class asserted here stands.
const UNREADABLE = "files.write.guarded write-unreadable";

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
  // Build-6 round two (lead rulings L62542 and L62568): an output is an unread
  // part, any text with a `/` in it, and the word asks the class of every
  // guarded path it could be. `$(printf .gi)t/config` may be
  // `.claude/hooks/…t/config`; `.$(echo g)it/config` may be
  // `.approval/log/…it/config`; `cd $(printf .gi)t` may enter
  // `.approval/vault`, a credential read as `cd .approval/vault` is. Those
  // classes ride beside the `.git` reader's, which is unmoved.
  assert.deepEqual(pure("cd $(printf .gi)t && echo x >> config"), ["account.credential credential-path", DIR_WRITE, READ_SHELL]);
  assert.deepEqual(pure("echo x >> $(printf .gi)t/config"), ["policy.core redirect-protected", DIR_WRITE, "vcs.history.rewrite redirect-protected"]);
  assert.deepEqual(pure("echo x >> .g$(printf it)/config"), ["policy.core redirect-protected", DIR_WRITE, "policy.edit redirect-protected", "vcs.history.rewrite redirect-protected"]);
  assert.deepEqual(pure("echo x >> $(printf .)git/config"), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> .$(echo g)it/config"), ["log.mutate redirect-protected", DIR_WRITE, "policy.core redirect-protected", "cron.manage redirect-protected", "policy.edit redirect-protected", "vcs.history.rewrite redirect-protected"]);
  assert.deepEqual(pure('cd "$(printf .gi)t" && echo x >> config'), ["account.credential credential-path", DIR_WRITE, READ_SHELL]);
  assert.deepEqual(pure("cd .g$(printf it) && echo x >> config"), [READ_SHELL, DIR_WRITE]);
  assert.deepEqual(pure("D=$(printf .gi)t; echo x >> $D/config"), [ASSIGNMENT, DIR_WRITE]);
  assert.deepEqual(pure("D=a:.g$(printf it); cd $D && echo x >> config"), [ASSIGNMENT, READ_SHELL, DIR_WRITE]);
  // An output may hold a `/`: `.git` may begin inside one (`x/.gi` + `t`) or
  // end inside one (`.g` + `it/x`), past literal text around it.
  assert.deepEqual(pure("echo x >> x$(printf /.gi)t/config"), ["policy.core redirect-protected", DIR_WRITE, "vcs.history.rewrite redirect-protected"]);
  assert.deepEqual(pure("echo x >> .g$(printf it/)config"), ["policy.core redirect-protected", DIR_WRITE, "policy.edit redirect-protected", "vcs.history.rewrite redirect-protected"]);
  // A glob or brace beside the substitution is read the broad way.
  // GLOB-WRITE (22 Nov 2026): an output beside a glob construct may hold a
  // `/` and so name any directory, the approval log's among them: the stricter
  // `log.mutate` answers before the `.git` reader.
  assert.deepEqual(pure("echo x >> .g$(printf i)?/config"), ["log.mutate redirect-protected", DIR_WRITE, "vcs.history.rewrite redirect-protected"]);
  assert.deepEqual(pure("echo x >> .g{x,$(printf it)}/config"), ["policy.core redirect-protected", DIR_WRITE, "policy.edit redirect-protected", "vcs.history.rewrite redirect-protected"]);
  // git's own write option, and a script a shell wrapper runs.
  assert.deepEqual(pure("git log --output=.g$(printf it)/config"), [DIR_WRITE]);
  assert.deepEqual(pure("bash -lc 'cd $(printf .gi)t && echo x >> config'"), ["account.credential credential-path", DIR_WRITE, READ_SHELL]);
  // The backtick form was refused before and is still.
  assert.deepEqual(pure("echo x >> `printf .gi`t/config"), ["refused opaque"]);
});

test("both rules inside a substitution body: the body is read as a line of its own", () => {
  assert.deepEqual(pure('echo x >> "$(echo $(printf .gi)t)/config"'), ["refused opaque"]);
  assert.deepEqual(pure("D=$(echo .g$(printf it)); cd $D && echo x >> config"), [ASSIGNMENT, READ_SHELL, DIR_WRITE]);
  assert.deepEqual(pure('D=$(cd "$(git rev-parse --git-dir)" && pwd); echo x >> $D/config'), [ASSIGNMENT, DIR_WRITE]);
  // zsh's echo decodes escapes in a word the text cannot read, so an echo of
  // a substitution's output counts (the sixth security review of the gate's
  // fold); the same output through a command that prints it as it is does not.
  assert.deepEqual(pure('echo x > "$(echo $(date +%F))".txt'), [DIR_WRITE]);
  assert.deepEqual(pure('echo x > "$(cat $(date +%F))".txt'), [REDIRECT]);
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
  assert.deepEqual(hook("echo x > out/$(date +%F).txt", repo), [REDIRECT, UNREADABLE]);
  assert.deepEqual(hook('cd "$(git rev-parse --show-toplevel)" && echo x > notes.txt', repo), [READ_SHELL, REDIRECT, UNREADABLE]);
  assert.deepEqual(hook('echo x > "$(git rev-parse --short HEAD)".txt', repo), [REDIRECT, UNREADABLE]);
  assert.deepEqual(hook("B=$(git rev-parse --abbrev-ref HEAD); echo x > out/$B.txt", repo), [ASSIGNMENT, REDIRECT, UNREADABLE]);
  assert.deepEqual(hook("echo x > src/$(date +%s).log", repo), [REDIRECT, UNREADABLE]);
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
  // A command whose printing is not rendered (a script a shell runs): the
  // body's raw text is decoded too, both ways octal is written.
  assert.deepEqual(pure("echo x >> \"$(sh -c 'printf \\x2egit')/config\""), [DIR_WRITE]);
  assert.deepEqual(pure("echo x >> \"$(sh -c 'echo -e \"\\0056git\"')/config\""), [DIR_WRITE]);
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
  assert.deepEqual(pure("echo x >> ${VAR:-.g$(printf it)}/config"), ["policy.core redirect-protected", DIR_WRITE, "policy.edit redirect-protected", "vcs.history.rewrite redirect-protected"]);
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

test("hook: printf's precision on %b decoded bytes, with its control (codex on 09a3acd7)", { skip }, () => {
  const repo = checkout();
  assert.ok(hook(`echo x > "$(printf '%.5b' '.g\\0itX')/config"`, repo).includes(DIR_WRITE));
  assert.ok(hook(`echo x > $(printf '%.4s' '.gi*xyz')/config`, repo).includes(DIR_WRITE));
  assert.ok(hook(`echo x > "$(printf '%.7s' 'é/.gitfoo')/config"`, repo).includes(DIR_WRITE));
  assert.deepEqual(hook(`echo x > "$(printf '%.6b' '.g\\0itX')/config"`, repo), [REDIRECT, UNREADABLE]);
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
  assert.deepEqual(hook('echo x > "${OUT:-build}/log.txt"', repo), [REDIRECT, UNREADABLE]);
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
  assert.deepEqual(pure("echo x >> $'\\x2e'$(printf git)/config"), ["log.mutate redirect-protected", DIR_WRITE, "policy.core redirect-protected", "cron.manage redirect-protected", "policy.edit redirect-protected", "vcs.history.rewrite redirect-protected"]);
  // A decoded `.` that is no segment's start is no `.git`.
  assert.deepEqual(pure("echo x > a$'\\x2e'gitx"), [REDIRECT]);
});

test("security review b: quotes are tracked, and a quote that does not close is the strict side", () => {
  // `$'` inside single quotes is text the shell leaves as written.
  assert.deepEqual(pure("echo '$'\"'\"'\\x2egit' > \"$D\""), [REDIRECT]);
  // `\'` inside `$'…'` is a quote character (lead ruling L62542: the lexer
  // reads it as the shell does), so the `'` after the string opens a quote that
  // never closes: bash 3.2 and zsh 5.9 refuse the line (lab), and so does the
  // classifier. It was a `.git` write while the lexer ended the string there.
  assert.deepEqual(pure("echo $'x\\'' ' > \"$D\""), ["refused unparseable"]);
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
  assert.deepEqual(pure('echo x > "${name}.${ext}"'), ["log.mutate redirect-protected", "policy.core redirect-protected", "policy.edit redirect-protected", REDIRECT, "cron.manage redirect-protected"]);
});

test("security review e: a nested expansion in an operator's word is an output that joins", () => {
  assert.deepEqual(pure("echo x >> ${A:-.g${B}t}/config"), ["policy.core redirect-protected", DIR_WRITE, "policy.edit redirect-protected", "vcs.history.rewrite redirect-protected"]);
  assert.deepEqual(pure("echo x >> .g${A:-i}t/config"), ["policy.core redirect-protected", DIR_WRITE, "policy.edit redirect-protected", "vcs.history.rewrite redirect-protected"]);
  assert.deepEqual(pure("echo x >> ${A:-.g$(printf i)t}/config"), ["policy.core redirect-protected", DIR_WRITE, "policy.edit redirect-protected", "vcs.history.rewrite redirect-protected"]);
  assert.deepEqual(pure('echo x > "${OUT:-${HOME}/out}/f"'), [REDIRECT]);
  assert.deepEqual(pure('echo x > "${OUT:-out}.${EXT:-txt}"'), ["log.mutate redirect-protected", "policy.core redirect-protected", "policy.edit redirect-protected", REDIRECT, "cron.manage redirect-protected"]);
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

test("security review g to q: every operator that transforms a value counts", () => {
  // Removal, substring, replacement and case changes, on a name the line does
  // not set, on a positional, a special parameter, an array element.
  for (const line of [
    'echo x > "${f%.txt}.log"',
    'echo x > "${f/.txt/.md}"',
    'echo x > "out/${NAME,,}.txt"',
    'echo x > "out/${f: -3}.txt"',
    'echo x > "${1%.md}.html"',
    "echo x >> ${@#x}/config",
    "echo x >> ${A[0]%x}/config",
    "echo x >> ${!-.g}it/config",
  ]) {
    assert.deepEqual(pure(line), [DIR_WRITE], line);
  }
  // And on a name the line itself sets, however it is spelled: no value is
  // worked out (the exact evaluator is a carry).
  for (const line of [
    "G='.gi''tx'; echo x >> ${G%x}/config",
    "G=$'\\x2egitx'; echo x >> ${G:0:4}/config",
    "D=.gi?x; echo x >> ${D%x}/config",
    "D=it; echo x >> ${D/#/.g}/config",
    "D=xxxxxxxx.git; echo x >> ${D:010}/config",
    "D=\u00e9.git; echo x >> ${D:1}/config",
    'f=notes.txt; echo x > "${f%[]a-z].txt}.log"',
    'f=notes.txt; echo x > "${f/@(notes)/x}.log"',
    'D=x; echo "${D:=y}" > out.txt; echo x >> ${D%q}/config',
    'f=notes.txt; echo x > "${f%.txt}.log"',
  ]) {
    assert.ok(pure(line).includes(DIR_WRITE), line);
  }
  // Lines that set a variable another way are refused already.
  for (const line of [
    "set -- .gitx; echo x >> ${1%x}/config",
    "for D in .gi?x; do echo x >> ${D%x}/config; done",
    "D=x; : ${D:=.git}; echo x >> ${D%q}/config",
    'f=notes.txt; shopt -s nocasematch; echo x > "${f%.txt}.log"',
  ]) {
    assert.deepEqual(pure(line), ["refused unclassified"], line);
  }
  // A length, a plain expansion, an indirection and :? stay unknown values.
  assert.deepEqual(pure('echo x > "${#X}.txt"'), [REDIRECT]);
  assert.deepEqual(pure('echo x > "out/${!REF}.txt"'), [REDIRECT]);
  assert.deepEqual(pure('echo x > "${f}.bak"'), [REDIRECT]);
  assert.deepEqual(pure('echo x > "${name}.${ext}"'), ["log.mutate redirect-protected", "policy.core redirect-protected", "policy.edit redirect-protected", REDIRECT, "cron.manage redirect-protected"]);
  assert.deepEqual(pure("echo x >> ${VAR:?.git}/config"), [REDIRECT]);
  // A read of a transformed name, or a write to a literal path, does not move.
  assert.deepEqual(pure('cat "${f%.txt}.log"'), [READ_SHELL]);
  assert.deepEqual(pure('echo "${f%.txt}" > names.txt'), [REDIRECT]);
});

test("source review S1: printf's precision cuts a string; a * width or precision is not modelled", () => {
  for (const line of [
    `echo x > "$(printf '%.4s' '.gitfoo')/config"`,
    `echo x > "$(printf '%.4b' '.gitfoo')/config"`,
    `echo x > "$(printf '%.*s' 4 '.gitfoo')/config"`,
    `echo x > "$(printf '%*s' 4 x)/config"`,
    `echo x > "$(printf '%.4s' "$X")/config"`,
    `echo x > "$(printf '%.4b' "$(cat f)")/config"`,
  ]) {
    assert.ok(pure(line).includes(DIR_WRITE), line);
  }
  // A precision that cuts no .git, a width, and a number do not move.
  assert.deepEqual(pure(`echo x > "$(printf '%s' '.gitfoo')/config"`), [REDIRECT]);
  assert.deepEqual(pure(`echo x > "$(printf '%.3s' report.txt)"`), [REDIRECT]);
  assert.deepEqual(pure(`echo x > "$(printf '%5s' abc)/config"`), [REDIRECT]);
  assert.deepEqual(pure(`echo x > "out-$(printf '%05d' 7).log"`), [REDIRECT]);
});

test("source review S2: an ANSI-C string ends at a NUL, and a substitution drops NULs", () => {
  for (const line of [
    "echo x > $'.g\\0junk'it/config",
    "echo x > $'.g\\x00junk'it/config",
    `echo x > "$(printf '.g\\0it')/config"`,
  ]) {
    assert.ok(pure(line).includes(DIR_WRITE), line);
  }
  assert.deepEqual(pure("echo x > $'notes\\0junk'.md"), [REDIRECT]);
});

test("security review of the precision fold: printed globs, and a NUL read three ways", () => {
  for (const line of [
    // A precision cuts a longer word to a glob, and the unquoted output is globbed.
    `echo x > $(printf '%.4s' '.gi*xyz')/config`,
    `echo x > $(printf '%.4s' '.g?tzz')/config`,
    `echo x > $(printf '%.6s' '.gi[t]zz')/config`,
    // A NUL as an end, in a body's escapes.
    `echo x > "$(printf '\\x2egit\\0x')/config"`,
  ]) {
    assert.ok(pure(line).includes(DIR_WRITE), line);
  }
  // codex's SOURCE HOLD on 09a3acd7: %b's precision cuts before the NULs go.
  assert.ok(pure(`echo x > "$(printf '%.5b' '.g\\0itX')/config"`).includes(DIR_WRITE));
  assert.deepEqual(pure(`echo x > "$(printf '%.6b' '.g\\0itX')/config"`), [REDIRECT]);
  // codex's SOURCE HOLD on fc846a73: printf's precision counts bytes.
  assert.ok(pure(`echo x > "$(printf '%.7s' 'é/.gitfoo')/config"`).includes(DIR_WRITE));
  assert.ok(pure(`echo x > "$(printf '%.7b' 'é/.gitfoo')/config"`).includes(DIR_WRITE));
  assert.deepEqual(pure(`echo x > "$(printf '%s' 'é/.gitfoo')/config"`), [REDIRECT]);
  // A * width takes its argument: a long line of them ends in time.
  assert.ok(pure(`echo x > "$(printf '%*s' ${"4 x ".repeat(2000)})/config"`).includes(DIR_WRITE));
  // A printed glob that cannot name .git, and a NUL in ordinary text, do not move.
  assert.deepEqual(pure(`echo x > $(printf '%.5s' '*.logs')`), [REDIRECT]);
  assert.deepEqual(pure(`echo x > "$(printf 'out\\0x').log"`), [REDIRECT]);
});

// ---------------------------------------------------------------------------
// #680's gate (claude-lead@2): M2, M3, and the three planted faults no test
// killed (N2), folded with the coarse rules of the fifth security review.
// Each case's shell truth was taken in bash 3.2 and zsh in a temp dir
// holding an empty .git.
// ---------------------------------------------------------------------------

test("gate M2: printf is read only with a literal format of %s, %b, %c and %d", () => {
  for (const line of [
    // Length modifiers (bash reads %.4ls as %.4s), %q, %Q, bash's %(…)T, an
    // unknown letter, a % the reader cannot read.
    ...["%.4ls", "%.4hs", "%.4Ls", "%.4zs", "%.4js", "%.4ts", "%.4hhs", "%.4lb", "%ls", "%.4qs", "%.4Q", "%k"].map(
      (spec) => `echo x > "$(printf ${spec} .gitfoo)/config"`,
    ),
    `echo x > "$(printf '%(%Y)T')/report.txt"`,
    `echo x > "$(printf 'a%')/report.txt"`,
    // A format that is not a literal word, with words after it or not.
    'F=%.4s; echo x > "$(printf "$F" .gitfoo)/config"',
    'F=x; echo x > "$(printf "$F")/report.txt"',
    'echo x > "$(printf $F)/config"',
    'echo x > "$(printf ${F})/config"',
    // A substitution as the format, or as a word to fill it.
    'echo x > "$(printf "$(echo %.4s)" .gitfoo)/config"',
    'echo x > "$(printf %s "$(cat v)")/config"',
  ]) {
    assert.ok(pure(line).includes(DIR_WRITE), line);
  }
  // Build-6 round two (L62542): `%.${N}s` may be `%.x/.approval/keys`, a
  // credential printf reads as main reads `printf %s .approval/env`, and a
  // substitution that reads one is refused.
  assert.deepEqual(pure('echo x > "$(printf "%.${N}s" .gitfoo)/config"'), ["refused opaque"]);
  // Literal formats of %s, %b, %c and %d with literal words keep their reading.
  assert.deepEqual(pure(`echo x > "$(printf '%s-%s' a b).txt"`), [REDIRECT]);
  assert.deepEqual(pure(`echo x > "out-$(printf '%05d' 7).log"`), [REDIRECT]);
  assert.deepEqual(pure(`echo x > "$(printf '%.3s' report.txt)"`), [REDIRECT]);
  assert.deepEqual(pure(`echo x > "$(printf '%b' 'out\\tx').txt"`), [REDIRECT]);
  assert.deepEqual(pure(`echo x > "out-$(printf %s "$V").txt"`), [REDIRECT]);
});

test("gate M2: printf and echo named by the system's path are read as printf and echo", () => {
  for (const line of [
    'echo x > "$(/usr/bin/printf %.4s .gitfoo)/config"',
    "echo x > \"$(/usr/bin/printf '%c%c%c%c' .x gx ix tx)/config\"",
    "echo x > \"$(/bin/echo -n .g; printf it)/config\"",
  ]) {
    assert.deepEqual(pure(line), [DIR_WRITE], line);
  }
  // A program by any other path named printf may be the system's own: what
  // it prints counts (review-b's read of #683, M1).
  assert.deepEqual(pure('echo x > "$(./printf %.4s .gitfoo)/config"'), [DIR_WRITE]);
  assert.deepEqual(pure('echo x > "$(/usr/bin/printf %s out)/report.txt"'), [REDIRECT]);
});

test("gate M2: a printf or echo -e word that may not stay one word in its place counts", () => {
  // Each lands in .git in bash for some value or set of files.
  for (const line of [
    `echo x > "$(printf '%.4s%.0s' $u .gitfoo)/config"`,
    `echo x > "$(printf '%s%.4s' "$@" .gitfoo)/config"`,
    `echo x > "$(printf '%s%.4s' \${!r} .gitfoo)/config"`,
    `echo x > "$(printf '%s%.4s' \${a[@]} .gitfoo)/config"`,
    `echo x > "$(printf '%.4s/' {x,.gitfoo})config"`,
    `echo x > "$(printf '%s/' {a,b})config"`,
    `echo x > "$(printf '%s' *)/config"`,
    `echo x > "$(printf 'x%s' $u)/config"`,
    `echo x > "$(printf '%b' $u)/config"`,
    `echo x > "out-$(printf %s $V).txt"`,
    `echo x > "$(echo -e $u)/config"`,
  ]) {
    assert.deepEqual(pure(line), [DIR_WRITE], line);
  }
  // zsh's flags in braces are refused already.
  assert.deepEqual(pure(`echo x > "$(printf '%s%.4s' \${(s: :)u} .gitfoo)/config"`), ["refused unclassified"]);
  // A cut or %c of a quoted unknown value counts.
  assert.deepEqual(pure(`echo x > "$(printf '%c' "$V")/report.txt"`), [DIR_WRITE]);
});

test("gate M3: zsh subscripts and modifiers count", () => {
  // zsh lands each in .git/config; bash reads the value and literal text.
  for (const line of [
    "f=.gitx; echo x > $f[1,4]/config",
    "f=.gitx; echo x > ${f[1,4]}/config",
    'f=.gitx; echo x > "$f[1,4]/config"',
    "f=.git.x; echo x > $f:r/config",
    "f=.gxt; echo x > $f:s/x/i//config",
    "f=.gxt; echo x > $f:S/x/i//config",
    "f=x.gitx; echo x > $f[2,5]/config",
    "f=x.git; echo x > $f[-4,-1]/config",
    "f=a/.git.x; echo x > $f:t:r/config",
    "f=.GIT; echo x > $f:l/config",
    // One index of a scalar is one character in zsh.
    "f=x.git; echo x > ${f[2]}${f[3]}${f[4]}${f[5]}/config",
    "f=x.git; echo x > $f[2]$f[3]$f[4]$f[5]/config",
  ]) {
    // GLOB-WRITE: bash reads an UNQUOTED `[...]` after a parameter as a glob
    // beside an unknown value, which may name a guarded path, so that pattern
    // rides beside the git-dir write; in double quotes it is text.
    // (Build-6 round two, L62568: the unread value beside the pattern may
    // hold a `/`, and every guarded class it may reach rides beside.)
    const globbed = /\$\w+\[/u.test(line) && !line.includes('"');
    const SPLICED_BESIDE = ["policy.core redirect-protected", "cron.manage redirect-protected", "policy.edit redirect-protected", "vcs.history.rewrite redirect-protected"];
    assert.deepEqual(pure(line), globbed ? [ASSIGNMENT, "log.mutate redirect-protected", DIR_WRITE, ...SPLICED_BESIDE] : [ASSIGNMENT, DIR_WRITE], line);
  }
  // The coarse rule: after an unbraced parameter, any `[` or `:` and a
  // letter or `&` counts, on any parameter, special ones too.
  for (const line of [
    'echo x > "${OUT[1]}/report.txt"',
    'echo x > "$name:r.txt"',
    "echo x > $f:u/config",
    "echo x > $1:r/config",
    "echo x > $@:r/config",
    "echo x > $*[1,4]/config",
    'echo x > "$#:t/config"',
    'echo x > "$OUT[@]/report.txt"',
    'v=1; echo x > "out-$v:z.txt"',
  ]) {
    assert.ok(pure(line).includes(DIR_WRITE), line);
  }
  // `${a[@]}` in braces is the value; a `:` before no letter is text.
  assert.deepEqual(pure('echo x > "out/${arr[@]}.txt"'), [REDIRECT]);
  assert.deepEqual(pure('echo x > "exit-$?.txt"'), [REDIRECT]);
  assert.deepEqual(pure('echo x > "$OUT:/report.txt"'), [REDIRECT]);
  // zsh's flags in braces were refused already, and are.
  assert.deepEqual(pure("f=.git; echo x > ${(L)f}/config"), ["refused unclassified"]);
});

test("hook: the gate's spellings in a checkout", { skip }, () => {
  const repo = checkout();
  for (const command of [
    'echo x > "$(printf %.4ls .gitfoo)/config"',
    'echo x > "$(/usr/bin/printf %.4s .gitfoo)/config"',
    'F=%.4s; echo x > "$(printf "$F" .gitfoo)/config"',
    `echo x > "$(printf '%.4s%.0s' $u .gitfoo)/config"`,
    "f=.gitx; echo x > $f[1,4]/config",
    "f=.git.x; echo x > $f:r/config",
  ]) {
    assert.ok(hook(command, repo).includes(DIR_WRITE), command);
  }
  assert.deepEqual(hook(`echo x > "$(printf '%s-%s' a b).txt"`, repo), [REDIRECT, UNREADABLE]);
});

test("gate N2 (m11): an ANSI-C string ends at a NUL past the near reader's reach", () => {
  // Past the near reader's five characters, only the NUL end reads it.
  // Lead ruling L62568: after a decoded NUL the rest of the word is unread
  // (bash keeps it, zsh ends the path), and `.g` then any text may be a
  // guarded `.github` path: the spliced reading's class rides beside.
  assert.deepEqual(pure(`echo x > $'.g\\0junk'""""""""it/config`), ["policy.core redirect-protected", DIR_WRITE, "policy.edit redirect-protected", "vcs.history.rewrite redirect-protected"]);
});

test("gate N2 (m17): %c prints the first character of each word", () => {
  assert.deepEqual(pure(`echo x > "$(printf '%c%c%c%c' .x gx ix tx)/config"`), [DIR_WRITE]);
  assert.deepEqual(pure(`echo x > "$(printf '%c%c%c' ab cd ef)/config"`), [REDIRECT]);
});

test("gate N2 (m15): past 65,536 printed characters the rest counts as naming .git", () => {
  // 13,108 passes of five characters reach the stop, 13,000 do not.
  assert.deepEqual(pure(`echo x > "$(printf '%.4s/'${" aaaa".repeat(13200)})/config"`), [DIR_WRITE]);
  assert.deepEqual(pure(`echo x > "$(printf '%.4s/'${" aaaa".repeat(13000)})/config"`), [REDIRECT]);
});

test("sixth security review: an unknown value echo, %b or print may decode counts; zsh's flags", () => {
  // Inherited from main: each spells .git through a decoded escape.
  for (const line of [
    `X='\\056git'; echo x > "$(printf %b "$X")/config"`,
    `X='\\056git'; echo x > "$(echo -e "$X")/config"`,
    // zsh's echo decodes escapes with no -e.
    `X='\\056git'; echo x > "$(echo "$X")/config"`,
    `echo x > "$(echo $u)/config"`,
    // An ANSI-C or locale word as printf's word, and an escaped %.
    `echo x > "$(printf '%.4s' $'.gitfoo')/config"`,
    `echo x > "$(printf '%.4s' $".gitfoo")/config"`,
    `echo x > "$(printf '\\x25s%s' a)/report.txt"`,
    // zsh's flags before an unbraced name.
    "f=.gitx; echo x > $=f[1,4]/config",
    "f=.gitx; echo x > $^f[1,4]/config",
    "f=.gi?; echo x > $~f/config",
    'echo x > "$~f/report.txt"',
  ]) {
    assert.ok(pure(line).includes(DIR_WRITE), line);
  }
  // zsh's print with a word the text cannot read is refused already.
  assert.deepEqual(pure(`X='\\056git'; echo x > "$(print "$X")/config"`), ["refused unclassified"]);
  // Literal echo and printf words keep their reading.
  assert.deepEqual(pure(`echo x > "$(echo out)/report.txt"`), [REDIRECT]);
  assert.deepEqual(pure(`echo x > "$(printf '%b' 'out')/report.txt"`), [REDIRECT]);
});

test("codex's SOURCE HOLD on 101630f2: a printer named by its path is never read looser than before; \\c; inexact words; a stray %", () => {
  // M1 (new in this fold): main read `/usr/bin/printf` and `/bin/echo` as an
  // unknown output, so each of these was git-dir-write there and stays so.
  for (const line of [
    `echo x > "$(printf .g; /usr/bin/printf x)/config"`,
    `echo x > "$(printf .g; /usr/bin/printf it)/config"`,
    `echo x > "$(printf .g; /bin/echo x)/config"`,
    `echo x > "$(echo -n .g; /bin/echo -n x)/config"`,
    `echo x > "$(/bin/echo -n .g; echo -n it)/config"`,
    `echo x > "$(/usr/bin/printf .g; /usr/bin/printf it)/config"`,
  ]) {
    assert.ok(pure(line).includes(DIR_WRITE), line);
  }
  // M2 (inherited): a `\c` stops all output; the rest is not printed.
  for (const line of [
    `echo x > "$(printf '%b' '.g\\cXXX'; printf it)/config"`,
    `echo x > "$(echo -e '.g\\cXX'; printf it)/config"`,
    `echo x > "$(echo '.g\\cXX'; printf it)/config"`,
    `echo x > "$(printf 'a\\c'; printf it)/config"`,
  ]) {
    assert.ok(pure(line).includes(DIR_WRITE), line);
  }
  // M3 (inherited): a quoted word whose text is not the shell's.
  assert.deepEqual(pure(`echo x > "$(printf '%b' "\\x2e""git")/config"`), [DIR_WRITE]);
  assert.deepEqual(pure(`echo x > "$(printf '%s' "\\x2e""git")/config"`), [DIR_WRITE]);
  assert.deepEqual(pure(`echo x > "$(printf '%s' "$SHA-x")/config"`), [DIR_WRITE]);
  // A fully quoted plain scalar keeps its place.
  assert.deepEqual(pure(`echo x > "$(printf '%s' "$SHA")/config"`), [REDIRECT]);
  assert.deepEqual(pure(`echo x > "$(printf '%s' "\${SHA}")/config"`), [REDIRECT]);
  // N1: a `%` printf did not parse counts; a parsed `%%` does not.
  for (const line of [`echo x > "$(printf %)/config"`, `echo x > "$(printf '%s%' a)/config"`, `echo x > "$(printf 'a%')/config"`]) {
    assert.ok(pure(line).includes(DIR_WRITE), line);
  }
  assert.deepEqual(pure(`echo x > "$(printf '%s%%' a)/config"`), [REDIRECT]);
  assert.deepEqual(pure(`echo x > "$(printf '%%')/config"`), [REDIRECT]);
  // Ordinary lines keep their reading.
  assert.deepEqual(pure(`echo x > "$(/usr/bin/printf .g; printf x)/config"`), [REDIRECT]);
  assert.deepEqual(pure("echo x > out/$(printf '%s' abc)/config"), [REDIRECT]);
});

test("review-b's read of #683: a printer by any other path; a colon before the parameter; printf -v", () => {
  // M1: a path whose last name is printf or echo, but not the system's own
  // binary written plainly, may still run it: what it prints counts.
  for (const path of ["/usr/bin//printf", "//usr/bin/printf", "/bin/../usr/bin/printf", "/usr/bin/./printf", "/./usr/bin/printf", "/usr/bin/../bin/printf", "./printf"]) {
    assert.deepEqual(pure(`echo x > "$(${path} %.4s .gitfoo)/config"`), [DIR_WRITE], path);
  }
  assert.ok(pure(`echo x > "$(/bin//echo -n .gi; echo t)/config"`).includes(DIR_WRITE));
  assert.deepEqual(pure(`echo x > "$(/usr/bin/printf %s out)/config"`), [REDIRECT]);
  // S1: a word whose first `:` comes before the parameter (zsh reads `$f:r`).
  assert.ok(pure("mkdir -p :; f=.git.x; echo x > :/../$f:r/config").includes(DIR_WRITE));
  assert.ok(pure("f=.git.x; echo x > $HOST:8080/$f:r/config").includes(DIR_WRITE));
  // N1: `printf -v` sets a variable to what it would print; a target the
  // variable reaches counts.
  for (const line of [
    'printf -v d %.4s .gitfoo; echo x > "$d/config"',
    `printf -v d '\\056git'; mkdir -p "$d/sub"`,
    'printf -v d %s .git; cd "$d" && echo x > config',
    // printf by another path.
    '/usr/bin//printf -v d %s .git; echo x > "$d/config"',
  ]) {
    assert.ok(pure(line).includes(DIR_WRITE), line);
  }
  // zsh's print is refused as a command already.
  assert.deepEqual(pure('print -v d .git; echo x > "$d/config"'), ["refused unclassified"]);
  // N3: in a body, `printf -v` prints nothing; its segment is not read as output.
  assert.deepEqual(pure(`echo x > "$(printf -v x '%s' y; printf '%.4s' .gitfoo)/config"`), [DIR_WRITE]);
  // Without -v, a literal target does not move.
  assert.deepEqual(pure("printf '%s' 1 > out.txt"), [REDIRECT]);
});
