/**
 * Dollar-quoted words (lead ruling CLAIMS L62542): `$'…'` and `$"…"` are read
 * as the text the shell makes of them.
 *
 * On main 48787b8f the lexer kept the `$` and read the quote after it, so
 * `echo x >> $'\x41PPROVAL.md'` was a write to the unknown variable
 * `$\x41PPROVAL.md`, a workspace write, and the hook allowed it under a policy
 * where workspace writes run on their own: bash and zsh write the policy file.
 * The lexer now decodes `$'…'` where bash (3.2 and 5) and zsh decode alike,
 * and `\uH…` and `\UH…` where the character is ASCII, as zsh 5.9 (and bash
 * 4.2 on) reads them; bash 3.2 keeps those as written, and main's reading,
 * beside, reads them as written too (review of b58db9ec, S3). It reads `$"…"`
 * as `"…"`, and leaves anything else unknown, the way `$X` is: an unknown
 * part may be empty, and the word goes on after the quote (M1).
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
    // Review of b58db9ec (M1): an unknown part is the rest of its QUOTE at
    // most, and the word goes on after it.
    ["$'a\\cAb'c", `a${U}bc`], // \cA is one part; the quote goes on (review of fe0a101a, M1)
    ["$'a\\U00000041b'", "aAb"],
    ["$'a\\U41'b", "aAb"],
    ["$'a\\U41b'", `a${U}`], // U+041B: outside ASCII
    ["$'a\\U2e'c", "a.c"],
    ["$'a\\u41'b", "aAb"],
    ["$'a\\u41b'", `a${U}`], // U+041B
    ["$'\\u2e'approval", ".approval"],
    ["$'a\\u0'c", "ac"], // a NUL: bash ends the quote there
    ["$'a\\xgb'c", `a${U}gbc`],
    ["$'a\\C-ab'c", `a${U}bc`],
    ["$'a\\M-ab'c", `a${U}bc`],
    ["$'a\\c\\\\b'c", `a${U}\${__APPROVAL_REST__}`], // a backslash after \c: the shells part (review of 83b52249, M1)
    ["$'a\\M-\\x41b'c", `a${U}Abc`], // after \M- the next escape is decoded
    ["$'a\\x{41}b'c", "aAbc"], // bash 3.2's braced hex, decoded as bash reads it (L63099; review of 7c1c2b06, M1)
    ["$'a\\x{e9}b'c", `a${U}bc`], // a byte past ASCII is one unread part
    ["$'a\\x{0041z'c", "aAzc"], // the brace is optional; the digits run on, the low byte kept
    ["$'a\\x{}b'c", `a${U}\${__APPROVAL_REST__}`], // no digit: bash's NUL
    ["$'a\\x{100}b'c", `a${U}\${__APPROVAL_REST__}`], // a low byte of 0: bash's NUL
    ["$'\\conformance/../\\x2eapproval/env'", `${U}nformance/../.approval/env`],
    ["$'a\\xc3\\xa9b'", `a${U}b`],
    ["$'a\\u00e9b'", `a${U}b`],
    ["$'a\\0b'c", "ac"],
    ["$'a\\x00b'c", "ac"],
    ["$'a\\400b'c", "ac"],
    ["$'\\0'.approval/env", ".approval/env"],
    ["x$'a'$'b'\"c\"'d'", "xabcd"],
    [`$'${"\\q".repeat(40)}'tail`, `${U}tail`], // one unread run
    // Past 32 placeholders the rest of the word is unknown to every reader (M3).
    [`$'${"a\\q".repeat(40)}'tail`, `${`a${U}`.repeat(32)}a\${__APPROVAL_REST__}`],
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
  // Read as zsh and bash 4.2 read it; bash 3.2's reading as written is main's, beside.
  for (const spelling of ["$'\\U00000041PPROVAL.md'", "$'\\u41PPROVAL.md'"]) assert.ok(classesOf(`cp notes.txt ${spelling}`).includes("policy.core"), spelling);
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

test("review of b58db9ec (M1): a quote's unknown part ends at its quote, and the word goes on", () => {
  const cwd = mkdtempSync(join(tmpdir(), "approval-md-dollar-quote-m1-"));
  try {
    for (const [line, cls] of [
      ["cat $'\\0'.approval/env", "account.credential"],
      ["cat $'\\u2e'approval/env", "account.credential"],
      ["cat < $'\\0'.approval/env", "account.credential"],
      ["grep K $'\\0'.approval/env", "account.credential"],
      ["head -1 $'\\u2e'approval/env", "account.credential"],
      ["cat ./$'\\0'.approval/env", "account.credential"],
      ["cat src/$'\\u2e'approval/env", "account.credential"],
      ["cat src/$'\\0'.approval/env", "account.credential"],
      ["cat $'\\cA'.approval/env", "account.credential"],
      ["rm -f $'\\0'APPROVAL.md", "policy.core"],
      ["rm -f $'\\u41'PPROVAL.md", "policy.core"],
      ["echo x > $'\\0'APPROVAL.md", "policy.core"],
      ["tee $'\\0'APPROVAL.md", "policy.core"],
      ["touch $'\\0'APPROVAL.md", "policy.core"],
      ["sed -i s/a/b/ $'\\0'APPROVAL.md", "policy.core"],
      ["echo x >> $'\\0'.approval/log/events.jsonl", "log.mutate"],
      ["truncate -s0 $'\\0'.approval/log/events.jsonl", "log.mutate"],
      ["echo x > $'\\0'.claude/settings.json", "policy.core"],
      ["tee -a $'\\u2e'/$'\\x41PPROVAL.md'", "policy.core"],
      ["echo x > $'\\x'APPROVAL.md", "policy.core"],
      ["git reset $'\\u2d'-hard", "vcs.history.rewrite"],
      ["git commit $'\\u2d'-amend -m x", "vcs.history.rewrite"],
      ["gh pr $'\\u6d'erge 1", "vcs.push.main"],
      // Review of fe0a101a (M1): after \c, \C- or \M- the rest of the quote is read.
      ["cat $'\\conformance/../\\x2eapproval/env'", "account.credential"],
      ["cat < $'\\conformance/../\\x2eapproval/env'", "account.credential"],
      ["grep K $'\\conformance/../\\x2eapproval/env'", "account.credential"],
      ["cat $'\\c/../\\x2eapproval/env'", "account.credential"],
      ["cat src/$'\\c/../../\\x2eapproval/env'", "account.credential"],
      ["rm -f $'\\conformance/../\\x41PPROVAL.md'", "policy.core"],
      ["echo x > $'\\conformance/../\\x41PPROVAL.md'", "policy.core"],
      ["echo x >> $'\\conformance/../\\x2eapproval/log/events.jsonl'", "log.mutate"],
      ["tee $'\\conformance/../\\x2eclaude/settings.json'", "policy.core"],
      ["cat $'\\cX/../\\x2eapproval/env'", "account.credential"],
      ["cat $'\\C-a/../\\x2eapproval/env'", "account.credential"],
      ["cat $'\\M-a/../\\x2eapproval/env'", "account.credential"],
      // zsh ends the path at the NUL: APPROVAL.md; bash writes APPROVAL.md.bak.
      ["echo x > $'APPROVAL.md\\0'.bak", "policy.core"],
    ] as const) {
      assert.ok(classesOf(line).includes(cls), `${line}: ${classesOf(line).join(",")}`);
      const hook = classifyForHook(line, [], cwd).result;
      assert.ok(hook.ok && hook.classes.includes(cls), `${line} (hook): ${JSON.stringify(hook)}`);
    }
    // bash's \c@, \c` and \c<space> are a NUL that ends bash's quote, while zsh reads on:
    // the rest of the word is unknown to every reader, so the path's class or the strictest.
    for (const [line, cls] of [
      ["cat $'.approval/env\\c@x'", "account.credential"],
      ["echo x > $'APPROVAL.md\\c@junk'", "policy.core"],
      ["rm -f $'APPROVAL.md\\c`x'", "policy.core"],
      ["tee $'.claude/settings.json\\c x'", "policy.core"],
      // bash takes \c of a character's first UTF-8 byte (U+0801 starts 0xE0, a NUL): after \c,
      // any non-ASCII character ends the known text, whatever its first byte.
      ["echo x > $'APPROVAL.md\\c\u0801junk'", "policy.core"],
      ["echo x > $'APPROVAL.md\\c\u00e9junk'", "policy.core"],
      ["echo x > $'APPROVAL.md\\c\u{1F600}junk'", "policy.core"],
      // A backslash after \c parts them too: zsh reads c and decodes the escape (review of 83b52249, M1).
      ["rm -f $'\\c\\x2fAPPROVAL.md'", "policy.core"],
      ["rm -f $'\\c\\x2f.claude/settings.json'", "policy.core"],
      ["rm -f $'\\c\\x2f.approval/log/events.jsonl'", "log.mutate"],
      ["echo x > $'\\c\\057APPROVAL.md'", "policy.core"],
      ["echo x >> $'\\c\\u2f.approval/log/events.jsonl'", "log.mutate"],
      ["echo x > $'\\c\\x2f.github/workflows/ci.yml'", "policy.edit"],
      ["tee $'\\c\\x2f.claude/settings.json'", "policy.core"],
      ["cat $'\\c\\x2f.approval/env'", "account.credential"],
    ] as const) {
      const pure = classesOf(line);
      assert.ok(pure.includes(cls) || pure.includes("log.mutate"), `${line}: ${pure.join(",")}`);
      const hook = classifyForHook(line, [], cwd).result;
      assert.ok(hook.ok && (hook.classes.includes(cls) || hook.classes.includes("log.mutate")), `${line} (hook): ${JSON.stringify(hook)}`);
    }
    // bash 3.2 reads \x{H...} as the low byte of its digits (build-2's probe, L63099).
    for (const [line, cls] of [
      ["echo x > $'\\x{41}PPROVAL.md'", "policy.core"],
      ["echo x >> $'\\x{41}PPROVAL.md'", "policy.core"],
      ["tee $'\\x{41}PPROVAL.md'", "policy.core"],
      ["touch $'\\x{0041}PPROVAL.md'", "policy.core"],
      ["sed -i s/a/b/ $'\\x{41}PPROVAL.md'", "policy.core"],
      ["echo x > $'.claude\\x{2f}settings.json'", "policy.core"],
      ["cat $'.approval\\x{2f}env'", "account.credential"],
      ["echo x >> $'.approval/log/events.jsonl\\x{41'", "log.mutate"],
      // A word of braced escapes only is read as bash reads it (review of 7c1c2b06, M1).
      ["cat $'\\x{2e}\\x{61}\\x{70}\\x{70}\\x{72}\\x{6f}\\x{76}\\x{61}\\x{6c}\\x{2f}\\x{65}\\x{6e}\\x{76}'", "account.credential"],
      ["echo x > $'\\x{41}\\x{50}\\x{50}\\x{52}\\x{4f}\\x{56}\\x{41}\\x{4c}\\x{2e}\\x{6d}\\x{64}'", "policy.core"],
      ["rm -f $'\\x{2e}\\x{63}\\x{6c}\\x{61}\\x{75}\\x{64}\\x{65}\\x{2f}\\x{73}\\x{65}\\x{74}\\x{74}\\x{69}\\x{6e}\\x{67}\\x{73}\\x{2e}\\x{6a}\\x{73}\\x{6f}\\x{6e}'", "policy.core"],
    ] as const) {
      assert.ok(classesOf(line).includes(cls), `${line}: ${classesOf(line).join(",")}`);
      const hook = classifyForHook(line, [], cwd).result;
      assert.ok(hook.ok && hook.classes.includes(cls), `${line} (hook): ${JSON.stringify(hook)}`);
    }
    // A braced hex that is bash's NUL ends the known text: the path's class or the strictest.
    for (const [line, cls] of [
      ["echo x > $'\\x{}'APPROVAL.md", "policy.core"],
      ["echo x > $'\\x{100}junk'APPROVAL.md", "policy.core"],
      ["cat $'\\x{g}'.approval/env", "account.credential"],
    ] as const) {
      const pure = classesOf(line);
      assert.ok(pure.includes(cls) || pure.includes("log.mutate"), `${line}: ${pure.join(",")}`);
    }
    // After \C- or \M- a backslash is not taken: bash writes \C- as it is and decodes
    // the next escape, so the path below it takes its own class (review of 83b52249, M1).
    for (const [line, cls] of [
      ["rm -f $'\\M-\\x2fAPPROVAL.md'", "policy.core"],
      ["rm -f $'\\C-\\x2f.claude/settings.json'", "policy.core"],
      ["echo x > $'\\M-\\057APPROVAL.md'", "policy.core"],
      ["tee $'\\C-\\u2f.approval/log/events.jsonl'", "log.mutate"],
      ["echo x > $'\\M-\\x2f.github/workflows/ci.yml'", "policy.edit"],
      ["cat $'\\M-\\x2f.approval/env'", "account.credential"],
    ] as const) {
      assert.ok(classesOf(line).includes(cls), `${line}: ${classesOf(line).join(",")}`);
      const hook = classifyForHook(line, [], cwd).result;
      assert.ok(hook.ok && hook.classes.includes(cls), `${line} (hook): ${JSON.stringify(hook)}`);
    }
    // Past 32 unread parts the word could be any path: never lighter than one unread part.
    for (const [tail, cls] of [["APPROVAL.md", "policy.core"], [".approval/env", "account.credential"]] as const) {
      const verb = tail === "APPROVAL.md" ? "echo x >" : "cat";
      const one = classesOf(`${verb} $'\\q'${tail}`);
      assert.ok(one.includes(cls), `${verb} one: ${one.join(",")}`);
      for (const n of [32, 33, 40]) {
        const many = classesOf(`${verb} ${"$'\\q'a".repeat(n)}${tail}`);
        assert.ok(many.includes(cls) || many.includes("log.mutate"), `${verb} ${String(n)}: ${many.join(",")}`);
      }
    }
    assert.ok(classesOf(`echo x > ${"$'\\q'".repeat(33)}$'/../\\x41PPROVAL.md'`).some((cls) => cls === "policy.core" || cls === "log.mutate"));
    // A git or gh flag or subcommand holding an escape the shells read differently refuses.
    for (const line of ["git reset $'\\q'-hard", "gh pr $'\\q'erge 1", "git $'\\q'ush --force"]) {
      assert.equal(classifyCommand(line, []).ok, false, line);
    }
    // Ordinary dollar-quoted lines keep their answer.
    for (const line of ["git commit -m $'a\\n\\nb'", "printf $'%s\\n' x", "grep $'\\t' f", "sort -t $'\\t' -k1 f", "echo x > $'notes\\0junk'.md"]) {
      assert.deepEqual(classesOf(line), asPlainOrMain(line), line);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

/** The plain-spelled answer for the ordinary lines above. */
function asPlainOrMain(line: string): string[] {
  const plain: Record<string, string> = {
    "git commit -m $'a\\n\\nb'": "git commit -m x",
    "printf $'%s\\n' x": "printf x x",
    "grep $'\\t' f": "grep x f",
    "sort -t $'\\t' -k1 f": "sort -t x -k1 f",
    "echo x > $'notes\\0junk'.md": "echo x > notes.md",
  };
  return classesOf(plain[line] ?? line);
}

test("reviews of the M1 fix: where a dollar quote holds a NUL the line is read as zsh reads it too", () => {
  // zsh ends a path at the NUL: each reader sees zsh's word, the verb rules included.
  for (const [line, cls] of [
    ["tee $'APPROVAL.md\\0'x", "policy.core"],
    ["cp a $'.approval/env\\0'z", "account.credential"],
    ["sed -i s/a/b/ $'CLAUDE.md\\0'q", "policy.edit"],
    ["echo x > $'APPROVAL.md\\0'.bak", "policy.core"],
    ["git reset $'--hard\\0'x", "vcs.history.rewrite"],
    ["gh pr $'merge\\0'z 1", "vcs.push.main"],
  ] as const) {
    assert.ok(classesOf(line).includes(cls), `${line}: ${classesOf(line).join(",")}`);
  }
  // As zsh reads `-D`, the plain spelling's answer is there.
  for (const each of classesOf("git branch -D main")) assert.ok(classesOf("git branch $'-D\\0'q main").includes(each), each);
  // A prefix that is only a substitution's output: at least as strict as the substitution alone.
  for (const [line, alone] of [
    ["echo x > $(printf APPROVAL.md)$'\\0'junk", "echo x > $(printf APPROVAL.md)"],
    ["cat $(echo .approval/env)$'\\0'x", "cat $(echo .approval/env)"],
  ] as const) {
    const head = classifyCommand(line, []);
    const sub = classifyCommand(alone, []);
    if (!sub.ok) assert.equal(head.ok, false, line);
    else if (head.ok) for (const each of sub.classes) assert.ok(head.classes.includes(each), `${line}: ${each}`);
  }
});

test("review of b58db9ec (M3): repeated unread quotes in one word are linear, as main is", () => {
  const bound = scaledBound(1);
  const control = cpuSeconds(() => classifyCommand(`tee ${"a$'b'".repeat(17_000)}`, []));
  for (const [label, command] of [
    ["a$'\\q' repeated", `tee ${"a$'\\q'".repeat(16_000)}`],
    ["a$'\\0' repeated", `tee ${"a$'\\0'".repeat(16_000)}`],
    [".appr$'\\q' repeated", `cat ${".appr$'\\q'".repeat(9_000)}/env`],
  ] as const) {
    assert.ok(command.length <= 100_000, label);
    const seconds = cpuSeconds(() => classifyCommand(command, []));
    assert.ok(seconds < bound, `${label}: ${seconds.toFixed(3)} CPU s, bound ${bound.toFixed(2)}, control ${control.toFixed(3)} (${runner().line})`);
    assert.ok(seconds < Math.max(0.2, 8 * control), `${label}: ${seconds.toFixed(3)} CPU s against a control of ${control.toFixed(3)}`);
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
