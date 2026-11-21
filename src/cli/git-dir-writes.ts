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

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import {
  commandSegmentShapes,
  GATE_SELF_CLASS,
  type ClassifiedSegment,
  type CommandClassification,
} from "../core/command-class.js";
import { cdTarget } from "./push-repo.js";

const REWRITE_CLASS = "vcs.history.rewrite";
const GIT_DIR_WRITE_RULE = "git-dir-write";

/** `path` with its existing prefix resolved through symlinks, or `null`. */
function landing(path: string): string | null {
  let existing = path;
  const tail: string[] = [];
  for (let depth = 0; depth < 64; depth += 1) {
    if (existsSync(existing)) break;
    const up = dirname(existing);
    if (up === existing) return null;
    tail.unshift(basename(existing));
    existing = up;
  }
  try {
    const real = realpathSync(existing);
    return tail.length === 0 ? real : join(real, ...tail);
  } catch {
    return null;
  }
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
        if (statSync(entry).isDirectory()) return [realpathSync(entry)];
        const named = /^gitdir:\s*(.+)$/mu.exec(readFileSync(entry, "utf8"));
        if (named === null) return [];
        const gitdir = landing(resolve(at, (named[1] as string).trim()));
        if (gitdir === null) return [];
        const found = [gitdir];
        const commonFile = join(gitdir, "commondir");
        if (existsSync(commonFile)) {
          const common = landing(resolve(gitdir, readFileSync(commonFile, "utf8").trim()));
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
  let dirs = [cwd];
  const home = process.env["HOME"];
  for (const [index, segment] of result.segments.entries()) {
    const shapes = commandSegmentShapes(segment.text);
    if (shapes === null) continue;
    const before = dirs;
    for (const shape of shapes) {
      const bin = shape.bin === null ? null : (shape.bin.split("/").pop() ?? shape.bin);
      if (bin === "cd" && shape.assignments.length === 0) {
        const next: string[] = [];
        for (const dir of dirs) {
          const target = cdTarget(shape.args, dir);
          if (target !== null) next.push(target);
        }
        dirs = [...new Set([...dirs, ...next])];
      }
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
        const spelled = word.startsWith("~/") && home !== undefined ? join(home, word.slice(2)) : word;
        const landed = landing(isAbsolute(spelled) ? spelled : resolve(dir, spelled));
        if (landed === null) continue;
        if (hasGitSegment(landed) || inGit.some((root) => within(landed, root))) {
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
