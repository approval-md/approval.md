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
const ws = join(base, "ws");
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
