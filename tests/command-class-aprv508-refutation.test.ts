/**
 * The PR #636 refutation findings (APRV-508), pinned.
 *
 * M1: `>&WORD` with a WORD that is not a descriptor writes the file WORD
 * (bash reads it as `>WORD 2>&1`). The lexer used to skip it as a dup, so
 * `paste a >& APPROVAL.md` read as `read.shell`. Now the word is read in full:
 * digits with an optional `-`, or a lone `-`, is a dup or close; anything else
 * after `>&` is a write redirection, and after `<&` a refusal.
 *
 * S1: a bare assignment of a variable that steers which program runs or which
 * file is read (`TZ=/etc/x; date`, `PATH=/tmp/x; cat f`) is not a read.
 * S2: a `TZ=` inside a `-d` string is matched case-insensitively.
 * S3: `test`/`[` refuse a `-v`/`-R` operand carrying `[` (bash evaluates the
 * subscript, `$(…)` included) and an unquoted substitution.
 * S4: `seq` prints at most 100,000 values, and never an endless run.
 *
 * Pure: no disk, no clock, no log.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyCommand } from "../src/core/command-class.js";

function classesOf(command: string): string[] | string {
  const result = classifyCommand(command);
  return result.ok ? result.classes : `refused:${result.code}`;
}

// -- M1 ---------------------------------------------------------------------

const DUP_TO_FILE: ReadonlyArray<readonly [string, string]> = [
  ["paste /dev/null >& APPROVAL.md", "policy.core"],
  ["paste /dev/null >& .approval/policy.yml", "policy.core"],
  ["[ -f x ] >& APPROVAL.md", "policy.core"],
  ["cat /dev/null >& APPROVAL.md", "policy.core"],
  ["test -f x >& out", "files.write.workspace"],
  ["date >& +x", "files.write.workspace"],
  ["date >&+notes", "files.write.workspace"],
  ["seq 1 >&10.5", "files.write.workspace"],
  ["paste a >&1x", "files.write.workspace"],
  ["ls >&$fd", "files.write.workspace"],
];

for (const [command, cls] of DUP_TO_FILE) {
  test(`refutation M1: ${command} writes, it does not read`, () => {
    assert.deepEqual(classesOf(command), [cls], command);
  });
}

test("refutation M1: real descriptor dups and closes are unmoved", () => {
  for (const command of ["ls 2>&1", "ls >&2", "ls 2>&-", "ls >&-", "ls 3<&0", "ls 2>&1 | head", "date -u 2>&1", "ls >& /dev/null", "ls 2>& 1"]) {
    assert.deepEqual(classesOf(command), ["read.shell"], command);
  }
});

test("refutation M1: <& with a word that is not a descriptor is refused", () => {
  assert.equal(classesOf("cat <&notes"), "refused:unparseable");
  assert.equal(classesOf("cat <&"), "refused:unparseable");
  assert.equal(classesOf("cat >&"), "refused:unparseable");
});

// -- S1 ---------------------------------------------------------------------

test("refutation S1: a bare steering assignment is not a read", () => {
  for (const command of [
    "TZ=/etc/x; date",
    "TZDIR=/tmp; date",
    "LC_ALL=/tmp/x; date",
    "LANG=/tmp/x; date",
    "LANGUAGE=x; date",
    "PATH=/tmp/x; cat f",
    "LD_PRELOAD=./x.so; cat f",
    "LD_LIBRARY_PATH=/tmp; ls",
    "LOCPATH=/tmp; date",
    "GCONV_PATH=/tmp; date",
  ]) {
    assert.equal(classesOf(command), "refused:unclassified", command);
  }
  // Ordinary assignments still read.
  for (const command of ["NOW=$(date +%s)", "X=1; echo $X", "START=$(date -u +%FT%TZ) && echo $START"]) {
    assert.deepEqual(classesOf(command), ["read.shell"], command);
  }
});

// -- S2 ---------------------------------------------------------------------

test("refutation S2: a lowercase tz= path inside -d is refused", () => {
  for (const command of ["date -d 'tz=\"/etc/x\" now'", "date -d 'Tz=\"/etc/x\" now'", "date --date='tz=/etc/x now'"]) {
    assert.equal(classesOf(command), "refused:unclassified", command);
  }
  assert.deepEqual(classesOf("date -d 'tz=\"Asia/Kolkata\" 09:00'"), ["read.shell"]);
});

// -- S3 ---------------------------------------------------------------------

test("refutation S3: test and [ refuse an array subscript under -v/-R", () => {
  for (const command of [
    "test -v 'a[$(id)]'",
    "[ -v 'a[$(id)]' ]",
    "[ -v 'a[1]' ]",
    "test -R 'r[0]'",
  ]) {
    assert.equal(classesOf(command), "refused:unclassified", command);
  }
  for (const command of ["test -v HOME", "[ -v HOME ]", "[ -f README.md ]", 'test "$(date +%u)" -gt 5']) {
    assert.deepEqual(classesOf(command), ["read.shell"], command);
  }
});

test("refutation S3: test and [ refuse an unquoted substitution, whose output the shell splits", () => {
  for (const command of ["[ $(date +%u) -gt 5 ]", "test $(cat notes)"]) {
    assert.equal(classesOf(command), "refused:unclassified", command);
  }
});

// -- S4 ---------------------------------------------------------------------

test("refutation S4: seq is capped at 100,000 values and never runs forever", () => {
  for (const command of ["seq 100000", "seq 0 0.5 10", "seq 10 -1 1", "seq 5 1"]) {
    assert.deepEqual(classesOf(command), ["read.shell"], command);
  }
  for (const command of ["seq 100001", "seq 1e18", "seq 1 0 5", "seq -1e9 1e9", "seq 0 0.000001 1"]) {
    assert.equal(classesOf(command), "refused:unclassified", command);
  }
});
