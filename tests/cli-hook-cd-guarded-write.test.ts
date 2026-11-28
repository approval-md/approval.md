/**
 * A relative write after a `cd` into a guarded folder is judged where it
 * lands (build-6, cd-guarded-write).
 *
 * `cd .claude && echo x > settings.json` was allowed as
 * `read.shell, files.write.workspace` where `echo x > .claude/settings.json`
 * is `policy.core`; the same for `.github/workflows`, `.approval` and
 * `.approval/log`. Only `.git` was caught: the classifier follows a literal
 * `cd` for the git directory alone (`relativeLandsInGitDir`), and the hook's
 * write pass followed the `cd` (its `here` list) but judged the landing only
 * against the guarded list and the write roots, never against the protected
 * path classes. The fix: after a `cd` the hook follows, each relative word a
 * segment writes is spelled from the line's start and, where that spelling is
 * guarded, the segment is classified with it as its direct spelling is.
 *
 * Each row compares a `cd` line with its direct twin: the line carries every
 * class the twin carries (a refusal is matched by a refusal). Lines that land
 * outside every guarded tree keep the answer they had. Through the in-process
 * hook chain (classifyForHook), in a scratch checkout. No line is run.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { classifyForHook } from "../src/cli/hook.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-cd-guarded-write-")));
after(() => {
  rmSync(base, { recursive: true, force: true });
});
// HOME is a fixture folder: nothing here reads or writes the real one.
process.env["HOME"] = join(base, "home");
mkdirSync(join(base, "home"), { recursive: true });
delete process.env["HERMES_HOME"];
delete process.env["APPROVAL_HERMES_HOME"];
delete process.env["CLAUDE_CONFIG_DIR"];
delete process.env["CLAUDE_PROJECT_DIR"];
// The checkout sits under the fixture HOME: a temp folder under another user's
// home (TMPDIR below /Users/<name>) would otherwise be judged as that home
// (review-b's N7 on #714).
const ws = join(base, "home", "ws");
mkdirSync(ws, { recursive: true });
spawnSync("git", ["init", "-q"], { cwd: ws });
for (const path of [
  "APPROVAL.md",
  "README.md",
  "notes.md",
  "docs/notes.md",
  "packages/x/package.json",
  ".approval/env",
  ".approval/log/events.jsonl",
  ".claude/settings.json",
  ".github/workflows/ci.yml",
  ".cursor/hooks.json",
  ".grok/hooks/x.json",
  ".muse/hooks.json",
  ".codex/config.toml",
  ".hermes/config.yaml",
]) {
  mkdirSync(dirname(join(ws, path)), { recursive: true });
  writeFileSync(join(ws, path), "x\n", "utf8");
}
// A link to the approval home that exists beforehand (the `.git` rule's form).
symlinkSync(".approval", join(ws, "applink"));
// A guarded NAME that is a link to an ordinary folder (the reverse of `applink`).
mkdirSync(join(ws, "packages", "y"), { recursive: true });
symlinkSync("../../docs", join(ws, "packages", "y", ".claude"));
const SRC = join(ws, "README.md");

/** The hook chain's classes, or `REF:<code>` for a refused line. */
function hook(command: string): string[] | string {
  const result = classifyForHook(command, [], ws).result;
  return result.ok ? result.classes : `REF:${result.code}`;
}

/** Every class `twin` has, `line` has too (a refusal must be matched by a refusal). */
function covers(line: string, twin: string): void {
  const got = hook(line);
  const want = hook(twin);
  if (typeof want === "string") {
    assert.equal(typeof got, "string", `${line} is classified (${JSON.stringify(got)}) where its twin ${twin} is refused (${want})`);
    return;
  }
  assert.ok(typeof got !== "string", `${line} is refused (${String(got)}) where its twin ${twin} is classified`);
  const missing = want.filter((cls) => !got.includes(cls));
  assert.deepEqual(missing, [], `${line} lacks ${missing.join(",")} that ${twin} has (${JSON.stringify(got)} against ${JSON.stringify(want)})`);
}

/** The line's classes, which must hold `cls`. */
function holds(line: string, cls: string): void {
  const got = hook(line);
  assert.ok(typeof got !== "string" && got.includes(cls), `${line}: ${JSON.stringify(got)} lacks ${cls}`);
}

const ALLOWED = ["read.shell", "files.write.workspace"];

test("the hole's table: each allow row now carries its direct spelling's class", () => {
  const rows: readonly (readonly [line: string, twin: string, cls: string])[] = [
    ["cd .claude && echo x > settings.json", "echo x > .claude/settings.json", "policy.core"],
    ["cd .github/workflows && echo x > ci.yml", "echo x > .github/workflows/ci.yml", "policy.edit"],
    ["cd .approval && echo x > env", "echo x > .approval/env", "policy.core"],
    ["cd .approval && echo x >> log/events.jsonl", "echo x >> .approval/log/events.jsonl", "log.mutate"],
    ["cd .approval; echo x >> log/events.jsonl", "echo x >> .approval/log/events.jsonl", "log.mutate"],
    ["cd .approval && echo x | tee log/events.jsonl", "echo x | tee .approval/log/events.jsonl", "log.mutate"],
    ["D=.approval; cd $D && echo x >> log/events.jsonl", "echo x >> .approval/log/events.jsonl", "log.mutate"],
    ["cd .approval && cp ../README.md log/events.jsonl", "cp README.md .approval/log/events.jsonl", "log.mutate"],
  ];
  for (const [line, twin, cls] of rows) {
    covers(line, twin);
    holds(line, cls);
  }
});

test("the rows that worked keep their answer: .git, the credential read, an unguarded folder", () => {
  assert.deepEqual(hook("cd .git && echo x > config"), ["read.shell", "vcs.history.rewrite", "files.write.guarded"]);
  assert.deepEqual(hook("cd .git/hooks && echo x > pre-push"), ["read.shell", "vcs.history.rewrite", "files.write.guarded"]);
  assert.deepEqual(hook("cd .approval && cat env"), ["read.shell", "account.credential"]);
  assert.deepEqual(hook("cd docs && echo x > notes.md"), ALLOWED);
});

test("every write form, into the log and into the workflows, reaches its twin's class", () => {
  const trees: readonly (readonly [dir: string, file: string])[] = [
    [".approval", "log/events.jsonl"],
    [".approval/log", "events.jsonl"],
    [".github/workflows", "ci.yml"],
    [".claude", "settings.json"],
    [".approval", "env"],
  ];
  const forms: readonly ((file: string) => string)[] = [
    (f) => `echo x > ${f}`,
    (f) => `echo x >> ${f}`,
    (f) => `echo x | tee ${f}`,
    (f) => `echo x | tee -a ${f}`,
    (f) => `cp ${SRC} ${f}`,
    (f) => `mv ${SRC} ${f}`,
    (f) => `rm ${f}`,
    (f) => `ln -s ${SRC} ${f}`,
    (f) => `install -m 644 ${SRC} ${f}`,
    (f) => `touch ${f}`,
    (f) => `sed -i s/a/b/ ${f}`,
    (f) => `truncate -s 0 ${f}`,
    (f) => `dd of=${f}`,
  ];
  for (const [dir, file] of trees) {
    for (const form of forms) {
      const twin = form(`${dir}/${file}`);
      for (const sep of [" && ", "; ", "\n"]) covers(`cd ${dir}${sep}${form(file)}`, twin);
    }
  }
});

test("a cd that only the failure of another reaches, two steps, pushd, and back out", () => {
  // `||`: the write runs only where the cd failed, so it stays where the line started.
  assert.deepEqual(hook("cd .approval || echo x > env"), ALLOWED);
  // `a || b && c` is `(a || b) && c`: c runs in .approval when the first cd succeeds.
  holds("cd .approval || cd docs && echo x > env", "policy.core");
  holds("cd /nonexistent-b6 || cd .approval && echo x >> log/events.jsonl", "log.mutate");
  holds("cd .approval && cd log && echo x >> events.jsonl", "log.mutate");
  holds("cd .approval\ncd log\necho x >> events.jsonl", "log.mutate");
  // pushd is refused by the classifier on this base (no rule): it stays refused.
  assert.equal(typeof hook("pushd .approval && echo x >> log/events.jsonl"), "string");
  // Back out: `cd ..` after `&&` leaves the guarded folder.
  assert.deepEqual(hook("cd .approval && cd .. && echo x > notes.md"), ALLOWED);
  // Leaving by the target: `../` or an absolute path is judged where it lands.
  assert.deepEqual(hook("cd .approval && echo x > ../notes.md"), ALLOWED);
  covers("cd .approval && echo x > ../.claude/settings.json", "echo x > .claude/settings.json");
  covers(`cd .approval && echo x > ${ws}/.github/workflows/ci.yml`, "echo x > .github/workflows/ci.yml");
  covers("cd docs && echo x > ../.approval/env", "echo x > .approval/env");
});

test("a cd in a subshell reaches the commands inside it, not the ones after it", () => {
  covers("(cd .approval && echo x >> log/events.jsonl)", "echo x >> .approval/log/events.jsonl");
  covers("cd .approval && (echo x >> log/events.jsonl)", "echo x >> .approval/log/events.jsonl");
  assert.deepEqual(hook("(cd .approval); echo x > notes.md"), ALLOWED);
  assert.deepEqual(hook("(cd .approval) && echo x > notes.md"), ALLOWED);
  // A `$(…)` is a subshell too: its cd reaches its own segments and not the one that expands it.
  covers("cd .approval && echo $(cd /tmp) > env", "echo x > .approval/env");
  // A write inside a `$(…)` is refused by the classifier on this base (opaque); refused or caught.
  const inner = hook("echo $(cd .approval && echo y >> log/events.jsonl)");
  assert.ok(typeof inner === "string" || inner.includes("log.mutate"), JSON.stringify(inner));
  const outer = hook("echo $(cd .approval) > notes.md");
  assert.ok(typeof outer !== "string" && !outer.includes("policy.core"), JSON.stringify(outer));
});

test("every guarded tree of the classifier's own list, one row each", () => {
  const rows: readonly (readonly [dir: string, file: string])[] = [
    [".approval/log", "events.jsonl"],
    [".approval", "env"],
    [".claude", "settings.json"],
    [".cursor", "hooks.json"],
    [".grok/hooks", "x.json"],
    [".muse", "hooks.json"],
    [".codex", "config.toml"],
    [".hermes", "config.yaml"],
    [".github/workflows", "ci.yml"],
    [".git", "config"],
  ];
  for (const [dir, file] of rows) {
    const twin = `echo x > ${dir}/${file}`;
    covers(`cd ${dir} && echo x > ${file}`, twin);
    const want = hook(twin);
    assert.ok(typeof want !== "string" && want.some((cls) => cls !== "files.write.workspace"), `${twin}: ${JSON.stringify(want)}`);
  }
});

test("a cd through a variable the line sets, and through a home variable it sets", () => {
  covers("D=.approval; cd $D && echo x >> log/events.jsonl", "echo x >> .approval/log/events.jsonl");
  covers("D=.approval/log; cd $D && echo x >> events.jsonl", "echo x >> .approval/log/events.jsonl");
  covers("D=.claude; cd $D && echo x > settings.json", "echo x > .claude/settings.json");
  // The home form keeps the guarded class it had (the word is unreadable) and adds the landing's.
  const home = hook("HERMES_HOME=.approval; cd $HERMES_HOME && echo x >> log/events.jsonl");
  assert.ok(typeof home !== "string" && home.includes("files.write.guarded") && home.includes("log.mutate"), JSON.stringify(home));
});

test("a cd into a link to a guarded folder is followed, as the .git rule's link is", () => {
  covers("cd applink && echo x > env", "echo x > .approval/env");
  covers("cd applink && echo x >> log/events.jsonl", "echo x >> .approval/log/events.jsonl");
});

test("a cd that may fail before `;` or `||`, a pipeline's stages, and a guarded name that links elsewhere", () => {
  // `;` after a cd that may fail: the shell may still stand where the failed cd left it.
  holds("cd .claude && cd missing; echo x > settings.json", "policy.core");
  holds("cd .approval && cd missing; echo x >> log/events.jsonl", "log.mutate");
  // `a && b && c || d`: d runs where b failed, and b failed where a landed.
  holds("cd .claude && cd missing && true || echo x > settings.json", "policy.core");
  holds("cd .approval && cd missing && true || echo x >> log/events.jsonl", "log.mutate");
  // A cd in an earlier stage of a pipeline ran in a subshell: a later stage stands where the line did.
  assert.deepEqual(hook("cd .approval | echo x > env"), ALLOWED);
  assert.deepEqual(hook("cd .claude | tee settings.json"), ALLOWED);
  // A cd in the last stage may run in the shell itself (zsh): what follows is judged there too.
  holds("true | cd .approval; echo x > env", "policy.core");
  // A guarded name that links to an ordinary folder: a plain cd keeps the name
  // its direct spelling has; `cd -P` lands at the folder the link names.
  covers("cd packages/y/.claude && echo x > settings.json", "echo x > packages/y/.claude/settings.json");
  holds("cd packages/y/.claude && echo x > settings.json", "policy.core");
  assert.deepEqual(hook("cd -P packages/y/.claude && echo x > settings.json"), ALLOWED);
});

test("over-asking: a cd into an ordinary folder then a build, a test or a write moves nothing", () => {
  // Each answer as the base (9fc48afc) gives it. The copy rows' credential
  // class is the base's own credential pass after a cd, not this change.
  const rows: readonly (readonly [line: string, classes: readonly string[]])[] = [
    ["cd packages/x && npm test", ALLOWED],
    ["cd docs && make", ALLOWED],
    ["cd docs && echo x > notes.md", ALLOWED],
    ["cd docs && rm notes.md", ALLOWED],
    ["cd packages/x && sed -i s/a/b/ package.json", ALLOWED],
    ["cd docs; touch a.md && cp a.md b.md", ["read.shell", "files.write.workspace", "account.credential"]],
    ["cd docs && cp ../README.md notes2.md", ["read.shell", "files.delete.out_of_scope", "account.credential"]],
  ];
  for (const [line, classes] of rows) assert.deepEqual(hook(line), classes, line);
});

test("an empty alternative in the cd word: bash's landing is followed, and what no shell lands is guarded (review-b's M3 on #715)", () => {
  // bash and sh drop the empty word a brace makes and change to the other
  // (`cd {,.claude}` lands in .claude); zsh keeps it and reads `cd '' .claude`,
  // its two-word form, whose landing is not read: both answers are kept.
  holds("cd {,.claude} && echo x > settings.json", "policy.core");
  holds("cd {,.claude} && echo x > settings.json", "files.write.guarded");
  holds("cd {.claude,} && echo x > settings.json", "policy.core");
  holds("cd {,.approval}; echo x >> log/events.jsonl", "log.mutate");
  // Empty in every alternative: bash's bare cd (the home), zsh's `cd '' ''`.
  // Not followed, so a relative write after it is guarded.
  holds("cd {,} && echo x > notes.md", "files.write.guarded");
  // zsh's two-word form through a brace (`cd docs packages`): not read.
  holds("cd {docs,packages} && echo x > notes.md", "files.write.guarded");
  // A pattern that matches several folders is several words too (.claude, .codex, .cursor).
  holds("cd .c* && echo x > notes.md", "files.write.guarded");
});

test("a delete or a move's source after a cd this hook cannot follow is guarded, as a write there is (review-b's M4 on #715)", () => {
  for (const cd of ["cd -", "cd $UNSET_B6", 'cd "$(echo .approval/log)"', "cd {,}"]) {
    // (`unlink` and `shred` are refused by the classifier on this base: refused whole, so not listed.)
    for (const form of ["rm -f events.jsonl", "rm settings.json", "rm -rf log", "rmdir log", "mv env /tmp/b6-x", "find . -delete"]) {
      holds(`${cd} && ${form}`, "files.write.guarded");
    }
  }
  // An absolute word after it, and the same delete with no cd or after a cd it follows, keep their answers.
  const absolute = hook(`cd - && rm -f ${ws}/notes.md`);
  assert.ok(typeof absolute !== "string" && !absolute.includes("files.write.guarded"), JSON.stringify(absolute));
  assert.deepEqual(hook("rm -f notes.md"), ["files.write.workspace"]);
  assert.deepEqual(hook("cd docs && rm -f notes.md"), ALLOWED);
});

// The faults no row pinned (review-b's read of #715): each test below fails
// with one of its planted faults (R2, R4, R5, R6, C16) and passes here.

test("a write word through a variable the line sets is spelled again where the cd lands it", () => {
  holds("F=settings.json; cd .claude && echo x > $F", "policy.core");
  holds('F=env; cd .approval && cp /dev/null "$F"', "account.credential");
});

test("a program's `--opt=value` write word is read by its value where the cd lands it", () => {
  holds("cd .claude && sort --output=settings.json ../x", "policy.core");
  holds("cd .claude && curl --output=settings.json https://example.invalid/x", "policy.core");
  holds("cd .approval/log && cp --target-directory=. /dev/null", "log.mutate");
});

test("an argv word with two landings is read at each, not only the first", () => {
  // .approval/new does not exist, so that cd may fail and the second cd may run.
  holds("cd .approval/new || cd .github/workflows; cp /dev/null ci.yml", "policy.core");
  holds("cd .approval/new || cd .github/workflows; cp /dev/null ci.yml", "policy.edit");
});

test("a subshell's frame is taken as it opens: its cd does not reach the segment after it", () => {
  assert.deepEqual(hook("(cd .approval && ls); echo x > notes.md"), ALLOWED);
  const after = hook("(cd .claude && ls); echo x > settings.json");
  assert.ok(typeof after !== "string" && !after.includes("policy.core"), JSON.stringify(after));
});

test("a spelling that names nothing guarded moves nothing: a delete after a cd into the home or the root", () => {
  // The mutant that made every spelling guarded (C16) added files.delete.out_of_scope here.
  for (const line of ["cd ~ && rm -rf work", "cd / && rm -rf tmp"]) {
    const got = hook(line);
    assert.ok(typeof got !== "string" && !got.includes("files.delete.out_of_scope"), `${line}: ${JSON.stringify(got)}`);
  }
});

test("a cd into a folder that exists cannot fail, unless the line may change the disk first (review-b's S1 on #715)", () => {
  // The cd cannot fail: no failed branch, so the shell is not taken to stand where it was.
  assert.deepEqual(hook("cd .approval; cd ..; echo x > notes.md"), ALLOWED);
  assert.deepEqual(hook("cd .approval\ncd ..\necho x > notes.md"), ALLOWED);
  assert.deepEqual(hook("cd .claude; cd ..; echo x > settings.json"), ALLOWED);
  const out = hook("cd .approval/log; cd ..; echo x >> events.jsonl");
  assert.ok(typeof out !== "string" && !out.includes("log.mutate"), JSON.stringify(out));
  // What it lands in keeps its class, and a cd that may fail keeps both.
  holds("cd .approval; echo x > env", "policy.core");
  holds("cd nosuch; echo x > .claude/settings.json", "policy.core");
  // The failed branch is kept wherever the cd may still fail when the line runs: an earlier
  // segment that may remove, move or lock a folder (the hook reads the disk before the line
  // runs), a program that may do anything, a cd in a process of its own (`&`, a later
  // pipeline stage), a redirection that may fail to open, and a word the kernel cannot walk.
  for (const line of [
    "cd .approval/log; chmod 000 ..; cd ..; echo x >> events.jsonl",
    "cd .approval/log; rm -rf ../../docs; cd ..; echo x >> events.jsonl",
    "cd .approval/log; mv ../../docs ../../d2; cd ..; echo x >> events.jsonl",
    "cd .approval/log; npm test; cd ..; echo x >> events.jsonl",
    "cd .approval/log; cd .. & echo x >> events.jsonl",
    "cd .approval/log; true | cd ..; echo x >> events.jsonl",
    "cd .approval/log; cd .. 2>/nonexistent-b6/x; echo x >> events.jsonl",
    "cd .approval/log; cd ../env/..; echo x >> events.jsonl",
    // A script's cd is read in its place: the shell stays where the script left it.
    "cd .approval/log; sh -c 'cd ..'; echo x >> events.jsonl",
  ]) {
    holds(line, "log.mutate");
  }
});

test("a sure cd has no redirection of any kind, and only a cd or a quiet builtin may come before it (S1, tightened on its security review)", () => {
  // A redirection that fails to open does not run the cd; a dup or a close is not kept in the shape.
  for (const line of [
    "cd .approval/log; cd .. 2>&1; echo x >> events.jsonl",
    "cd .approval/log; cd .. < ../env; echo x >> events.jsonl",
    "cd .approval/log; cd .. >/dev/null; echo x >> events.jsonl",
    // A reader can run code (`sort --compress-program`, `rg --pre`, sed's `e`): not proof that nothing changed.
    "cd .approval/log; sort events.jsonl; cd ..; echo x >> events.jsonl",
    "cd .approval/log; sed -n p events.jsonl; cd ..; echo x >> events.jsonl",
    "cd .approval/log; cat events.jsonl; cd ..; echo x >> events.jsonl",
    "cd .approval/log; rg x .; cd ..; echo x >> events.jsonl",
  ]) {
    holds(line, "log.mutate");
  }
  // An earlier unit that may assign a variable a later cd reads (CDPATH, HOME, OLDPWD) is not quiet either.
  for (const before of [
    "printf -v CDPATH '%s' /tmp",
    ": ${CDPATH:=/tmp}",
    "echo ${HOME:=/x}",
    "CDPATH=/tmp :",
    "CDPATH=/tmp",
    "read CDPATH",
    "export CDPATH=/tmp",
    "declare CDPATH=/tmp",
  ]) {
    const line = `cd .approval/log; ${before}; cd ..; echo x >> events.jsonl`;
    const got = hook(line);
    assert.ok(typeof got === "string" || got.includes("log.mutate"), `${line}: ${JSON.stringify(got)}`);
  }
});

test("only a plain cd, with nothing but plain cds before it, is sure (S1, on its fourth security review)", () => {
  // Any earlier unit, a builtin included, keeps the failed branch of the cd after it.
  // (Refused whole by the classifier, as `: x` is on this base, is the stricter answer.)
  for (const before of ["true", ": x", "echo hi", "pwd", "test a -eq 1", "[ a -eq 1 ]"]) {
    const line = `${before}; cd .approval; cd ..; echo x > notes.md`;
    const got = hook(line);
    assert.ok(typeof got === "string" || got.includes("policy.core"), `${line}: ${JSON.stringify(got)}`);
  }
  // A cd that is not plain (a brace, `~+`, a pattern, an expansion) is not sure, nor is any cd after it.
  holds("cd {.approval,}; cd ..; echo x > notes.md", "policy.core");
  holds("cd ~+; cd .approval; cd ..; echo x > notes.md", "policy.core");
  holds("cd .appr*; cd ..; echo x > notes.md", "policy.core");
  holds("cd ${X:=.approval}; cd ..; echo x > notes.md", "files.write.guarded");
  // Plain cds alone: main's answer.
  for (const line of [
    "cd .approval; cd ..; echo x > notes.md",
    "cd .approval && cd .. && echo x > notes.md",
    "cd -P .approval; cd ..; echo x > notes.md",
    "cd ./.approval; cd ..; echo x > notes.md",
    "cd ~/ws/.approval; cd ..; echo x > notes.md",
  ]) {
    assert.deepEqual(hook(line), ALLOWED, line);
  }
});

test("two subshells back to back: each one's cd ends with it (review-b's S3 on #715)", () => {
  // The second subshell stands where the line did, not where the first one's cd went.
  for (const line of ["(cd .claude) && (echo x > settings.json)", "(cd .claude); (echo x > settings.json)"]) {
    const got = hook(line);
    assert.ok(typeof got !== "string" && !got.includes("policy.core"), `${line}: ${JSON.stringify(got)}`);
  }
  // Nor does a cd in the first leave the second where it went: `(cd ..)` ends, the shell stays in .claude.
  holds("cd .claude && (cd ..) && (echo x > settings.json)", "policy.core");
  // A cd inside a subshell still reaches the segments inside it, and a nested subshell stays inside its group.
  holds("(cd .claude && echo x > settings.json)", "policy.core");
  holds("(cd docs) && (cd .claude && echo x > settings.json)", "policy.core");
  holds("((cd .claude); echo x > settings.json)", "policy.core");
});

test("a line whose parentheses do not pair for sure restores no subshell frame and is read the stricter way (S3's security review)", () => {
  // A `)` with no `(`, a `(` never closed, arithmetic `((…))`, a subshell nested in another:
  // the shell may stand where the subshell's cd went or where it was, and a relative write is guarded.
  for (const line of [
    "cd .claude; true ); cd ..; echo x > settings.json",
    "(cd .claude; echo x > settings.json",
    "cd .claude && ((x=1)) && (echo x > settings.json)",
    "cd .claude && ((cd ..) && (echo x > settings.json))",
  ]) {
    holds(line, "files.write.guarded");
  }
  // Parentheses that pair at depth one keep S3's reading, with no guarded class.
  const balanced = hook("(cd .claude) && (echo x > settings.json)");
  assert.ok(typeof balanced !== "string" && !balanced.includes("files.write.guarded"), JSON.stringify(balanced));
  // A quoted parenthesis is no paren to the lexer.
  holds("cd .claude && echo ')' && (cd ..) && (echo x > settings.json)", "policy.core");
});
