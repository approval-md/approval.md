/**
 * `date` reads the clock; it never sets it (APRV-508).
 *
 * Hosted agents could not tell the time: `date` fell to `unclassified`, and the
 * `python3 -c` fallback is opaque. The fix is a SHAPE row: only the display
 * forms match it, and every setting form keeps the refusal it had.
 *
 * What this suite pins:
 *
 * 1. every display form an agent types is `read.shell` under `date-read`;
 * 2. every setting form, and everything the parse cannot read literally, stays
 *    `unclassified` (the answer it had before the row existed);
 * 3. `-r FILE` is a stat, and is treated as `stat FILE` is: a credential path
 *    is `account.credential`, and the file is a read-scope target;
 * 4. the zone and locale assignments are admitted, and no other assignment is;
 * 5. `timedatectl` and `python3 -c` are not widened.
 *
 * Pure: no disk, no clock, no log.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyCommand } from "../src/core/command-class.js";
import { parseDateDisplay } from "../src/core/date-argv.js";
import { READ_OUT_OF_SCOPE_CLASS, readTargetsOf } from "../src/core/read-scope.js";

function classified(command: string, roots?: readonly string[]): { class: string; rule: string; path?: string } {
  const result = classifyCommand(command, [], roots === undefined ? {} : { readRoots: roots });
  assert.equal(
    result.ok,
    true,
    `expected ${JSON.stringify(command)} to classify, got ${result.ok ? "" : `${result.code}: ${result.detail}`}`,
  );
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.segments.length, 1, command);
  return result.segments[0] as { class: string; rule: string; path?: string };
}

// ---------------------------------------------------------------------------
// 1. The display forms
// ---------------------------------------------------------------------------

const DISPLAY: readonly string[] = [
  "date",
  "date +%s",
  "date '+%Y-%m-%d %H:%M:%S %Z'",
  'date "+%A, %B %d"',
  "date -u",
  "date --utc",
  "date --universal +%FT%TZ",
  "date -R",
  "date --rfc-2822",
  "date --rfc-email",
  "date -I",
  "date -Iseconds",
  "date -Ins",
  "date --iso-8601",
  "date --iso-8601=minutes",
  "date --rfc-3339=seconds",
  "date --rfc-3339 date",
  "date -d tomorrow",
  "date -d 'next monday' +%F",
  "date -d@1760000000",
  "date -d '-1 day' +%F",
  "date --date=@0",
  "date --date '2026-10-12 09:00 IST' -u",
  "date -uR",
  "date -ud @0",
  "date -uIseconds",
  "date +%s -u",
  "TZ=Asia/Kolkata date",
  "TZ=UTC date -R",
  "LC_ALL=C TZ=Europe/Paris date '+%c'",
  "LANG=en_US.UTF-8 date",
  "/bin/date -u",
  "date -r README.md",
  "date -ur README.md +%s",
  "date --reference README.md",
];

for (const command of DISPLAY) {
  test(`APRV-508: ${command} is read.shell under date-read`, () => {
    const segment = classified(command);
    assert.equal(segment.class, "read.shell");
    assert.equal(segment.rule, "date-read");
  });
}

test("APRV-508: date in a pipeline or a list reads as its neighbours do", () => {
  const result = classifyCommand("date -u && date +%s | cut -c1-5");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.classes, ["read.shell"]);
  assert.deepEqual(
    result.segments.map((segment) => segment.rule),
    ["date-read", "date-read", "read-shell"],
  );
});

test("APRV-508: a date redirected into a file is a write, as any read is", () => {
  assert.equal(classified("date -u > stamp.txt").class, "files.write.workspace");
  assert.equal(classified("date -u 2>/dev/null").class, "read.shell");
});

test("APRV-508: a read-only substitution inside an ASSIGNMENT leaves the row matched", () => {
  // The substitution is classified on its own, and only a read may run there.
  assert.equal(classified('TZ="$(cat .tz)" date').rule, "date-read");
});

// ---------------------------------------------------------------------------
// 2. The setting forms, and what cannot be read literally
// ---------------------------------------------------------------------------

const REFUSED: ReadonlyArray<readonly [string, string]> = [
  ["date -s '2020-01-01 00:00'", "sets the clock"],
  ["date -s now", "sets the clock"],
  ["date --set='2020-01-01'", "sets the clock"],
  ["date --set '2020-01-01'", "sets the clock"],
  ["date -us now", "-s inside a cluster"],
  ["date -su now", "-s inside a cluster, value attached"],
  ["date 010112002020", "a bare MMDDhhmmCCYY operand sets the clock (GNU and BSD)"],
  ["date 0101120020.30", "with seconds"],
  ["date 1012", "a short MMDD-shaped operand"],
  ["date -u 101209002026", "a setting operand behind a display flag"],
  ["date +%s 101209002026", "a second operand"],
  ["date +%s +%F", "two formats is an extra operand"],
  ["date -d now 101209002026", "an operand after a -d value"],
  ["date -I seconds", "-I's value is optional, so a separate word is an operand"],
  ["date --iso-8601 seconds", "the same for the long form"],
  ["date -f dates.txt", "-f reads a file's lines and echoes the bad ones"],
  ["date --file=dates.txt", "the long form"],
  ["date --file dates.txt", "the long form, separate value"],
  ["date --reference=README.md", "the =-attached reference hides FILE from the credential and scope checks"],
  ["date -rREADME.md", "the attached short reference, the same"],
  ["date -r -x", "a flag-shaped reference"],
  ["date -r", "a reference with no file"],
  ["date -d", "a date flag with no value"],
  ["date --date", "the long form with no value"],
  ["date --rfc-3339", "a required value missing"],
  ["date --se=2020-01-01", "getopt abbreviation of --set: only exact names are read"],
  ["date --da=tomorrow", "an abbreviation even of a display flag"],
  ["date --debug", "not a display form this row names"],
  ["date --help", "not a display form this row names"],
  ["date --version", "not a display form this row names"],
  ["date -j -f %s 0", "BSD parse forms stay out"],
  ["date -v+1d", "BSD adjust stays out"],
  ["date -- +%s", "a bare -- is not read"],
  ["date -", "a lone dash is an operand"],
  ["date +$FMT", "an unquoted expansion may split into flags"],
  ['date "$WHEN"', "an expansion this file cannot read"],
  ["date -d $(cat when.txt)", "a substituted word is a hole in the text"],
  ['date -d "$(cat when.txt)"', "quoted, the same"],
  ["date {-s,now}", "brace expansion writes flags"],
  ["date -d *", "a glob may expand to a flag-shaped file name"],
  ["date +%s?", "glob characters anywhere"],
  ["LD_PRELOAD=./x.so date", "an assignment that loads code"],
  ["PATH=. date", "an assignment that picks a different date"],
  ["TZ=UTC PATH=. date", "one foreign name among admitted ones declines the row"],
];

for (const [command, why] of REFUSED) {
  test(`APRV-508: ${command} stays unclassified (${why})`, () => {
    const result = classifyCommand(command);
    assert.equal(result.ok, false, `${command} classified, expected a refusal`);
    if (result.ok) return;
    assert.equal(result.code, "unclassified", `${command}: ${result.detail}`);
    assert.match(result.detail, /^no rule for date/u);
  });
}

test("APRV-508: one setting segment refuses the whole line", () => {
  const result = classifyCommand("date -u && date -s now");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "unclassified");
});

test("APRV-508: sudo date stays a refusal of its own", () => {
  const result = classifyCommand("sudo date -s now");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "opaque");
});

// ---------------------------------------------------------------------------
// 3. -r FILE is a stat, treated as stat is
// ---------------------------------------------------------------------------

test("APRV-508: date -r and stat agree on a credential path", () => {
  for (const command of ["date -r ~/.hermes/.env", "date --reference .approval/env", "stat ~/.hermes/.env"]) {
    const segment = classified(command);
    assert.equal(segment.class, "account.credential", command);
    assert.equal(segment.rule, "credential-path", command);
  }
});

test("APRV-508: a secret-named variable is a credential touch before the shape is asked", () => {
  const segment = classified("date -d $APPROVAL_TG_TOKEN");
  assert.equal(segment.class, "account.credential");
  assert.equal(segment.rule, "credential-env");
});

test("APRV-508: date -r and stat agree on the read scope", () => {
  const roots = ["/work", "/private/tmp"];
  for (const command of ["date -r /etc/hosts", "date -ur /etc/hosts +%s", "stat /etc/hosts"]) {
    const segment = classified(command, roots);
    assert.equal(segment.class, READ_OUT_OF_SCOPE_CLASS, command);
    assert.equal(segment.path, "/etc/hosts", command);
  }
  assert.equal(classified("date -r /work/README.md", roots).class, "read.shell");
});

test("APRV-508: a date naming no reference reads no file, under any roots", () => {
  const roots = ["/work"];
  for (const command of ["date", "date -d /etc/hosts", "date +/etc/hosts", "date -u -d tomorrow +%F"]) {
    const segment = classified(command, roots);
    assert.equal(segment.class, "read.shell", command);
    assert.equal(segment.rule, "date-read", command);
  }
});

test("APRV-508: readTargetsOf names the reference and nothing else", () => {
  // `null` is "not a scoped reader": the hook's disk pass leaves the segment
  // alone, and does NOT check the working directory in its place.
  assert.equal(readTargetsOf("date", [], []), null);
  assert.equal(readTargetsOf("date", ["tomorrow", "+%F"], ["-d", "tomorrow", "+%F"]), null);
  assert.deepEqual(readTargetsOf("date", ["/etc/hosts"], ["-r", "/etc/hosts"]), ["/etc/hosts"]);
  assert.deepEqual(
    readTargetsOf("/bin/date", ["now", "a.txt", "+%s"], ["-d", "now", "--reference", "a.txt", "+%s"]),
    ["a.txt"],
  );
});

// ---------------------------------------------------------------------------
// 5. Not widened
// ---------------------------------------------------------------------------

test("APRV-508: timedatectl and python3 -c keep their answers", () => {
  const timedatectl = classifyCommand("timedatectl status");
  assert.equal(timedatectl.ok, false);
  if (!timedatectl.ok) assert.equal(timedatectl.code, "unclassified");
  const python = classifyCommand("python3 -c 'import datetime; print(datetime.datetime.now())'");
  assert.equal(python.ok, false);
  if (!python.ok) assert.equal(python.code, "opaque");
});

// ---------------------------------------------------------------------------
// The parser on its own
// ---------------------------------------------------------------------------

test("APRV-508: parseDateDisplay follows getopt on value-taking flags", () => {
  // A required value is the next word whatever it looks like.
  assert.deepEqual(parseDateDisplay(["-d", "-s"]), { references: [] });
  assert.deepEqual(parseDateDisplay(["--date", "--set"]), { references: [] });
  // An optional value is attached or absent.
  assert.equal(parseDateDisplay(["--iso-8601", "seconds"]), null);
  assert.deepEqual(parseDateDisplay(["--iso-8601=seconds"]), { references: [] });
  // References come back in order.
  assert.deepEqual(parseDateDisplay(["-r", "a", "--reference", "b"]), { references: ["a", "b"] });
});
