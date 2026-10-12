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
 * 3. no form reads a file: `-f` and `-r` in every spelling, a zone or locale
 *    value that is a path, and a `TZ="…"` path inside a `-d` string all stay
 *    refused, so no `date` is a read the read scope would have to judge;
 * 4. the zone and locale assignments are admitted, and no other assignment is;
 * 5. `date` inside `$(…)` and pipelines classifies as the agents write it;
 * 6. `[` reads as `test` does;
 * 7. `timedatectl` and `python3 -c` are not widened.
 *
 * Pure: no disk, no clock, no log.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyCommand } from "../src/core/command-class.js";
import { isDateAssignment, isDateDisplay, isZoneValue } from "../src/core/date-argv.js";
import { readTargetsOf } from "../src/core/read-scope.js";

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
  "date --date=@0",
  "date --date '2026-10-12 09:00 IST' -u",
  "date -d 'TZ=\"Asia/Kolkata\" 09:00' +%R",
  "date -d '1 day ago' +%F",
  "date -u +%Y-%m-%dT%H:%M:%SZ",
  "date --debug -d tomorrow",
  "date --resolution",
  "date --help",
  "date -h",
  "date --version",
  "date -V",
  "date -uR",
  "date -ud @0",
  "date -uIseconds",
  "date +%s -u",
  "TZ=Asia/Kolkata date",
  "TZ=UTC date -R",
  "LC_ALL=C TZ=Europe/Paris date '+%c'",
  "LANG=en_US.UTF-8 date",
  "TZ=:Asia/Kolkata date",
  "TZ=Etc/GMT+5 date",
  "TZ=IST-5:30 date",
  "TZ= date",
  "/bin/date -u",
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
  ["date -r README.md", "-r reads a file's metadata; the row reads no file"],
  ["date -r /etc/shadow", "the same, outside every root"],
  ["date -ur README.md +%s", "-r inside a cluster"],
  ["date --reference README.md", "the long form"],
  ["date --reference=README.md", "the long form, attached"],
  ["date --ref=README.md", "an abbreviation of --reference"],
  ["date -rREADME.md", "the attached short form"],
  ["date -r=README.md", "clap's -r=FILE"],
  ["date -r", "a reference with no file"],
  ["date -uf dates.txt", "-f inside a cluster"],
  ["date --fi=dates.txt", "an abbreviation of --file"],
  ["date -d '-1 day' +%F", "a flag-shaped value: getopt takes it as the value, clap as a flag"],
  ["date -d -s now", "a flag-shaped value that clap would read as --set"],
  ["date --date -s", "the long form"],
  ["date --rfc-3339 -s", "the same for --rfc-3339"],
  ["date -d 'TZ=\"/etc/shadow\" now'", "a TZ path inside the date string opens that file"],
  ["date -d 'TZ=\":/etc/shadow\" now'", "the POSIX colon form"],
  ["date -d 'TZ=\"../../etc/shadow\" now'", "a climb out of the zone database"],
  ["date --date='TZ=/etc/shadow now'", "unquoted, attached"],
  ["TZ=/etc/shadow date", "a zone value that is an absolute path"],
  ["TZ=:/etc/shadow date", "the POSIX colon form"],
  ["TZ=../../../etc/shadow date", "a relative climb"],
  ["TZ=Asia/../../etc/shadow date", "a climb behind a real region"],
  ["TZ=~/zone date", "a home-relative path"],
  ["TZ=$ZONE date", "a value this file cannot read"],
  ["TZDIR=/tmp TZ=x date", "TZDIR moves the zone database"],
  ["LC_ALL=/tmp/loc date", "a locale value that is a path"],
  ["LANG=../x date", "a locale climb"],
  ["LOCPATH=/tmp date", "LOCPATH moves the locale database"],
  ["date -d", "a date flag with no value"],
  ["date --date", "the long form with no value"],
  ["date --rfc-3339", "a required value missing"],
  ["date --se=2020-01-01", "getopt abbreviation of --set: only exact names are read"],
  ["date --da=tomorrow", "an abbreviation even of a display flag"],
  ["date --u", "an abbreviation of --utc"],
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
// 3. No form reads a file
// ---------------------------------------------------------------------------

test("APRV-508: a credential path in a date argv is still a credential touch", () => {
  // The credential tier answers before any row is matched, so a refused
  // reference to a credential file is named for what it touches.
  for (const command of ["date -r ~/.hermes/.env", "date --reference .approval/env"]) {
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

test("APRV-508: date is not a scoped reader, and stays read.shell under any roots", () => {
  // No admitted form opens a file, so there is nothing for the read scope to
  // judge: `null` means the hook's disk pass leaves the segment alone and does
  // NOT check the working directory in its place.
  assert.equal(readTargetsOf("date", [], []), null);
  assert.equal(readTargetsOf("date", ["tomorrow", "+%F"], ["-d", "tomorrow", "+%F"]), null);
  for (const command of ["date", "date -d /etc/hosts", "date +/etc/hosts", "date -u -d tomorrow +%F"]) {
    const segment = classified(command, ["/work"]);
    assert.equal(segment.class, "read.shell", command);
    assert.equal(segment.rule, "date-read", command);
  }
});

test("APRV-508: zone values name the database, never a file", () => {
  for (const zone of ["", "UTC", "Asia/Kolkata", ":Asia/Kolkata", "Etc/GMT+5", "America/Argentina/Buenos_Aires", "IST-5:30", "EST5EDT", "<+0530>-5:30"]) {
    assert.equal(isZoneValue(zone), true, zone);
  }
  for (const zone of ["/etc/shadow", ":/etc/shadow", "../x", "Asia/../../x", "a/./b", "~/z", "Asia/Kolkata/", "/", ":"]) {
    assert.equal(isZoneValue(zone), false, zone);
  }
  assert.equal(isDateAssignment("LC_ALL=C.UTF-8"), true);
  assert.equal(isDateAssignment("LANGUAGE=en:fr"), true);
  assert.equal(isDateAssignment("LC_TIME=/x"), false);
  assert.equal(isDateAssignment("TZDIR=x"), false);
});

// ---------------------------------------------------------------------------
// 5. Where the agents write it: substitutions and pipelines
// ---------------------------------------------------------------------------

test("APRV-508: date inside $(…) is an inert read substitution", () => {
  for (const command of [
    'echo "today is $(date +%F)"',
    "NOW=$(date -u +%s)",
    'START=$(date -u -d "1 hour ago" +%Y-%m-%dT%H:%M:%SZ) && echo "$START"',
    'curl -sS "https://example.com/events?since=$(date -u +%FT%TZ)"',
  ]) {
    const result = classifyCommand(command);
    assert.equal(result.ok, true, `${command}: ${result.ok ? "" : result.detail}`);
  }
  const set = classifyCommand('echo "$(date -s now)"');
  assert.equal(set.ok, false);
  if (!set.ok) assert.equal(set.code, "unclassified");
});

test("APRV-508: date at the end of a four-segment pipeline", () => {
  const result = classifyCommand("printenv HOME | cut -d/ -f2 | tr a-z A-Z | date -u +%FT%TZ");
  assert.equal(result.ok, true, result.ok ? "" : result.detail);
  if (!result.ok) return;
  assert.deepEqual(result.classes, ["read.shell"]);
  assert.equal(result.segments[3]?.rule, "date-read");
});

// ---------------------------------------------------------------------------
// 6. `[` is `test`
// ---------------------------------------------------------------------------

test("APRV-508: [ classifies as test does", () => {
  for (const [bracket, plain] of [
    ["[ -f README.md ]", "test -f README.md"],
    ['[ "$(date +%u)" -gt 5 ] && echo weekend', 'test "$(date +%u)" -gt 5 && echo weekend'],
    ["[ -d /etc ]", "test -d /etc"],
  ] as const) {
    const a = classifyCommand(bracket);
    const b = classifyCommand(plain);
    assert.equal(a.ok, true, `${bracket}: ${a.ok ? "" : a.detail}`);
    assert.equal(b.ok, true, plain);
    if (!a.ok || !b.ok) return;
    assert.deepEqual(a.classes, b.classes, bracket);
    assert.equal(a.segments[0]?.rule, "read-shell", bracket);
  }
  // A protected or credential path still answers first, as it does for test.
  assert.equal(classified("[ -f ~/.hermes/.env ]").class, "account.credential");
});

// ---------------------------------------------------------------------------
// 7. Not widened
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

test("APRV-508: isDateDisplay holds the stricter of getopt's and clap's reading", () => {
  // A required value must not look like a flag: clap may read it as one.
  assert.equal(isDateDisplay(["-d", "-s"]), false);
  assert.equal(isDateDisplay(["--date", "--set"]), false);
  assert.equal(isDateDisplay(["-d", "now"]), true);
  // An optional value is attached, or the next word is an operand.
  assert.equal(isDateDisplay(["--iso-8601", "seconds"]), false);
  assert.equal(isDateDisplay(["--iso-8601=seconds"]), true);
  // Assignments are judged by name AND value.
  assert.equal(isDateDisplay([], ["TZ=Asia/Kolkata"]), true);
  assert.equal(isDateDisplay([], ["TZ=/etc/shadow"]), false);
  assert.equal(isDateDisplay([], ["LD_PRELOAD=./x.so"]), false);
});
