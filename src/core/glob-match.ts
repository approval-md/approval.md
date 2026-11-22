/**
 * Shell glob components matched in bounded time (B-HOOK-GLOB-LINEAR).
 *
 * Both glob readers in the hook used to compile a component into one anchored
 * regular expression and test names with it: the credential and organ passes
 * in src/cli/hook.ts (`globRegex`: `*` as `.*`) and the `.git` reader in
 * src/core/command-class.ts (`globSegmentMatches`: `*` as `[^/]*`). A
 * component of many `*` made the engine backtrack, at a cost that grows with
 * (stars + name length) choose (name length) for each name tested. `cat` with
 * 240 `*` and 12 `z` spent 35.7 CPU s in the credential pass from a directory
 * holding `env` and `keys`, and with `auth.json` beside them 40 `*` took
 * 31 CPU s and 240 did not finish in 100 s; `echo x > ~/.hermes/` and 8 `*`
 * and 12 `z` spent 36.7 CPU s in the `.git` reader. Claude Code's hook
 * timeout is 60 s, and a hook stopped by it lets the call through.
 *
 * {@link matchGlobTokens} replaces the backtracking with a set-of-positions
 * walk: a component is a list of tokens, each either one character from a
 * set or a run (`*`) of characters from a set, and the walk keeps the set of
 * token positions the name read so far can reach. Runs of `*` collapse into
 * one token, and a name shorter than the component's one-character tokens is
 * refused before any walk, so one test costs at most (name length) x
 * (2 x name length + 1) token checks after a compile linear in the component.
 *
 * {@link globPattern} is the hook's reader, with the accepted syntax and the
 * answers of `globRegex` for every component and name (tests/hook-glob-match
 * ports `globRegex` as its oracle):
 *
 * - the component is read the way the engine read the expression built from
 *   it, under the `u` flag: `*` is any run of characters, `?` is one
 *   character, `[...]` is a class of literal characters and ranges (`a-z`);
 *   a class is never negated (`!` and `^` are members), `?` and `*` inside one
 *   are the members `.` and `*`, and `[` inside one is a member;
 * - `*` and `?` do not match a line terminator (`\n`, `\r`, U+2028, U+2029),
 *   as `.` does not;
 * - a component the engine refused (a lone `]`, an unclosed `[`, a reversed
 *   range such as `[z-a]`) matches as `^.*$` did: any name without a line
 *   terminator;
 * - `[]` is an empty class, which no character matches.
 */

/** A compiled glob component. `test` answers whether a whole name matches it. */
export interface GlobPattern {
  test(name: string): boolean;
}

/**
 * One position of a compiled component: a single character from a set, or,
 * when `run` is true, any number of characters from it (a `*`).
 */
export interface GlobToken {
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
export function singleCharacterTokens(tokens: readonly GlobToken[]): number {
  let single = 0;
  for (const token of tokens) if (!token.run) single += 1;
  return single;
}

/**
 * Does the whole of `name` (read by code point) match `tokens`? `single` is
 * {@link singleCharacterTokens} of `tokens`, counted once by the caller.
 */
export function matchGlobTokens(tokens: readonly GlobToken[], single: number, name: string): boolean {
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

const STAR = 0x2a;
const DOT = 0x2e;
const OPEN = 0x5b;
const DASH = 0x2d;

/** The expression `globRegex` built, item by item, before the engine parsed it. */
type Item =
  | { kind: "dot" }
  | { kind: "quantifier" }
  | { kind: "open" }
  | { kind: "close" }
  | { kind: "char"; code: number };

function itemsOf(component: string): Item[] {
  const items: Item[] = [];
  for (const char of component) {
    if (char === "*") items.push({ kind: "dot" }, { kind: "quantifier" });
    else if (char === "?") items.push({ kind: "dot" });
    else if (char === "[") items.push({ kind: "open" });
    else if (char === "]") items.push({ kind: "close" });
    // `globRegex` escaped `.+^${}()|\` and wrote every other character as
    // itself: either way the engine read a literal.
    else items.push({ kind: "char", code: char.codePointAt(0) as number });
  }
  return items;
}

/** What `^.*$` matched: everything without a line terminator. */
const MATCH_ALL: readonly GlobToken[] = [ANY_RUN];

/**
 * A character class's members, read as the engine reads `ClassRanges` under
 * the `u` flag: `A-B` is a range when a member follows the dash, a dash first
 * or last is a member, and a reversed range is an error (`null`).
 */
function classRanges(atoms: readonly number[]): number[] | null {
  const ranges: number[] = [];
  let index = 0;
  while (index < atoms.length) {
    const low = atoms[index] as number;
    if (atoms[index + 1] === DASH && index + 2 < atoms.length) {
      const high = atoms[index + 2] as number;
      if (low > high) return null;
      ranges.push(low, high);
      index += 3;
    } else {
      ranges.push(low, low);
      index += 1;
    }
  }
  return ranges;
}

function classToken(ranges: readonly number[]): GlobToken {
  return {
    run: false,
    matches: (code) => {
      for (let index = 0; index < ranges.length; index += 2) {
        if (code >= (ranges[index] as number) && code <= (ranges[index + 1] as number)) return true;
      }
      return false;
    },
  };
}

function compile(component: string): readonly GlobToken[] {
  const items = itemsOf(component);
  const tokens: GlobToken[] = [];
  const literals = new Map<number, GlobToken>();
  let index = 0;
  while (index < items.length) {
    const item = items[index] as Item;
    if (item.kind === "dot") {
      if (items[index + 1]?.kind === "quantifier") {
        if (tokens[tokens.length - 1] !== ANY_RUN) tokens.push(ANY_RUN);
        index += 2;
      } else {
        tokens.push(ANY_ONE);
        index += 1;
      }
    } else if (item.kind === "char") {
      let token = literals.get(item.code);
      if (token === undefined) {
        const code = item.code;
        token = { run: false, matches: (each) => each === code };
        literals.set(code, token);
      }
      tokens.push(token);
      index += 1;
    } else if (item.kind === "open") {
      const atoms: number[] = [];
      let at = index + 1;
      let closed = false;
      for (; at < items.length; at += 1) {
        const inner = items[at] as Item;
        if (inner.kind === "close") {
          closed = true;
          break;
        }
        if (inner.kind === "dot") atoms.push(DOT);
        else if (inner.kind === "quantifier") atoms.push(STAR);
        else if (inner.kind === "open") atoms.push(OPEN);
        else atoms.push(inner.code);
      }
      if (!closed) return MATCH_ALL;
      const ranges = classRanges(atoms);
      if (ranges === null) return MATCH_ALL;
      tokens.push(classToken(ranges));
      index = at + 1;
    } else {
      // A lone `]` (or a quantifier with nothing to repeat, which the
      // translation never writes) was a syntax error under the `u` flag.
      return MATCH_ALL;
    }
  }
  return tokens;
}

/** The hook's glob component as a whole-name matcher (see the module header). */
export function globPattern(component: string): GlobPattern {
  const tokens = compile(component);
  const single = singleCharacterTokens(tokens);
  return { test: (name: string): boolean => matchGlobTokens(tokens, single, name) };
}
