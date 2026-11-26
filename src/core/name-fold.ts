/** The code points HFS+ ignores inside a file name (Apple TN1150); see {@link foldFileName}. */
const HFS_IGNORED = /[\u200C-\u200F\u202A-\u202E\u206A-\u206F\uFEFF]/gu;

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
 * a trailing dot or space.
 *
 * HFS+, the volume format before APFS (still on older and external disks),
 * IGNORES some code points inside a name altogether (Apple TN1150's list):
 *
 * | Code point             | Opens        |
 * |------------------------|--------------|
 * | U+200C to U+200F       | nothing (dropped) |
 * | U+202A to U+202E       | nothing (dropped) |
 * | U+206A to U+206F       | nothing (dropped) |
 * | U+FEFF                 | nothing (dropped) |
 *
 * So on HFS+ `APPRO<U+200D>VAL.md`, `APPROVAL.md<U+FEFF>` and
 * `.appro<U+200D>val/env` are the guarded files (measured by a reviewer of
 * #688 on an HFS+ image, nine of these code points: 200C, 200D, 200E, 200F,
 * 202A, 202E, 206A, 206F and FEFF; APFS ignores none of them). The fold drops
 * them first. On APFS such a name is another file, so there the strip costs an
 * approval prompt and never an exposure. A segment made only of them folds to
 * the empty name, which no guarded name equals, and `.<U+200D>.` folds to
 * `..`, which the guards that read `..` treat as a parent step (stricter: the
 * `.codex` row, and the Hermes home's tail judged also with `..` resolved).
 * The as-spelled reading (below) keeps main's compare, so whatever main said
 * of such a spelling is still reported beside the folded class.
 *
 * Folded on every platform. On a case-sensitive volume (most Linux systems) a
 * folded match names a different file as guarded, which costs an approval
 * prompt and never an exposure.
 *
 * Two properties the guards rely on, both checked over every code point (each
 * alone, beside a combining mark, and beside an ignored code point): the fold
 * is idempotent, and it refines `toLowerCase()`, so two names equal after
 * `toLowerCase()` are equal after the fold too. A guard that compared
 * lower-cased names therefore matches at least what it matched before. The
 * fold never makes a `/`, a `\` or a `.` out of another character, so folding
 * a segment never changes how a path splits (dropping an ignored code point
 * can only bring two dots together, as above).
 *
 * Nothing else decides how a guarded name is folded: every guard compares
 * `foldFileName(a)` with `foldFileName(b)`, through the reading helpers below.
 */
export function foldFileName(text: string): string {
  if (!text.includes(SUBSTITUTION_SENTINEL)) return foldText(text);
  return text.split(SUBSTITUTION_SENTINEL).map(foldText).join(SUBSTITUTION_SENTINEL);
}

/** Is `text` made of ASCII alone ({@link foldText}'s fast path)? */
function asciiOnly(text: string): boolean {
  for (let at = 0; at < text.length; at += 1) if (text.charCodeAt(at) > 0x7f) return false;
  return true;
}

function foldText(text: string): string {
  // ASCII alone holds no ignored code point, NFD leaves it as it is, and its
  // lower, upper, lower round trip is its lower case: the same fold, read in
  // one pass (cost: a guard folds every segment of every path it tests).
  if (asciiOnly(text)) return text.toLowerCase();
  return text.replace(HFS_IGNORED, "").normalize("NFD").toLowerCase().toUpperCase().toLowerCase();
}

/**
 * What a `$(…)` leaves in a word's text: see `command-class.ts`, which reads
 * and re-exports it. It stands for text nobody has, so it is not a name and
 * {@link foldFileName} leaves it as it is.
 *
 * It is spelled in capitals. Folded like a name it became another string, so
 * every word holding a substitution counted as a name whose two readings
 * differ, and the whole as-spelled reading ran for it: twice the cost on any
 * line with a `$(…)` in a path word, for an answer that could not differ (no
 * guarded name holds a `$`).
 */
export const SUBSTITUTION_SENTINEL = "${__APPROVAL_SUBST__}";

/** The placeholder as a lowering compare spells it in the as-spelled reading. */
const SENTINEL_LOWERED = SUBSTITUTION_SENTINEL.toLowerCase();


// ===========================================================================
// Two readings of every name: folded, and as spelled
// ===========================================================================
//
// Folding a name can change WHICH guarded class a path takes, not only
// whether it takes one: `.approval/LOG/x` read as spelled is `policy.core`
// (`LOG` is not `log`, and `.approval` is the approval home), and folded it is
// `log.mutate`, which the classifier answers first. A policy may hold
// `policy.core` human-only and `log.mutate` lighter, so the folded answer
// alone can be lighter than the as-spelled one under some policy: the
// classifier's own order of tiers is not any policy's order of strictness.
//
// So every guard is read twice: FOLDED (the default, how APFS opens the name)
// and AS SPELLED (exactly how the guards read names before they folded: a
// compare that was exact stays exact, one that lowered stays lowered). Callers
// report the folded answer and every class the as-spelled answer adds beside
// it; a gate judges each class, and the strictest decision answers. A grant
// (an answer that makes something lighter) must hold in both readings.
//
// The reading is module state, set only by {@link withNamesAsSpelled}, whose
// `finally` restores it: a throw cannot leave it on, and nothing outside this
// file can set it. The classifier and the hook's passes are synchronous, and a
// callback that returns a promise is refused, so no continuation can run in
// the other reading.

let spelledReading = false;

/**
 * Did a name compare in the current folded run see a name whose folded and
 * as-spelled forms differ? Only then can the as-spelled run answer anything
 * else: see {@link eachNameReading}.
 */
let readingsDiverged = false;

/**
 * Which of several EQUAL claims the folded reading takes this turn, and the
 * most claims any compare offered in the current run: see
 * {@link takeAmongEqual}.
 */
let equalTurn = 0;
let widestEqual = 1;

/** Is the as-spelled reading on? For tests; nothing outside this file branches on it. */
export function namesReadAsSpelled(): boolean {
  return spelledReading;
}

/**
 * Has a name compare in the current folded run seen a name whose two readings
 * differ? With {@link markReadingsDiverged}, for a caller that remembers a
 * pure scan's answer and must leave this record as the scan itself would.
 */
export function readingsDivergedNow(): boolean {
  return readingsDiverged;
}

/** Record what a remembered scan recorded when it ran: see {@link readingsDivergedNow}. */
export function markReadingsDiverged(): void {
  readingsDiverged = true;
}

/**
 * A guarded name at a compare that was EXACT before names folded: folded in
 * the folded reading, the name itself in the as-spelled one.
 */
export function foldNameExact(text: string): string {
  if (spelledReading) return text;
  const folded = foldFileName(text);
  if (folded !== text) readingsDiverged = true;
  return folded;
}

/**
 * A guarded name at a compare that LOWERED it (`toLowerCase()`) before names
 * folded: folded in the folded reading, lowered in the as-spelled one.
 */
export function foldNameLower(text: string): string {
  if (spelledReading) return text.toLowerCase();
  const folded = foldFileName(text);
  if (!readingsDiverged) {
    const lowered = text.toLowerCase();
    // The as-spelled answer lowers the placeholder and the folded one keeps
    // it: the same word either way, so that alone is no divergence. The
    // placeholder is looked for only when the two already differ: this runs
    // once per name compared, and 400,000 plain words must not each pay for
    // a split and a join.
    if (
      folded !== lowered &&
      (!lowered.includes(SENTINEL_LOWERED) || folded !== lowered.split(SENTINEL_LOWERED).join(SUBSTITUTION_SENTINEL))
    ) {
      readingsDiverged = true;
    }
  }
  return folded;
}

const foldedLists = new WeakMap<readonly string[], readonly string[]>();

/**
 * Is `name` one of `list`, at a compare that was EXACT before names folded?
 * `name` must come from {@link foldNameExact}. Folded reading: against the
 * list's folded copy; as-spelled reading: against the list as written.
 */
export function nameListIncludes(list: readonly string[], name: string): boolean {
  if (spelledReading) return list.includes(name);
  let folded = foldedLists.get(list);
  if (folded === undefined) {
    folded = list.map(foldFileName);
    foldedLists.set(list, folded);
  }
  const hit = folded.includes(name);
  // `name` is the folded spelling. Where it equals the spelled one (else a
  // divergence is already recorded), the as-spelled compare is this one.
  if (hit !== list.includes(name)) readingsDiverged = true;
  return hit;
}

/**
 * Run `run` in the as-spelled reading, and restore the reading it was called
 * in afterwards, thrown or not.
 */
export function withNamesAsSpelled<T>(run: () => T): T {
  const before = spelledReading;
  spelledReading = true;
  try {
    return refusePromise(run());
  } finally {
    spelledReading = before;
  }
}

/**
 * Run `run`, whose answer already holds every name reading (it joins its own
 * {@link eachNameReading} answers, so its folded answer contains its
 * as-spelled one), without telling the caller's reading that names diverged
 * inside it: a divergence `run` records is undone, and one the caller recorded
 * before stays. So the caller is not read again as spelled for a value that
 * has no other reading to add. The caller's own compares still mark its
 * reading as before. #682's unknown-pattern classes: on a fresh entry list
 * every line that reached them was classified a second time, as spelled
 * (build-1's VERDICT on A682 queue red 3).
 */
export function apartFromCallerReading<T>(run: () => T): T {
  const before = readingsDiverged;
  try {
    return refusePromise(run());
  } finally {
    readingsDiverged = before;
  }
}

/**
 * `run`'s answer in the current reading, and whether it is the answer in
 * EVERY reading: `true` only in the folded reading, when no name compare
 * inside `run` met a name whose two readings differ and none offered more
 * than one equal claim. That is the test {@link eachNameReading} skips its
 * other runs on, applied to `run` alone: with no divergence the as-spelled
 * run takes the same branches over the same values, and with no claim set
 * wider than one every turn takes the same claim. As spelled the helpers
 * mark nothing, so the answer there is never called invariant.
 *
 * What `run` marks still reaches the caller's reading, as if it ran inline.
 */
export function inEveryReading<T>(run: () => T): { value: T; invariant: boolean } {
  const outer = { diverged: readingsDiverged, widest: widestEqual };
  readingsDiverged = false;
  widestEqual = 1;
  let value: T;
  let invariant = false;
  try {
    value = refusePromise(run());
    invariant = !spelledReading && !readingsDiverged && widestEqual === 1;
  } finally {
    readingsDiverged = outer.diverged || readingsDiverged;
    widestEqual = Math.max(outer.widest, widestEqual);
  }
  return { value, invariant };
}

/**
 * `run`'s answer once per equal claim its own compares offer (turn `k` takes
 * claim `k mod n` of a set of `n`, as {@link eachNameReading}'s turns do), in
 * the current reading, the first turn first. The caller has every turn's
 * answer, so the widened claims are not passed on: the caller is not run
 * again in another turn for this value alone (the claims of the caller's own
 * compares still widen its reading). As spelled every claim is the first:
 * `[run()]`. A divergence `run` marks reaches the caller as before.
 */
export function inEachEqualTurn<T>(run: () => T): [T, ...T[]] {
  if (spelledReading) return [refusePromise(run())];
  const outer = { turn: equalTurn, widest: widestEqual };
  widestEqual = 1;
  try {
    equalTurn = 0;
    const answers: [T, ...T[]] = [refusePromise(run())];
    for (equalTurn = 1; equalTurn < widestEqual; equalTurn += 1) answers.push(refusePromise(run()));
    return answers;
  } finally {
    equalTurn = outer.turn;
    widestEqual = outer.widest;
  }
}

/** Is {@link localReadingStart} on? Only inside {@link withLocalReadingsSettled}. */
let settleLocalReadings = false;

/**
 * `run`, with {@link localReadingStart}'s runs on: a run of compares whose
 * divergence leaves its answer the same does not mark the reading. For one
 * caller: the hook's synthetic line of plain names, whose answer is shared by
 * every reading where it holds in every reading (`redirectMatchClasses`).
 * Everywhere else every divergence marks, as before, so no other line's
 * readings change. The switch is restored afterwards, thrown or not.
 */
export function withLocalReadingsSettled<T>(run: () => T): T {
  const before = settleLocalReadings;
  settleLocalReadings = true;
  try {
    return refusePromise(run());
  } finally {
    settleLocalReadings = before;
  }
}

/**
 * Would {@link localReadingStart} start a run here (folded, inside
 * {@link withLocalReadingsSettled})? Where it would not, the run marks as
 * inline and nothing is settled, so a caller may judge inline.
 */
export function localReadingsSettling(): boolean {
  return settleLocalReadings && !spelledReading;
}

/**
 * The start of a run of compares whose divergence may be undone, where it
 * turns out not to change what they answer ({@link localReadingEnd},
 * {@link localReadingSame}). The caller's marks are set aside and handed
 * back, to give to both; `-1` as spelled, or outside
 * {@link withLocalReadingsSettled}, where the run marks as inline. Two calls
 * and a number, not a closure: the protected-path tier asks once per word.
 */
export function localReadingStart(): number {
  if (spelledReading || !settleLocalReadings) return -1;
  const saved = widestEqual * 2 + (readingsDiverged ? 1 : 0);
  readingsDiverged = false;
  widestEqual = 1;
  return saved;
}

/**
 * The end of a run begun by {@link localReadingStart}, called in a `finally`:
 * the run's marks join the caller's, as if it ran inline. `true` when the run
 * marked a divergence and offered no claim set wider than one: the caller may
 * then run the same compares as spelled ({@link withNamesAsSpelled}) and, where
 * they answer the same, call {@link localReadingSame}.
 */
export function localReadingEnd(saved: number): boolean {
  if (saved < 0) return false;
  const settle = readingsDiverged && widestEqual === 1;
  readingsDiverged = (saved & 1) === 1 || readingsDiverged;
  widestEqual = Math.max(Math.floor(saved / 2), widestEqual);
  return settle;
}

/**
 * The run {@link localReadingEnd} let the caller compare answers the same as
 * spelled: the caller's reading is left as it was before the run. So a caller
 * whose names diverge only inside it, with no effect on what it answers, is
 * not read again as spelled for that alone (the hook's synthetic lines: every
 * segment of `/Users/x/…` diverges, and the protected-path tier answers the
 * same in both readings). Sound by {@link eachNameReading}'s own test applied
 * to the caller: its as-spelled run gets the same value at that point, and
 * every other compare it makes still marks. The run must answer by its value
 * alone (a module flag it sets is part of that value: the caller compares it
 * too, and keeps the folded run's).
 */
export function localReadingSame(saved: number): void {
  if (saved >= 0) readingsDiverged = (saved & 1) === 1;
}

function refusePromise<T>(value: T): T {
  if (typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function") {
    throw new TypeError("a name reading runs synchronously; a promise would finish in the other reading");
  }
  return value;
}

/**
 * One of several claims on a name that nothing in the text ranks: two routed
 * policy entries of the same depth that both match a path (they can differ
 * only by case, `SPEC/` beside `spec/`), or a built-in class beside a route
 * the policy spelled in another case. A pure reader cannot say which is the
 * stricter (that is the policy's to say), so the folded reading takes EACH in
 * turn: {@link eachNameReading} runs once per claim and its callers judge
 * every answer, as they judge the two name readings. The as-spelled reading
 * takes the first, as the guards did before names folded.
 *
 * `claims` must not be empty.
 */
export function takeAmongEqual<T>(claims: readonly T[]): T {
  const first = claims[0];
  if (first === undefined) throw new TypeError("takeAmongEqual needs a claim");
  if (spelledReading) return first;
  if (claims.length > widestEqual) widestEqual = claims.length;
  return claims[equalTurn % claims.length] as T;
}

/**
 * The equal claims a compare offers the caller to gather (and hand on to
 * {@link takeAmongEqual} once it has every one): all of them folded, the
 * first alone as spelled.
 */
export function equalClaims<T>(claims: readonly T[]): readonly T[] {
  return spelledReading ? claims.slice(0, 1) : claims;
}

/**
 * Does a rule that holds in the FOLDED reading only apply here? `true` folded,
 * `false` as spelled. Calling it records that this compare's two readings
 * differ, so {@link eachNameReading} runs the as-spelled reading too and the
 * caller reports both answers: the as-spelled one is exactly the answer the
 * guards gave before the rule existed. Call it only where the rule would
 * otherwise apply, so a line it never reaches pays for one reading. Used for
 * the `.claude-<suffix>` settings rule (S2: a spelling keeps the class main
 * gave it, as 7bff5543 did for folded names).
 */
export function inFoldedReadingOnly(): boolean {
  if (spelledReading) return false;
  readingsDiverged = true;
  return true;
}

/**
 * Answers that only the folded reading reports, beside the one the guards
 * gave before names folded (every OTHER guarded class a segment's targets
 * take): `make()` folded, nothing as spelled, so the as-spelled reading stays
 * exactly the old answer.
 */
export function foldedOnly<T>(make: () => readonly T[]): readonly T[] {
  return spelledReading ? [] : make();
}

/**
 * `make()` in the folded reading, `null` as spelled: an answer only the folded
 * reading reports, as {@link foldedOnly} is, made QUIETLY: a name compare
 * inside it that would differ as spelled does not make {@link eachNameReading}
 * run the as-spelled reading, which has no such answer to compare (for a
 * reading that walks the guarded names themselves, the spliced reading in
 * `command-class.ts`, where every walk meets a name that folds). A set of
 * equal claims it meets does not turn the whole line either: the caller takes
 * every claim inside, with {@link eachEqualClaim} (automated security review
 * of the spliced reading, c; a line's second turn doubled its cost).
 */
export function foldedOnlyQuietly<T>(make: () => T): T | null {
  if (spelledReading) return null;
  const diverged = readingsDiverged;
  const widest = widestEqual;
  try {
    return refusePromise(make());
  } finally {
    readingsDiverged = diverged;
    widestEqual = widest;
  }
}

/**
 * `run`'s answer once per claim of the widest set of equal claims it meets
 * ({@link takeAmongEqual}), in this call alone: the turns do not reach the
 * line's {@link eachNameReading}. As spelled, `[run()]`.
 */
export function eachEqualClaim<T>(run: () => T): T[] {
  if (spelledReading) return [refusePromise(run())];
  const outer = { turn: equalTurn, widest: widestEqual };
  equalTurn = 0;
  widestEqual = 1;
  const answers: T[] = [];
  try {
    answers.push(refusePromise(run()));
    for (equalTurn = 1; equalTurn < widestEqual; equalTurn += 1) answers.push(refusePromise(run()));
  } finally {
    equalTurn = outer.turn;
    widestEqual = outer.widest;
  }
  return answers;
}

/**
 * `run`'s answer in each reading: `[folded]`, `[folded, asSpelled]`, or, where
 * the folded reading met equal claims ({@link takeAmongEqual}), the folded
 * answer once per claim and then the as-spelled one.
 *
 * Inside the as-spelled reading this is `[run()]`, already as spelled. In the
 * folded one, `run` runs folded first, and the as-spelled run is SKIPPED when
 * no name compare during the folded run met a name whose two readings differ
 * ({@link foldNameExact}, {@link foldNameLower} and {@link nameListIncludes}
 * record it). The skip is sound because those three helpers and
 * {@link takeAmongEqual} are the only places the readings differ: when every
 * name helper returned what it would have returned as spelled, the as-spelled
 * run takes the same branches over the same values, and where it meets equal
 * claims it takes the first, which is the folded run's first turn (the
 * callers put the claim the as-spelled reading takes first, or report it
 * with a divergence). A divergence or a set of equal claims inside a nested
 * reading counts for the outer one too.
 *
 * The folded turns are as many as the widest set of equal claims any compare
 * offered: turn `k` takes claim `k mod n` of a set of `n`, so every claim of
 * every set is taken in some turn. At most one turn per routed policy entry.
 */
export function eachNameReading<T>(run: () => T): [T, ...T[]] {
  if (spelledReading) return [refusePromise(run())];
  const outer = { diverged: readingsDiverged, turn: equalTurn, widest: widestEqual };
  readingsDiverged = false;
  equalTurn = 0;
  widestEqual = 1;
  let answers: [T, ...T[]];
  let diverged = true;
  try {
    answers = [refusePromise(run())];
    for (equalTurn = 1; equalTurn < widestEqual; equalTurn += 1) answers.push(refusePromise(run()));
    diverged = readingsDiverged;
  } finally {
    readingsDiverged = outer.diverged || readingsDiverged;
    widestEqual = Math.max(outer.widest, widestEqual);
    equalTurn = outer.turn;
  }
  if (diverged) answers.push(withNamesAsSpelled(run));
  return answers;
}
