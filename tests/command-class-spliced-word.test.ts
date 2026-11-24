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
 * it (a `.` in a component counts; a component of `.` or `..` alone does
 * not), and a word whose directory is WHOLLY unread (`$D/tail`) asks only
 * where a guarded path ends in the tail by name. So `$D/APPROVAL.md`,
 * `$D/settings.json`, `.github/$W/ci.yml` and `.$X` ask; `$OUT`, `$D/$F`,
 * `./$X`, `$D/notes.md` and `$D/env` (as `.approval/notes.md` and
 * `.approval/env`, both the gate's folder) and `out/$F` (as `out/APPROVAL.md`)
 * keep main's answer. Reads: a word that could be a credential file asks the
 * credential's class (L62542, "for writes AND reads").
 *
 * Pure: classifyCommand only, no disk, except the hook checks.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { classifyForHook } from "../src/cli/hook.js";
import { classifyCommand, classifyCommandWithDollarQuotesKept, classifyCommandWithMainRules } from "../src/core/command-class.js";
import { cpuSeconds, runner, scaledBound } from "./cost-runner.js";

const ROUTES = [
  { path: ".github/workflows/", class: "policy.edit.ci" },
  { path: ".github/CODEOWNERS", class: "policy.edit.owners" },
];

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
    // A part may hold a `/`: `notes-$F.md` is `notes-/../APPROVAL.md` with F=`/../APPROVAL`.
    ["echo x > notes-$F.md", "policy.core"],
  ];
  for (const [command, cls] of rows) {
    const head = classesOf(command);
    assert.ok(head.includes(cls), `${command}: ${head.join(",")}`);
    for (const each of mainClasses(command)) assert.ok(head.includes(each), `${command}: main's ${each}`);
  }
  // The path's own class; where several match, the strictest (`rm -rf .approval` takes the log).
  // (`.appro${x}val/env` may also be `.approval/log/…val/env`, x holding a `/`: the log.)
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
  // Where no protected path matches, the `.git` join reader names it (`x=.`: `.git/HEAD`).
  assert.ok(classesOf("echo x > ${x}git/HEAD").includes("vcs.history.rewrite"));
  assert.deepEqual(mainClasses("echo x > ${x}git/HEAD"), ["files.write.workspace"]);
});

test("the edge: a word whose guarded reading needs no literal text keeps main's answer", () => {
  for (const command of [
    "echo x > $OUT",
    "tee \"$LOG\"",
    "echo x > $D/$F",
    "echo x > $D/notes.md",
    // A tail inside a folder the guards hold whole adds nothing to the folder.
    "echo x > $D/env",
    "echo x > $D/events.jsonl",
    "echo x > out/$F",
    "echo x > out/$F.txt",
    "echo x > out-$i.log",
    "echo x > src/$X/index.ts",
    "echo x > \"$TMPDIR/x.json\"",
    "echo x > $HOME/notes.txt",
    // `~` takes no part: a `.hermes` folder anywhere is judged as the home.
    "echo x > ~/$F",
    "echo x > exit-$?.txt",
    "echo x > out-$$.txt",
    "echo x > $X.tmp",
    "echo x > dist/$X.tmp",
    "echo x > 'APPROVAL$E.md'", // single-quoted: a file named so, no expansion
    "echo x > APPROVAL\\$E.md",
    // A component of `.` or `..` alone is a step, not literal text.
    "echo x > ./$X",
    "echo x > ../$X",
    "echo x > ./$D/$F",
  ]) {
    assert.deepEqual(classesOf(command), mainClasses(command), command);
  }
  // A copy to an unknown target keeps main's fail-closed class, as ever.
  assert.ok(classesOf("cp a \"$DIR/b\"").includes("policy.core"));
});

test("round two: a `.` in a component is literal text, and a directory with literal text in it is matched as any part", () => {
  // Lead's rule (L62568): an unread part counts as `*`, `/` included, and any
  // possible match asks. `.$X` may be `.approval`; `.github/$W/ci.yml` may be
  // `.github/workflows/ci.yml`; `$D/log/x.txt` may be `.approval/log/x.txt`.
  for (const command of [
    "echo x > .$X",
    "echo x > .${X}",
    "echo x > ./.$X",
    "echo x > \"${name}.${ext}\"",
    "echo x > v$A.$B",
    "echo x > .github/$W/ci.yml",
    "echo x > $D/log/x.txt",
    "echo x >> .g$(printf it)/config",
  ]) {
    const head = classesOf(command);
    assert.ok(head.some((cls) => GUARDED.has(cls)), `${command}: ${head.join(",")}`);
    for (const each of mainClasses(command)) assert.ok(head.includes(each), `${command}: main's ${each}`);
  }
  assert.ok(classesOf("echo x > .github/$W/ci.yml").includes("policy.edit"));
  const routed = classifyCommand("echo x > .github/$W/ci.yml", ROUTES);
  assert.ok(routed.ok && routed.classes.includes("policy.edit.ci"), JSON.stringify(routed));
  assert.ok(classesOf("echo x > $D/log/x.txt").includes("log.mutate"));
});

test("round two (automated security review, b): brace groups are expanded before the spliced reading", () => {
  for (const [command, cls] of [
    ["echo x > {x,.github}/$W/ci.yml", "policy.edit"],
    ["echo x > {A,B}$X/settings.json", "policy.core"],
    ["echo x >> .g{x,$(printf it)}/config", null],
    ["echo x > {a,.approval}$X/env", null],
  ] as const) {
    const head = classesOf(command);
    assert.ok(cls === null ? head.some((each) => GUARDED.has(each)) : head.includes(cls), `${command}: ${head.join(",")}`);
  }
});

test("round two (L62542, for reads too): a word that could be a credential file asks the credential's class", () => {
  for (const command of [
    "cat .appro${x}val/env",
    "cat .approval/$F",
    "cat < .approval/$F",
    "grep k .approval/$F",
    "head -1 .approval/$F",
    "cp .approval/$F x",
    "cat .approval/e$X",
    "cat ~/.hermes/$F",
    "cat .$X",
  ]) {
    const head = classesOf(command);
    assert.ok(head.includes("account.credential"), `${command}: ${head.join(",")}`);
    for (const each of mainClasses(command)) assert.ok(head.includes(each), `${command}: main's ${each}`);
  }
  // Main refuses this line (no rule for an awk program); the program's nine
  // parameters are past the parts bound, so it may be a credential, and the
  // refusal still stands (the line's main answer joins).
  const awk = classifyCommand("awk '{print $3,$4,$5,$6,$7,$8,$9,$10,$11}' x", []);
  assert.equal(awk.ok, false, JSON.stringify(awk));
  assert.equal(classifyCommandWithMainRules("awk '{print $3,$4,$5,$6,$7,$8,$9,$10,$11}' x", []).ok, false);
  // A `$` that opens no parameter is text in the spliced reading, not one
  // that may hold several directories.
  for (const command of ['grep -n "build.py\\" \\"\\$S\\"|-I build.py|build.py \\$" w/*.sh', 'node q.mjs "echo x > \\$\'A\'*\\$?"']) {
    assert.deepEqual(classesOf(command), mainClasses(command), command);
  }
  // As the plain spelling: `source .approval/env` is refused, and so is this.
  for (const command of ["source .approval/$F", ". .approval/$F"]) assert.equal(classifyCommand(command, []).ok, false, command);
  // No credential reading, or a glob (judged against the listing by the hook, as main judges it).
  // A wholly unread directory keeps main's pure answer, as a write there does:
  // the hook judges the tail by its name (`credential-path-resolved`).
  for (const command of ["cat $D/env", "cat $H/keys", "cat $D/notes.md", "cat $X.txt", "cat src/$X.ts", "cat ./$X", "cat out/$F", "grep -n x $P/*.sh", "grep -h x $D/*"]) {
    assert.deepEqual(classesOf(command), mainClasses(command), command);
  }
});

test("round two (automated security review, a): the kept reading reads every unread part but a kept quote's own `$`", () => {
  const kept = (command: string): string[] => {
    const result = classifyCommandWithDollarQuotesKept(command, []);
    assert.ok(result.ok, command);
    return result.classes;
  };
  // A dollar-quoted word beside a spliced write: the write asks in the kept pass too.
  assert.ok(kept("echo $'a' > APPROVAL$E.md").includes("policy.core"));
  assert.ok(kept("echo $'a' > .approval/$F").includes("log.mutate"));
  // A kept quote's `$` names no parameter: main's answer.
  assert.deepEqual(kept("echo x > $'A'PPROVAL.md"), ["files.write.workspace"]);
  // The same text made by a kept quote and by a parameter: each `$` a parameter.
  assert.ok(kept("echo x > A$PPROVAL$E.md; echo A$'P'PROVAL$E.md").includes("policy.core"));
});

test("round two (automated security review, c): every equal claim a spliced word meets is reported", () => {
  // `.github` bare takes the class of every routed entry inside it; so does `.gith${X}ub`.
  const plain = classifyCommand("echo x > .github", ROUTES);
  const spliced = classifyCommand("echo x > .gith${X}ub", ROUTES);
  assert.ok(plain.ok && spliced.ok);
  for (const cls of ["policy.edit.ci", "policy.edit.owners"]) {
    assert.ok(plain.classes.includes(cls), `plain: ${plain.classes.join(",")}`);
    assert.ok(spliced.classes.includes(cls), `spliced: ${spliced.classes.join(",")}`);
  }
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
  // A 100 KB literal component beside an unread part costs a scan, not a walk
  // (0.03 to 0.09 CPU s measured on a laptop).
  for (const command of [`echo x > a$E${"b".repeat(99_000)}`, `cp a $'${"a\\q".repeat(33_000)}'`]) {
    const seconds = cpuSeconds(() => classifyCommand(command, []));
    assert.ok(seconds < scaledBound(0.4), `${command.slice(0, 20)}: ${seconds.toFixed(3)} CPU s (${runner().line})`);
  }
  // Nine parts are past the bound: the word could be any path, the log included.
  assert.ok(classesOf(`echo x > a${"$E".repeat(9)}b`).includes("log.mutate"));
  assert.ok(!classesOf(`echo x > a${"$E".repeat(8)}b`).includes("log.mutate"));
});
