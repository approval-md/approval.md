/**
 * An unread part spliced into a guarded name (lead ruling CLAIMS L62568, on
 * review-b's FINDING L61530 and build-1's S on #682).
 *
 * `echo x > APPROVAL$E.md` writes the policy file when E is empty, and on main
 * 48787b8f it was a workspace write; so were `.claude$S/settings.json`,
 * `.appro${x}val/env` and `{APPROVAL,x}$E.md`. The rule: an unread part (a
 * parameter, a substitution's output, a dollar-quote escape the shells read
 * differently) counts as any text, a `/` included, and the word is matched
 * against every guarded path; a possible match asks, with the class that path
 * takes (the strictest where several match).
 *
 * The edge: a match counts only where the word's LITERAL text takes part in
 * it, and a word that opens with an unread directory (`$D/tail`) asks only
 * where a guarded path ends in the tail by name. So `$D/APPROVAL.md` and
 * `$D/settings.json` ask; `$OUT`, `$D/$F`, `$D/notes.md` (as
 * `.approval/notes.md`), `out/$F` (as `out/APPROVAL.md`) and `$L/scripts/x.sh`
 * (under a guarded `scripts` folder) keep main's answer.
 *
 * Pure: classifyCommand only, no disk, except the hook checks.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { classifyForHook } from "../src/cli/hook.js";
import { classifyCommand, classifyCommandWithMainRules } from "../src/core/command-class.js";
import { cpuSeconds, runner, scaledBound } from "./cost-runner.js";

const GUARDED = new Set(["policy.core", "log.mutate", "account.credential", "policy.edit", "vcs.history.rewrite", "cron.manage"]);

function classesOf(command: string): string[] {
  const result = classifyCommand(command, []);
  assert.ok(result.ok, `${command} was refused: ${result.ok ? "" : result.detail}`);
  return result.classes;
}

/** Main's classes (every GLOB-WRITE-style raise off: the answer that rides beside). */
function mainClasses(command: string): string[] {
  const result = classifyCommandWithMainRules(command, []);
  assert.ok(result.ok, `${command}: main refuses it`);
  return result.classes;
}

test("the ruling's lines ask: the guarded path's class, main's class beside", () => {
  const rows: readonly (readonly [string, string])[] = [
    ["echo x > APPROVAL$E.md", "policy.core"],
    ["echo x > APPROVAL${E}.md", "policy.core"],
    ["echo x > ${E}APPROVAL.md", "policy.core"],
    ["echo x > APPROVAL.md$E", "policy.core"],
    ["echo x > A${x:-B}PPROVAL.md", "policy.core"],
    ["echo x > {APPROVAL,x}$E.md", "policy.core"],
    ["touch {APPROVAL,x}$E.md", "policy.core"],
    ["echo x > .claude$S/settings.json", "policy.core"],
    ["tee .claude$S/settings.json", "policy.core"],
    ["echo x > ~/.hermes/auth$E.json", "policy.core"],
    ["echo x > .github$X/workflows/ci.yml", "policy.edit"],
    ["echo x > .approval$E/log/y", "log.mutate"],
    ["echo x > \"APPROVAL$E.md\"", "policy.core"],
    ["echo x > $D/settings.json", "policy.core"],
  ];
  for (const [command, cls] of rows) {
    const head = classesOf(command);
    assert.ok(head.includes(cls), `${command}: ${head.join(",")}`);
    for (const each of mainClasses(command)) assert.ok(head.includes(each), `${command}: main's ${each}`);
  }
  // Several guarded paths may match: the strictest answers (`.approval/log/...`).
  assert.ok(classesOf("echo x >> .appro${x}val/env").includes("log.mutate"));
  assert.ok(classesOf("rm -rf .appro$x").includes("log.mutate"));
  // Main's answer already asked for these, and still does.
  assert.ok(classesOf("echo x > $D/APPROVAL.md").includes("policy.core"));
  assert.ok(classesOf("echo x > .approval/$F").includes("policy.core"));
  // A dollar-quote escape the shells read differently is an unread part too.
  assert.ok(classesOf("echo x > $'APPRO\\VAL.md'").includes("policy.core"));
  assert.ok(classesOf("echo x > $'APPROVAL.md\\0'.bak").includes("policy.core"));
  // A substitution's output is one (the substitution itself is classified as ever).
  assert.ok(classesOf("echo x > APPROVAL$(true).md").includes("policy.core"));
});

test("a spliced `.git` asks", () => {
  for (const command of ["echo x > .gi${x}t/config", "cp a .g$X/hooks/pre-push", "echo x > .gi$X/config"]) {
    const head = classesOf(command);
    assert.ok(head.some((cls) => GUARDED.has(cls)), `${command}: ${head.join(",")}`);
  }
  // Away from a protected class, the `.git` reader names it.
  assert.ok(classesOf("git add .gi${x}t/x").length > 0);
});

test("the edge: a word whose guarded reading needs no literal text keeps main's answer", () => {
  for (const command of [
    "echo x > $OUT",
    "tee \"$LOG\"",
    "echo x > $D/$F",
    "echo x > $D/notes.md",
    "echo x > out/$F",
    "echo x > out/$F.txt",
    "echo x > out-$i.log",
    "echo x > $D/log/x.txt",
    "cat > $L/scripts/cost-run.sh",
    "echo x > src/$X/index.ts",
    "echo x > \"$TMPDIR/x.json\"",
    "echo x > $HOME/notes.txt",
    "echo x > ~/$F",
    "echo x > exit-$?.txt",
    "echo x > out-$$.txt",
    "echo x > 'APPROVAL$E.md'", // single-quoted: a file named so, no expansion
    "echo x > APPROVAL\\$E.md",
  ]) {
    assert.deepEqual(classesOf(command), mainClasses(command), command);
  }
  // A copy to an unknown target keeps main's fail-closed class, as ever.
  assert.ok(classesOf("cp a \"$DIR/b\"").includes("policy.core"));
});

test("through the hook: a spliced write is not allowed alone, and a spliced credential read is the credential's", () => {
  const cwd = mkdtempSync(join(tmpdir(), "approval-md-spliced-"));
  try {
    mkdirSync(join(cwd, ".approval"));
    writeFileSync(join(cwd, ".approval", "env"), "x\n");
    for (const command of ["echo x > APPROVAL$E.md", "echo x > .claude$S/settings.json", "echo x >> .appro${x}val/env"]) {
      const refined = classifyForHook(command, [], cwd);
      assert.ok(refined.result.ok && refined.result.classes.some((cls) => GUARDED.has(cls)), `${command}: ${JSON.stringify(refined.result)}`);
    }
    for (const command of ["cat .appro${x}val/env", "cat .approval/$F"]) {
      const refined = classifyForHook(command, [], cwd);
      assert.ok(refined.result.ok && refined.result.classes.includes("account.credential"), `${command}: ${JSON.stringify(refined.result)}`);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cost: a word of 3,000 unread parts is bounded, and past the bound could be any path", () => {
  const bound = scaledBound(1);
  for (const [label, command, strict] of [
    ["3,000 parts around a guarded name", `echo x > A${"$E".repeat(3000)}PPROVAL.md`, true],
    ["3,000 parts with literal text between", `echo x > ${Array.from({ length: 3000 }, (_, i) => `a$E${String(i)}`).join("")}.md`, true],
    ["3,000 unread directories", `echo x > ${"$E/".repeat(3000)}APPROVAL.md`, true],
    ["3,000 parts and slashes only", `echo x > ${"$E/".repeat(3000)}$F`, false],
  ] as const) {
    let classes: string[] = [];
    const seconds = cpuSeconds(() => {
      classes = classesOf(command);
    });
    assert.ok(seconds < bound, `${label}: ${seconds.toFixed(3)} CPU s, bound ${bound.toFixed(2)} (${runner().line})`);
    if (strict) assert.ok(classes.some((cls) => GUARDED.has(cls)), `${label}: ${classes.join(",")}`);
    else assert.deepEqual(classes, mainClasses(command), label);
  }
  // Nine parts are past the bound: the word could be any path, the log included.
  assert.ok(classesOf(`echo x > a${"$E".repeat(9)}b`).includes("log.mutate"));
  assert.ok(!classesOf(`echo x > a${"$E".repeat(8)}b`).includes("log.mutate"));
});
