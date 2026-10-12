/**
 * `date` in its display forms (APRV-508).
 *
 * The classifier's `date-read` row asks this file one question of an argv and
 * the assignments in front of it: is this a `date` that only PRINTS a time,
 * reading no file to do it?
 *
 * `date` has two jobs. One prints a time; the other sets the system clock, and
 * the setting forms are spelled with the same binary and overlapping flags.
 * So this reads the argv the way an option parser does and answers `false` for
 * anything it does not recognise as display-only. `false` is the fail-closed
 * answer: the classifier row does not match, and the command keeps the
 * `unclassified` refusal it had before this row existed.
 *
 * Two implementations are in scope, and an argv is accepted only where both
 * read it as a display: GNU coreutils (getopt) and uutils coreutils 0.10, the
 * `date` the hosted Agent Village boxes run (clap). Where they differ the
 * stricter reading wins: a required value may not start with `-` (getopt takes
 * it as the value, clap may take it as the next flag), and long options match
 * by EXACT name only (getopt and clap both accept a unique prefix, so `--se`
 * is `--set` to both).
 *
 * Accepted, and nothing else:
 *
 * - no arguments at all (`date`);
 * - at most one operand, and it must start with `+` (the output format). Any
 *   other operand is a clock setting (`MMDDhhmm[[CC]YY][.ss]`) on GNU, BSD and
 *   uutils alike;
 * - `-u`, `--utc`, `--universal` (print in UTC);
 * - `-R`, `--rfc-2822`, `--rfc-email`;
 * - `-I` alone or with an ATTACHED precision (`-Iseconds`), and `--iso-8601`
 *   alone or with `=precision`;
 * - `--rfc-3339=FMT` or `--rfc-3339 FMT`, FMT one of `date`, `seconds`, `ns`;
 * - `-d STRING`, `-ud STRING`, `--date=STRING`, `--date STRING`: the string is
 *   parsed and printed, never applied to the clock. A `TZ="…"` inside the
 *   string names a zone and is held to {@link isZoneValue};
 * - `--debug`, `--resolution`, `-h`/`--help`, `-V`/`--version`, which print
 *   diagnostics or text and read nothing;
 * - the clusters `-uR`, `-Ru` and `-ud`, and no other: a cluster is accepted
 *   only by its exact spelling.
 *
 * Declined, so `unclassified` as before:
 *
 * - `-s`/`--set` (sets the clock), in any spelling or cluster;
 * - `-f`/`--file` (reads a file's lines and echoes the bad ones back; on BSD
 *   `-f` is an input format that sets the clock without `-j`);
 * - `-r`/`--reference` in EVERY spelling. It prints a file's modification
 *   time, which is a read of that file's metadata, and the agents this row
 *   exists for need the clock rather than a file's mtime. Admitting it would
 *   put a second spelling of `stat` behind a row whose whole claim is that it
 *   reads no file, so it stays refused;
 * - BSD's `-j`/`-v`/`-n`, a bare `--`, every long-option abbreviation, an
 *   attached short value (`-d@0`, `-d=@0`), and every cluster not listed;
 * - any word this file cannot read literally: one carrying `$`, a backtick, a
 *   glob or a brace, since the shell may split or expand it into flags this
 *   parse never saw. The classifier also declines a segment with a
 *   substituted word;
 * - an assignment other than {@link DATE_ENV_NAMES}, and one of those whose
 *   value could name a file (`TZ=/etc/x`, `TZ=:../x`, `LC_ALL=/tmp/x`): a zone
 *   or locale value that is a path makes `date` open that file.
 */

/** Assignments a display `date` may carry: the zone, and the locale it prints in. */
export const DATE_ENV_NAMES: readonly string[] = ["TZ", "LANG", "LANGUAGE", "LC_ALL", "LC_TIME"];

/** Characters the shell may expand into more words, or into other words. */
const UNREADABLE_WORD = /[$`*?[\]{}]/u;

/** Long options that take no value, by exact spelling. */
const LONG_BARE: readonly string[] = [
  "--utc",
  "--universal",
  "--rfc-2822",
  "--rfc-email",
  "--iso-8601",
  "--debug",
  "--resolution",
  "--help",
  "--version",
];

/**
 * Short words that take no value, by exact spelling. Clusters are admitted
 * only as listed here: no general cluster parsing, so a letter this file does
 * not know can never ride inside one.
 */
const SHORT_BARE: readonly string[] = ["-u", "-R", "-h", "-V", "-I", "-uR", "-Ru"];

/** The `-I` / `--iso-8601` precisions, attached (`-Iseconds`, `--iso-8601=ns`). */
const ISO_PRECISIONS: readonly string[] = ["date", "hours", "minutes", "seconds", "ns"];

/** The `--rfc-3339` precisions. */
const RFC3339_PRECISIONS: readonly string[] = ["date", "seconds", "ns"];

/** Words that take the NEXT word as a date string. */
const DATE_VALUE_WORDS: readonly string[] = ["-d", "-ud", "--date"];

/**
 * A tz database name (`Asia/Kolkata`, `Etc/GMT+5`, `UTC`), optionally behind
 * the POSIX `:`. Every segment is a name: no leading `/`, no `.` anywhere, so
 * neither an absolute path nor a `..` climb out of the zoneinfo directory.
 */
const ZONE_NAME = /^:?[A-Za-z_][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/u;

/**
 * A POSIX TZ rule with no transition dates (`IST-5:30`, `EST5EDT`, `<+0530>-5:30`).
 * A rule never names a file.
 */
const POSIX_ZONE =
  /^(?:[A-Za-z]{3,}|<[A-Za-z0-9+-]{3,}>)[+-]?\d{1,2}(?::\d{2}){0,2}(?:(?:[A-Za-z]{3,}|<[A-Za-z0-9+-]{3,}>)(?:[+-]?\d{1,2}(?::\d{2}){0,2})?)?$/u;

/** A locale name (`C`, `C.UTF-8`, `en_US.UTF-8`, `en:fr`), never a path. */
const LOCALE_VALUE = /^[A-Za-z0-9_@.:-]*$/u;

/** Is this a zone value that names no file outside the zone database? */
export function isZoneValue(value: string): boolean {
  if (value === "") return true;
  if (value.includes("..")) return false;
  return ZONE_NAME.test(value) || POSIX_ZONE.test(value);
}

/**
 * May this `NAME=value` word stand in front of a display `date`?
 *
 * Only the zone and locale names, and only with a value that cannot name a
 * file: a zone outside the database or a locale that is a path makes `date`
 * open whatever the value names.
 */
export function isDateAssignment(word: string): boolean {
  const equals = word.indexOf("=");
  if (equals <= 0) return false;
  const name = word.slice(0, equals);
  const value = word.slice(equals + 1);
  if (!DATE_ENV_NAMES.includes(name)) return false;
  if (UNREADABLE_WORD.test(value) || value.includes("~")) return false;
  if (name === "TZ") return isZoneValue(value);
  return !value.includes("..") && LOCALE_VALUE.test(value);
}

/**
 * Does a `-d` string carry only zones that name no file?
 *
 * GNU (and the parser uutils uses) accept a leading `TZ="Zone"` inside the
 * date string, and resolve it as the variable would be resolved.
 */
function isDateString(value: string): boolean {
  // Case-insensitive (refutation S2): GNU's prefix is `TZ=` exactly, but a
  // parser that folds case would read `tz="/etc/x"` as a zone path too.
  const embedded = /TZ\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S*))/giu;
  for (let match = embedded.exec(value); match !== null; match = embedded.exec(value)) {
    const zone = match[1] ?? match[2] ?? match[3] ?? "";
    if (!isZoneValue(zone)) return false;
  }
  return true;
}

/** A required value: present, not flag-shaped, and readable as a date string. */
function isRequiredValue(value: string | undefined): boolean {
  return value !== undefined && !value.startsWith("-") && isDateString(value);
}

/**
 * Is this `date` argv a display form? `args` is the words after the binary,
 * quotes already removed; `assignments` the `NAME=value` words in front of it.
 *
 * A strict allow-grammar: every word must be one of the exact spellings below,
 * a value in a position one of them opens, or the single `+FORMAT` operand.
 * Anything else (a cluster not listed, an abbreviation, `--`, an `=` joined
 * to a short flag) answers `false`.
 */
export function isDateDisplay(args: readonly string[], assignments: readonly string[] = []): boolean {
  if (!assignments.every((word) => isDateAssignment(word))) return false;
  if (args.some((arg) => UNREADABLE_WORD.test(arg))) return false;
  const seen = new Set<string>();
  let operands = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    // A flag word given twice: clap (uutils) refuses it, getopt takes the last.
    if (arg.startsWith("-")) {
      if (seen.has(arg)) return false;
      seen.add(arg);
    }
    if (LONG_BARE.includes(arg) || SHORT_BARE.includes(arg)) continue;
    if (arg.startsWith("-I") && ISO_PRECISIONS.includes(arg.slice(2))) continue;
    if (arg.startsWith("--iso-8601=") && ISO_PRECISIONS.includes(arg.slice("--iso-8601=".length))) continue;
    if (arg.startsWith("--rfc-3339=") && RFC3339_PRECISIONS.includes(arg.slice("--rfc-3339=".length))) continue;
    if (arg === "--rfc-3339") {
      index += 1;
      if (!RFC3339_PRECISIONS.includes(args[index] ?? "")) return false;
      continue;
    }
    if (arg.startsWith("--date=")) {
      if (!isDateString(arg.slice("--date=".length))) return false;
      continue;
    }
    if (DATE_VALUE_WORDS.includes(arg)) {
      index += 1;
      if (!isRequiredValue(args[index])) return false;
      continue;
    }
    // An operand: exactly one, and only an output format. Anything else is a
    // flag this grammar does not list, or a clock setting.
    if (!arg.startsWith("+")) return false;
    operands += 1;
    if (operands > 1) return false;
  }
  return true;
}
