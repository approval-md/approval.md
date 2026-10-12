/**
 * The system-information readers' safe forms (APRV-508).
 *
 * `uptime`, `whoami`, `hostname`, `df`, `free`, `seq` and `paste` each print
 * something and change nothing in the forms below, and some of them change
 * something in forms that look almost the same: `hostname NAME` and `hostname
 * -F FILE` SET the host name, `free -s N` loops forever, `uptime FILE` reads a
 * utmp file. So each binary gets a STRICT allow-grammar rather than a seat in
 * the read table:
 *
 * - every flag is matched by its exact spelling. No abbreviation (getopt and
 *   clap both accept a unique prefix of a long option), no cluster except the
 *   ones a table below lists word for word, no `=` joined to a short flag;
 * - `--` is never accepted;
 * - an operand is accepted only where the binary's grammar names one, and
 *   only in the shape it names (a number for `seq`, a file for `paste`);
 * - a word carrying `$`, a backtick, a glob or a brace is never accepted,
 *   since the shell may expand it into words this grammar never saw;
 * - nothing else. An argv this file does not recognise answers `false`, and
 *   the classifier row does not match, so the command keeps the
 *   `unclassified` refusal it had before the row existed.
 *
 * Two implementations are read at once: GNU (coreutils, procps, net-tools
 * `hostname`) and uutils coreutils 0.10, which the hosted boxes run. Where a
 * spelling exists in one and not the other, the other errors out on it, which
 * is a refusal by the tool rather than a different act.
 */

/**
 * Characters the shell may expand into more words, or into other words. A
 * leading `~` is not among them: it expands to one path and never splits, and
 * the read scope already judges a `~` path as one it cannot place.
 */
const UNREADABLE_WORD = /[$`*?[\]{}]/u;

/** No word of this argv is one the shell may expand. */
function literal(args: readonly string[]): boolean {
  return !args.some((arg) => UNREADABLE_WORD.test(arg));
}

/**
 * The option each flag word sets, so that two spellings of one option count
 * as a repeat (`-s --serial`, `-h --human-readable`, `-h -hT`). A word not in
 * the map is its own option.
 */
const SAME_OPTION: Readonly<Record<string, readonly string[]>> = {
  "--human-readable": ["-h"],
  "--si": ["-H"],
  "--print-type": ["-T"],
  "--inodes": ["-i"],
  "--all": ["-a"],
  "--local": ["-l"],
  "--portability": ["-P"],
  "-hT": ["-h", "-T"],
  "-Th": ["-h", "-T"],
  "-hi": ["-h", "-i"],
  "-ih": ["-h", "-i"],
  "-hl": ["-h", "-l"],
  "-lh": ["-h", "-l"],
  "--bytes": ["-b"],
  "--kibi": ["-k"],
  "--mebi": ["-m"],
  "--gibi": ["-g"],
  "--human": ["-h"],
  "--lohi": ["-l"],
  "--total": ["-t"],
  "--wide": ["-w"],
  "--committed": ["-v"],
  "-ht": ["-h", "-t"],
  "-th": ["-h", "-t"],
  "-hw": ["-h", "-w"],
  "-wh": ["-h", "-w"],
  "--equal-width": ["-w"],
  "--separator": ["-s"],
  "--format": ["-f"],
  "--serial": ["-s"],
  "--zero-terminated": ["-z"],
};

/**
 * No option is given twice, in any spelling. clap (uutils) refuses a repeated
 * option where getopt takes the last one, so the grammar admits neither.
 * `-dX` / `--delimiters=X` and `--separator=X` / `--format=X` count by name.
 */
function noRepeatedFlag(args: readonly string[], valueWords: readonly string[] = []): boolean {
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (!arg.startsWith("-") || arg === "-" || /^-[\d.]/u.test(arg)) continue;
    let name = arg;
    if (arg.startsWith("--delimiters=") || (arg.startsWith("-d") && !arg.startsWith("--"))) name = "-d";
    else if (arg.startsWith("--separator=")) name = "-s";
    else if (arg.startsWith("--format=")) name = "-f";
    for (const option of SAME_OPTION[name] ?? [name]) {
      if (seen.has(option)) return false;
      seen.add(option);
    }
    // A separate-word value is not a flag, even when it looks like one.
    if (valueWords.includes(arg)) index += 1;
  }
  return true;
}

/** `--help` or `--version`, alone. */
function isHelpOrVersion(args: readonly string[]): boolean {
  return args.length === 1 && (args[0] === "--help" || args[0] === "--version");
}

/** `uptime` and `whoami`: nothing, or `--help` / `--version`. */
export function isBareInfo(args: readonly string[]): boolean {
  return args.length === 0 || isHelpOrVersion(args);
}

/**
 * `hostname`: nothing, or ONE display flag. Any operand sets the host name,
 * and `-F`/`--file`/`-b`/`--boot` set it from a file or at boot, so none of
 * them is in the list.
 */
const HOSTNAME_FLAGS: readonly string[] = [
  "-s",
  "--short",
  "-f",
  "--fqdn",
  "--long",
  "-d",
  "--domain",
  "-i",
  "--ip-address",
  "-I",
  "--all-ip-addresses",
  "--help",
  "--version",
];

export function isHostnameDisplay(args: readonly string[]): boolean {
  if (args.length === 0) return true;
  return args.length === 1 && HOSTNAME_FLAGS.includes(args[0] as string);
}

/**
 * `df`: display flags only. A path operand would be a read the read scope
 * judges, and the agents asking need the mount table, so operands are not in
 * the grammar. `--output` and the type filters are left out with them.
 */
const DF_FLAGS: readonly string[] = [
  "-h",
  "--human-readable",
  "-H",
  "--si",
  "-k",
  "-T",
  "--print-type",
  "-i",
  "--inodes",
  "-a",
  "--all",
  "-l",
  "--local",
  "-P",
  "--portability",
  "--total",
  "--help",
  "--version",
  // The clusters, by exact spelling.
  "-hT",
  "-Th",
  "-hi",
  "-ih",
  "-hl",
  "-lh",
];

export function isDfDisplay(args: readonly string[]): boolean {
  return literal(args) && noRepeatedFlag(args) && args.every((arg) => DF_FLAGS.includes(arg));
}

/**
 * `free`: display flags only. `-s`/`--seconds` and `-c`/`--count` repeat the
 * report on a timer, which holds the turn rather than reading anything, and
 * stay out.
 */
const FREE_FLAGS: readonly string[] = [
  "-b",
  "--bytes",
  "-k",
  "--kibi",
  "--kilo",
  "-m",
  "--mebi",
  "--mega",
  "-g",
  "--gibi",
  "--giga",
  "-h",
  "--human",
  "--si",
  "-l",
  "--lohi",
  "-t",
  "--total",
  "-w",
  "--wide",
  "-v",
  "--committed",
  "--help",
  "--version",
  "-ht",
  "-th",
  "-hw",
  "-wh",
];

export function isFreeDisplay(args: readonly string[]): boolean {
  return literal(args) && noRepeatedFlag(args) && args.every((arg) => FREE_FLAGS.includes(arg));
}

/** A decimal number, signed or not, with an optional exponent. No hex, `inf` or `nan`. */
const SEQ_NUMBER = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/u;

/**
 * The most values an admitted `seq` prints (refutation S4). `seq 1e18` is a
 * read in the sense that it changes nothing, but it holds the turn the way
 * `free -s` does, so a range past this is not admitted.
 */
export const SEQ_MAX_VALUES = 100_000;

/**
 * Can a double hold this number exactly enough to count with? (Recheck S-R2.)
 * GNU and uutils count digit strings exactly, so a range narrower than half a
 * ULP of its ends (`seq 1e30-ish 1e30-ish+5e13`) reads as one value to a
 * double and prints fifty trillion. No more than 15 significant digits, and no
 * magnitude above 2^53, keeps every admitted operand exact enough.
 */
function isCountable(word: string): boolean {
  const mantissa = word.replace(/^[-+]/u, "").replace(/[eE].*$/u, "").replace(".", "");
  const significant = mantissa.replace(/^0+/u, "");
  if (significant.length > 15) return false;
  return Math.abs(Number(word)) <= 2 ** 53;
}

/** How many values `seq FIRST [INCREMENT] LAST` prints; Infinity when it never ends. */
function seqCount(numbers: readonly number[]): number {
  const [first, increment, last] =
    numbers.length === 1
      ? [1, 1, numbers[0] as number]
      : numbers.length === 2
        ? [numbers[0] as number, 1, numbers[1] as number]
        : [numbers[0] as number, numbers[1] as number, numbers[2] as number];
  if (![first, increment, last].every((n) => Number.isFinite(n))) return Infinity;
  if (increment === 0) return Infinity;
  const steps = Math.floor((last - first) / increment);
  return steps < 0 ? 0 : steps + 1;
}

/** One floating-point directive, `%%` escapes around it, nothing else. */
const SEQ_FORMAT = /^(?:[^%]|%%)*%[-+ #0]*\d*(?:\.\d+)?[eEfFgG](?:[^%]|%%)*$/u;

/** A separator: any literal text that does not look like a flag. */
function isSeqSeparator(value: string | undefined): boolean {
  return value !== undefined && !value.startsWith("-");
}

/**
 * `seq`: one to three numbers, with `-w`/`--equal-width`, `-s SEP` /
 * `--separator=SEP` and `-f FMT` / `--format=FMT`. A separate-word value is
 * the next word; the attached short spellings (`-s,`) are not in the grammar.
 * Every flag comes BEFORE the first number: uutils reads a word after a number
 * as another number (`seq 1 -w` is an error there and a flag to GNU), and the
 * grammar takes the reading both agree on.
 */
export function isSeqDisplay(args: readonly string[]): boolean {
  if (!literal(args) || !noRepeatedFlag(args, ["-s", "--separator", "-f", "--format"])) return false;
  if (isHelpOrVersion(args)) return true;
  let numbers = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (numbers > 0) {
      if (!SEQ_NUMBER.test(arg)) return false;
      numbers += 1;
      continue;
    }
    if (arg === "-w" || arg === "--equal-width") continue;
    if (arg === "-s" || arg === "--separator") {
      index += 1;
      if (!isSeqSeparator(args[index])) return false;
      continue;
    }
    if (arg.startsWith("--separator=")) continue;
    if (arg === "-f" || arg === "--format") {
      index += 1;
      // A flag-shaped value is the value to getopt and the next flag to clap.
      const value = args[index] ?? "";
      if (value.startsWith("-") || !SEQ_FORMAT.test(value)) return false;
      continue;
    }
    if (arg.startsWith("--format=")) {
      if (!SEQ_FORMAT.test(arg.slice("--format=".length))) return false;
      continue;
    }
    if (!SEQ_NUMBER.test(arg)) return false;
    numbers += 1;
  }
  // GNU and uutils both refuse a format beside equal width.
  const width = args.includes("-w") || args.includes("--equal-width");
  const format = args.some((arg) => arg === "-f" || arg === "--format" || arg.startsWith("--format="));
  if (width && format) return false;
  if (numbers < 1 || numbers > 3) return false;
  const operands = args.slice(args.length - numbers);
  if (!operands.every((word) => isCountable(word))) return false;
  return seqCount(operands.map(Number)) <= SEQ_MAX_VALUES;
}

/**
 * `paste`: files (or `-`, standard input) with `-s`/`--serial`,
 * `-z`/`--zero-terminated`, and the delimiter list ATTACHED (`-d,`,
 * `--delimiters=,`). Attached, so that every positional is a file: the read
 * scope takes paste's operands exactly as it takes `cat`'s (`READ_TARGET_SHAPES`
 * in read-scope.ts), and a delimiter in its own word would be taken for one.
 */
const PASTE_FLAGS: readonly string[] = ["-s", "--serial", "-z", "--zero-terminated", "--help", "--version"];

export function isPasteRead(args: readonly string[]): boolean {
  if (!literal(args) || !noRepeatedFlag(args)) return false;
  for (const arg of args) {
    if (PASTE_FLAGS.includes(arg)) continue;
    if (arg.startsWith("--delimiters=")) continue;
    if (arg.startsWith("-d") && arg.length > 2) continue;
    // A file, or `-` for standard input. Every other flag-shaped word is not
    // in the grammar (`--`, `-d` with a separate value, abbreviations).
    if (arg === "-" || !arg.startsWith("-")) continue;
    return false;
  }
  return true;
}
