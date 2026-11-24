/**
 * Dollar-quoted words (lead ruling CLAIMS L62542): `$'…'` and `$"…"` are read
 * as the text the shell makes of them.
 *
 * On main 48787b8f the lexer kept the `$` and read the quote after it, so
 * `echo x >> $'\x41PPROVAL.md'` was a write to the unknown variable
 * `$\x41PPROVAL.md`, a workspace write, and the hook allowed it under a policy
 * where workspace writes run on their own: bash and zsh write the policy file.
 * The lexer now decodes `$'…'` where bash (3.2 and 5) and zsh decode alike,
 * reads `$"…"` as `"…"`, and leaves anything else unknown, the way `$X` is.
 * Wherever it decoded one, main's reading of the line rides beside
 * (`classifyCommandWithDollarQuotesKept`), so no line answers lighter than main.
 *
 * Pure: classifyCommand only, no disk, except the hook check at the end.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { classifyForHook } from "../src/cli/hook.js";
import {
  classifyCommand,
  classifyCommandWithDollarQuotesKept,
  commandSegmentShapes,
  SUBSTITUTION_SENTINEL,
} from "../src/core/command-class.js";
import { cpuSeconds, runner, scaledBound } from "./cost-runner.js";

function classesOf(command: string): string[] {
  const result = classifyCommand(command, []);
  assert.ok(result.ok, `${command} was refused: ${result.ok ? "" : result.detail}`);
  return result.classes;
}

/** Main's classes for the line (dollar quotes kept as main kept them). */
function mainClasses(command: string): string[] {
  const result = classifyCommandWithDollarQuotesKept(command, []);
  assert.ok(result.ok, `${command}: main refuses it`);
  return result.classes;
}

/** The plain spelling's classes, then every class main gives the dollar-quoted line that they lack. */
function asPlain(command: string, plain: string): string[] {
  const expected = classesOf(plain);
  return [...expected, ...mainClasses(command).filter((cls) => !expected.includes(cls))];
}

test("the brief's table: each dollar-quoted line answers as its plain spelling, main's class beside", () => {
  const rows: readonly (readonly [string, string])[] = [
    ["echo x > $'APPROVAL.md'", "echo x > APPROVAL.md"],
    ["echo x >> $'\\x41PPROVAL.md'", "echo x >> APPROVAL.md"],
    ["echo x > $'\\101PPROVAL.md'", "echo x > APPROVAL.md"],
    ["echo x > $'A'PPROVAL.md", "echo x > APPROVAL.md"],
    ["echo x > $'\\u0041PPROVAL.md'", "echo x > APPROVAL.md"],
    ["tee $'APPROVAL.md'", "tee APPROVAL.md"],
    ["touch $'APPROVAL.md'", "touch APPROVAL.md"],
    ["sed -i s/a/b/ $'APPROVAL.md'", "sed -i s/a/b/ APPROVAL.md"],
    ["echo x > .claude/$'settings.json'", "echo x > .claude/settings.json"],
    ["echo x > $'.approval/log.jsonl'", "echo x > .approval/log.jsonl"],
    ["cat $'.approval/env'", "cat .approval/env"],
    ['cat $".approval/env"', "cat .approval/env"],
    ['echo x > $"APPROVAL.md"', "echo x > APPROVAL.md"],
    ['tee -a $"APPROVAL.md"', "tee -a APPROVAL.md"],
    ["cp notes.txt $'\\x41PPROVAL.md'", "cp notes.txt APPROVAL.md"],
    ["mv notes.txt $'\\x41PPROVAL.md'", "mv notes.txt APPROVAL.md"],
    ["rm $'\\x41PPROVAL.md'", "rm APPROVAL.md"],
    ["echo x > $'.approval/\\x65nv'", "echo x > .approval/env"],
    ["cat $'.approval/\\x65nv'", "cat .approval/env"],
    ["echo x > .github/workflows/$'\\x63i.yml'", "echo x > .github/workflows/ci.yml"],
    ["echo x > .git/hooks/$'\\x70re-push'", "echo x > .git/hooks/pre-push"],
    // Main's reading beside is main's answer: there `$'env'` is the parameter `$env`,
    // and no spliced-word reading (lead ruling L62568) is made of it.
    ["echo x > .approval/$'env'", "echo x > .approval/env"],
    ["echo x > $'SP'EC.md", "echo x > SPEC.md"],
  ];
  // Those two are their plain spelling's answer exactly: main's reading adds nothing.
  assert.deepEqual(classesOf("echo x > .approval/$'env'"), classesOf("echo x > .approval/env"));
  assert.deepEqual(classesOf("echo x > $'SP'EC.md"), classesOf("echo x > SPEC.md"));
  for (const [command, plain] of rows) {
    assert.deepEqual(classesOf(command), asPlain(command, plain), command);
    // The plain spelling's strictest class is there.
    for (const cls of ["policy.core", "log.mutate", "account.credential", "policy.edit", "vcs.history.rewrite"]) {
      if (classesOf(plain).includes(cls)) assert.ok(classesOf(command).includes(cls), `${command}: ${cls}`);
    }
  }
});

test("every escape bash and zsh decode alike is decoded", () => {
  const spellings = [
    "$'\\x41PPROVAL.md'", // \xHH
    "$'\\x41''PPROVAL.md'",
    "$'\\101PPROVAL.md'", // octal
    "$'APPROVAL\\56md'",
    "$'APPROVAL\\x2emd'",
    "$'\\u0041PPROVAL.md'", // \uHHHH, four digits
    "$'APPRO\\x56AL.md'",
    "$'APPROVAL.m\\x64'",
    "$'APPR'O$'VAL.md'",
    "$'APP'\"ROV\"'AL'.md", // mixed with '…' and "…"
    "A$'P'P\\ROVAL.md",
  ];
  for (const spelling of spellings) {
    assert.ok(classesOf(`echo x > ${spelling}`).includes("policy.core"), spelling);
  }
  // A decoded backslash is read as the plain spelling reads one.
  assert.deepEqual(classesOf("echo x > $'APPROVAL.md\\\\'"), asPlain("echo x > $'APPROVAL.md\\\\'", "echo x > 'APPROVAL.md\\'"));
  // A letter escape decodes to its character.
  assert.deepEqual(classesOf("echo $'a\\tb\\n' > notes.txt"), mainClasses("echo $'a\\tb\\n' > notes.txt"));
});

/** The lexer's text for the redirect target of `echo x > <word>`. */
function targetText(word: string): string {
  const shapes = commandSegmentShapes(`echo x > ${word}`);
  assert.ok(shapes !== null && shapes.length === 1, word);
  return (shapes[0] as { writes: string[] }).writes[0] as string;
}

test("the lexer's text: each shared escape decoded, each other one unknown", () => {
  const U = SUBSTITUTION_SENTINEL;
  const cases: readonly (readonly [string, string])[] = [
    ["$'APPROVAL.md'", "APPROVAL.md"],
    ["$'\\x41'", "A"],
    ["$'\\x4'g", "\u0004g"],
    ["$'\\101'", "A"],
    ["$'\\1011'", "A1"],
    ["$'\\0101'", "\b1"],
    ["$'\\777'", U], // a byte: 0xFF, outside ASCII
    ["$'\\u0041'", "A"],
    ["$'\\u00411'", "A1"],
    ["$'a\\tb\\nc'", "a\tb\nc"],
    ["$'\\a\\b\\e\\E\\f\\r\\v'", "\u0007\b\u001b\u001b\f\r\v"],
    ["$'\\\\'", "\\"],
    ["$'\\''", "'"],
    ["$'\\\"'", '"'],
    ["$'\\?'", "?"],
    ['$"APPROVAL.md"', "APPROVAL.md"],
    ['$"$X.md"', "$X.md"],
    ["$'APPRO\\VAL.md'", `APPRO${U}AL.md`],
    ["$'a\\qb'", `a${U}b`],
    ["$'a\\cAb'", `a${U}`],
    ["$'a\\U00000041b'", `a${U}`],
    ["$'a\\u41b'", `a${U}`],
    ["$'a\\xgb'", `a${U}`],
    ["$'a\\C-ab'", `a${U}`],
    ["$'a\\M-ab'", `a${U}`],
    ["$'a\\xc3\\xa9b'", `a${U}b`],
    ["$'a\\u00e9b'", `a${U}b`],
    ["$'a\\0b'c", `a${U}`],
    ["$'a\\x00b'c", `a${U}`],
    ["$'a\\400b'c", `a${U}`],
    ["x$'a'$'b'\"c\"'d'", "xabcd"],
    [`$'${"\\q".repeat(40)}'tail`, `${U}tail`], // one unread run
    [`$'${"a\\q".repeat(40)}'tail`, `a${U}`.repeat(33)], // past the bound: the rest of the word is unknown
  ];
  for (const [word, text] of cases) assert.equal(targetText(word), text, word);
  // The program word and a read operand are read the same way.
  const verb = commandSegmentShapes("$'\\x72m' -rf x");
  assert.equal(verb?.[0]?.bin, "rm");
  const read = commandSegmentShapes("cat $'.approval/\\x65nv'");
  assert.deepEqual(read?.[0]?.args, [".approval/env"]);
  // A substitution ends at its own `)`, past a `\'` inside a dollar quote.
  const inner = commandSegmentShapes("echo $(printf $'a\\'b') > out.txt");
  assert.deepEqual(inner?.[0]?.substitutions, ["printf $'a\\'b'"]);
});

test("an escape the shells read differently, a non-ASCII character or a NUL leaves the word unknown", () => {
  // Each is a copy to a target the text cannot settle: main's fail-closed class.
  for (const spelling of [
    "$'APPRO\\VAL.md'", // bash keeps `\V`, zsh drops the backslash
    "$'APPROVAL\\cA.md'", // bash only
    "$'\\U00000041PPROVAL.md'", // bash 3.2 keeps it
    "$'\\u41PPROVAL.md'", // fewer than four digits: bash 3.2 keeps it
    "$'\\xPPROVAL.md'", // `\x` with no digit: zsh decodes it
    "$'\\C-APPROVAL.md'", // zsh only
    "$'\\M-APPROVAL.md'", // zsh only
    "$'\\xc3\\x81PPROVAL.md'", // a byte outside ASCII
    "$'\\u00c1PPROVAL.md'", // a character outside ASCII
    "$'APPROVAL.md\\0'.bak", // bash ends the quote at the NUL, zsh the path
    "$'APPROVAL.md\\x00'",
    "$'APPROVAL.md\\400'",
  ]) {
    const head = classesOf(`cp notes.txt ${spelling}`);
    assert.ok(head.includes("policy.core"), `${spelling}: ${head.join(",")}`);
  }
  // The `.git` reading of #680 still reads a NUL both ways.
  assert.ok(classesOf("echo x > $'.g\\0junk'it/config").includes("vcs.history.rewrite"));
});

test("a `\\'` inside `$'…'` does not end it: the words after the quote are commands", () => {
  // bash and zsh run `rm` here (lab, bash 3.2 and zsh 5.9); main read one `echo` word.
  assert.deepEqual(mainClasses("echo $'\\'' ; rm -rf APPROVAL.md #'"), ["read.shell"]);
  assert.ok(classesOf("echo $'\\'' ; rm -rf APPROVAL.md #'").includes("policy.core"));
  assert.ok(classesOf("echo $'\\'' ; echo x > APPROVAL.md #'").includes("policy.core"));
  // An apostrophe in a dollar quote: main could not read the line, and it stays refused.
  const apostrophe = classifyCommand("echo $'it\\'s' > notes.txt", []);
  assert.ok(!apostrophe.ok && apostrophe.code === "unparseable");
  assert.ok(!classifyCommandWithDollarQuotesKept("echo $'it\\'s' > notes.txt", []).ok);
});

test("the verb: a dollar-quoted program answers as the plain one, or the line is refused", () => {
  for (const command of ["$'rm' -rf x", "$'\\x67it' push", "$'git' push --force", '$"rm" x']) {
    const result = classifyCommand(command, []);
    if (result.ok) {
      const plain = command.replace(/\$'\\x67it'/u, "git").replace(/\$'([a-z]+)'/u, "$1").replace(/\$"([a-z]+)"/u, "$1");
      for (const cls of classesOf(plain)) assert.ok(result.classes.includes(cls), `${command}: ${cls}`);
    } else {
      assert.equal(result.code, "unclassified", command);
    }
  }
});

test("ordinary lines keep main's answer", () => {
  for (const command of [
    "git commit -m $'fix\\n\\nbody'",
    "echo $'a\\tb' > notes.txt",
    "printf $'%s\\n' x",
    "grep $'\\t' f",
    "IFS=$'\\n'",
    "echo \"$'x'\" > notes.txt", // not a quoting inside "…"
    "echo \\$'APPROVAL.md' > notes.txt", // an escaped `$`
    "cat <<E\n$'\\x41PPROVAL.md'\nE", // a heredoc body
    "echo x # $'\\x41PPROVAL.md'", // a comment
    "echo $$'x' > notes.txt", // the pid, then a quote
    "sort -t $'\\t' -k2 notes.txt",
    "echo $'\\e[1m'bold$'\\e[0m'",
  ]) {
    assert.deepEqual(classesOf(command), mainClasses(command), command);
  }
});

test("a double-quoted text in `$\"…\"` keeps its expansions unknown", () => {
  // `$X` inside it is a variable, as inside "…": the copy target is unknown.
  assert.ok(classesOf('cp notes.txt $"$X.md"').includes("policy.core"));
  assert.ok(classesOf('cat $".approval/$F"').length > 0);
});

test("through the hook: the policy file spelled as a dollar quote is not a workspace write alone", () => {
  const cwd = mkdtempSync(join(tmpdir(), "approval-md-dollar-quote-"));
  try {
    for (const command of ["echo x >> $'\\x41PPROVAL.md'", "echo x > $\"APPROVAL.md\"", "tee $'APPROVAL.md'"]) {
      const refined = classifyForHook(command, [], cwd);
      assert.ok(refined.result.ok, command);
      if (refined.result.ok) assert.ok(refined.result.classes.includes("policy.core"), `${command}: ${refined.result.classes.join(",")}`);
    }
    // Main's answer rides beside through the hook too: a copy to a decoded workspace
    // name keeps main's fail-closed class for the target it could not read.
    const copy = classifyForHook("cp notes.txt $'b.txt'", [], cwd);
    assert.ok(copy.result.ok && copy.result.classes.includes("policy.core"), JSON.stringify(copy.result));
    const removed = classifyForHook("rm $'\\x41PPROVAL.md'", [], cwd);
    assert.ok(removed.result.ok && removed.result.classes.includes("files.delete.out_of_scope") && removed.result.classes.includes("policy.core"));
    // The hook's own passes run in both readings too: main's credential pass read the unknown
    // spans of `$.claude/$settings.json` as a credential once resolved, and that class stays.
    const spans = classifyForHook("cat $'.claude/'$\"settings.json\"", [], cwd);
    assert.ok(spans.result.ok && spans.result.classes.includes("account.credential"), JSON.stringify(spans.result));
    const read = classifyForHook("cat $'.approval/\\x65nv'", [], cwd);
    assert.ok(read.result.ok && read.result.classes.includes("account.credential"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cost: 100 KB of dollar quotes is read in time; past the bound the rest of the word is unknown", () => {
  // Measured on a laptop, best of five, through the hook: 0.12 s for each of these
  // (main 0.02 to 0.05 s); 4.7 s for the unread word with the bound removed.
  // CPU seconds, stretched by this runner's measured factor (`tests/cost-runner.ts`).
  const cwd = mkdtempSync(join(tmpdir(), "approval-md-dollar-quote-cost-"));
  try {
    const bound = scaledBound(1);
    for (const [label, command] of [
      ["one word of quotes", `cp a ${"$'\\x41'".repeat(14_000)}`],
      ["one quote of escapes", `cp a $'${"\\x41".repeat(24_000)}'`],
      ["one quote of unread escapes", `cp a $'${"a\\q".repeat(33_000)}'`],
      ["3,000 words", `echo ${Array.from({ length: 3000 }, (_, i) => `$'w\\x41${String(i)}'`).join(" ")} > out.txt`],
    ] as const) {
      assert.ok(command.length <= 100_000, label);
      let classes: string[] = [];
      const seconds = cpuSeconds(() => {
        const result = classifyForHook(command, [], cwd).result;
        classes = result.ok ? result.classes : [];
      });
      assert.ok(seconds < bound, `${label}: ${seconds.toFixed(3)} CPU s, bound ${bound.toFixed(2)} (${runner().line})`);
      assert.ok(classes.length > 0, label);
    }
    // Past the bound the word is unknown: a copy to it keeps the fail-closed class.
    const many = `cp notes.txt $'${"a\\q".repeat(40)}APPROVAL.md'`;
    assert.ok(classesOf(many).includes("policy.core"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
