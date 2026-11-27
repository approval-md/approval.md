/**
 * A home variable the line assigns itself, then writes through (#709's owed
 * row, S1 of the judge's verdict at 7c1c2b06).
 *
 * `HERMES_HOME=.approval/log; echo x >> $HERMES_HOME/events.jsonl` asked only
 * as `files.write.guarded`, where the same line with an ordinary variable
 * (`D=.approval/log; …`) reached `log.mutate`. Two readings missed the value:
 * the classifier reads a home variable that opens a word as the home (the M2
 * rule of #709), and the hook's resolved pass ({@link refineWriteLandings})
 * gives up on `$HERMES_HOME` on a line that sets it. The fix is the union of
 * two readings: the word as before (the home; unreadable, so guarded) AND the
 * word as `$D` is read (the line's own value in the hook's pass; an unread
 * part in the classifier's spliced reading). Every class the first reading
 * gave stays; the second only adds.
 *
 * The test compares each line with its `D=` twin: the home form reaches every
 * class the twin reaches. Rows: the four weak rows of the verdict's table,
 * the union row, the prefix assignment (expanded before it applies), the
 * scope rows (a subshell, a function body, after the use, a pipeline stage),
 * values the text cannot read, and one row per name of the hook's
 * `STEERING_NAMES` list (`HOME`, `PWD`, `TMPDIR`, `HERMES_HOME`).
 *
 * Pure (classifyCommand) and through the in-process hook chain
 * (classifyForHook), in a scratch checkout. No line is run.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { classifyForHook } from "../src/cli/hook.js";
import { classifyCommand } from "../src/core/command-class.js";

const GUARDED = "files.write.guarded";

const base = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-home-var-assigned-")));
after(() => {
  rmSync(base, { recursive: true, force: true });
});
// HOME is a fixture folder: nothing here reads or writes the real one, and no
// Hermes home is configured for the hook's own environment.
process.env["HOME"] = join(base, "home");
mkdirSync(join(base, "home"), { recursive: true });
delete process.env["HERMES_HOME"];
delete process.env["APPROVAL_HERMES_HOME"];
delete process.env["CLAUDE_CONFIG_DIR"];
delete process.env["CLAUDE_PROJECT_DIR"];
const ws = join(base, "ws");
mkdirSync(ws, { recursive: true });
spawnSync("git", ["init", "-q"], { cwd: ws });
for (const path of ["APPROVAL.md", "notes.txt", "a.yml", ".approval/env", ".approval/log/events.jsonl", ".claude/settings.json", ".github/workflows/ci.yml"]) {
  mkdirSync(dirname(join(ws, path)), { recursive: true });
  writeFileSync(join(ws, path), "x\n", "utf8");
}

/** The hook chain's classes, or `REF:<code>` for a refused line. */
function hook(command: string): string[] | string {
  const result = classifyForHook(command, [], ws).result;
  return result.ok ? result.classes : `REF:${result.code}`;
}

/** The pure classifier's classes, or `REF:<code>` for a refused line. */
function pure(command: string): string[] | string {
  const result = classifyCommand(command, []);
  return result.ok ? result.classes : `REF:${result.code}`;
}

/** Every class `twin` has, `line` has too (a refusal must be matched by a refusal). */
function covers(line: string, twin: string, read: (command: string) => string[] | string, label: string): void {
  const got = read(line);
  const want = read(twin);
  if (typeof want === "string") {
    assert.equal(typeof got, "string", `${label}: ${line} is classified where its twin ${twin} is refused (${want})`);
    return;
  }
  assert.ok(typeof got !== "string", `${label}: ${line} is refused (${String(got)}) where its twin ${twin} is classified`);
  const missing = want.filter((cls) => !got.includes(cls));
  assert.deepEqual(missing, [], `${label}: ${line} lacks ${missing.join(",")} that ${twin} has (${JSON.stringify(got)} against ${JSON.stringify(want)})`);
}

function classesOf(read: string[] | string, command: string): string[] {
  assert.ok(typeof read !== "string", `${command} was refused: ${String(read)}`);
  return read;
}

test("the four weak rows reach what their D= twins reach, and keep the guarded class", () => {
  const rows: readonly (readonly [line: string, twin: string, cls: string | null])[] = [
    ["HERMES_HOME=.approval/log; echo x >> $HERMES_HOME/events.jsonl", "D=.approval/log; echo x >> $D/events.jsonl", "log.mutate"],
    ["HERMES_HOME=.claude; echo x > $HERMES_HOME/settings.json", "D=.claude; echo x > $D/settings.json", "policy.core"],
    ["HERMES_HOME=.github/workflows; echo x > $HERMES_HOME/ci.yml", "D=.github/workflows; echo x > $D/ci.yml", "policy.edit"],
    // The two-step: the D= twin's own reading gives up on a name set twice
    // (guarded only); the home's second reading follows the sets in order.
    ["HERMES_HOME=.approval; HERMES_HOME=$HERMES_HOME/log; echo x >> $HERMES_HOME/events.jsonl", "D=.approval; D=$D/log; echo x >> $D/events.jsonl", "log.mutate"],
  ];
  for (const [line, twin, cls] of rows) {
    covers(line, twin, hook, "hook");
    covers(line, twin, pure, "pure");
    const classes = classesOf(hook(line), line);
    // The first reading stays: the variable read on a line that sets it is unreadable, so guarded.
    assert.ok(classes.includes(GUARDED), `${line}: ${JSON.stringify(classes)}`);
    if (cls !== null) assert.ok(classes.includes(cls), `${line}: ${JSON.stringify(classes)} lacks ${cls}`);
  }
  // In the pure classifier the settings row is the spliced reading's (`$D/settings.json`).
  assert.ok(classesOf(pure("HERMES_HOME=.claude; echo x > $HERMES_HOME/settings.json"), "pure").includes("policy.core"));
});

test("the same holds in every spelling of the variable and every list form", () => {
  const forms: readonly (readonly [string, string])[] = [
    ["HERMES_HOME=.approval/log; echo x >> ${HERMES_HOME}/events.jsonl", "D=.approval/log; echo x >> ${D}/events.jsonl"],
    ['HERMES_HOME=.approval/log; echo x >> "$HERMES_HOME/events.jsonl"', 'D=.approval/log; echo x >> "$D/events.jsonl"'],
    ["HERMES_HOME=.approval/log && echo x >> $HERMES_HOME/events.jsonl", "D=.approval/log && echo x >> $D/events.jsonl"],
    ["HERMES_HOME=.approval/log || echo x >> $HERMES_HOME/events.jsonl", "D=.approval/log || echo x >> $D/events.jsonl"],
    ["HERMES_HOME=.approval; echo x >> $HERMES_HOME/log/events.jsonl", "D=.approval; echo x >> $D/log/events.jsonl"],
    ["HERMES_HOME=.github; echo x > $HERMES_HOME/workflows/ci.yml", "D=.github; echo x > $D/workflows/ci.yml"],
    ["HERMES_HOME=.approval; cp notes.txt $HERMES_HOME/env", "D=.approval; cp notes.txt $D/env"],
    ["HERMES_HOME=.github/workflows; cp a.yml $HERMES_HOME/", "D=.github/workflows; cp a.yml $D/"],
    ["HERMES_HOME=.github/workflows; sed -i s/a/b/ $HERMES_HOME/*.yml", "D=.github/workflows; sed -i s/a/b/ $D/*.yml"],
    ["HERMES_HOME=.approval; D=$HERMES_HOME/log; echo x >> $D/events.jsonl", "E=.approval; D=$E/log; echo x >> $D/events.jsonl"],
    // A segment main classes above a workspace write is judged against the
    // guarded list only, where an unreadable word counts for a tree program
    // alone: the value's guarded landing counts, as the twin's does.
    ["HERMES_HOME=.claude; sed -i s/a/b/ $HERMES_HOME/hooks/x.sh", "D=.claude; sed -i s/a/b/ $D/hooks/x.sh"],
    ["HERMES_HOME=.git; sed -i s/a/b/ $HERMES_HOME/hooks/pre-push", "D=.git; sed -i s/a/b/ $D/hooks/pre-push"],
  ];
  for (const [line, twin] of forms) {
    covers(line, twin, hook, "hook");
    covers(line, twin, pure, "pure");
    assert.ok(classesOf(hook(line), line).includes(GUARDED), line);
  }
  assert.ok(classesOf(hook(forms[0]![0]), forms[0]![0]).includes("log.mutate"));
  assert.ok(classesOf(hook(forms[6]![0]), forms[6]![0]).includes("account.credential"));
});

test("the union: the home reading's classes stay beside the value's", () => {
  // The value is read too, and the home reading still names the credential and the scheduler.
  assert.ok(classesOf(hook("HERMES_HOME=/tmp/x; cat $HERMES_HOME/env"), "env").includes("account.credential"));
  assert.ok(classesOf(hook("HERMES_HOME=/tmp/x; cat ${HERMES_HOME}/.env"), ".env").includes("account.credential"));
  const scripts = classesOf(hook("HERMES_HOME=/tmp/x; echo x > $HERMES_HOME/scripts/a.sh"), "scripts");
  assert.ok(scripts.includes("cron.manage") && scripts.includes(GUARDED), JSON.stringify(scripts));
  // An ordinary value adds nothing, and the guarded class stays (its D= twin is a workspace write).
  const ordinary = classesOf(hook("HERMES_HOME=docs; echo x > $HERMES_HOME/a.md"), "docs");
  assert.ok(ordinary.includes(GUARDED), JSON.stringify(ordinary));
  assert.ok(!classesOf(hook("D=docs; echo x > $D/a.md"), "D docs").includes(GUARDED));
  // A read gains no write class.
  const read = classesOf(hook("HERMES_HOME=.approval/log; cat $HERMES_HOME/events.jsonl"), "read");
  assert.deepEqual(read, classesOf(hook("D=.approval/log; cat $D/events.jsonl"), "D read"));
  // With no assignment on the line nothing moves: the home is the hook's own (none here).
  assert.ok(!classesOf(hook("echo x >> $HERMES_HOME/events.jsonl"), "bare").includes("log.mutate"));
  assert.ok(!classesOf(pure("echo x > $HERMES_HOME/settings.json"), "bare pure").includes("policy.core"));
});

test("a value the text cannot read is an unread part: it asks the guarded name's class, as $D does", () => {
  const rows: readonly (readonly [string, string, string])[] = [
    ["HERMES_HOME=$(pwd); echo x > $HERMES_HOME/settings.json", "D=$(pwd); echo x > $D/settings.json", "policy.core"],
    ["HERMES_HOME=$X; echo x > $HERMES_HOME/APPROVAL.md", "D=$X; echo x > $D/APPROVAL.md", "policy.core"],
    ["HERMES_HOME=$(pwd)/.approval/log; echo x >> $HERMES_HOME/events.jsonl", "D=$(pwd)/.approval/log; echo x >> $D/events.jsonl", GUARDED],
  ];
  for (const [line, twin, cls] of rows) {
    covers(line, twin, hook, "hook");
    covers(line, twin, pure, "pure");
    const classes = classesOf(hook(line), line);
    assert.ok(classes.includes(cls) && classes.includes(GUARDED), `${line}: ${JSON.stringify(classes)}`);
  }
  // `read` and a loop bind the name in a way the classifier refuses, here and in the D= form.
  for (const line of ["read HERMES_HOME; echo x >> $HERMES_HOME/events.jsonl", "for HERMES_HOME in .approval/log; do echo x >> $HERMES_HOME/events.jsonl; done"]) {
    assert.equal(typeof hook(line), "string", line);
  }
});

test("a prefix assignment does not apply to its own command's words", () => {
  // The shell expands `$HERMES_HOME` before the assignment applies: the hook's
  // pass gives up on the name (a prefix taints it), as for `D`, and the
  // classifier does not count a prefix as the line's own binding: the word
  // keeps the answer it had before this change (pinned here as it was).
  for (const line of ["HERMES_HOME=.approval/log echo x >> $HERMES_HOME/events.jsonl", "HERMES_HOME=.claude tee $HERMES_HOME/settings.json </dev/null"]) {
    assert.deepEqual(classesOf(hook(line), line), ["files.write.workspace", GUARDED], line);
    assert.deepEqual(classesOf(pure(line), line), ["files.write.workspace"], line);
  }
  // The D= twin of the second has policy.core from the spliced reading alone
  // (`$D/settings.json` is an unread part with or without an assignment), not
  // from the prefix's value; the home form keeps the home reading there.
  assert.ok(classesOf(hook("D=.claude tee $D/settings.json </dev/null"), "D prefix").includes("policy.core"));
  // A bare assignment before it on the line does count.
  assert.ok(classesOf(pure("HERMES_HOME=.claude; HERMES_HOME=x tee $HERMES_HOME/settings.json </dev/null"), "bare then prefix").includes("policy.core"));
});

test("scope: what the D= reading does not carry to the word, the home's does not either", () => {
  // A subshell's assignment and an assignment after the use: neither twin gains.
  for (const [line, twin] of [
    ["(HERMES_HOME=.approval/log); echo x >> $HERMES_HOME/events.jsonl", "(D=.approval/log); echo x >> $D/events.jsonl"],
    ["echo x >> $HERMES_HOME/events.jsonl; HERMES_HOME=.approval/log", "echo x >> $D/events.jsonl; D=.approval/log"],
    ["HERMES_HOME=.approval/log; HERMES_HOME=a; echo x >> $HERMES_HOME/events.jsonl", "D=.approval/log; D=a; echo x >> $D/events.jsonl"],
  ] as const) {
    const classes = classesOf(hook(line), line);
    const twinClasses = classesOf(hook(twin), twin);
    assert.ok(!twinClasses.includes("log.mutate"), `${twin}: ${JSON.stringify(twinClasses)}`);
    assert.ok(!classes.includes("log.mutate") && classes.includes(GUARDED), `${line}: ${JSON.stringify(classes)}`);
  }
  // A function body and a brace group: refused, in both forms.
  for (const [line, twin] of [
    ["f() { HERMES_HOME=.approval/log; }; f; echo x >> $HERMES_HOME/events.jsonl", "f() { D=.approval/log; }; f; echo x >> $D/events.jsonl"],
    ["{ HERMES_HOME=.approval/log; }; echo x >> $HERMES_HOME/events.jsonl", "{ D=.approval/log; }; echo x >> $D/events.jsonl"],
  ] as const) {
    assert.equal(typeof hook(line), "string", line);
    assert.equal(typeof hook(twin), "string", twin);
  }
  // A pipeline stage or a background job: the D= reading carries the value
  // over (a stage is a subshell to bash, so it over-reads: a class added, never
  // one taken), and the home's does the same.
  for (const [line, twin] of [
    ["HERMES_HOME=.approval/log | echo x >> $HERMES_HOME/events.jsonl", "D=.approval/log | echo x >> $D/events.jsonl"],
    ["HERMES_HOME=.approval/log & echo x >> $HERMES_HOME/events.jsonl", "D=.approval/log & echo x >> $D/events.jsonl"],
  ] as const) {
    covers(line, twin, hook, "hook");
    assert.ok(classesOf(hook(twin), twin).includes("log.mutate"), twin);
  }
});

test("every name of the hook's STEERING_NAMES list, one row each", () => {
  // HOME and TMPDIR: a line that assigns them is refused before the hook's pass.
  assert.equal(typeof hook("HOME=.approval/log; echo x > $HOME/a.txt"), "string");
  assert.equal(typeof hook("TMPDIR=.approval/log; echo x >> $TMPDIR/events.jsonl"), "string");
  // PWD: the value the line gives it, unless a cd before the word set it again.
  const pwd = classesOf(hook("PWD=.approval/log; echo x >> $PWD/events.jsonl"), "PWD");
  assert.ok(pwd.includes("log.mutate") && pwd.includes(GUARDED), JSON.stringify(pwd));
  const cd = classesOf(hook("PWD=.approval/log; cd /tmp; echo x >> $PWD/events.jsonl"), "PWD after cd");
  assert.ok(!cd.includes("log.mutate") && cd.includes(GUARDED), JSON.stringify(cd));
  // HERMES_HOME: the row itself.
  assert.ok(classesOf(hook("HERMES_HOME=.approval/log; echo x >> $HERMES_HOME/events.jsonl"), "HERMES_HOME").includes("log.mutate"));
});

test("the two-step form: a steering name set again, each time bare and unconditionally, takes its last value before the word", () => {
  for (const [line, cls] of [
    ["HERMES_HOME=.approval; HERMES_HOME=$HERMES_HOME/log; echo x >> $HERMES_HOME/events.jsonl", "log.mutate"],
    ["HERMES_HOME=a; HERMES_HOME=.approval/log; echo x >> $HERMES_HOME/events.jsonl", "log.mutate"],
    // Set again only after the word: the value at the word is the first.
    ["HERMES_HOME=.approval/log; echo x >> $HERMES_HOME/events.jsonl; HERMES_HOME=a", "log.mutate"],
    ["PWD=.approval; PWD=$PWD/log; echo x >> $PWD/events.jsonl", "log.mutate"],
  ] as const) {
    const classes = classesOf(hook(line), line);
    assert.ok(classes.includes(cls) && classes.includes(GUARDED), `${line}: ${JSON.stringify(classes)}`);
  }
  // Where the line's last value is another, or the sets cannot be followed
  // (two in one segment, one behind a condition), nothing is added; guarded stays.
  for (const line of [
    "HERMES_HOME=.approval/log; HERMES_HOME=a; echo x >> $HERMES_HOME/events.jsonl",
    "HERMES_HOME=.approval HERMES_HOME=$HERMES_HOME/log; echo x >> $HERMES_HOME/events.jsonl",
    "true && HERMES_HOME=a; HERMES_HOME=.approval; HERMES_HOME=$HERMES_HOME/log; echo x >> $HERMES_HOME/events.jsonl",
  ]) {
    const classes = classesOf(hook(line), line);
    assert.ok(!classes.includes("log.mutate") && classes.includes(GUARDED), `${line}: ${JSON.stringify(classes)}`);
  }
  // An ordinary name set twice is not followed: its D= reading is as before.
  const twin = classesOf(hook("D=.approval; D=$D/log; echo x >> $D/events.jsonl"), "D two-step");
  assert.ok(!twin.includes("log.mutate") && twin.includes(GUARDED), JSON.stringify(twin));
  // Bounded: past eight steps the word is unreadable (guarded), whatever the chain spells.
  const steps = (n: number): string => `HERMES_HOME=.approval; ${Array.from({ length: n }, () => "HERMES_HOME=$HERMES_HOME/.").join("; ")}; HERMES_HOME=$HERMES_HOME/log; echo x >> $HERMES_HOME/events.jsonl`;
  assert.ok(classesOf(hook(steps(6)), "6 steps").includes("log.mutate"));
  const deep = classesOf(hook(steps(400)), "400 steps");
  assert.ok(deep.includes(GUARDED) && !deep.includes("log.mutate"), JSON.stringify(deep));
});
