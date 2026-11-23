/**
 * How the gate folds a file name before it compares it with a guarded name.
 *
 * The guards read path names as text, and the filesystem the agent writes to
 * may not. APFS, macOS's default volume, opens a name under FULL Unicode case
 * folding, so `Approval.MD`, `.Claude/settings.json` and `.APPROVAL/env` are
 * the guarded files themselves there. Measured on APFS (macOS 26, every code
 * point from U+0080 to U+10FFFF tried against an ASCII name): besides the ASCII
 * letters in either case, eleven code points open an ASCII name.
 *
 * | Code point            | Opens |
 * |-----------------------|-------|
 * | U+212A (Kelvin sign)  | `k`   |
 * | U+017F (long s)       | `s`   |
 * | U+00DF, U+1E9E (ß, ẞ) | `ss`  |
 * | U+FB00 (ﬀ)            | `ff`  |
 * | U+FB01 (ﬁ)            | `fi`  |
 * | U+FB02 (ﬂ)            | `fl`  |
 * | U+FB03 (ﬃ)            | `ffi` |
 * | U+FB04 (ﬄ)            | `ffl` |
 * | U+FB05, U+FB06 (ﬅ, ﬆ) | `st`  |
 *
 * `toLowerCase()` alone folds only the first of them. The fold below folds all
 * eleven: NFD splits a precomposed letter, the lower, upper, lower round trip
 * applies the full case mappings (`ß` to `SS` to `ss`, `ﬁ` to `FI` to `fi`).
 * It is stricter than the filesystem on one code point: the dotless i (U+0131)
 * folds to `i` here and is a different name on APFS. Not folded by APFS, and
 * not here: the dotted capital I (U+0130) to plain `i`, fullwidth letters,
 * zero-width characters, a trailing dot or space.
 *
 * Folded on every platform. On a case-sensitive volume (most Linux systems) a
 * folded match names a different file as guarded, which costs an approval
 * prompt and never an exposure.
 *
 * Two properties the guards rely on, both checked over every code point (each
 * alone and beside a combining mark): the fold is idempotent, and it refines
 * `toLowerCase()`, so two names equal after `toLowerCase()` are equal after the
 * fold too. A guard that compared lower-cased names therefore matches at least
 * what it matched before. The fold never makes a `/`, a `\` or a `.` out of
 * another character, so folding a segment never changes how a path splits.
 *
 * Nothing else decides how a guarded name is folded: every guard compares
 * `foldFileName(a)` with `foldFileName(b)`.
 */
export function foldFileName(text: string): string {
  return text.normalize("NFD").toLowerCase().toUpperCase().toLowerCase();
}
