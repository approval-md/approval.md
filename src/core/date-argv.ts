/**
 * `date` in its display forms (APRV-508).
 *
 * The classifier's `date-read` row and the read scope's `reference` shape both
 * ask this one question of the same argv, so it lives in one place: is this a
 * `date` that only PRINTS a time, and which file, if any, does it stat?
 *
 * `date` has two jobs. One prints a time; the other sets the system clock, and
 * the setting forms are spelled with the same binary and overlapping flags.
 * So this reads the argv the way getopt does and answers `null` for anything
 * it does not recognise as display-only. `null` is the fail-closed answer: the
 * classifier row does not match, and the command keeps the `unclassified`
 * refusal it had before this row existed.
 *
 * Accepted, and nothing else:
 *
 * - no arguments at all (`date`);
 * - at most one operand, and it must start with `+` (the output format). Any
 *   other operand is a clock setting on GNU (`MMDDhhmm[[CC]YY][.ss]`), BSD and
 *   BusyBox alike;
 * - `-u`, `--utc`, `--universal` (print in UTC);
 * - `-R`, `--rfc-2822`, `--rfc-email`;
 * - `-I` with an optional ATTACHED value (`-Iseconds`), and `--iso-8601` with
 *   an optional `=value`. The value is optional in getopt's sense, so a
 *   separate word after it is an operand and is judged as one;
 * - `--rfc-3339=FMT` or `--rfc-3339 FMT`;
 * - `-d STRING`, `-dSTRING`, `--date=STRING`, `--date STRING`: the string is
 *   parsed and printed, never applied to the clock. As in getopt, the next
 *   word is the value even when it starts with `-`;
 * - `-r FILE` and `--reference FILE`, as SEPARATE words, with a FILE that does
 *   not start with `-`. This prints the file's modification time, which is
 *   what `stat FILE` prints, so it is treated the way `stat` is: `read.shell`,
 *   a credential path is `account.credential`, and the file is a read-scope
 *   target. The separate-word spelling is required because it keeps FILE among
 *   the positionals those two checks read; `--reference=FILE` and `-rFILE`
 *   would hide it inside a flag word, so they are declined;
 * - short flags clustered as getopt allows (`-uR`, `-ud @0`, `-uIseconds`,
 *   `-ur FILE`).
 *
 * Declined, so `unclassified` as before: `-s`/`--set` (sets the clock),
 * `-f`/`--file` (reads a FILE's lines and echoes the bad ones back, which is
 * a read of its contents; on BSD `-f` is an input format that sets the clock
 * without `-j`), `--debug`, `--help`, `--version`, BSD's `-j`/`-v`/`-n`, a bare
 * `--`, every long-option ABBREVIATION (getopt accepts `--se` for `--set`, so
 * only exact names are read), and any word this file cannot read literally:
 * one carrying `$`, a backtick, a glob or a brace, since the shell may split
 * or expand it into flags this parse never saw. The caller also declines a
 * segment with a substituted word or with an environment assignment other than
 * {@link DATE_ENV_NAMES}.
 */

/** Assignments a display `date` may carry: the zone, and the locale it prints in. */
export const DATE_ENV_NAMES: readonly string[] = ["TZ", "LANG", "LANGUAGE", "LC_ALL", "LC_TIME"];

/** Characters the shell may expand into more words, or into other words. */
const UNREADABLE_WORD = /[$`*?[\]{}]/u;

/** Long options that take no value. */
const LONG_BARE: readonly string[] = ["--utc", "--universal", "--rfc-2822", "--rfc-email", "--iso-8601"];

/** Long options whose value is required: `--name=value` or `--name value`. */
const LONG_VALUE: readonly string[] = ["--date", "--rfc-3339"];

/** What a display `date` touches beyond the clock: the files it stats. */
export interface DateDisplay {
  /** The `-r` / `--reference` files, in argv order. Empty for every other form. */
  references: string[];
}

/** The value word for a `-r` / `--reference`, or `null` when it is missing or flag-shaped. */
function referenceValue(args: readonly string[], index: number): string | null {
  const value = args[index];
  if (value === undefined || value.startsWith("-")) return null;
  return value;
}

/**
 * Parse a `date` argv as a display form, or answer `null` when it is not one.
 *
 * `args` is the words after the binary, quotes already removed.
 */
export function parseDateDisplay(args: readonly string[]): DateDisplay | null {
  if (args.some((arg) => UNREADABLE_WORD.test(arg))) return null;
  const references: string[] = [];
  let operands = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;

    if (arg.startsWith("--")) {
      if (LONG_BARE.includes(arg)) continue;
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg : arg.slice(0, equals);
      if (name === "--iso-8601") continue;
      if (LONG_VALUE.includes(name)) {
        if (equals === -1) {
          index += 1;
          if (index >= args.length) return null;
        }
        continue;
      }
      if (arg === "--reference") {
        const value = referenceValue(args, index + 1);
        if (value === null) return null;
        references.push(value);
        index += 1;
        continue;
      }
      // `--set`, `--file`, `--reference=FILE`, `--debug`, `--`, abbreviations.
      return null;
    }

    if (arg.startsWith("-") && arg.length > 1) {
      for (let at = 1; at < arg.length; at += 1) {
        const flag = arg[at];
        if (flag === "u" || flag === "R") continue;
        // -I's value is optional and attached: the rest of the word is it.
        if (flag === "I") break;
        if (flag === "d") {
          // Attached (`-d@0`) or the next word, whatever it looks like.
          if (at === arg.length - 1) {
            index += 1;
            if (index >= args.length) return null;
          }
          break;
        }
        if (flag === "r") {
          // Only as the last letter, so FILE is a word of its own.
          if (at !== arg.length - 1) return null;
          const value = referenceValue(args, index + 1);
          if (value === null) return null;
          references.push(value);
          index += 1;
          break;
        }
        // `-s`, `-f`, and every letter this file does not know.
        return null;
      }
      continue;
    }

    // An operand. Only an output format prints; anything else sets the clock.
    if (!arg.startsWith("+")) return null;
    operands += 1;
    if (operands > 1) return null;
  }
  return { references };
}
