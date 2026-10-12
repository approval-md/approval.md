/**
 * The system-information readers (APRV-508).
 *
 * `uptime`, `whoami`, `hostname`, `df`, `free`, `seq` and `paste` are `read.shell`
 * in their display forms, each through a strict allow-grammar
 * (`src/core/sysinfo-argv.ts`), and `unclassified` in every other form: the
 * answer they had before. The case that matters most is `hostname NAME`,
 * which SETS the host name.
 *
 * Pure: no disk, no clock, no log. The real tools are compared in
 * `tests/command-class-differential.test.ts`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyCommand } from "../src/core/command-class.js";
import { READ_OUT_OF_SCOPE_CLASS, readTargetsOf } from "../src/core/read-scope.js";

const ALLOWED: ReadonlyArray<readonly [string, string]> = [
  ["uptime", "sysinfo-read"],
  ["uptime --version", "sysinfo-read"],
  ["whoami", "sysinfo-read"],
  ["/usr/bin/whoami", "sysinfo-read"],
  ["hostname", "hostname-read"],
  ["hostname -s", "hostname-read"],
  ["hostname -f", "hostname-read"],
  ["hostname -d", "hostname-read"],
  ["hostname -i", "hostname-read"],
  ["hostname -I", "hostname-read"],
  ["hostname --fqdn", "hostname-read"],
  ["df", "df-read"],
  ["df -h", "df-read"],
  ["df -hT", "df-read"],
  ["df -h --total", "df-read"],
  ["free", "free-read"],
  ["free -h", "free-read"],
  ["free -m -t", "free-read"],
  ["seq 5", "seq-read"],
  ["seq 1 5", "seq-read"],
  ["seq 0 2 10", "seq-read"],
  ["seq -5 5", "seq-read"],
  ["seq -w 1 10", "seq-read"],
  ["seq -s , 1 3", "seq-read"],
  ["seq --separator=' ' 1 3", "seq-read"],
  ["seq -f '%03g' 1 3", "seq-read"],
  ["seq --format=%.2f 0 0.5 2", "seq-read"],
  ["paste a.txt b.txt", "paste-read"],
  ["paste -d, a.txt b.txt", "paste-read"],
  ["paste --delimiters=: a.txt", "paste-read"],
  ["paste -s a.txt", "paste-read"],
  ["paste -s -", "paste-read"],
];

for (const [command, rule] of ALLOWED) {
  test(`APRV-508: ${command} is read.shell under ${rule}`, () => {
    const result = classifyCommand(command);
    assert.equal(result.ok, true, result.ok ? "" : `${command}: ${result.code} ${result.detail}`);
    if (!result.ok) return;
    assert.equal(result.segments[0]?.class, "read.shell", command);
    assert.equal(result.segments[0]?.rule, rule, command);
  });
}

const REFUSED: ReadonlyArray<readonly [string, string]> = [
  // hostname: a positional SETS the host name.
  ["hostname newname", "a positional sets the host name"],
  ["hostname -s newname", "a display flag does not make an operand safe"],
  ["hostname -- newname", "-- then the new name"],
  ["hostname -F /etc/hostname", "-F sets it from a file"],
  ["hostname --file=/etc/hostname", "the long form"],
  ["hostname --fi=/etc/hostname", "an abbreviation of --file"],
  ["hostname -b newname", "-b sets it at boot"],
  ["hostname --boot", "the long form"],
  ["hostname -sf", "a cluster this grammar does not list"],
  ["hostname -s -f", "one display flag at a time"],
  ["hostname --fq", "an abbreviation"],
  ["hostname $NAME", "a word the shell expands"],
  ["./hostname", "a binary in the working directory"],
  ["LD_PRELOAD=./x.so hostname", "an assignment in front"],
  // uptime / whoami.
  ["uptime /var/log/wtmp", "uptime FILE reads that utmp file"],
  ["uptime -p", "not in the grammar"],
  ["uptime --", "-- is never accepted"],
  ["whoami root", "an operand"],
  ["TZ=UTC uptime", "no assignment rides in front of these"],
  // df / free.
  ["df /", "a path operand is a read the grammar leaves out"],
  ["df -h /etc", "the same behind a flag"],
  ["df --output=source", "--output is not in the grammar"],
  ["df -t ext4", "a type filter is not in the grammar"],
  ["df -hP", "a cluster this grammar does not list"],
  ["df --hu", "an abbreviation"],
  ["df --", "-- is never accepted"],
  ["free -s 1", "-s repeats the report forever"],
  ["free -c 3", "-c repeats it"],
  ["free --seconds=1", "the long form"],
  ["free -hs 1", "a cluster carrying -s"],
  ["free x", "an operand"],
  // seq.
  ["seq", "no number"],
  ["seq 1 2 3 4", "four numbers"],
  ["seq 0x10", "hex is not in the grammar"],
  ["seq inf", "inf is not in the grammar"],
  ["seq -s", "a separator flag with no value"],
  ["seq -s -x 1 3", "a flag-shaped separator"],
  ["seq -s, 1 3", "an attached separator"],
  ["seq -f %s 1 3", "a format that is not a single float directive"],
  ["seq -f '%g %g' 1 3", "two directives"],
  ["seq -f %n 1 3", "%n is not a float directive"],
  ["seq --f=%g 1", "an abbreviation"],
  ["seq -- 1 3", "-- is never accepted"],
  ["seq 1 $N", "a word the shell expands"],
  ["seq {1..3}", "brace expansion"],
  // paste.
  ["paste -d , a.txt b.txt", "a separate delimiter would be taken for a file"],
  ["paste --delimiters , a.txt", "the long form, separate"],
  ["paste --serial=x a.txt", "an = on a flag that takes none"],
  ["paste -- a.txt", "-- is never accepted"],
  ["paste --de=, a.txt", "an abbreviation"],
  ["paste -x a.txt", "a flag not in the grammar"],
  ["paste *.txt", "a glob"],
];

for (const [command, why] of REFUSED) {
  test(`APRV-508: ${command} stays unclassified (${why})`, () => {
    const result = classifyCommand(command);
    assert.equal(result.ok, false, `${command} classified, expected a refusal`);
    if (result.ok) return;
    assert.equal(result.code, "unclassified", `${command}: ${result.detail}`);
  });
}

test("APRV-508: paste's files are read targets exactly as cat's are", () => {
  const roots = ["/work"];
  for (const [paste, cat] of [
    ["paste /etc/hosts", "cat /etc/hosts"],
    ["paste -d, /work/a /etc/hosts", "cat /work/a /etc/hosts"],
  ] as const) {
    const a = classifyCommand(paste, [], { readRoots: roots });
    const b = classifyCommand(cat, [], { readRoots: roots });
    assert.equal(a.ok && b.ok, true);
    if (!a.ok || !b.ok) return;
    assert.equal(a.segments[0]?.class, READ_OUT_OF_SCOPE_CLASS, paste);
    assert.equal(a.segments[0]?.class, b.segments[0]?.class, paste);
    assert.equal(a.segments[0]?.path, b.segments[0]?.path, paste);
  }
  assert.deepEqual(readTargetsOf("paste", ["a", "-"], ["-d,", "a", "-"]), ["a", "-"]);
  const credential = classifyCommand("paste ~/.hermes/.env");
  assert.equal(credential.ok, true);
  if (credential.ok) assert.equal(credential.segments[0]?.class, "account.credential");
});

test("APRV-508: the system readers inside $(…) and pipelines", () => {
  for (const command of [
    'echo "$(whoami)@$(hostname -s) up $(uptime)"',
    "df -h | tail -n +2",
    "seq 1 3 | paste -s -d+ -",
  ]) {
    const result = classifyCommand(command);
    assert.equal(result.ok, true, result.ok ? "" : `${command}: ${result.detail}`);
    if (result.ok) assert.deepEqual(result.classes, ["read.shell"], command);
  }
  const set = classifyCommand('echo "$(hostname newname)"');
  assert.equal(set.ok, false);
});
