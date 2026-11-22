/**
 * The hook's glob components matched in bounded time (B-HOOK-GLOB-LINEAR).
 *
 * The credential and organ passes in src/cli/hook.ts compiled each glob
 * component into one anchored regular expression (`globRegex`: `*` as `.*`)
 * and tested names with it. A component of many `*` made the engine
 * backtrack, at a cost that grows with (stars + name length) choose (name
 * length) for each name tested: `cat` with 240 `*` and 12 `z` spent 35.7 CPU s
 * in the credential pass from a directory holding `env` and `keys`, and with
 * `auth.json` beside them 40 `*` took 31 CPU s. Claude Code's hook timeout is
 * 60 s, and a hook stopped by it lets the call through. (The `.git` reader in
 * src/core/command-class.ts had the same fault; #680 gave it its own walk.)
 *
 * {@link matchGlobTokens} replaces the backtracking with a set-of-positions
 * walk: a component is a list of tokens, each either one character from a
 * set or a run (`*`) of characters from a set, and the walk keeps the set of
 * token positions the name read so far can reach. Runs of `*` collapse into
 * one token, and a name shorter than the component's one-character tokens is
 * refused before any walk, so one test costs at most (name length) x
 * (2 x name length + 1) token checks after a compile linear in the component
 * (a class's members sorted once, natively, so each check is a binary
 * search). The compile reads each character once: an unclosed `[` ends it.
 *
 * {@link globPattern} is the hook's reader. Its rule (review-b's FINDING on
 * 8c91e702, and the lead's rulings L60812 and L60846: "negation as the shell
 * does, strict where it cannot decide") is that a component matches at least
 * every name bash 3.2, zsh or dash would expand it to, in any locale, so a
 * path is classed as what the shell will open. It is handed the word as the
 * hook's lexer leaves it, quotes and escapes removed. Where the old expression
 * already met that rule, the answer is the old one (tests/hook-glob-match
 * ports `globRegex` as its oracle, and compares negated classes with the
 * shells themselves):
 *
 * - an ASCII letter matches either case, written alone or in a class (a
 *   shell with nocaseglob set does, and the hook cannot see an option set
 *   outside the command it is handed);
 * - `*` is any run of characters and `?` one character; neither matches a
 *   line terminator (`\n`, `\r`, U+2028, U+2029), as the old `.` did not;
 * - `[!...]` and `[^...]` are any one character: bash and zsh negate both,
 *   dash reads `^` as a member, and a `!` the command escaped or quoted
 *   (`[\!h]`) is a member, which the lexer's text no longer shows;
 * - `[...]` is a class of literal characters and ranges, as the old
 *   expression read it (`*` inside one is the members `.` and `*`). A range
 *   of letters also holds the other case (bash 3.2 under en_US.UTF-8 reads
 *   `[A-H]` as holding `h`), and any other range not within the digits
 *   (`[_-a]` holds `.` there) makes the class any one character;
 * - the component matches any name (`^.*$`, as the old expression did when
 *   the engine refused it) when it holds a form the shells read apart: a lone
 *   `]`, an unclosed `[`, `[]`, `[!]` or `[^]`, a `[` or `?` inside a class
 *   (POSIX classes included), a reversed range, a backslash, `(`, `)`, `|`,
 *   `<`, `>`, `#`, `~`, or a `^` outside a class (bash's extglob, zsh's
 *   groups, numeric ranges and extended glob).
 */

/** A compiled glob component. `test` answers whether a whole name matches it. */
export interface GlobPattern {
  test(name: string): boolean;
}

/**
 * One position of a compiled component: a single character from a set, or,
 * when `run` is true, any number of characters from it (a `*`).
 */
interface GlobToken {
  readonly run: boolean;
  matches(code: number): boolean;
}

/** Mark every position reachable from a marked one by taking a run zero times. */
function closeOverRuns(tokens: readonly GlobToken[], reached: Uint8Array): void {
  for (let index = 0; index < tokens.length; index += 1) {
    if (reached[index] === 1 && (tokens[index] as GlobToken).run) reached[index + 1] = 1;
  }
}

/** How many of `tokens` take exactly one character: the shortest name that can match. */
function singleCharacterTokens(tokens: readonly GlobToken[]): number {
  let single = 0;
  for (const token of tokens) if (!token.run) single += 1;
  return single;
}

/**
 * Does the whole of `name` (read by code point) match `tokens`? `single` is
 * {@link singleCharacterTokens} of `tokens`, counted once by the caller.
 */
function matchGlobTokens(tokens: readonly GlobToken[], single: number, name: string): boolean {
  const codes: number[] = [];
  for (const char of name) codes.push(char.codePointAt(0) as number);
  if (codes.length < single) return false;
  if (single === tokens.length && codes.length !== single) return false;
  let current = new Uint8Array(tokens.length + 1);
  let next = new Uint8Array(tokens.length + 1);
  current[0] = 1;
  closeOverRuns(tokens, current);
  for (const code of codes) {
    next.fill(0);
    let live = false;
    for (let index = 0; index < tokens.length; index += 1) {
      if (current[index] !== 1) continue;
      const token = tokens[index] as GlobToken;
      if (!token.matches(code)) continue;
      next[token.run ? index : index + 1] = 1;
      live = true;
    }
    if (!live) return false;
    closeOverRuns(tokens, next);
    [current, next] = [next, current];
  }
  return current[tokens.length] === 1;
}

function isLineTerminator(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029;
}

const ANY_RUN: GlobToken = { run: true, matches: (code) => !isLineTerminator(code) };
const ANY_ONE: GlobToken = { run: false, matches: (code) => !isLineTerminator(code) };
/** A class whose members the shells disagree on: every character, line terminators too. */
const ANY_CHARACTER: GlobToken = { run: false, matches: () => true };

const STAR = 0x2a;
const QUESTION = 0x3f;
const DOT = 0x2e;
const OPEN = 0x5b;
const CLOSE = 0x5d;
const DASH = 0x2d;
const BANG = 0x21;
const CARET = 0x5e;

/**
 * Characters that make the whole component match any name wherever they
 * stand: a backslash (an escape to the shell, a literal to the old
 * expression), bash's extglob and zsh's groups (`(`, `)`, `|`), zsh's numeric
 * ranges (`<`, `>`) and its extended glob (`#`, `~`).
 */
const UNDECIDED: ReadonlySet<number> = new Set([0x5c, 0x28, 0x29, 0x7c, 0x3c, 0x3e, 0x23, 0x7e]);

/** What `^.*$` matched: everything without a line terminator. */
const MATCH_ALL: readonly GlobToken[] = [ANY_RUN];

/** The component's code points, read once. */
function codesOf(component: string): number[] {
  const codes: number[] = [];
  for (let at = 0; at < component.length; at += 1) {
    const code = component.codePointAt(at) as number;
    codes.push(code);
    if (code > 0xffff) at += 1;
  }
  return codes;
}

/**
 * The other case of an ASCII letter, or the code itself. A shell with
 * nocaseglob set (bash's shopt, zsh's setopt, in the same command, in an rc
 * file a harness's shell snapshot carries, or in a shell that persists
 * between calls) matches a letter in either case, and a case-insensitive
 * volume opens either spelling, so every letter here matches both.
 */
function otherCase(code: number): number {
  if (code >= 0x41 && code <= 0x5a) return code + 0x20;
  if (code >= 0x61 && code <= 0x7a) return code - 0x20;
  return code;
}

/** The ASCII group a range end belongs to: 1 digits, 2 lower case, 3 upper case, 0 none. */
function rangeGroup(code: number): number {
  if (code >= 0x30 && code <= 0x39) return 1;
  if (code >= 0x61 && code <= 0x7a) return 2;
  if (code >= 0x41 && code <= 0x5a) return 3;
  return 0;
}

/**
 * A plain class's members (`[...]`, not negated), read as the old expression
 * read `ClassRanges` under the `u` flag (`A-B` is a range when a member
 * follows the dash, a dash first or last is a member), widened where a shell
 * reads more: a range of letters also holds the other case, and a range that
 * is not within one ASCII group (its members follow the locale's collation)
 * makes the class any character (`"any"`). `null` for a reversed range, the
 * old expression's error: the component matches any name.
 */
function plainClassRanges(atoms: readonly number[]): number[] | "any" | null {
  const ranges: number[] = [];
  let any = false;
  let index = 0;
  while (index < atoms.length) {
    const low = atoms[index] as number;
    if (atoms[index + 1] === DASH && index + 2 < atoms.length) {
      const high = atoms[index + 2] as number;
      if (low > high) return null;
      index += 3;
      const group = rangeGroup(low);
      if (low === high) ranges.push(low, low, otherCase(low), otherCase(low));
      else if (group === 0 || group !== rangeGroup(high)) any = true;
      else {
        ranges.push(low, high);
        if (group === 2) ranges.push(low - 0x20, high - 0x20);
        if (group === 3) ranges.push(low + 0x20, high + 0x20);
      }
    } else {
      ranges.push(low, low, otherCase(low), otherCase(low));
      index += 1;
    }
  }
  return any ? "any" : ranges;
}

/**
 * A class as a token whose test is a binary search (codex caveat 2 on #682).
 * The ranges are packed one number each, sorted natively and merged once, at
 * compile time (M1 of review-b's re-gate on 8c91e702: sorting pairs with a
 * comparator was most of a big class's compile).
 */
function classToken(ranges: readonly number[]): GlobToken {
  const count = ranges.length / 2;
  const keys = new Float64Array(count);
  // Code points are below 0x200000, so low * 0x200000 + high orders by low
  // first and is exact in a double.
  for (let index = 0; index < count; index += 1) {
    keys[index] = (ranges[2 * index] as number) * 0x200000 + (ranges[2 * index + 1] as number);
  }
  keys.sort();
  const lows: number[] = [];
  const highs: number[] = [];
  for (const key of keys) {
    const low = Math.floor(key / 0x200000);
    const high = key - low * 0x200000;
    const last = highs.length - 1;
    if (last >= 0 && low <= (highs[last] as number) + 1) {
      if (high > (highs[last] as number)) highs[last] = high;
    } else {
      lows.push(low);
      highs.push(high);
    }
  }
  return {
    run: false,
    matches: (code) => {
      // The last merged range whose low end is at or below `code`.
      let low = 0;
      let high = lows.length - 1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        if ((lows[middle] as number) <= code) low = middle + 1;
        else high = middle - 1;
      }
      return high >= 0 && code <= (highs[high] as number);
    },
  };
}

function compile(component: string): readonly GlobToken[] {
  const codes = codesOf(component);
  for (const code of codes) if (UNDECIDED.has(code)) return MATCH_ALL;
  const tokens: GlobToken[] = [];
  const literals = new Map<number, GlobToken>();
  let index = 0;
  while (index < codes.length) {
    const code = codes[index] as number;
    if (code === STAR) {
      if (tokens[tokens.length - 1] !== ANY_RUN) tokens.push(ANY_RUN);
      index += 1;
    } else if (code === QUESTION) {
      tokens.push(ANY_ONE);
      index += 1;
    } else if (code === CLOSE || code === CARET) {
      // A lone `]` was a syntax error under the `u` flag; a `^` outside a
      // class is zsh's extended-glob negation.
      return MATCH_ALL;
    } else if (code === OPEN) {
      // `[!...]` and `[^...]` are any one character. bash and zsh negate both,
      // dash reads `^` as a member, and an escaped or quoted `!` (`[\!h]`,
      // `["!"h]`) is a member to every shell, while the hook's lexer hands
      // this reader the word with the escape and the quotes removed: between
      // the readings, every character. `[]`, `[!]` and `[^]` open a class the
      // readings close in different places.
      const lead = codes[index + 1];
      const negated = lead === BANG || lead === CARET;
      const from = negated ? index + 2 : index + 1;
      if (codes[from] === CLOSE) return MATCH_ALL;
      const atoms: number[] = [];
      let at = from;
      for (; at < codes.length && codes[at] !== CLOSE; at += 1) {
        const inner = codes[at] as number;
        if (inner === OPEN || inner === QUESTION) return MATCH_ALL;
        // The old expression read `*` inside a class as `.*`: two members.
        if (inner === STAR) atoms.push(DOT, STAR);
        else atoms.push(inner);
      }
      if (at >= codes.length) return MATCH_ALL;
      index = at + 1;
      if (negated) {
        tokens.push(ANY_CHARACTER);
        continue;
      }
      const ranges = plainClassRanges(atoms);
      if (ranges === null) return MATCH_ALL;
      tokens.push(ranges === "any" ? ANY_CHARACTER : classToken(ranges));
    } else {
      let token = literals.get(code);
      if (token === undefined) {
        const other = otherCase(code);
        token = { run: false, matches: (each) => each === code || each === other };
        literals.set(code, token);
      }
      tokens.push(token);
      index += 1;
    }
  }
  return tokens;
}

/**
 * Compiled components, kept so that a caller testing the same component again
 * (the credential pass judges a word once for each place its prefix may land,
 * and once for each combination of its directory patterns) compiles it once
 * (M1 of review-b's re-gate on 8c91e702). Emptied past
 * {@link COMPILED_CHARACTERS_CAP} characters of components.
 */
const compiled = new Map<string, GlobPattern>();
let compiledCharacters = 0;
const COMPILED_CHARACTERS_CAP = 4_000_000;

/** Any name without a line terminator: what the hook reads a pattern as once the command sets a shell option. */
export const ANY_NAME: GlobPattern = { test: (name: string): boolean => matchGlobTokens(MATCH_ALL, 0, name) };

/** The hook's glob component as a whole-name matcher (see the module header). */
export function globPattern(component: string): GlobPattern {
  const known = compiled.get(component);
  if (known !== undefined) return known;
  const tokens = compile(component);
  const single = singleCharacterTokens(tokens);
  const pattern: GlobPattern = { test: (name: string): boolean => matchGlobTokens(tokens, single, name) };
  if (compiledCharacters + component.length > COMPILED_CHARACTERS_CAP) {
    compiled.clear();
    compiledCharacters = 0;
  }
  compiled.set(component, pattern);
  compiledCharacters += component.length;
  return pattern;
}
