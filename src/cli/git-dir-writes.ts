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

import { existsSync, lstatSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";

import {
  commandSegmentShapes,
  GATE_SELF_CLASS,
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
 * the way, as written. `null` when the walk cannot be finished: too many
 * links, or a component that cannot be examined.
 */
function physicalLanding(path: string): { landed: string; links: string[] } | null {
  const pending = path.split("/").filter((part) => part.length > 0);
  let current = "/";
  const links: string[] = [];
  let followed = 0;
  while (pending.length > 0) {
    const part = pending.shift() as string;
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
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        current = next;
        continue;
      }
      return null;
    }
    if (!stat.isSymbolicLink()) {
      current = next;
      continue;
    }
    followed += 1;
    if (followed > LINK_LIMIT) return null;
    let target: string;
    try {
      target = readlinkSync(next);
    } catch {
      return null;
    }
    links.push(target);
    if (target.startsWith("/")) current = "/";
    pending.unshift(...target.split("/").filter((piece) => piece.length > 0));
  }
  return { landed: current, links };
}

/** {@link physicalLanding}'s place alone, or `null`. */
function landing(path: string): string | null {
  return physicalLanding(path)?.landed ?? null;
}

/** Does this absolute path have a `.git` segment, in any case? */
function hasGitSegment(path: string): boolean {
  return path.split(sep).some((part) => part.toLowerCase() === ".git");
}

/** Is `path` `root` or below it, compared without case (APFS folds it)? */
function within(path: string, root: string): boolean {
  const p = path.toLowerCase();
  const r = root.toLowerCase().replace(/\/+$/u, "");
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
    if (!arg.startsWith("--")) for (let at = 2; at < arg.length; at += 1) words.push(arg.slice(at));
  }
  return words;
}

/** A word whose text is the path, with nothing the shell would still change. */
function literalPath(word: string): boolean {
  return word.length > 0 && !/[\s$`*?[\]{}~]/u.test(word.replace(/^~\//u, ""));
}

/** The command words that change the shell's directory, followed alike here. */
const DIRECTORY_CHANGERS: ReadonlySet<string> = new Set(["cd", "chdir", "pushd", "popd"]);

/**
 * Every directory a `cd` / `chdir` / `pushd` word may lead to from `dir`, as
 * text. A bare name is tried from `dir` and from every `CDPATH` entry of the
 * hook's own environment (an assignment on the segment itself counts as
 * unknown). A target the text cannot give (`cd "$D"`, `cd -`, `~user`, a
 * glob, `popd`, a `HOME=` or `CDPATH=` prefix) yields nothing: KNOWN LIMIT,
 * such a line keeps the hook's other directories, exactly as the write-scope
 * pass judges every write from the hook's own directory, and is not raised
 * for the unknown one.
 */
function directoryTargets(args: readonly string[], assignments: readonly string[], dir: string): string[] {
  if (assignments.length > 0) return [];
  const words = args.filter((word) => !/^-[LPe@]+$/u.test(word));
  const operands = words[0] === "--" ? words.slice(1) : words;
  const home = process.env["HOME"];
  if (operands.length === 0) return home === undefined ? [] : [home];
  if (operands.length !== 1) return [];
  const word = operands[0] as string;
  if (word === "-" || word.startsWith("-") || /[$`*?[\]{}\\]/u.test(word)) return [];
  if (word === "~") return home === undefined ? [] : [home];
  if (word.startsWith("~/")) return home === undefined ? [] : [`${home}/${word.slice(2)}`];
  if (word.startsWith("~")) return [];
  if (word.startsWith("/")) return [word];
  const targets = [`${dir}/${word}`];
  if (!word.startsWith("./") && !word.startsWith("../") && word !== "." && word !== "..") {
    for (const entry of (process.env["CDPATH"] ?? "").split(":")) {
      if (entry.length === 0) continue;
      targets.push(entry.startsWith("/") ? `${entry}/${word}` : `${dir}/${entry}/${word}`);
    }
  }
  return targets;
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
  const segments = [...result.segments];
  const gitDirs = new Map<string, string[]>();
  const gitDirsOf = (dir: string): string[] => {
    let known = gitDirs.get(dir);
    if (known === undefined) {
      known = gitDirectoriesOf(dir);
      gitDirs.set(dir, known);
    }
    return known;
  };
  // Every directory a segment may run in, as TEXT (joined, never normalised,
  // so the physical walk applies each `..`): the hook's own and every place a
  // directory change before it may lead. A failed `cd` leaves the shell where
  // it was, so the set only grows, and `popd` returns to a directory already
  // in it.
  const home = process.env["HOME"];
  let dirs = [cwd];
  for (const [index, segment] of result.segments.entries()) {
    const shapes = commandSegmentShapes(segment.text);
    if (shapes === null) continue;
    const before = dirs;
    for (const shape of shapes) {
      const bin = shape.bin === null ? null : (shape.bin.split("/").pop() ?? shape.bin);
      if (bin === null || !DIRECTORY_CHANGERS.has(bin)) continue;
      const next: string[] = [];
      for (const dir of dirs) next.push(...directoryTargets(shape.args, shape.assignments, dir));
      dirs = [...new Set([...dirs, ...next])];
    }
    if (segment.class === REWRITE_CLASS || segment.class === GATE_SELF_CLASS) continue;
    const shape = shapes[0];
    if (shapes.length !== 1 || shape === undefined) continue;
    const bin = shape.bin === null ? null : (shape.bin.split("/").pop() ?? shape.bin);
    const reads = segment.class.startsWith("read.") && bin !== "curl" && bin !== "wget";
    // A read writes nothing but its redirection; `git`'s own words are not
    // file writes (its rows classify what git writes).
    const candidates = [
      ...shape.writes,
      ...(reads || segment.rule === "redirect-write" || bin === "git" ? [] : writeWords(shape.args)),
    ].filter(literalPath);
    if (candidates.length === 0) continue;
    let hit: { word: string; landed: string } | null = null;
    for (const dir of before) {
      const inGit = gitDirsOf(dir);
      for (const word of candidates) {
        const spelled = word.startsWith("~/") && home !== undefined ? `${home}/${word.slice(2)}` : word;
        const walked = physicalLanding(spelled.startsWith("/") ? spelled : `${dir}/${spelled}`);
        // A path whose walk cannot be finished (a link loop) is judged the
        // stricter way.
        if (walked === null) {
          hit = { word, landed: "an unresolvable path" };
          break;
        }
        const { landed, links } = walked;
        if (hasGitSegment(landed) || inGit.some((root) => within(landed, root)) || links.some((link) => hasGitSegment(link))) {
          hit = { word, landed };
          break;
        }
      }
      if (hit !== null) break;
    }
    if (hit === null) continue;
    const { path: _dropped, ...rest } = segment as ClassifiedSegment;
    segments[index] = { ...rest, class: REWRITE_CLASS, rule: GIT_DIR_WRITE_RULE, path: hit.word };
    notes.push(
      `git-dir-write: \`${segment.text}\` writes ${hit.word}, which lands at ${hit.landed}, inside a git directory; it is ${REWRITE_CLASS}, was ${segment.class} (${segment.rule})`,
    );
  }
  if (notes.length === 0) return { result, notes };
  const classes: string[] = [];
  for (const segment of segments) {
    if (!classes.includes(segment.class)) classes.push(segment.class);
  }
  return { result: { ok: true, segments, classes }, notes };
}
