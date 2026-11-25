/**
 * The git-directory write refinement (APRV-518 review fold, S1).
 *
 * The classifier judges a write into `.git` by the text of its target, and,
 * since the review fold, from the directory the line's own literal `cd`s
 * moved the shell to. Three things the text cannot show still decide where a
 * write lands, and each is a fact about the disk:
 *
 * - the directory the hook runs in, which may itself be inside a git
 *   directory (a session whose cwd is `.git/hooks` writes `pre-push` there);
 * - a symlink that exists when the hook runs (`g -> .git`, then
 *   `echo x >> g/config`);
 * - a git directory that is not named `.git`: a linked worktree's `gitdir`,
 *   or a `--separate-git-dir`, named by the `.git` FILE of the checkout.
 *
 * So this step resolves every path a write segment may write, from every
 * directory it may run in (the hook's own and each literal `cd` before it,
 * followed as the push-repository pass follows one), where the disk lands it,
 * and a landing with a `.git` segment, or inside the checkout's git
 * directory, makes the segment `git-dir-write`. A `cd` this step cannot
 * follow (`cd "$D"`, `cd -`) adds no directory: the write is judged from the
 * others, as the write-scope pass judges every write from the hook's own
 * directory, so the accepted cost does not grow through it.
 *
 * It only ever raises a segment to `vcs.history.rewrite`. IMPURE by design:
 * it reads the file system (no git process), and it runs before the
 * write-scope pass, so a segment it raises is not narrowed again.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync, type Dirent } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";

import { foldNameLower } from "../core/name-fold.js";

import {
  classifiedSegmentShapes,
  expandBraces,
  GATE_SELF_CLASS,
  gitWriteTargets,
  globSegmentMatches,
  isPatternSegment,
  mayNameGitDirectory,
  readWriteSureTargets,
  readWriteTargets,
  type ClassifiedSegment,
  type CommandClassification,
} from "../core/command-class.js";

const REWRITE_CLASS = "vcs.history.rewrite";
const GIT_DIR_WRITE_RULE = "git-dir-write";

/** Symlinks followed while resolving one path, past which it is unresolvable. */
const LINK_LIMIT = 40;

/**
 * Where the kernel lands `path`, walked one component at a time the way the
 * kernel walks it (review fold): `..` is applied to the PHYSICAL directory
 * reached so far, never to the text, and every symlink is read and followed
 * whether or not its target exists yet, so a dangling link into `.git` is seen
 * as the write through it would land. `links` is every link target read on
 * the way, as written. A missing component is applied as text, as the
 * kernel applies it. Any other failure (EACCES, ENAMETOOLONG, a link loop,
 * an unreadable link) is `unplaceable`, with its code.
 */
function physicalLanding(path: string): { landed: string; links: string[] } | { unplaceable: string } {
  // The components still to walk, LAST FIRST: taking the next one is a pop.
  // Taking it from the front of a long array moved every other component each
  // time, so a word of n components cost n squared.
  const pending = path.split("/").filter((part) => part.length > 0).reverse();
  let current = "/";
  const links: string[] = [];
  let followed = 0;
  while (pending.length > 0) {
    const part = pending.pop() as string;
    if (part === ".") continue;
    if (part === "..") {
      current = dirname(current);
      continue;
    }
    const next = current === "/" ? `/${part}` : `${current}/${part}`;
    let stat;
    try {
      stat = lstatSync(next);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "an error";
      // A missing component: the kernel sees nothing there either, so the
      // rest applies as text. Anything else (EACCES, ENAMETOOLONG, ELOOP, …)
      // hides whether a link is there: the path cannot be placed.
      if (code === "ENOENT") {
        current = next;
        continue;
      }
      return { unplaceable: code };
    }
    if (!stat.isSymbolicLink()) {
      current = next;
      continue;
    }
    followed += 1;
    if (followed > LINK_LIMIT) return { unplaceable: "ELOOP" };
    let target: string;
    try {
      target = readlinkSync(next);
    } catch (error) {
      // A confirmed link whose target cannot be read cannot be placed.
      return { unplaceable: (error as NodeJS.ErrnoException).code ?? "an unreadable link" };
    }
    links.push(target);
    if (target.startsWith("/")) current = "/";
    const pieces = target.split("/").filter((piece) => piece.length > 0);
    for (let index = pieces.length - 1; index >= 0; index -= 1) pending.push(pieces[index] as string);
  }
  return { landed: current, links };
}

/** {@link physicalLanding}'s place alone, or `null`. */
function landing(path: string): string | null {
  const walked = physicalLanding(path);
  return "landed" in walked ? walked.landed : null;
}

/** Does this absolute path have a `.git` segment, in any case ({@link foldFileName})? */
function hasGitSegment(path: string): boolean {
  return path.split(sep).some((part) => foldNameLower(part) === ".git");
}

/** Is `path` `root` or below it, compared folded (APFS folds it; {@link foldFileName})? */
function within(path: string, root: string): boolean {
  const p = foldNameLower(path);
  const r = foldNameLower(root).replace(/\/+$/u, "");
  return p === r || p.startsWith(`${r}/`);
}

/**
 * The git directories of the checkout `dir` is in, resolved: the `.git`
 * directory itself, or, for a `.git` FILE, the `gitdir:` it names and that
 * directory's `commondir`. Empty when no `.git` entry is found upward.
 */
function gitDirectoriesOf(dir: string): string[] {
  let at = landing(dir);
  for (let depth = 0; at !== null && depth < 128; depth += 1) {
    const entry = join(at, ".git");
    if (existsSync(entry)) {
      try {
        if (statSync(entry).isDirectory()) {
          const real = landing(entry);
          return real === null ? [] : [real];
        }
        const named = /^gitdir:\s*(.+)$/mu.exec(readFileSync(entry, "utf8"));
        if (named === null) return [];
        const text = (named[1] as string).trim();
        const gitdir = landing(text.startsWith("/") ? text : `${at}/${text}`);
        if (gitdir === null) return [];
        const found = [gitdir];
        const commonFile = join(gitdir, "commondir");
        if (existsSync(commonFile)) {
          const commonText = readFileSync(commonFile, "utf8").trim();
          const common = landing(commonText.startsWith("/") ? commonText : `${gitdir}/${commonText}`);
          if (common !== null) found.push(common);
        }
        return found;
      } catch {
        return [];
      }
    }
    const up = dirname(at);
    if (up === at) return [];
    at = up;
  }
  return [];
}

/** The words of a write segment that may name a path it writes. */
function writeWords(args: readonly string[]): string[] {
  const words: string[] = [];
  for (const arg of args) {
    if (arg === "-") continue;
    if (!arg.startsWith("-")) {
      words.push(arg);
      const equals = arg.indexOf("=");
      if (equals > 0) words.push(arg.slice(equals + 1));
      continue;
    }
    const equals = arg.indexOf("=");
    if (equals !== -1) words.push(arg.slice(equals + 1));
    // An attached short-option value: EVERY tail of a single-dash word from
    // its second letter on (`-o.git/config`, `-vthooks`, `-xfC.git`), since
    // which letter takes a value differs per command. The strict side: a
    // tail that is no value costs something only when it resolves into a git
    // directory (the `l` ending `-t…/av-approval`, with a link `l -> .git/hooks`
    // in the checkout, is read as that link).
    if (!arg.startsWith("--")) for (let at = 2; at < arg.length; at += 1) words.push(arg.slice(at));
  }
  return words;
}

/**
 * The files a `curl` or `wget` writes, from its own options (review fold):
 * curl's output (`-o`, `--output`) and output directory (`--output-dir`);
 * wget's output document (`-O`, `--output-document`), directory prefix
 * (`-P`, `--directory-prefix`) and log file (`-o`, `-a`, `--output-file`,
 * `--append-output`). A value letter inside a short cluster takes the rest
 * of the cluster, or the NEXT word when it ends the cluster (`curl -so f`);
 * a long option takes its `=` value or the next word.
 */
function fetchOutputValues(bin: string, args: readonly string[]): string[] {
  const letters = bin === "curl" ? "o" : bin === "wget" ? "OPoa" : "";
  const long =
    bin === "curl"
      ? ["--output", "--output-dir"]
      : bin === "wget"
        ? ["--output-document", "--directory-prefix", "--output-file", "--append-output"]
        : [];
  const values: string[] = [];
  for (const [at, arg] of args.entries()) {
    const next = args[at + 1];
    if (arg === "--") break;
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg : arg.slice(0, equals);
      // A long option may be given by any prefix of it (wget's getopt
      // takes an unambiguous one): read every prefix as the option.
      if (name.length < 3 || !long.some((option) => option.startsWith(name))) continue;
      if (equals !== -1) values.push(arg.slice(equals + 1));
      else if (next !== undefined) values.push(next);
      continue;
    }
    if (!arg.startsWith("-") || letters.length === 0) continue;
    for (let index = 1; index < arg.length; index += 1) {
      if (!letters.includes(arg[index] as string)) continue;
      const rest = arg.slice(index + 1);
      if (rest.length > 0) values.push(rest);
      else if (next !== undefined) values.push(next);
      break;
    }
  }
  return values;
}

/**
 * A word whose text is the path, or a glob or brace pattern of paths (second
 * review, S1): nothing a variable or a substitution would still change.
 */
function pathOrPattern(word: string): boolean {
  return word.length > 0 && !/[\s$`~]/u.test(word.replace(/^~\//u, ""));
}

/** Does the word hold a glob or a brace group the shell would expand? */
function isPattern(word: string): boolean {
  return word.includes("{") || word.split("/").some(isPatternSegment);
}

/** Directory entries one expansion may visit, in all; past it, it gives up. */
const ENTRY_LIMIT = 100_000;

/**
 * One path a pattern stands for: `"match"`, an entry a real listing
 * returned; `"parent"`, the pattern itself under a listed directory, standing
 * for the plain files there (a plain file lands where its parent does);
 * `"literal"`, the whole word as written, which the shell uses as the name
 * when the pattern matches nothing.
 */
interface Placed {
  path: string;
  from: "match" | "parent" | "literal";
}

/** The paths a pattern stands for, or why this step could not expand it. */
type Expansion = { paths: Placed[] } | { giveUp: string };

/** Keep every entry that is a directory or a link (one that may be descended or followed). */
const DIRECTORY_OR_LINK = (entry: Dirent): boolean => entry.isDirectory() || entry.isSymbolicLink();

/**
 * The paths a glob or brace word names on disk from `base` (second review,
 * S1), for walking: braces expanded first, then each pattern segment matched
 * against its parent's entries with the classifier's own matcher. Every
 * entry of a listing is read, and every matching directory or link (and an
 * entry named `.git`) is kept, at the last segment too, since a directory may
 * be a git directory under another name; only plain files are left to the
 * pattern under their parent. Each path says where it came from
 * ({@link Placed}), never read back from its text. It gives up past
 * {@link ENTRY_LIMIT} entries visited in all, or when a parent cannot be
 * read; the caller then judges a sure target the strict way and a possible
 * one by its text (review of the second fold).
 */
export function expandOnDisk(
  base: string,
  word: string,
  /**
   * Design v4, point 6 (the write-scope pass): `keepFiles` keeps a plain file
   * that matches a pattern segment as a match of its own, so a match is judged
   * by its own name; `deadline` (a `Date.now()` value) gives up once passed.
   * Absent, this step behaves exactly as the git-directory pass has it.
   */
  options: {
    keepFiles?: boolean;
    deadline?: number;
    /**
     * The listing of one directory, or the error code reading it gave: the
     * write pass's per-call memo ({@link listDirectory} by default). A memo
     * keeps only what the disk said; the entries are matched here, in the
     * current name reading, every time.
     */
    list?: (path: string) => Dirent[] | string;
  } = {},
): Expansion {
  const words = word.includes("{") ? expandBraces(word) : [word];
  if (words === null) return { giveUp: "more brace alternatives than this hook expands" };
  const join2 = (place: string, name: string): string => (place === "/" ? `/${name}` : `${place}/${name}`);
  const found: Placed[] = [];
  let visited = 0;
  for (const each of words) {
    const start = each.startsWith("/") ? "/" : base;
    const segments = each.split("/").filter((part) => part.length > 0);
    found.push({ path: segments.reduce(join2, start), from: "literal" });
    let places: Placed[] = [{ path: start, from: "match" }];
    for (const segment of segments) {
      if (!isPatternSegment(segment)) {
        places = places.map((place) => ({ path: join2(place.path, segment), from: place.from }));
        continue;
      }
      const next: Placed[] = [];
      for (const place of places) {
        if (place.from !== "match") continue;
        const listed = (options.list ?? listDirectory)(place.path);
        if (typeof listed === "string") {
          if (listed === "ENOENT" || listed === "ENOTDIR") continue;
          return { giveUp: `${place.path} cannot be listed (${listed})` };
        }
        const entries = listed;
        visited += entries.length;
        if (visited > ENTRY_LIMIT) return { giveUp: `more than ${String(ENTRY_LIMIT)} entries to read` };
        if (options.deadline !== undefined && Date.now() > options.deadline) {
          return { giveUp: "the time this hook gives one expansion ran out" };
        }
        next.push({ path: join2(place.path, segment), from: "parent" });
        for (const entry of entries) {
          if (!globSegmentMatches(segment, entry.name)) continue;
          if (DIRECTORY_OR_LINK(entry) || foldNameLower(entry.name) === ".git" || options.keepFiles === true) {
            next.push({ path: join2(place.path, entry.name), from: "match" });
          }
        }
      }
      places = next;
    }
    found.push(...places);
  }
  return { paths: found };
}

/** `items` without a repeat of any key, each kept where it first appears. */
function distinctBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const each = key(item);
    if (seen.has(each)) continue;
    seen.add(each);
    out.push(item);
  }
  return out;
}

/** A directory's entries, or the error code reading it gave ("an error" when it has none). */
export function listDirectory(path: string): Dirent[] | string {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? "an error";
  }
}

/** Does anything exist at `path` itself (a link counts, followed or not)? */
function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The commands that copy or move a whole tree, `.git` entry included. */
const TREE_COPIERS: ReadonlySet<string> = new Set(["cp", "mv", "rsync", "ditto"]);

/**
 * The SOURCE operands of a tree copy or move (second review, N2): every
 * operand but the last, or every operand when a target directory is named by
 * `-t` / `--target-directory`.
 */
function treeSources(bin: string, args: readonly string[]): string[] {
  if (!TREE_COPIERS.has(bin)) return [];
  const operands: string[] = [];
  let targetNamed = false;
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] as string;
    if (arg === "--") {
      operands.push(...args.slice(at + 1));
      break;
    }
    if ((bin === "cp" || bin === "mv") && (arg === "-t" || arg === "--target-directory")) {
      targetNamed = true;
      at += 1;
      continue;
    }
    if ((bin === "cp" || bin === "mv") && (arg.startsWith("--target-directory=") || /^-[A-Za-z]*t./u.test(arg))) targetNamed = true;
    if (arg.startsWith("-")) continue;
    operands.push(arg);
  }
  return targetNamed ? operands : operands.slice(0, -1);
}

/** The command words that change the shell's directory, followed alike here. */
const DIRECTORY_CHANGERS: ReadonlySet<string> = new Set(["cd", "chdir", "pushd", "popd"]);

/**
 * Where a directory change may lead from `dir` (review fold, round 2). The
 * principle: follow only the forms whose landing is certain, and for those
 * take BOTH landings, the logical one (the shell's default `cd -L` removes `.`
 * and `..` from `<dir>/<word>` as text before it lands) and the physical one
 * (`cd -P`, walked later component by component). Every other form is
 * UNKNOWN, with the reason: `cd -`, `+N` / `-N`, two operands (zsh's
 * substitution form), a word the shell may still change, `~user`, `pushd`
 * with no operand, a change behind an assignment, and a bare-name or
 * no-argument `cd`, or any relative one, once an earlier segment may have
 * changed `HOME`, `CDPATH`, `OLDPWD` or `PWD`. An unknown change still contributes every landing it
 * can name (a failed `cd` stays put, so nothing is lost by adding them).
 */
function directoryTargets(
  bin: string,
  args: readonly string[],
  assignments: readonly string[],
  dir: string,
  envChanged: boolean,
): { targets: string[]; unknown: string | null } {
  if (assignments.length > 0) return { targets: [], unknown: "a directory change behind an assignment" };
  let at = 0;
  let options = "";
  while (at < args.length && /^-[LPe@]+$/u.test(args[at] as string)) {
    options += (args[at] as string).slice(1);
    at += 1;
  }
  const physicalOnly = options.lastIndexOf("P") > options.lastIndexOf("L");
  const operands = args[at] === "--" ? args.slice(at + 1) : args.slice(at);
  const both = (text: string): string[] => (physicalOnly ? [text] : [...new Set([normalize(text), text])]);
  const home = process.env["HOME"];
  const homeTargets = home === undefined ? [] : both(home);
  if (bin === "popd") {
    // Back to a directory already in the set; `popd +N` / `-N` drop another.
    return operands.length === 0 ? { targets: [], unknown: null } : { targets: [], unknown: `\`popd ${operands.join(" ")}\`` };
  }
  if (operands.length === 0) {
    if (bin === "pushd") return { targets: [], unknown: "`pushd` with no operand swaps the stack" };
    return { targets: homeTargets, unknown: envChanged ? "a `cd` to HOME after the line may have changed HOME" : null };
  }
  if (operands.length !== 1) return { targets: [], unknown: `\`${bin} ${operands.join(" ")}\` (two operands)` };
  const word = operands[0] as string;
  if (word === "-" || /^[+-]\d+$/u.test(word) || word.startsWith("-")) return { targets: [], unknown: `\`${bin} ${word}\`` };
  if (/[$`\\]/u.test(word) || (word.startsWith("~") && isPattern(word))) {
    return { targets: [], unknown: `\`${bin} ${word}\` (a word the shell may still change)` };
  }
  if (isPattern(word)) {
    // Second review, S1: a glob or brace directory is expanded on disk; one
    // match is certain, several or none readable are not.
    const expanded = expandOnDisk(dir, word);
    if ("giveUp" in expanded) return { targets: [], unknown: `\`${bin} ${word}\` (a pattern this hook cannot expand: ${expanded.giveUp})` };
    // Every entry a real listing matched; with none, the shell uses the word
    // as a name, which is a target only when such an entry exists.
    const matches = expanded.paths.filter((placed) => placed.from === "match").map((placed) => placed.path);
    if (matches.length === 0) {
      const literal = expanded.paths.filter((placed) => placed.from === "literal" && entryExists(placed.path)).map((placed) => placed.path);
      if (literal.length === 0) return { targets: [], unknown: `\`${bin} ${word}\` (a pattern that matches nothing here)` };
      return { targets: literal.flatMap(both), unknown: envChanged ? "a relative `cd` after the line may have changed PWD or CDPATH" : null };
    }
    return {
      targets: matches.flatMap(both),
      unknown: matches.length > 1 ? `\`${bin} ${word}\` (a pattern with ${String(matches.length)} matches)` : envChanged ? "a relative `cd` after the line may have changed PWD or CDPATH" : null,
    };
  }
  if (word === "~" || word.startsWith("~/")) {
    const targets = home === undefined ? [] : both(word === "~" ? home : `${home}/${word.slice(2)}`);
    return { targets, unknown: envChanged ? "a `cd` to HOME after the line may have changed HOME" : null };
  }
  if (word.startsWith("~")) return { targets: [], unknown: `\`${bin} ${word}\`` };
  if (word.startsWith("/")) return { targets: both(word), unknown: null };
  const targets = both(`${dir}/${word}`);
  const bare = !word.startsWith("./") && !word.startsWith("../") && word !== "." && word !== "..";
  if (bare) {
    for (const entry of (process.env["CDPATH"] ?? "").split(":")) {
      if (entry.length === 0) continue;
      targets.push(...both(entry.startsWith("/") ? `${entry}/${word}` : `${dir}/${entry}/${word}`));
    }
  }
  // A relative `cd` reads `$PWD` for its logical landing, and a bare name
  // `$CDPATH`: once the line may have changed either, it cannot be placed.
  return { targets, unknown: envChanged ? "a relative `cd` after the line may have changed PWD or CDPATH" : null };
}

/** The variables a directory change reads from the environment. */
const CD_VARIABLES = /^(?:HOME|CDPATH|OLDPWD|PWD)(?:=|$)/u;

/**
 * May this segment change `HOME`, `CDPATH`, `OLDPWD` or `PWD` for the rest of
 * the line? An assignment on its own, `export` / `declare` / `typeset` /
 * `local` / `readonly` / `unset` naming one, `set -a` (every later assignment
 * exported), and `source` / `.` / `eval`, which may do any of them.
 */
function changesCdEnvironment(shape: { bin: string | null; args: readonly string[]; assignments: readonly string[] }): boolean {
  if (shape.bin === null) return shape.assignments.some((word) => CD_VARIABLES.test(word));
  const bin = shape.bin.split("/").pop() ?? shape.bin;
  if (["export", "declare", "typeset", "local", "readonly", "unset"].includes(bin)) {
    return shape.args.some((word) => CD_VARIABLES.test(word));
  }
  if (bin === "set") return shape.args.some((word) => /^-[A-Za-z]*a/u.test(word) || word === "allexport");
  return bin === "source" || bin === "." || bin === "eval";
}

/** A classification plus one note per segment this step raised. */
export interface GitDirWriteRefinement {
  result: CommandClassification;
  notes: string[];
}

/**
 * Raise every write segment whose target lands in a git directory on disk to
 * `git-dir-write`.
 *
 * `cwd` is the directory the command runs in, the one every other impure pass
 * of `classifyForHook` reads.
 */
export function refineGitDirWrites(result: CommandClassification, cwd: string): GitDirWriteRefinement {
  if (!result.ok) return { result, notes: [] };
  const notes: string[] = [];
  const added = new Map<number, ClassifiedSegment>();
  const gitDirs = new Map<string, string[]>();
  const gitDirsOf = (dir: string): string[] => {
    let known = gitDirs.get(dir);
    if (known === undefined) {
      known = gitDirectoriesOf(dir);
      gitDirs.set(dir, known);
    }
    return known;
  };
  // The disk is read and never written while the hook judges a line, so a
  // pattern expanded from one directory, or one path walked, answers the
  // same each time this pass asks: each is read once per pass, as
  // `gitDirsOf` reads each directory's git directories once. A line whose
  // segments repeat (`rm -rf ./*; ` again and again), or a segment the
  // classifier gives several classes (each its own segment here, with the
  // same text), asked the disk the same question each time (#682's
  // rm_dot_names cost line). Only the reads are saved: every word is still
  // placed, from every directory, in the same order, so the first hit and
  // its note are the ones the walk found before. What an expansion marks on
  // its way (a name whose readings diverge, a GLOB-WRITE match) only ever
  // turns on within one name reading, and this pass runs inside one, so the
  // first ask leaves those marks as every repeat would.
  const expansions = new Map<string, Map<string, Expansion>>();
  const expandOnce = (base: string, word: string): Expansion => {
    let fromBase = expansions.get(base);
    if (fromBase === undefined) {
      fromBase = new Map();
      expansions.set(base, fromBase);
    }
    let expansion = fromBase.get(word);
    if (expansion === undefined) {
      expansion = expandOnDisk(base, word);
      fromBase.set(word, expansion);
    }
    return expansion;
  };
  const landings = new Map<string, ReturnType<typeof physicalLanding>>();
  const landOnce = (path: string): ReturnType<typeof physicalLanding> => {
    let walked = landings.get(path);
    if (walked === undefined) {
      walked = physicalLanding(path);
      landings.set(path, walked);
    }
    return walked;
  };
  // Every directory a segment may run in, as TEXT (joined, never normalised,
  // so the physical walk applies each `..`): the hook's own and every place a
  // directory change before it may lead. A failed `cd` leaves the shell where
  // it was, so the set only grows, and `popd` returns to a directory already
  // in it.
  const home = process.env["HOME"];
  let dirs = [cwd];
  let envChanged = false;
  // Why the shell may stand somewhere this step cannot name, once it may.
  let unknown: string | null = null;
  for (const [index, segment] of result.segments.entries()) {
    // The segment's own text, which leaves out a heredoc's body: read as the
    // segment it is (review-b's M2 at 3774fdd4), never refused as a heredoc
    // never terminated and skipped.
    const shapes = classifiedSegmentShapes(segment.text);
    if (shapes === null) continue;
    const before = dirs;
    const unknownBefore = unknown;
    for (const shape of shapes) {
      const bin = shape.bin === null ? null : (shape.bin.split("/").pop() ?? shape.bin);
      if (bin === null || !DIRECTORY_CHANGERS.has(bin)) {
        if (changesCdEnvironment(shape)) envChanged = true;
        continue;
      }
      const next: string[] = [];
      for (const dir of dirs) {
        const led = directoryTargets(bin, shape.args, shape.assignments, dir, envChanged);
        next.push(...led.targets);
        if (led.unknown !== null) unknown ??= led.unknown;
      }
      dirs = [...new Set([...dirs, ...next])];
    }
    if (segment.class === REWRITE_CLASS || segment.class === GATE_SELF_CLASS) continue;
    const shape = shapes[0];
    if (shapes.length !== 1 || shape === undefined) continue;
    const bin = shape.bin === null ? null : (shape.bin.split("/").pop() ?? shape.bin);
    const reads = segment.class.startsWith("read.") && bin !== "curl" && bin !== "wget" && bin !== "git";
    // A read writes nothing but its redirection and the outputs it names
    // itself (`sort -o`, `uniq in out`, sed's `w`: follow-up, item B);
    // `git`'s own words are file writes only where git writes through them.
    const gitWrites = bin === "git" ? gitWriteTargets(shape.args).filter(pathOrPattern) : [];
    // A sed script's possible file is judged both as LITERAL text (sed
    // expands nothing in it, so it keeps its blanks, a `$`, a backtick or a
    // glob character, and is placed exactly as written) and as the shell
    // word it may also be (an unquoted script word is expanded before sed
    // sees it). The tag belongs to the candidate, never to its text: a
    // redirection spelled the same (`sed -n 'w .g*t/x' f > .g*t/x`) is only
    // a shell word.
    const readsOnly = reads || segment.rule === "redirect-write";
    const sedNames = bin === "sed" && readsOnly ? readWriteTargets(bin, shape.args).filter((word) => word.length > 0) : [];
    const readOutputs = bin === null || bin === "sed" ? [] : readWriteTargets(bin, shape.args).filter(pathOrPattern);
    const named = readsOnly ? readOutputs : bin === "git" ? gitWrites : writeWords(shape.args).filter(pathOrPattern);
    // A word repeated in the segment is placed once (`cp README.md d*/x
    // d*/x …`, the 4,000 words of #682's continuation cost line): the same
    // word from the same directories lands where it landed the first time,
    // and the first hit is the same one, so only the walks are saved.
    const candidates: { word: string; literal: boolean }[] = distinctBy(
      [
        ...[...shape.writes.filter(pathOrPattern), ...named].map((word) => ({ word, literal: false })),
        ...sedNames.map((word) => ({ word, literal: true })),
      ],
      (candidate) => `${candidate.literal ? "literal" : "word"}\u0000${candidate.word}`,
    );
    // The words the segment surely writes: its redirection targets, and every
    // word of a segment the classifier already calls a file write. A word of
    // any other segment (a `curl -d` payload, a script argument) is only a
    // POSSIBLE target. A path that cannot be placed is judged the strict way
    // for a sure target and as text for a possible one, so a long payload or
    // an argument under an unreadable directory moves nothing.
    const sure = new Set([
      ...shape.writes,
      ...(segment.class.startsWith("files.") ? named : []),
      ...(bin === null ? [] : fetchOutputValues(bin, shape.args)),
      ...gitWrites,
      ...(bin === null ? [] : readWriteSureTargets(bin, shape.args)),
    ]);
    const sources = bin === null ? [] : [...new Set(treeSources(bin, shape.args).filter(pathOrPattern))];
    if (candidates.length === 0 && sources.length === 0) continue;
    let hit: { word: string; landed: string } | null = null;
    for (const dir of before) {
      const inGit = gitDirsOf(dir);
      // Each candidate where it is placed: a pattern by each name it expands
      // to on disk, or by its text when it cannot be expanded.
      const placed: { word: string; spelled: string }[] = [];
      for (const candidate of candidates) {
        const { word } = candidate;
        // A sed name: placed as its literal text, AND judged below as the
        // shell word it may also be (a hit from either counts).
        if (candidate.literal) placed.push({ word, spelled: word });
        const spelled = word.startsWith("~/") && home !== undefined ? `${home}/${word.slice(2)}` : word;
        if (!isPattern(spelled)) {
          placed.push({ word, spelled });
          continue;
        }
        const text = spelled.startsWith("/") ? spelled : `${dir}/${spelled}`;
        if (mayNameGitDirectory(text)) {
          hit = { word, landed: `${text} (a pattern that names .git)` };
          break;
        }
        const expanded = expandOnce(dir, spelled);
        if ("giveUp" in expanded) {
          // Cannot be expanded: a sure target the strict way; a possible one
          // was judged by its text just above.
          if (sure.has(word)) {
            hit = { word, landed: `a place this hook cannot determine (${expanded.giveUp})` };
            break;
          }
          continue;
        }
        for (const each of expanded.paths) placed.push({ word, spelled: each.path });
      }
      if (hit !== null) break;
      for (const { word, spelled } of placed) {
        const walked = landOnce(spelled.startsWith("/") ? spelled : `${dir}/${spelled}`);
        if ("unplaceable" in walked) {
          if (sure.has(word) || walked.unplaceable === "ELOOP") {
            hit = { word, landed: `a place this hook cannot determine (${walked.unplaceable})` };
            break;
          }
          // A possible target: judged by its text, normalised, as before the
          // disk was read (a `.git` segment, or a known git directory).
          const text = normalize(spelled.startsWith("/") ? spelled : `${dir}/${spelled}`);
          if (hasGitSegment(text) || inGit.some((root) => within(text, root))) {
            hit = { word, landed: `${text} (by its text: ${walked.unplaceable})` };
            break;
          }
          continue;
        }
        const { landed, links } = walked;
        if (hasGitSegment(landed) || inGit.some((root) => within(landed, root)) || links.some((link) => hasGitSegment(link))) {
          hit = { word, landed };
          break;
        }
      }
      if (hit !== null) break;
      // Second review, N2: a copy or move of a tree that carries a `.git` at
      // its top (`cp -R /x/. .`, `rsync -a /x/ .`, `mv /x/.git .`) puts that
      // git directory, its hooks and its config where it lands.
      for (const word of sources) {
        const spelled = word.startsWith("~/") && home !== undefined ? `${home}/${word.slice(2)}` : word;
        let paths = [spelled.startsWith("/") ? spelled : `${dir}/${spelled}`];
        if (isPattern(spelled)) {
          const expanded = expandOnce(dir, spelled);
          if ("giveUp" in expanded) {
            if (sure.has(word)) {
              hit = { word, landed: `a tree this hook cannot list (${expanded.giveUp})` };
              break;
            }
            continue;
          }
          // The tree a copy reads: each real match, or the word as a name.
          paths = expanded.paths
            .filter((placed) => placed.from === "match" || (placed.from === "literal" && entryExists(placed.path)))
            .map((placed) => placed.path);
        }
        for (const path of paths) {
          const last = path.replace(/(?:\/\.?)+$/u, "").split("/").pop() ?? "";
          let carries = foldNameLower(last) === ".git";
          if (!carries) {
            try {
              carries = statSync(path).isDirectory() && existsSync(join(path, ".git"));
            } catch {
              carries = false;
            }
          }
          if (carries) {
            hit = { word, landed: `${path}, a tree that carries a .git entry` };
            break;
          }
        }
        if (hit !== null) break;
      }
      if (hit !== null) break;
    }
    if (hit === null) {
      // KNOWN LIMIT (measured: such lines are autonomous on 0.4.8 under this
      // repository's policy, so the strict answer would move ordinary lines).
      // A relative write after a directory change this step cannot place is
      // judged from the places it can name, as 0.4.8 judges it, and said so.
      const relative = candidates.map((candidate) => candidate.word).find((word) => !word.startsWith("/") && !word.startsWith("~/"));
      if (unknownBefore !== null && relative !== undefined) {
        notes.push(
          `git-dir-write: \`${segment.text}\` writes ${relative} after ${unknownBefore}, which this hook cannot place; it is judged from the directories it can name (known limit), and stays ${segment.class}`,
        );
      }
      continue;
    }
    // ADDED beside the segment, never in its place: the passes after this one
    // (scratch deletes, the read and write scopes, credential reads) still
    // judge the segment as it was, and a policy sees both classes, so no
    // policy can find the line looser than before (one that holds
    // `files.delete.out_of_scope` stricter than `vcs.history.rewrite` keeps it).
    added.set(index, { text: segment.text, class: REWRITE_CLASS, rule: GIT_DIR_WRITE_RULE, path: hit.word });
    notes.push(
      `git-dir-write: \`${segment.text}\` writes ${hit.word}, which lands at ${hit.landed}, inside a git directory; it is also ${REWRITE_CLASS} (was ${segment.class} alone)`,
    );
  }
  if (added.size === 0) return { result, notes };
  const segments: ClassifiedSegment[] = [];
  for (const [index, segment] of result.segments.entries()) {
    segments.push(segment);
    const extra = added.get(index);
    if (extra !== undefined) segments.push(extra);
  }
  const classes: string[] = [];
  for (const segment of segments) {
    if (!classes.includes(segment.class)) classes.push(segment.class);
  }
  return { result: { ok: true, segments, classes }, notes };
}
