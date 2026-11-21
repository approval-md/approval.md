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
import { dirname, join, normalize, sep } from "node:path";

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
 * the way, as written. A missing component is applied as text, as the
 * kernel applies it. Any other failure (EACCES, ENAMETOOLONG, a link loop,
 * an unreadable link) is `unplaceable`, with its code.
 */
function physicalLanding(path: string): { landed: string; links: string[] } | { unplaceable: string } {
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
    pending.unshift(...target.split("/").filter((piece) => piece.length > 0));
  }
  return { landed: current, links };
}

/** {@link physicalLanding}'s place alone, or `null`. */
function landing(path: string): string | null {
  const walked = physicalLanding(path);
  return "landed" in walked ? walked.landed : null;
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
 * The output a `curl` or `wget` writes, from its own options: curl's `-o` /
 * `--output`, wget's `-O` / `--output-document` / `-P` / `--directory-prefix`,
 * separate, attached or `=`.
 */
function fetchOutputValues(bin: string, args: readonly string[]): string[] {
  const short = bin === "curl" ? ["-o"] : bin === "wget" ? ["-O", "-P"] : [];
  const long = bin === "curl" ? ["--output"] : bin === "wget" ? ["--output-document", "--directory-prefix"] : [];
  const values: string[] = [];
  for (const [at, arg] of args.entries()) {
    const next = args[at + 1];
    if ((short.includes(arg) || long.includes(arg)) && next !== undefined) values.push(next);
    for (const flag of short) if (arg.startsWith(flag) && arg.length > flag.length) values.push(arg.slice(flag.length));
    for (const flag of long) if (arg.startsWith(`${flag}=`)) values.push(arg.slice(flag.length + 1));
  }
  return values;
}

/** A word whose text is the path, with nothing the shell would still change. */
function literalPath(word: string): boolean {
  return word.length > 0 && !/[\s$`*?[\]{}~]/u.test(word.replace(/^~\//u, ""));
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
  if (/[$`*?[\]{}\\]/u.test(word)) return { targets: [], unknown: `\`${bin} ${word}\` (a word the shell may still change)` };
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
    const shapes = commandSegmentShapes(segment.text);
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
    const reads = segment.class.startsWith("read.") && bin !== "curl" && bin !== "wget";
    // A read writes nothing but its redirection; `git`'s own words are not
    // file writes (its rows classify what git writes).
    const named = reads || segment.rule === "redirect-write" || bin === "git" ? [] : writeWords(shape.args).filter(literalPath);
    const candidates = [...shape.writes.filter(literalPath), ...named];
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
    ]);
    if (candidates.length === 0) continue;
    let hit: { word: string; landed: string } | null = null;
    for (const dir of before) {
      const inGit = gitDirsOf(dir);
      for (const word of candidates) {
        const spelled = word.startsWith("~/") && home !== undefined ? `${home}/${word.slice(2)}` : word;
        const walked = physicalLanding(spelled.startsWith("/") ? spelled : `${dir}/${spelled}`);
        if ("unplaceable" in walked) {
          if (sure.has(word) || walked.unplaceable === "ELOOP") {
            hit = { word, landed: `a place this hook cannot determine (${walked.unplaceable})` };
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
    }
    if (hit === null) {
      // KNOWN LIMIT (measured: such lines are autonomous on 0.4.8 under this
      // repository's policy, so the strict answer would move ordinary lines).
      // A relative write after a directory change this step cannot place is
      // judged from the places it can name, as 0.4.8 judges it, and said so.
      const relative = candidates.find((word) => !word.startsWith("/") && !word.startsWith("~/"));
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
