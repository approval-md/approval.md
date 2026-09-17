/**
 * Read scope: which directories an agent may read from (APRV-347).
 *
 * ## The hole this closes
 *
 * Writes and deletes have been path-scoped for a while. `files.delete.scratch`
 * versus `files.delete.out_of_scope` is decided by comparing a resolved target
 * against roots the caller supplied (`ClassifierContext.scratchRoots`), and the
 * file tools carry their target into the payload a grant binds. Reads had none
 * of that: every shell reader classified `read.shell` with no path bound, and
 * `Read`, `Glob` and `Grep` were answered `allow` before classification ever
 * ran. So a policy could say a great deal about what an agent may WRITE and
 * nothing at all about what it may SEE, and an agent working in one directory
 * could read every sibling of it.
 *
 * This module is the pure half of the read-side mirror. It holds the class
 * name, the roots arithmetic, and the one genuinely fiddly question — which
 * words of a read command are paths — and it touches no disk, reads no
 * environment and resolves nothing. The impure half (relative paths resolved
 * against a working directory, symlinks followed, the escape that only the
 * filesystem can see) lives in `src/cli/hook.ts`, exactly where the delete
 * rule's second pass lives, and it can only ever TIGHTEN this file's answer.
 *
 * ## Fail closed, in three places
 *
 * SPEC.md §11.1: ambiguity resolves to the stricter path. Here that is
 *
 * 1. a target this file cannot read as a path (a `$VAR`, a glob, a `~`) is out
 *    of scope, because what it expands to is not in the text;
 * 2. a read command naming NO target reads the working directory, so it is
 *    checked against the working directory rather than waved through;
 * 3. an empty root list means nothing is in scope — but a caller that passes no
 *    roots at all gets today's answer instead (see {@link ClassifierContext}),
 *    because a caller that forgot the field must not have every read it makes
 *    turned into a decision.
 *
 * ## What a root is
 *
 * The gate root (the directory holding the policy file the runtime resolved),
 * the session scratchpad, and the system temp root. A policy may WIDEN that
 * with `read_scope.roots`; it may not narrow it below the gate root, because a
 * runtime that cannot read its own policy, log and workspace cannot run at all.
 */

/**
 * The class a read outside every root takes.
 *
 * A sibling of `read.shell` rather than a replacement for it: a read INSIDE the
 * roots is the same ordinary, autonomous act it has always been, and a policy
 * that says nothing about this class gets `defaults.autonomy` for it, which is
 * the fail-closed direction for a name nobody has declared.
 */
export const READ_OUT_OF_SCOPE_CLASS = "read.file.out_of_scope";

/**
 * The `read_scope` block of a policy (SPEC.md §5, amended APRV-347).
 *
 * Additive and optional, with the same discipline `protected_paths` has: the
 * built-in roots stand whatever this says, so a policy can widen the scope and
 * never shrink it. A relative entry is resolved against the gate root, so a
 * policy stays portable between a checkout and a clone of it.
 */
export interface ReadScope {
  roots?: string[];
}

/** Non-empty path segments, `.` dropped. Identical to the classifier's own. */
function segmentsOf(candidate: string): string[] {
  return candidate
    .split(/[/\\]+/u)
    .filter((segment) => segment.length > 0 && segment !== ".");
}

/**
 * Is `candidate` AT or under `root`, by path segment?
 *
 * At-or-under rather than the delete rule's strictly-under: `ls <gate root>` is
 * a read of the workspace an agent is working in, and a rule that made the root
 * itself out of scope would classify the most ordinary command in the session.
 *
 * Segment matching, never string prefixes: `/dev/muse-other` must not match a
 * root of `/dev/muse`, and `startsWith` says it does.
 */
export function isAtOrUnderReadRoot(candidate: string, root: string): boolean {
  const want = segmentsOf(root);
  const have = segmentsOf(candidate);
  if (want.length === 0) return false;
  if (have.length < want.length) return false;
  return want.every((segment, index) => segment === have[index]);
}

/** Is this path inside ANY of these roots? */
export function isInReadScope(candidate: string, roots: readonly string[]): boolean {
  return roots.some((root) => isAtOrUnderReadRoot(candidate, root));
}

/**
 * A value whose expansion the classifier cannot see, and therefore may not
 * vouch for. The same test the delete rule applies, and for the same reason:
 * `cat $SOMEWHERE` reads whatever that variable holds.
 */
export function isUnreadableTarget(word: string): boolean {
  return (
    word.includes("$") ||
    word.includes("*") ||
    word.includes("?") ||
    word.includes("[") ||
    word.startsWith("~")
  );
}

/**
 * The effective read roots: the built-ins, plus whatever the policy added.
 *
 * Pure, and every input is the caller's. `gateRoot` is the directory holding
 * the policy file the runtime resolved; `systemRoots` are the scratchpad and
 * temp roots the caller already resolved (`resolveScratchRoots` in the hook);
 * `declared` is `read_scope.roots` verbatim.
 *
 * A declared entry that is relative is joined onto the gate root. A declared
 * entry the caller cannot vouch for — empty, or one this file can see is not a
 * path at all — is DROPPED rather than accepted, because a root is an
 * authorization and a malformed one must not become `/`.
 *
 * The result is de-duplicated and otherwise in the order given, so the first
 * root a path matches is the most specific one a reader would expect.
 */
export function effectiveReadRoots(options: {
  gateRoot: string;
  declared?: readonly string[] | undefined;
  systemRoots?: readonly string[] | undefined;
}): string[] {
  const roots: string[] = [];
  const add = (candidate: string): void => {
    if (candidate.length === 0) return;
    if (!roots.includes(candidate)) roots.push(candidate);
  };
  add(options.gateRoot);
  for (const root of options.systemRoots ?? []) add(root);
  for (const entry of options.declared ?? []) {
    if (typeof entry !== "string" || entry.length === 0) continue;
    if (isUnreadableTarget(entry)) continue;
    add(entry.startsWith("/") ? entry : `${options.gateRoot}/${entry}`);
  }
  return roots;
}

// ---------------------------------------------------------------------------
// Which words of a read command are paths
// ---------------------------------------------------------------------------

/**
 * How a reader's positionals map to paths.
 *
 * - `all`: every positional is a file or directory (`cat a b`, `ls src`,
 *   `diff a b`, `cut -d: -f1 /etc/passwd` — `cut`'s delimiter and field list
 *   are flags, so none of its positionals is a pattern).
 * - `after-pattern`: the FIRST positional is a pattern or a script and the rest
 *   are paths (`grep needle src`, `sed -n 1,5p file`, `jq .x file.json`) —
 *   UNLESS the pattern arrived through a flag (`-e`, `-f`), in which case every
 *   positional is a path and the shape collapses to `all`.
 * - `walk`: `find`'s shape — positionals up to the first primary are paths.
 *
 * Binaries absent from this table are absent on purpose, and each omission is a
 * decision not to widen anything:
 *
 * - `echo`, `printf`, `tr`, `test`, `type`, `which`, `pwd`, `true`, `false`,
 *   `cd`: their positionals are not files, or name a file without reading its
 *   contents. A rule that treated `echo /etc/passwd` as a read of that file
 *   would route text through a human.
 * - `basename`, `dirname`, `readlink`, `realpath`: they manipulate or resolve a
 *   path and never open it. What leaks is the existence of a name, which is not
 *   what this class is about.
 * - `less` and `more` are NOT added to the classifier's reader list by this
 *   task. Adding them would take them from `unclassified` (a deny) to
 *   `read.shell` (this repository's policy: autonomous), which is a widening,
 *   and a task that exists to narrow reads has no business doing that in
 *   passing. They are named in the follow-up in `docs/sandboxed-exec.md`.
 */
export type ReadTargetShape = "all" | "after-pattern" | "walk";

/** Which readers take paths, and where. Keyed by the binary's basename. */
export const READ_TARGET_SHAPES: Readonly<Record<string, ReadTargetShape>> = {
  cat: "all",
  cksum: "all",
  cut: "all",
  diff: "all",
  du: "all",
  file: "all",
  find: "walk",
  grep: "after-pattern",
  head: "all",
  jq: "after-pattern",
  ls: "all",
  md5sum: "all",
  rg: "after-pattern",
  sed: "after-pattern",
  sha256sum: "all",
  shasum: "all",
  sort: "all",
  stat: "all",
  tail: "all",
  tree: "all",
  uniq: "all",
  wc: "all",
};

/**
 * `find` primaries: the first word starting with `-` ends the path list.
 *
 * `find` is the one reader whose arguments are a little language, and its shape
 * is `find [paths…] [expression]`. This one reads the RAW argument list rather
 * than the flag-filtered positionals, because the filter is what tells the
 * paths from the expression: in `find . -name '*.ts'` the pattern `*.ts` is a
 * positional too, and a rule fed the filtered list would read it as a path,
 * find it unreadable, and call an ordinary walk of the workspace out of scope.
 */
function walkTargets(args: readonly string[]): string[] {
  const targets: string[] = [];
  for (const word of args) {
    if (word.startsWith("-")) break;
    targets.push(word);
  }
  return targets;
}

/**
 * Flags that carry the pattern or the script, so every positional is a path.
 *
 * `grep -e needle src`, `sed -f script.sed file`, `rg --regexp needle dir`: the
 * first positional is the FILE, and a rule that skipped it would leave the one
 * target that matters unchecked. Under-detection is the failure mode that
 * matters here — an unchecked read is a read outside the jail — so the shape
 * widens to `all` whenever one of these appears.
 */
const PATTERN_BEARING_FLAGS: readonly string[] = [
  "-e",
  "-f",
  "--regexp",
  "--expression",
  "--file",
];

/** Did the pattern (or script) arrive through a flag rather than a positional? */
function patternCameFromFlag(args: readonly string[]): boolean {
  return args.some(
    (arg) =>
      PATTERN_BEARING_FLAGS.includes(arg) ||
      PATTERN_BEARING_FLAGS.some((flag) => flag.startsWith("--") && arg.startsWith(`${flag}=`)),
  );
}

/**
 * The paths a read command will open, or `null` when this binary is not one
 * whose reads this module scopes.
 *
 * An empty array is a real answer and is NOT the same as `null`: it means this
 * reader opens the working directory (`ls`, `find`, `grep needle` with no file
 * operand), and the caller checks the working directory in its place. `null`
 * means "not a scoped reader", and the caller leaves the segment alone.
 *
 * Treating a non-path positional as a path costs nothing: a bare word resolves
 * against the working directory, which is inside a root in every session this
 * module is meant for. Treating a path as a non-path costs the whole property.
 */
export function readTargetsOf(
  bin: string,
  positionals: readonly string[],
  args: readonly string[] = [],
): string[] | null {
  const shape = READ_TARGET_SHAPES[basenameOf(bin)];
  if (shape === undefined) return null;
  switch (shape) {
    case "all":
      return [...positionals];
    case "after-pattern":
      return patternCameFromFlag(args) ? [...positionals] : positionals.slice(1);
    case "walk":
      return walkTargets(args.length === 0 ? positionals : args);
  }
}

/** The last segment of a command word, so `/usr/bin/cat` reads as `cat`. */
function basenameOf(bin: string): string {
  const segments = segmentsOf(bin);
  return segments[segments.length - 1] ?? bin;
}

/**
 * The verdict the PURE half can reach for one target.
 *
 * `out-of-scope` and `in-scope` are final. `needs-disk` is the honest answer
 * for a relative path: its meaning depends on a working directory this file
 * does not have, and the caller with the disk decides it. A caller that cannot
 * do the second pass must treat `needs-disk` as out of scope — which is what
 * `hook classify` and `hook <harness>` both do, through the same function.
 */
export type ReadTargetVerdict = "in-scope" | "out-of-scope" | "needs-disk";

/**
 * Read one target against the roots, as far as text alone can settle it.
 *
 * Absolute and inside a root: in scope. Absolute and outside every root: out of
 * scope, decided here, no disk needed. Unreadable (a variable, a glob, a `~`):
 * out of scope, because what it names is not in the text. Anything relative, or
 * carrying a `..`, is `needs-disk`.
 */
export function readTargetVerdict(
  target: string,
  roots: readonly string[],
): ReadTargetVerdict {
  if (target.length === 0) return "needs-disk";
  if (isUnreadableTarget(target)) return "out-of-scope";
  if (!target.startsWith("/")) return "needs-disk";
  if (segmentsOf(target).includes("..")) return "needs-disk";
  return isInReadScope(target, roots) ? "in-scope" : "out-of-scope";
}

/**
 * The roots, rendered for a human: `approval policy check`'s line and the
 * hook's verdict note say the same sentence.
 */
export function renderReadRoots(roots: readonly string[]): string {
  return roots.length === 0 ? "(none)" : roots.join(", ");
}
