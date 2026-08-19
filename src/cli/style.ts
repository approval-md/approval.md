/**
 * Terminal presentation: colour, glyphs, headings, tables (APRV-91, APRV-93).
 *
 * The observation behind this file was a real `examples/email-demo.md` run and
 * a `policy amend --dry-run` the operator called dense: two 64-hex hashes on one
 * line, the same absolute path three times, every line the same visual weight,
 * no colour anywhere. Nothing was WRONG; nothing was scannable either.
 *
 * The design rules, from APRV-91's brief:
 *
 *   1. ROLES, NOT COLOURS. Callers ask for `ok` or `key`, never for green or
 *      bold, so a theme is one table and a colour-blind reader loses nothing.
 *   2. COLOUR IS REDUNDANT, ALWAYS. Every coloured thing is also carried by a
 *      glyph or a word, so the plain-text degradation is lossless. That is not
 *      politeness: piped output IS the tested output, and a pipe gets no colour.
 *   3. NEVER COLOUR A COPYABLE VALUE. Hashes, tokens, paths and commands are
 *      printed raw so a triple-click yields clean bytes. Colour the LABEL.
 *   4. DECIDED ONCE. {@link style} memoizes the process-wide answer; tests build
 *      their own with {@link makeStyle} rather than mutating the environment.
 *
 * NO NEW DEPENDENCY, deliberately: a colour library is thousands of lines to
 * buy the eleven escape sequences below, and this repo justifies every package.
 *
 * `--json` IS AN ABSOLUTE VETO here, above even FORCE_COLOR. The brief lists
 * `--json` alongside the other conditions, but the machine-readable shapes are
 * frozen public API; one escape byte in a JSON stream is a parse error, not a
 * cosmetic regression. So a caller that passes `json: true` cannot get colour by
 * any combination of environment variables.
 */

/** The single escape byte every sequence below starts with. */
const ESC = "\u001b";

/** The presentation roles. A theme is this list mapped to SGR parameters. */
export type Role =
  | "brand"
  | "ok"
  | "warn"
  | "fail"
  | "key"
  | "value"
  | "muted"
  | "rule"
  | "secret";

/**
 * Role to SGR parameters. `value` is empty on purpose: the role exists so a
 * caller can SAY "this is a value" at the call site, and the answer is that a
 * value is never dressed (rule 3 above).
 */
const SGR: Record<Role, string> = {
  brand: "1;38;5;111",
  ok: "32",
  warn: "33",
  fail: "1;31",
  key: "1",
  value: "",
  muted: "2",
  rule: "2",
  secret: "1;33",
};

/** The glyph vocabulary, and its ASCII degradation. */
const GLYPHS = {
  ok: ["✓", "[ok]"],
  fail: ["✗", "[x]"],
  skip: ["–", "[-]"],
  point: ["▸", ">"],
  bar: ["│", "|"],
  rule: ["─", "-"],
} as const satisfies Record<string, readonly [string, string]>;

export type Glyph = keyof typeof GLYPHS;

/** How many characters of a 64-hex digest a human is shown. */
export const SHORT_HASH_LENGTH = 12;

export interface StyleInput {
  /**
   * Whether stdout is a terminal. Omitted means "ask this process".
   *
   * Tests pass an explicit `true` to render coloured output into a captured
   * string, which is the only way to assert BOTH modes without a pty.
   */
  tty?: boolean;
  /** Environment to read. Omitted means `process.env`. */
  env?: Record<string, string | undefined>;
  /** Whether this invocation is answering in JSON. An absolute veto on colour. */
  json?: boolean;
  /** The `--no-color` flag. An explicit off, above FORCE_COLOR. */
  noColor?: boolean;
}

export interface Style {
  /** Whether escape sequences are emitted at all. */
  readonly enabled: boolean;
  /** Whether glyphs degrade to their ASCII spellings. */
  readonly ascii: boolean;

  /** Wrap `text` in `role`. A no-op when colour is off, or when text is empty. */
  paint(role: Role, text: string): string;

  brand(text: string): string;
  ok(text: string): string;
  warn(text: string): string;
  fail(text: string): string;
  key(text: string): string;
  /** Identity by contract: a value is never dressed. Here so call sites can say so. */
  value(text: string): string;
  muted(text: string): string;
  secret(text: string): string;

  /** One glyph, already coloured by its natural role where it has one. */
  glyph(name: Glyph): string;
  /** The bare glyph, uncoloured. */
  rawGlyph(name: Glyph): string;

  /** A section heading: the label in `key`, nothing else. */
  heading(text: string): string;
  /** A horizontal rule of `width` characters, in `rule`. */
  rule(width?: number): string;
  /** Aligned two-column rows. Column one in `key` unless the row says otherwise. */
  table(rows: readonly TableRow[], options?: TableOptions): string;
}

/**
 * One row of a two-column table.
 *
 * `left` is the label column and `right` the detail. `glyph` puts a coloured
 * status mark ahead of the label (doctor's column), and `plainLeft` opts a row
 * out of `key` styling for a left cell that is itself a copyable value.
 */
export interface TableRow {
  left: string;
  right?: string;
  glyph?: Glyph;
  /** Role for the glyph and, when set, nothing else. Defaults by glyph name. */
  role?: Role;
  plainLeft?: boolean;
  /** Extra lines printed under the row, indented to the detail column. */
  under?: readonly string[];
}

export interface TableOptions {
  /** Spaces before every row. Default 0. */
  indent?: number;
  /** Spaces between the columns. Default 2. */
  gap?: number;
}

/** The natural role of each glyph, so `glyph("ok")` is green without asking. */
const GLYPH_ROLE: Record<Glyph, Role> = {
  ok: "ok",
  fail: "fail",
  skip: "warn",
  point: "secret",
  bar: "rule",
  rule: "rule",
};

/**
 * The enable matrix, in precedence order.
 *
 * `json` first because it is frozen API (see the header). Then the explicit
 * flag, then FORCE_COLOR (the escape hatch for CI that renders ANSI), then
 * NO_COLOR and TERM=dumb, and only then the question of what stdout is.
 */
function colourEnabled(input: StyleInput, env: Record<string, string | undefined>): boolean {
  if (input.json === true) return false;
  if (input.noColor === true) return false;
  if (env["FORCE_COLOR"] === "1") return true;
  const noColor = env["NO_COLOR"];
  if (noColor !== undefined && noColor !== "") return false;
  if (env["TERM"] === "dumb") return false;
  return input.tty ?? process.stdout.isTTY === true;
}

/**
 * Whether glyphs degrade to ASCII.
 *
 * An UNSET locale is treated as UTF-8 capable. That is the deliberate choice:
 * a bare `env -i node cli.js` and every test runner would otherwise flip the
 * glyph column to `[ok]`, changing bytes that are pinned all over the suite for
 * a terminal that is almost certainly fine. Degrade when the locale is SET and
 * says something other than UTF-8, or when asked directly.
 */
function asciiOnly(env: Record<string, string | undefined>): boolean {
  if (env["APPROVAL_ASCII"] === "1") return true;
  const locale = env["LC_ALL"] ?? env["LANG"];
  if (locale === undefined || locale === "") return false;
  return !/utf-?8/iu.test(locale);
}

class TerminalStyle implements Style {
  readonly enabled: boolean;
  readonly ascii: boolean;

  constructor(enabled: boolean, ascii: boolean) {
    this.enabled = enabled;
    this.ascii = ascii;
  }

  paint(role: Role, text: string): string {
    const code = SGR[role];
    if (!this.enabled || code === "" || text === "") return text;
    return `${ESC}[${code}m${text}${ESC}[0m`;
  }

  brand(text: string): string {
    return this.paint("brand", text);
  }
  ok(text: string): string {
    return this.paint("ok", text);
  }
  warn(text: string): string {
    return this.paint("warn", text);
  }
  fail(text: string): string {
    return this.paint("fail", text);
  }
  key(text: string): string {
    return this.paint("key", text);
  }
  value(text: string): string {
    return text;
  }
  muted(text: string): string {
    return this.paint("muted", text);
  }
  secret(text: string): string {
    return this.paint("secret", text);
  }

  rawGlyph(name: Glyph): string {
    return GLYPHS[name][this.ascii ? 1 : 0];
  }

  glyph(name: Glyph): string {
    return this.paint(GLYPH_ROLE[name], this.rawGlyph(name));
  }

  heading(text: string): string {
    return this.key(text);
  }

  rule(width = 61): string {
    return this.paint("rule", this.rawGlyph("rule").repeat(Math.max(0, width)));
  }

  table(rows: readonly TableRow[], options: TableOptions = {}): string {
    const indent = " ".repeat(options.indent ?? 0);
    const gap = " ".repeat(options.gap ?? 2);

    // Width is measured on the UNDRESSED text: escape sequences occupy no
    // columns, so padding computed after painting would be wrong by exactly
    // the length of the escapes, and the table would only line up in a pipe.
    const marks = rows.map((row) => (row.glyph === undefined ? "" : this.rawGlyph(row.glyph)));
    const markWidth = Math.max(0, ...marks.map((mark) => mark.length));
    const leftWidth = Math.max(0, ...rows.map((row) => row.left.length));

    const out: string[] = [];
    rows.forEach((row, index) => {
      const rawMark = marks[index] ?? "";
      const mark =
        row.glyph === undefined
          ? " ".repeat(markWidth)
          : this.paint(row.role ?? GLYPH_ROLE[row.glyph], rawMark) +
            " ".repeat(markWidth - rawMark.length);
      const head = markWidth === 0 ? "" : `${mark} `;
      const left = row.plainLeft === true ? row.left : this.key(row.left);
      const pad = " ".repeat(leftWidth - row.left.length);
      const right = row.right ?? "";
      out.push(`${indent}${head}${left}${right === "" ? "" : `${pad}${gap}${right}`}`.trimEnd());
      for (const extra of row.under ?? []) {
        out.push(`${indent}${" ".repeat(markWidth === 0 ? 0 : markWidth + 1)}  ${extra}`.trimEnd());
      }
    });
    return out.join("\n");
  }
}

/**
 * The one shape a refusal is printed in (APRV-91 #8/#13).
 *
 *     ✗ payload-mismatch  message.json does not hash to the registered hash
 *       fix: approval payload hash message.json
 *
 * Glyph and machine-readable code in `fail`, message plain, and an optional
 * repair on a second line. NEVER followed by a help page: the operator did not
 * mistype anything, so the flags are not the answer and printing them buries
 * the one line that is.
 *
 * The `fix:` LABEL is dressed and the command after it is not, which departs
 * from the brief's "the command in `key`" on purpose. A fix line exists to be
 * copied and run, and rule 3 (never dress a copyable value) is the rule that
 * makes the whole palette safe to trust. The label alone carries the emphasis.
 *
 * Returned as text with no trailing newline, so callers keep control of the
 * stream and of whether a blank line follows.
 */
export function refusal(
  style: Style,
  code: string,
  message: string,
  fix?: string,
): string {
  const head = `${style.glyph("fail")} ${style.fail(code)}  ${message}`;
  return fix === undefined ? head : `${head}\n  ${style.key("fix:")} ${fix}`;
}

/** Build a style. Tests use this; the CLI uses {@link style}. */
export function makeStyle(input: StyleInput = {}): Style {
  const env = input.env ?? process.env;
  return new TerminalStyle(colourEnabled(input, env), asciiOnly(env));
}

let processStyle: Style | null = null;

/**
 * The process-wide style, decided once.
 *
 * `json` and `noColor` are known only after a command line is parsed, so the
 * first caller passes them and later callers get that same answer. A verb that
 * answers in JSON therefore has to ask FIRST, which every JSON branch does by
 * construction: it asks for the style before it prints.
 */
export function style(input: StyleInput = {}): Style {
  processStyle ??= makeStyle(input);
  return processStyle;
}

/** Forget the memoized answer. For tests, and for nothing else. */
export function resetStyle(): void {
  processStyle = null;
}

/**
 * The first 12 characters of a digest, for human output only.
 *
 * 12 hex characters is 48 bits: ample to tell two hashes in one report apart,
 * which is the entire job here, and short enough that two of them fit on a line
 * with their labels. The FULL value stays in `--json`, which is what anything
 * comparing hashes should be reading. Anything that is not a 64-hex digest is
 * returned untouched, so this is safe to apply to a field that may be null or
 * already short.
 */
export function shortHash(hash: string): string {
  return /^[0-9a-f]{64}$/iu.test(hash) ? hash.slice(0, SHORT_HASH_LENGTH) : hash;
}

/**
 * `path` relative to `cwd` when it is inside it, absolute otherwise.
 *
 * The dense-output complaint was largely this: the same 70-character absolute
 * path three times in one report. A path INSIDE the working directory is
 * printed relative because that is how the operator would type it. A path
 * outside stays absolute, because `../../../etc/approval/APPROVAL.md` is worse
 * than the truth in every way.
 */
export function relPath(path: string, cwd: string): string {
  if (path === "" || cwd === "") return path;
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
  if (path === cwd) return ".";
  return path.startsWith(base) ? path.slice(base.length) : path;
}
