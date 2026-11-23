/**
 * Write scope: where a write may land, and the places no write lands unasked
 * (design v4, "writes outside the workspace").
 *
 * The pure half, as `core/read-scope.ts` is the pure half of the read scope:
 * the two class names, the guarded list, the roots arithmetic, the opt-in rule
 * and the four decisions the lead ruled on, each behind ONE named constant so a
 * different ruling is a small change. It touches no disk and reads no
 * environment. The impure half (resolving a word the way the shell would,
 * landing it on the disk in both readings, expanding a glob) lives in
 * `src/cli/hook.ts`, beside the other disk passes, and it can only ever ADD a
 * stricter class to what the classifier answered.
 *
 * ## Two classes
 *
 * - {@link WRITE_OUT_OF_SCOPE_CLASS}: a write whose landing path is outside
 *   every write root. It applies only to a policy that opts in (point 8,
 *   {@link writeScopeOptedIn}); every other policy keeps today's answer for
 *   such a write.
 * - {@link WRITE_GUARDED_CLASS}: a write that lands on the guarded list, or
 *   whose target cannot be read after resolution (decision B). It applies to
 *   EVERY policy, and its built-in minimum ({@link WRITE_GUARDED_MINIMUM}) is
 *   applied at resolution (`core/policy-match.ts`), so no wildcard row, no
 *   `defaults.autonomy`, no `allow_irreversible` and no supervision mode can
 *   lift it.
 */

import { foldFileName } from "./name-fold.js";
import { effectiveReadRoots, isAtOrUnderReadRoot } from "./read-scope.js";

/** A write whose landing path is outside every write root (opt-in, point 8). */
export const WRITE_OUT_OF_SCOPE_CLASS = "files.write.out_of_scope";

/** A write onto the guarded list, or to a target that cannot be read (point 5, decision B). */
export const WRITE_GUARDED_CLASS = "files.write.guarded";

/**
 * The guarded class's built-in minimum (point 5). Applied by
 * `core/policy-match.ts` at resolution with provenance `floor`; a row naming
 * {@link WRITE_GUARDED_CLASS} itself below it is refused at load
 * (`core/policy-load.ts`, `checkClassMinimums`).
 */
export const WRITE_GUARDED_MINIMUM = "manual" as const;

/** The shipped default for {@link WRITE_OUT_OF_SCOPE_CLASS} (point 4: Carter said yes). */
export const WRITE_OUT_OF_SCOPE_SHIPPED_AUTONOMY = "supervised-retro" as const;

// ---------------------------------------------------------------------------
// The four decisions, one named place each
// ---------------------------------------------------------------------------

/**
 * Decision A (review-b's N1) is not built (coordinator, 23 Nov): a row main
 * already tightens to `files.delete.out_of_scope` keeps exactly that class
 * under every policy, so `cp a ../x` and `echo x > ../x` still differ.
 */

/**
 * Decision B: a target still unreadable after resolution takes this class.
 * The other ruling would name {@link WRITE_OUT_OF_SCOPE_CLASS} here (which only
 * applies to a policy that opts in).
 */
export const DECISION_B_UNREADABLE_CLASS: string = WRITE_GUARDED_CLASS;

/**
 * Decision D (review-b's N2), as recommended: an overwrite of an existing file
 * outside the roots is not special; it takes {@link WRITE_OUT_OF_SCOPE_CLASS}
 * like any other out-of-scope write. The other ruling (`true`) makes it
 * {@link WRITE_GUARDED_CLASS}.
 */
export const DECISION_D_OVERWRITE_IS_GUARDED = false;

/**
 * Decision E (codex), as recommended: an open gate window treats
 * {@link WRITE_GUARDED_CLASS} as it treats any `manual` class: it lets it
 * through with a bypass record. The other ruling, `"refuse"`, keeps a card
 * even inside a window (`src/cli/hook.ts`, the bypass path).
 */
export const DECISION_E_WINDOW: "as-manual" | "refuse" = "as-manual";

// ---------------------------------------------------------------------------
// The policy block and the opt-in rule
// ---------------------------------------------------------------------------

/**
 * The `write_scope` block of a policy (proposed SPEC.md §5.2). Additive and
 * optional, exactly as `read_scope` is: the built-in roots stand whatever it
 * says, so a policy can widen the write scope and never narrow it.
 */
export interface WriteScope {
  roots?: string[];
}

/**
 * Point 8: does this policy opt in to {@link WRITE_OUT_OF_SCOPE_CLASS}?
 *
 * Only a policy that NAMES the class (an exact key of `classes`, not a
 * wildcard that happens to match it) or carries a `write_scope` block. Any
 * other policy keeps today's answers for out-of-scope writes, as an absent
 * `read_scope` keeps today's answers for reads. The guarded class does not
 * wait for this: it applies to every policy.
 */
export function writeScopeOptedIn(
  policy: { classes?: Record<string, unknown>; write_scope?: unknown } | null | undefined,
): boolean {
  if (policy === null || policy === undefined) return false;
  if (policy.write_scope !== undefined && policy.write_scope !== null) return true;
  const classes = policy.classes ?? {};
  return Object.prototype.hasOwnProperty.call(classes, WRITE_OUT_OF_SCOPE_CLASS);
}

/**
 * The effective write roots, the same arithmetic as the read roots (point 2):
 * the gate root, the scratch and temp roots, plus `write_scope.roots`. A
 * declared entry that is relative is joined onto the gate root; one that is
 * empty or carries a variable, glob or `~` is dropped.
 */
export function effectiveWriteRoots(options: {
  gateRoot: string;
  declared?: readonly string[] | undefined;
  systemRoots?: readonly string[] | undefined;
}): string[] {
  return effectiveReadRoots(options);
}

/** Is this landing path at or under any of these roots, by path segment? */
export function isInWriteScope(candidate: string, roots: readonly string[]): boolean {
  return roots.some((root) => isAtOrUnderReadRoot(candidate, root));
}

// ---------------------------------------------------------------------------
// The guarded list (point 5)
// ---------------------------------------------------------------------------

/** One entry: a place, and every path at or under it. */
interface GuardedEntry {
  /** The name a note reports. */
  name: string;
  /** The segments under the anchor, compared through {@link foldFileName}. */
  segments: readonly string[];
}

/** Places under the user's home. */
export const GUARDED_HOME_ENTRIES: readonly GuardedEntry[] = [
  // ~/.ssh
  { name: "~/.ssh", segments: [".ssh"] },
  // shell start files
  { name: "~/.zshrc", segments: [".zshrc"] },
  { name: "~/.zshenv", segments: [".zshenv"] },
  { name: "~/.zprofile", segments: [".zprofile"] },
  { name: "~/.zlogin", segments: [".zlogin"] },
  { name: "~/.bashrc", segments: [".bashrc"] },
  { name: "~/.bash_profile", segments: [".bash_profile"] },
  { name: "~/.profile", segments: [".profile"] },
  { name: "~/.config/fish", segments: [".config", "fish"] },
  // launch agents and daemons
  { name: "~/Library/LaunchAgents", segments: ["Library", "LaunchAgents"] },
  { name: "~/Library/LaunchDaemons", segments: ["Library", "LaunchDaemons"] },
  // global git config
  { name: "~/.gitconfig", segments: [".gitconfig"] },
  { name: "~/.config/git", segments: [".config", "git"] },
  // PATH folders
  { name: "~/bin", segments: ["bin"] },
  { name: "~/.local/bin", segments: [".local", "bin"] },
  // credential stores
  { name: "~/.aws", segments: [".aws"] },
  { name: "~/.config/gh", segments: [".config", "gh"] },
  { name: "~/.netrc", segments: [".netrc"] },
  { name: "~/.docker", segments: [".docker"] },
  { name: "~/.kube", segments: [".kube"] },
  { name: "~/.gnupg", segments: [".gnupg"] },
];

/**
 * Places named from the root. Each has its `/private` twin, because macOS
 * links `/etc` and `/var` there and a landing path is read through the link.
 */
export const GUARDED_ABSOLUTE_ENTRIES: readonly GuardedEntry[] = [
  { name: "/Library/LaunchAgents", segments: ["Library", "LaunchAgents"] },
  { name: "/Library/LaunchDaemons", segments: ["Library", "LaunchDaemons"] },
  { name: "/System/Library/LaunchAgents", segments: ["System", "Library", "LaunchAgents"] },
  { name: "/System/Library/LaunchDaemons", segments: ["System", "Library", "LaunchDaemons"] },
  // `/etc/` covers `/etc/cron*`, `/etc/gitconfig` and `/etc/paths.d`.
  { name: "/etc", segments: ["etc"] },
  { name: "/etc", segments: ["private", "etc"] },
  { name: "/var/at", segments: ["var", "at"] },
  { name: "/var/at", segments: ["private", "var", "at"] },
  { name: "/usr/lib/cron", segments: ["usr", "lib", "cron"] },
  { name: "/usr/local/bin", segments: ["usr", "local", "bin"] },
  { name: "/opt/homebrew/bin", segments: ["opt", "homebrew", "bin"] },
];

/** The directories whose children are users' homes. */
const HOME_PARENTS: readonly (readonly string[])[] = [["Users"], ["home"]];

/** Children of a home parent that are not a user's home. */
const NOT_A_HOME: readonly string[] = ["shared"];

/** Single homes named from the root (the superuser's). */
const ROOT_HOMES: readonly (readonly string[])[] = [["root"], ["var", "root"], ["private", "var", "root"]];

/** Non-empty path segments, `.` dropped. */
function segmentsOf(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0 && segment !== ".");
}

/** Does `have` start with `want`, segment by segment, through the fold? */
function startsWithFolded(have: readonly string[], want: readonly string[]): boolean {
  if (want.length === 0 || have.length < want.length) return false;
  return want.every((segment, index) => foldFileName(segment) === foldFileName(have[index] as string));
}

/**
 * The guarded entry an absolute, `..`-free path is at or under, or `null`.
 *
 * `homes` is every spelling of the current user's home this caller knows (as
 * given and resolved): a path under one of them is tested against the home
 * entries; a path under ANOTHER child of `/Users` or `/home` (not `Shared`) is
 * another user's home. A git hooks folder is a `.git/hooks` pair of segments
 * anywhere. Every name compares through {@link foldFileName}, so `~/.SSH` and
 * `/ETC/hosts` are the guarded places on a volume that folds case.
 */
export function guardedEntryOf(path: string, homes: readonly string[]): string | null {
  const have = segmentsOf(path);
  if (have.includes("..")) return null;
  const folded = have.map((segment) => foldFileName(segment));

  for (let index = 0; index + 1 < folded.length; index += 1) {
    if (folded[index] === ".git" && folded[index + 1] === "hooks") return "a git hooks folder";
  }
  for (const entry of GUARDED_ABSOLUTE_ENTRIES) {
    if (startsWithFolded(have, entry.segments)) return entry.name;
  }

  let underOwnHome = false;
  for (const home of homes) {
    const anchor = segmentsOf(home);
    if (anchor.length === 0 || !startsWithFolded(have, anchor)) continue;
    underOwnHome = true;
    const rest = have.slice(anchor.length);
    for (const entry of GUARDED_HOME_ENTRIES) {
      if (startsWithFolded(rest, entry.segments)) return entry.name;
    }
  }
  if (underOwnHome) return null;

  for (const parent of HOME_PARENTS) {
    if (!startsWithFolded(have, parent)) continue;
    const child = have[parent.length];
    if (child === undefined) continue;
    if (NOT_A_HOME.includes(foldFileName(child))) continue;
    return "another user's home";
  }
  for (const rootHome of ROOT_HOMES) {
    if (startsWithFolded(have, rootHome)) return "another user's home";
  }
  return null;
}

/**
 * A guarded entry strictly UNDER an absolute, `..`-free path, or `null`: what a
 * tree written AT that path (a recursive copy, a move, a link, an archive
 * extracted there, a clone) may put onto the list without naming it. `/` holds
 * every entry; a `.git` folder holds its `hooks`; `/Users` and `/var` hold
 * other users' homes. Compared through {@link foldFileName}.
 */
export function guardedEntryBelow(path: string, homes: readonly string[]): string | null {
  const have = segmentsOf(path);
  if (have.includes("..")) return null;
  const strictlyUnder = (entry: readonly string[]): boolean =>
    entry.length > have.length && (have.length === 0 || startsWithFolded(entry, have));
  const last = have[have.length - 1];
  if (last !== undefined && foldFileName(last) === ".git") return "a git hooks folder";
  for (const entry of GUARDED_ABSOLUTE_ENTRIES) {
    if (strictlyUnder(entry.segments)) return entry.name;
  }
  for (const home of homes) {
    const anchor = segmentsOf(home);
    if (anchor.length === 0) continue;
    for (const entry of GUARDED_HOME_ENTRIES) {
      if (strictlyUnder([...anchor, ...entry.segments])) return entry.name;
    }
  }
  // `/Users` itself holds homes (its children); `/var` holds `/var/root`.
  for (const parent of [...HOME_PARENTS.map((each) => [...each, "a-home"]), ...ROOT_HOMES]) {
    if (strictlyUnder(parent)) return "another user's home";
  }
  return null;
}
