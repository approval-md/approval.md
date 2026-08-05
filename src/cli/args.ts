/**
 * Hand-rolled argv parsing. Zero dependencies, by policy: an argument parser is
 * a hundred lines of well-understood string handling, and a CLI that gates
 * side effects should not widen its supply chain to save them.
 *
 * Accepted forms: `--flag value`, `--flag=value`, `-n value`, `-n=value`, and
 * bare boolean flags. Anything else — an unknown flag, a flag missing its
 * value, a non-integer count — is a usage error, never a guess. Fail closed
 * applies to argument handling too: a CLI that quietly reinterprets a typo is a
 * CLI that eventually reindexes the wrong file.
 */

/** A flag's expected shape. */
export type FlagKind = "string" | "boolean";

export type ParsedFlags = Record<string, string | boolean>;

export type ParseResult =
  | { ok: true; flags: ParsedFlags; positionals: string[] }
  | { ok: false; message: string };

/**
 * Parse `argv` against a closed spec of flags. Unknown flags fail rather than
 * landing in `positionals`, so a mistyped `--jsno` can never be silently
 * swallowed as a path.
 */
export function parseFlags(argv: string[], spec: Record<string, FlagKind>): ParseResult {
  const flags: ParsedFlags = {};
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;

    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    const equals = token.indexOf("=");
    const name = equals === -1 ? token : token.slice(0, equals);
    const inlineValue = equals === -1 ? null : token.slice(equals + 1);

    const kind = spec[name];
    if (kind === undefined) {
      return { ok: false, message: `unknown flag ${name}` };
    }

    if (kind === "boolean") {
      if (inlineValue !== null) {
        return { ok: false, message: `flag ${name} takes no value` };
      }
      flags[name] = true;
      continue;
    }

    if (inlineValue !== null) {
      flags[name] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (next === undefined || next === "--") {
      return { ok: false, message: `flag ${name} requires a value` };
    }
    flags[name] = next;
    index += 1;
  }

  return { ok: true, flags, positionals };
}

/** Read a string flag, or `null` when absent. */
export function stringFlag(flags: ParsedFlags, name: string): string | null {
  const value = flags[name];
  return typeof value === "string" ? value : null;
}

/** Read a boolean flag. */
export function boolFlag(flags: ParsedFlags, name: string): boolean {
  return flags[name] === true;
}

/**
 * A non-negative integer flag value. `0` is legal and means "no records" —
 * an explicit request for nothing is not an error.
 */
export function countFlag(
  flags: ParsedFlags,
  name: string,
): { ok: true; value: number | null } | { ok: false; message: string } {
  const raw = flags[name];
  if (raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    return {
      ok: false,
      message: `${name} expects a non-negative integer, got ${JSON.stringify(raw)}`,
    };
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value)) {
    return { ok: false, message: `${name} value ${raw} is out of range` };
  }
  return { ok: true, value };
}
