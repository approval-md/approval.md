/**
 * What a usage error prints (APRV-91).
 *
 * Every verb used to answer a mangled command line with its whole help page:
 * the flags, the rationale, and the frozen exit-code table, under a one-line
 * message. The line the operator needed was buried, and on `setup identity` the
 * same trust-boundary paragraph appeared twice on one screen. So the rule is
 * one function, applied everywhere:
 *
 *   - a message plus `see: approval <verb> --help`, one line, for anything the
 *     runtime decided (no identity, an empty answer, a flag combination it
 *     refuses);
 *   - the usage synopsis as well, for an ARGUMENT-SHAPE error — a missing
 *     positional, an unknown flag, a flag without its value. There the shape of
 *     the command line IS what the operator got wrong, so the forms are the
 *     answer rather than a pointer to it.
 *
 * Nothing here changes an exit code or a `--json` shape: the JSON branch of
 * every caller is untouched, since `{"error":{"code","message"}}` is frozen
 * public API and a machine reader was never the one drowning in help text.
 */

/** How many usage lines a synopsis prints before it defers to `--help`. */
const SYNOPSIS_MAX_LINES = 6;

/**
 * Argument-shape errors: the ones whose repair is visible in the usage forms.
 *
 * Prefix matching over the messages the CLI actually produces, rather than a
 * flag threaded through 170 call sites. The distinction is a property of the
 * message ("this command line is malformed") and stating it once keeps every
 * verb answering the same way.
 */
const SHAPE_PATTERNS: readonly RegExp[] = [
  /^missing /u,
  /^unknown (flag|command|subcommand|adapter|channel|option) /u,
  /^unexpected argument/u,
  /^no command given/u,
  /^flag --?[\w-]+ (takes no value|requires a value)/u,
  /^--?[\w-]+ (expects|takes|requires) /u,
];

/** Whether the command LINE is what went wrong, rather than what it asked for. */
export function isShapeError(message: string): boolean {
  return SHAPE_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * The verb a help text belongs to, read from its title line
 * (`approval log tail — print the last records of the log`).
 */
export function verbOf(helpText: string): string {
  const first = helpText.split("\n", 1)[0] ?? "";
  const dash = first.indexOf(" — ");
  const name = (dash === -1 ? first : first.slice(0, dash)).trim();
  return name.startsWith("approval") ? name : "approval";
}

/**
 * The `Usage:` block, capped. A verb with more forms than fit says so and
 * points at its help rather than printing a page nobody reads at 2am.
 */
export function synopsis(helpText: string): string | null {
  const lines = helpText.split("\n");
  const start = lines.indexOf("Usage:");
  if (start === -1) return null;

  const forms: string[] = [];
  let truncated = false;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "") break;
    if (forms.length === SYNOPSIS_MAX_LINES) {
      truncated = true;
      break;
    }
    forms.push(line);
  }
  if (forms.length === 0) return null;
  return ["Usage:", ...forms, ...(truncated ? ["  …"] : [])].join("\n");
}

/** `see: approval <verb> --help`, the one line every usage error ends on. */
export function helpPointer(helpText: string): string {
  return `see: ${verbOf(helpText)} --help`;
}

/** The whole stderr text of a human-readable usage error, newline included. */
export function usageErrorText(message: string, helpText: string): string {
  const pointer = helpPointer(helpText);
  const forms = isShapeError(message) ? synopsis(helpText) : null;
  return forms === null
    ? `approval: ${message}\n${pointer}\n`
    : `approval: ${message}\n\n${forms}\n\n${pointer}\n`;
}
