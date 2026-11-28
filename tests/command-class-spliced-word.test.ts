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
import { classifyCommand, classifyCommandWithDollarQuotesKept, classifyCommandWithMainRules, splicedCredentialMemoHeld } from "../src/core/command-class.js";
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
  // A `$` the shell reads as text (single-quoted, escaped, in a dollar quote)
  // is text: the lexed word carries where each sits (coordinator, round two:
  // `'A$B'`), so a file named `.approval/$F` is that file, as main reads it.
  for (const command of ["cat '.approval/$F'", "cat .approval/\\$F", 'cat ".approval/\\$F"', "cat < '.approval/$F'", "cat $'.approval/$F'"]) {
    assert.deepEqual(classesOf(command), mainClasses(command), command);
  }
  // A write target with every glob and `$` quoted is exact: main's answer.
  assert.deepEqual(classesOf("echo x > 'APPROVAL$E.md'"), mainClasses("echo x > 'APPROVAL$E.md'"));
  // As the plain spelling: `source .approval/env` is refused, and so is this.
  for (const command of ["source .approval/$F", ". .approval/$F"]) assert.equal(classifyCommand(command, []).ok, false, command);
  // No credential reading, or a glob (judged against the listing by the hook, as main judges it).
  // A wholly unread directory keeps main's pure answer, as a write there does:
  // the hook judges the tail by its name (`credential-path-resolved`).
  // `cat x$F/*`: the glob is judged by the hook's listing, as main judges it.
  // A wholly unread directory after a `./` or `../` step is one too (`./$D/env`).
  for (const command of ["cat x$F/*", "cat $D/env", "cat ./$D/env", "cat ../$D/env", "cp ./$D/keys /tmp/x", "cat $H/keys", "cat $D/notes.md", "cat $X.txt", "cat src/$X.ts", "cat ./$X", "cat out/$F", "grep -n x $P/*.sh", "grep -h x $D/*"]) {
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
  // The same text made by a kept quote and by a parameter: each `$` a
  // parameter, in either order on the line.
  assert.ok(kept("echo x > A$PPROVAL$E.md; echo A$'P'PROVAL$E.md").includes("policy.core"));
  assert.ok(kept("echo A$'P'PROVAL$E.md; echo x > A$PPROVAL$E.md").includes("policy.core"));
  // A read judges the word's own text: a kept quote's `$F` earlier on the
  // line does not make the read's `$F` text.
  assert.ok(kept("echo .approval/$'F'; cat .approval/$F").includes("account.credential"));
  // In the kept pass a single-quoted `$` is text: a file named `$F9`, read,
  // is no credential there (the decoded pass beside it still asks).
  assert.ok(!kept("cat '.approval/$F9'").includes("account.credential"));
  assert.ok(kept("cat .approval/$F9").includes("account.credential"));
  assert.ok(!kept("cat '.approval/$F9'").includes("account.credential"), "the credential reading's memo keys on which `$` are text");
  // The decoded pass reads the same field: a quoted `$` there is text too.
  assert.deepEqual(classesOf("cat '.approval/$Q7'"), mainClasses("cat '.approval/$Q7'"));
  // Two HIGH reviews of b41520bc: which `$` is text is the lexed word's own
  // field, never a record by text. A literal `$` elsewhere on the line does
  // not make a guarded word's `$` text.
  assert.ok(classesOf("echo '$X'; echo x > APPROVAL$X.md").includes("policy.core"));
  assert.ok(kept("echo '$X'; echo x > APPROVAL$X.md").includes("policy.core"));
  // A brace group holding a quoted `$`.
  assert.ok(classesOf("echo x > {a,'$'}APPROVAL$E.md").includes("policy.core"));
  // A reading made from a word (a default's text) equal to a quoted word's text.
  assert.ok(classesOf("echo 'APPROVAL$E.md'; echo x > ${A:-APPROVAL$E.md}").includes("policy.core"));
  // A long line (once past the old record's bound) changes nothing: each word
  // carries its own.
  const filler = Array.from({ length: 8300 }, (_, i) => `$'f'${String(i)}`).join(" ");
  const long = `echo x > APPROVAL$E.md; echo ${filler}; echo APPROVAL$'E'.md`;
  assert.ok(kept(long).includes("policy.core"));
  assert.ok(classesOf(`echo ${filler}; echo x > .claude$S/settings.json`).includes("policy.core"));
});

test("round two (coordinator, `'A$B'`): a `$` the shell reads as text is the lexed word's field; a reading made from the word has none", () => {
  // The word's own text: single quotes, a backslash, double quotes' `\\$`, a
  // dollar quote's `$`. Main's answer, in a write target, an argument and a read.
  for (const command of [
    "backlog task edit T --append-notes 'A$B'",
    "echo x > 'APPROVAL$E.md'",
    "echo x > APPROVAL\\$E.md",
    'echo x > "APPROVAL\\$E.md"',
    "echo x > $'APPROVAL$E.md'",
    "cp a 'APPROVAL$E.md'",
    "tee 'APPROVAL$E.md'",
    "cat 'a$B' '.approval/$F'",
  ]) {
    assert.deepEqual(classesOf(command), mainClasses(command), command);
  }
  // A real parameter beside a literal `$` in the same word still asks.
  assert.ok(classesOf("echo x > '$'APPROVAL$E.md").includes("policy.core"));
  // The same text twice, once literal and once a parameter: each word reads its own.
  assert.ok(classesOf("echo x > 'APPROVAL$E.md' > APPROVAL$E.md").includes("policy.core"));
  assert.ok(classesOf("echo x > APPROVAL$E.md > 'APPROVAL$E.md'").includes("policy.core"));
  assert.ok(classesOf("cat '.approval$X/env' .approval$X/env").includes("account.credential"));
  // A reading made from a word carries no literal `$`: an option's value is
  // read with every `$` a parameter (fail closed), the quoted one too, and a
  // value equal to a quoted word's text is not read as that word.
  assert.ok(classesOf("cat '.approval$X/env' --file=.approval$X/env").includes("account.credential"));
  assert.ok(classesOf("cat --file='.approval$X/env'").includes("account.credential"));
  // A folded reading of a quoted word and a default's text read the same way.
  assert.ok(classesOf("echo 'APPROVAL$E.md'; echo x > ${A:-APPROVAL$E.md}").includes("policy.core"));
  // A reading with a `${…}` default put in moves the text after the default:
  // the word's literal positions would mark other `$`s there (a real `$X` read
  // as text, a quoted `$` read as a parameter), so that reading takes none.
  // `A` may hold `.approval/log/`; `$X` may be empty beside `.git`.
  // (The second lane's survivor patch for E3.)
  assert.ok(classesOf("echo x > ${A:-}'$X'/APP$XROVAL.md").includes("log.mutate"));
  assert.ok(classesOf("echo x > ${A:-.approval/}\\$abcde$X.git/config").includes("vcs.history.rewrite"));
});

test("round two (review of the home-operator reading): only a home default is the home, and its default is read beside", () => {
  // Any other operator's text can be anything: never lighter than an unread part there.
  for (const [command, unread] of [
    ["echo x > ${HOME%/*}/.ssh/k", "echo x > $X/.ssh/k"],
    ["echo x > ${HOME:+.ssh}/authorized_keys", "echo x > $X/authorized_keys"],
    ["cat ${HOME/x/y}/.hermes/.env", "cat $X/.hermes/.env"],
    ["echo x > ${HOME:+.claude}/settings.json", "echo x > $X.claude/settings.json"],
    ["echo x > ${HOME#/Users}APPROVAL.md", "echo x > ${X}APPROVAL.md"],
    ["echo x > ${HOME:0:1}APPROVAL.md", "echo x > ${X}APPROVAL.md"],
  ] as const) {
    const head = classesOf(command);
    for (const each of classesOf(unread).filter((cls) => GUARDED.has(cls))) assert.ok(head.includes(each), `${command}: ${head.join(",")} lacks ${each}`);
    for (const each of mainClasses(command)) assert.ok(head.includes(each), `${command}: main's ${each}`);
  }
  // A default is the home where the variable is set, and its own text beside.
  assert.ok(classesOf("cat ${HOME:-.approval}/env").includes("account.credential"));
  assert.ok(classesOf("echo x > ${HERMES_HOME-.claude}/settings.json").includes("policy.core"));
  // A default holding an expansion of its own is an unread part.
  assert.ok(classesOf("echo x > ${HOME:-$D}APPROVAL.md").includes("policy.core"));
  assert.ok(classesOf("echo x > ${HOME:-$D}/log/events.jsonl").includes("log.mutate"));
  assert.ok(!classesOf("echo x > ${HOME}/log/events.jsonl").includes("log.mutate"));
  // Review of b58db9ec (M2): a home variable is the home only as the word's
  // first component; anywhere else it may be empty (an unset HERMES_HOME).
  for (const [command, cls] of [
    ["rm -f APPROVAL${HERMES_HOME}.md", "policy.core"],
    ["echo x > APPROVAL$HERMES_HOME.md", "policy.core"],
    ['tee APPROVAL"$HERMES_HOME".md', "policy.core"],
    ["echo x > .claude$HERMES_HOME/settings.json", "policy.core"],
    ["echo x > .gi${HERMES_HOME}t/config", "vcs.history.rewrite"],
    ["echo x > .github${HERMES_HOME}/workflows/ci.yml", "policy.edit"],
    ["cat ${HOME}.approval/env", "account.credential"],
  ] as const) {
    assert.ok(classesOf(command).includes(cls), `${command}: ${classesOf(command).join(",")}`);
  }
  for (const command of ["echo x > $HERMES_HOME/workspace/x", "cat $HERMES_HOME/.env", "echo x > $HOME/notes.md", "echo x > ${HOME}/notes.md"]) {
    assert.deepEqual(classesOf(command), mainClasses(command), command);
  }
  // The home itself, and a default that names nothing guarded, keep main's answer.
  for (const command of ["echo x >> ${HERMES_HOME:-/x}/notes.md", "echo x > ${HOME}/notes.md", "echo x > ${HOME:-/tmp}/out.txt"]) {
    assert.deepEqual(classesOf(command), mainClasses(command), command);
  }
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

test("round two (security reviews of e0586131): a whole unread last component may hold a `/`, and past the bound fails closed", () => {
  // Each keeps a protected or credential class (an unread tail may be one or
  // two guarded names: `.claude/hooks/x`, `.github/workflows/ci.yml`).
  for (const [command, cls] of [
    ["echo x > .claude/$F", "policy.core"],
    ["echo x > .github/$F", "policy.edit"],
    ["echo x > .git/$F", "vcs.history.rewrite"],
    ["cat .approval/$F", "account.credential"],
    ["cat ~/.hermes/$F", "account.credential"],
  ] as const) {
    const head = classesOf(command);
    assert.ok(head.includes(cls), `${command}: ${head.join(",")}`);
    for (const each of mainClasses(command)) assert.ok(head.includes(each), `${command}: main's ${each}`);
  }
  // An unread directory before an unread tail is past the candidate bound:
  // the word could be any path, never the one-name reading.
  assert.ok(classesOf("echo x > out/$X/$F").includes("log.mutate"));
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

/**
 * A line and its control run back to back, the order turning each round (as
 * the walked-once cases in guarded-names-fold-case time theirs): the median
 * of the pairs' ratios, and the line's median call in CPU seconds.
 */
function pairedCost(controlRun: () => void, spentRun: () => void, rounds: number): { ratio: number; spent: number; control: number } {
  // Once each, untimed: the first call pays for the compiler.
  controlRun();
  spentRun();
  const ratios: number[] = [];
  const spents: number[] = [];
  // Measuring only (#720's list): the control's median call is printed too.
  const controls: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    let control: number;
    let spent: number;
    if (round % 2 === 0) {
      control = cpuSeconds(controlRun);
      spent = cpuSeconds(spentRun);
    } else {
      spent = cpuSeconds(spentRun);
      control = cpuSeconds(controlRun);
    }
    ratios.push(spent / Math.max(control, 1e-6));
    spents.push(spent);
    controls.push(control);
  }
  const median = (values: number[]): number => {
    values.sort((left, right) => left - right);
    const middle = values.length >> 1;
    return values.length % 2 === 1 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
  };
  return { ratio: median(ratios), spent: median(spents), control: median(controls) };
}

/**
 * Each paired control's median on CI, CPU s (#720's list; run 46140003817,
 * attempt 1, node 22: the parameter line's control 0.014 beside a median of
 * 0.043, the escapes line's 0.085 beside 0.131).
 */
const PAIRED_CONTROL_CI_S: Readonly<Record<"parameter" | "escapes", number>> = { parameter: 0.014, escapes: 0.085 };

/**
 * The most a paired control may read of its CI figure, before the runner's
 * factor. Three, as #719 holds its controls: each figure is one node 22 run's,
 * and the node 20 floor has not read these controls yet.
 */
const PAIRED_CONTROL_MOST = 3;

/** A paired control against its own bound (`runnerFactor` passed in so the rule can be tested with figures). */
function pairedControlJudged(controlSeconds: number, ciSeconds: number, runnerFactor: number): { controlBound: number; controlOver: boolean } {
  const controlBound = PAIRED_CONTROL_MOST * ciSeconds * runnerFactor;
  return { controlBound, controlOver: !(controlSeconds < controlBound) };
}

test("cost: a paired control is held by its own bound, stretched by the runner's factor and by nothing else (#720's list)", () => {
  for (const ci of Object.values(PAIRED_CONTROL_CI_S)) {
    assert.ok(ci > 0);
    assert.deepEqual(pairedControlJudged(ci, ci, 1), { controlBound: PAIRED_CONTROL_MOST * ci, controlOver: false });
    // A change that slows the control (and its line with it) to three times its figure reds.
    assert.equal(pairedControlJudged(PAIRED_CONTROL_MOST * ci, ci, 1).controlOver, true);
    assert.equal(pairedControlJudged(PAIRED_CONTROL_MOST * ci, ci, 1.5).controlOver, false);
  }
  assert.equal(PAIRED_CONTROL_MOST, 3);
});

test("cost: a word of 3,000 unread parts is bounded, and past the bound could be any path", (t) => {
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
    // Measuring only (#720's list): the reading, printed before it is judged.
    console.log(`# cost-line: SPLICE ${label}: ${seconds.toFixed(3)} CPU s (bound ${bound.toFixed(2)}; ${runner().line})`);
    assert.ok(seconds < bound, `${label}: ${seconds.toFixed(3)} CPU s, bound ${bound.toFixed(2)} (${runner().line})`);
    if (strict) assert.ok(classes.some((cls) => GUARDED.has(cls)), `${label}: ${classes.join(",")}`);
    else assert.deepEqual(classes, mainClasses(command), label);
  }
  // A 100 KB literal component beside an unread part costs a scan, not a walk.
  // One cold call sat at its bound on CI's runner (0.405 of 0.4, run
  // 45640084358; 0.19 to 0.26 s on a laptop, most of it the first call's
  // compile). So each line is timed as the walked-once cases are (lead ruling
  // L63127): back to back with a control of the same size, the order turning,
  // 21 pairs. The median call stays under the same 0.4 bound, and the median
  // ratio to the control is bounded too. Measured on a laptop: the escapes
  // line 1.11 (node 26) and 1.40 (node 20) of the same line with `\n`; the
  // parameter line 2.8 to 3.5 of the line without it.
  //
  // Since #720 the median call's 0.4 is printed, not asserted (CI read 0.158
  // of it with the code unchanged), and the control holds a bound of its own
  // in its place ({@link PAIRED_CONTROL_CI_S}), so a change that slows the
  // line and its control together still reds.
  for (const [name, command, control, most] of [
    ["parameter", `echo x > a$E${"b".repeat(99_000)}`, `echo x > ab${"b".repeat(99_000)}`, 8],
    ["escapes", `cp a $'${"a\\q".repeat(33_000)}'`, `cp a $'${"a\\n".repeat(33_000)}'`, 3],
  ] as const) {
    const { ratio, spent, control: controlSeconds } = pairedCost(() => classifyCommand(control, []), () => classifyCommand(command, []), 21);
    const { controlBound, controlOver } = pairedControlJudged(controlSeconds, PAIRED_CONTROL_CI_S[name], runner().factor);
    const label = `${command.slice(0, 20)}: median ${spent.toFixed(3)} CPU s, ${ratio.toFixed(2)} of its control (${runner().line})`;
    t.diagnostic(`${label}; bound ${String(most)}`);
    console.log(
      `# cost-line: SPLICE paired ${command.slice(0, 20)}: median ${spent.toFixed(3)} CPU s (the fixed ${scaledBound(0.4).toFixed(2)} is printed, not asserted; control median ${controlSeconds.toFixed(3)}, ratio ${ratio.toFixed(2)} of ${String(most)}; the control's own bound ${controlBound.toFixed(3)}; ${runner().line})`,
    );
    assert.ok(ratio <= most, label);
    assert.ok(
      !controlOver,
      `${name}'s control: median ${controlSeconds.toFixed(3)} CPU s, its own bound ${controlBound.toFixed(3)} (${String(PAIRED_CONTROL_MOST)} times CI's ${String(PAIRED_CONTROL_CI_S[name])}, by the runner's factor); ${runner().line}`,
    );
  }
  // The judge reads a `\\` as a separator: past the segments bound a word
  // with a real parameter in it could be any path, and costs a scan.
  {
    const command = `tee $a'${"a\\q".repeat(33_000)}'`;
    let classes: string[] = [];
    const seconds = cpuSeconds(() => {
      classes = classesOf(command);
    });
    // Measuring only (#720's list): the reading, printed before it is judged.
    console.log(`# cost-line: SPLICE backslashes beside a parameter: ${seconds.toFixed(3)} CPU s (bound ${scaledBound(0.4).toFixed(2)}; ${runner().line})`);
    assert.ok(seconds < scaledBound(0.4), `backslashes beside a parameter: ${seconds.toFixed(3)} CPU s (${runner().line})`);
    assert.ok(classes.includes("log.mutate"), classes.join(","));
    assert.deepEqual(classesOf(`tee $a'${"a\\q".repeat(30)}'`), mainClasses(`tee $a'${"a\\q".repeat(30)}'`));
    // A `\\` counts toward that bound only past 1,024 of them: a pattern's
    // escapes (`grep` words of a few dozen) keep their answer.
    for (const command of [`echo x > out/$X'${"\\q".repeat(40)}'`, `grep -n 'a@b'$X'${"\\|x".repeat(40)}' f`]) {
      assert.deepEqual(classesOf(command), mainClasses(command), command);
    }
  }
  // The credential reading remembers no long word: its memo stays small
  // however long the words it judged.
  for (let at = 0; at < 20; at += 1) classesOf(`cat .approval/$F${"x".repeat(200_000)}${String(at)}`);
  assert.ok(splicedCredentialMemoHeld() < 1_000_000, `memo holds ${String(splicedCredentialMemoHeld())} characters`);
  // Nine parts are past the bound: the word could be any path, the log included.
  // (Braced, so the `b` is literal text: `$Eb` would be a parameter of its own.)
  assert.ok(classesOf(`echo x > a${"${E}".repeat(9)}b`).includes("log.mutate"));
  assert.ok(!classesOf(`echo x > a${"${E}".repeat(8)}b`).includes("log.mutate"));
});
