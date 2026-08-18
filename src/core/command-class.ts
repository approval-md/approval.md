/**
 * Shell command classification: a pure, deterministic map from a command line
 * to the SPEC.md §7 side-effect classes it would produce (APRV-82).
 *
 * This is the input half of the Claude Code PreToolUse hook. The harness hands
 * us a command string it is about to run; policy speaks in classes; something
 * has to translate. That translation is the reviewable artifact of this task, so
 * it lives in one file, is data-driven, and is exhaustively fixture-tested.
 *
 * Three properties are load-bearing.
 *
 * **Pure.** No filesystem, no clock, no environment, no network. The same string
 * always yields the same answer, which is what makes the fixture table a real
 * specification rather than a sample of observed behaviour.
 *
 * **Fail closed, in three named ways.** A construct whose effect cannot be read
 * off the text is `opaque` (`bash -c`, `eval`, backticks, a tainting command
 * substitution). A binary the table does not know is `unclassified`. A string
 * the tokenizer cannot even split is `unparseable`. All three are refusals, and
 * the hook denies on each: the alternative, guessing a class for a command we do
 * not understand, would let the least legible command lines through the widest
 * gap. Ambiguity inside a construct we DO understand resolves to the stricter
 * class (`git push` with no refspec is `vcs.push.main`, an `rm` path holding an
 * unexpanded `$VAR` is `files.delete.out_of_scope`).
 *
 * **Best effort, and honest about it.** This is a classifier over shell text,
 * not a shell. It is a speed bump against an agent doing the wrong thing by
 * mistake, in the SPEC.md §11 sense; it is not scheming-robust, and nothing here
 * claims otherwise. The hard boundary stays where SPEC.md §10.4 puts it: the
 * credentials in the vault and the token an adapter demands.
 *
 * Self-reported text is never read. The hook passes the command only; the
 * harness's `description` field is authored by the very agent being gated
 * (SPEC.md §11.1: self-reported fields never reduce scrutiny).
 */

// ===========================================================================
// Result shape
// ===========================================================================

/** Why a command could not be classified. Each denies; none is a soft failure. */
export type ClassifierFailureCode = "unclassified" | "opaque" | "unparseable";

/** One command in a pipeline or list, with the class it resolved to. */
export interface ClassifiedSegment {
  /** The segment's source text, as written. */
  text: string;
  /** The dotted side-effect class (SPEC.md §7). */
  class: string;
  /** Which rule decided it, for `hook classify` output and for tests. */
  rule: string;
}

export type CommandClassification =
  | { ok: true; segments: ClassifiedSegment[]; classes: string[] }
  | {
      ok: false;
      code: ClassifierFailureCode;
      /** The segment (or whole command) that could not be read. */
      segment: string;
      detail: string;
    };

/**
 * The pass-through pseudo-class for the gate's own CLI.
 *
 * `approval …` is already the enforcement path — gating it with itself would
 * either deadlock (the hook waiting on a decision that `approval grant` cannot
 * deliver) or recurse. The hook allows this class without touching the log; it
 * is never written to any envelope and no policy rule should name it.
 */
export const GATE_SELF_CLASS = "gate.self";

// ===========================================================================
// Protected paths (policy.edit)
// ===========================================================================

/**
 * Files whose edit is `policy.edit` wherever they sit: the policy itself, the
 * agent instructions that carry the same authority in prose, and the release
 * configuration.
 */
const PROTECTED_FILENAMES: readonly string[] = [
  "APPROVAL.md",
  "APPROVALS.md",
  "CLAUDE.md",
  "AGENTS.md",
  ".npmrc",
];

/** Split a path into segments, dropping `./` noise. Never touches the disk. */
function pathSegments(candidate: string): string[] {
  return candidate
    .split(/[/\\]+/u)
    .filter((segment) => segment.length > 0 && segment !== ".");
}

/**
 * Does this path name something only a human may write? (`policy.edit`.)
 *
 * Deliberately name-based rather than location-based: the hook runs in whatever
 * directory the harness is in, and a classifier that resolved paths against a
 * checkout would answer differently in a worktree than in the primary. A
 * false positive here costs one approval prompt; a false negative costs the
 * property the whole file exists to defend.
 */
export function isProtectedPath(candidate: string): boolean {
  if (candidate.length === 0) return false;
  const segments = pathSegments(candidate);
  const last = segments[segments.length - 1];
  if (last !== undefined && PROTECTED_FILENAMES.includes(last)) return true;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    // The whole approval home: log, payload store, vault, environment map.
    if (segment === ".approval") return true;
    // The harness's own settings, which is where a hook is installed or removed.
    if (segment === ".claude") {
      const next = segments[index + 1];
      if (next !== undefined && next.startsWith("settings")) return true;
    }
    // CI configuration.
    if (segment === ".github" && segments[index + 1] === "workflows") return true;
  }
  return false;
}

// ===========================================================================
// Tokenizer
// ===========================================================================

interface LexWord {
  /** Literal text, quotes removed and backslash escapes applied. */
  text: string;
  /** True when any part of the word was quoted. */
  quoted: boolean;
  /** Inner text of each `$(…)` in this word, for recursive classification. */
  substitutions: string[];
}

interface LexRedirect {
  /** `>` and `>>` write; `<` reads. */
  op: ">" | ">>" | "<";
  target: LexWord;
}

interface LexSegment {
  text: string;
  words: LexWord[];
  redirects: LexRedirect[];
  /** Set when the segment contains a construct whose effect cannot be read. */
  opaque: string | null;
}

type LexResult =
  | { ok: true; segments: LexSegment[] }
  | { ok: false; detail: string };

const OPERATOR_CHARS = new Set(["&", "|", ";", "(", ")", "<", ">", "\n"]);

/** A pending `<<TERMINATOR` whose body is skipped at the next newline. */
interface PendingHeredoc {
  terminator: string;
  stripTabs: boolean;
}

/**
 * Split a command line into segments.
 *
 * Understood: single and double quotes, backslash escapes and line
 * continuations, leading `VAR=value` assignments (left in the word list and
 * stripped by the classifier), redirections including heredocs, the operators
 * `&& || ; | &` and newline, subshell parentheses, `$(…)` command substitution
 * (captured for recursive classification) and backticks (recorded as opaque).
 *
 * Not understood, on purpose: parameter expansion values. `$VAR` and `${VAR}`
 * are kept verbatim in the word text, and every rule that reads a path or a
 * refspec treats a word containing `$` as unknown, which resolves stricter.
 */
function lex(command: string): LexResult {
  const segments: LexSegment[] = [];
  let words: LexWord[] = [];
  let redirects: LexRedirect[] = [];
  let opaque: string | null = null;
  let segmentStart = 0;
  let index = 0;
  const pending: PendingHeredoc[] = [];

  const flush = (end: number): void => {
    if (words.length > 0 || redirects.length > 0 || opaque !== null) {
      segments.push({
        text: command.slice(segmentStart, end).trim(),
        words,
        redirects,
        opaque,
      });
    }
    words = [];
    redirects = [];
    opaque = null;
    segmentStart = end;
  };

  /**
   * Read one word starting at `index`, stopping at unquoted whitespace or an
   * operator character. Returns `null` for an unterminated quote or
   * substitution.
   */
  const readWord = (): LexWord | null => {
    let text = "";
    let quoted = false;
    const substitutions: string[] = [];
    const start = index;

    for (; index < command.length; index += 1) {
      const ch = command[index] as string;

      if (ch === " " || ch === "\t") break;
      if (OPERATOR_CHARS.has(ch)) break;

      if (ch === "\\") {
        const next = command[index + 1];
        if (next === undefined) {
          text += "\\";
          continue;
        }
        // A backslash-newline is a line continuation and contributes nothing.
        if (next !== "\n") text += next;
        index += 1;
        continue;
      }

      if (ch === "'") {
        const close = command.indexOf("'", index + 1);
        if (close === -1) return null;
        text += command.slice(index + 1, close);
        quoted = true;
        index = close;
        continue;
      }

      if (ch === '"') {
        const scan = readDoubleQuoted(command, index);
        if (scan === null) return null;
        text += scan.text;
        substitutions.push(...scan.substitutions);
        if (scan.opaque !== null) opaque = scan.opaque;
        quoted = true;
        index = scan.end;
        continue;
      }

      if (ch === "`") {
        // A backtick substitution is legal shell and unreadable here: its inner
        // text is nested-quoted differently from `$(…)`, and the construct is
        // rare enough that refusing it costs nothing a rewrite cannot fix.
        const close = command.indexOf("`", index + 1);
        if (close === -1) return null;
        opaque = "backtick command substitution";
        index = close;
        continue;
      }

      if (ch === "$" && command[index + 1] === "(") {
        if (command[index + 2] === "(") {
          const end = command.indexOf("))", index + 3);
          if (end === -1) return null;
          opaque = "arithmetic expansion";
          index = end + 1;
          continue;
        }
        const scan = readSubstitution(command, index + 1);
        if (scan === null) return null;
        substitutions.push(scan.inner);
        index = scan.end;
        continue;
      }

      text += ch;
    }

    // Nothing consumed means the caller was at a delimiter: no word here. A
    // word that consumed characters and produced no text is still a word (`''`,
    // or a backtick substitution that only set the opaque flag).
    if (index === start) return null;
    return { text, quoted, substitutions };
  };

  while (index < command.length) {
    const ch = command[index] as string;

    if (ch === " " || ch === "\t" || ch === "\r") {
      index += 1;
      continue;
    }

    if (ch === "\\" && command[index + 1] === "\n") {
      index += 2;
      continue;
    }

    if (ch === "\n") {
      const boundary = index;
      index += 1;
      // Heredoc bodies belong to the line that opened them, so they are
      // consumed here and never classified. A body is data, not commands.
      while (pending.length > 0) {
        const heredoc = pending.shift() as PendingHeredoc;
        const consumed = skipHeredocBody(command, index, heredoc);
        if (consumed === null) {
          return { ok: false, detail: `heredoc <<${heredoc.terminator} is never terminated` };
        }
        index = consumed;
      }
      flush(boundary);
      segmentStart = index;
      continue;
    }

    // Redirections, including the fd-prefixed and dup forms.
    const redirect = /^(\d*)(>>|>&|>\||>|<<-|<<|<&|<)/u.exec(command.slice(index));
    if (redirect !== null) {
      const op = redirect[2] as string;
      index += (redirect[0] as string).length;
      if (op === "<<" || op === "<<-") {
        while (command[index] === " " || command[index] === "\t") index += 1;
        const terminator = readWord();
        if (terminator === null) {
          return { ok: false, detail: "heredoc has no terminator word" };
        }
        pending.push({ terminator: terminator.text, stripTabs: op === "<<-" });
        continue;
      }
      if (op === ">&" || op === "<&") {
        // `2>&1` and friends: a file descriptor dup, no path involved.
        while (index < command.length && /[\d-]/u.test(command[index] as string)) index += 1;
        continue;
      }
      while (command[index] === " " || command[index] === "\t") index += 1;
      const target = readWord();
      if (target === null) {
        return { ok: false, detail: `redirection ${op} has no target` };
      }
      redirects.push({ op: op === ">>" ? ">>" : op === "<" ? "<" : ">", target });
      continue;
    }

    if (ch === "&" || ch === "|" || ch === ";" || ch === "(" || ch === ")") {
      const boundary = index;
      index += ch === "&" && command[index + 1] === "&" ? 2 : ch === "|" && command[index + 1] === "|" ? 2 : 1;
      flush(boundary);
      segmentStart = index;
      continue;
    }

    const word = readWord();
    if (word === null) {
      return { ok: false, detail: "unterminated quote or command substitution" };
    }
    words.push(word);
  }

  if (pending.length > 0) {
    const heredoc = pending[0] as PendingHeredoc;
    return { ok: false, detail: `heredoc <<${heredoc.terminator} is never terminated` };
  }
  flush(command.length);
  return { ok: true, segments };
}

/** Scan a double-quoted string starting at the opening quote. */
function readDoubleQuoted(
  command: string,
  start: number,
): { text: string; end: number; substitutions: string[]; opaque: string | null } | null {
  let text = "";
  const substitutions: string[] = [];
  let opaque: string | null = null;
  let index = start + 1;

  for (; index < command.length; index += 1) {
    const ch = command[index] as string;
    if (ch === '"') return { text, end: index, substitutions, opaque };
    if (ch === "\\") {
      const next = command[index + 1];
      if (next === undefined) break;
      if (next !== "\n") text += next;
      index += 1;
      continue;
    }
    if (ch === "`") {
      const close = command.indexOf("`", index + 1);
      if (close === -1) return null;
      opaque = "backtick command substitution";
      index = close;
      continue;
    }
    if (ch === "$" && command[index + 1] === "(") {
      if (command[index + 2] === "(") {
        const end = command.indexOf("))", index + 3);
        if (end === -1) return null;
        opaque = "arithmetic expansion";
        index = end + 1;
        continue;
      }
      const scan = readSubstitution(command, index + 1);
      if (scan === null) return null;
      substitutions.push(scan.inner);
      index = scan.end;
      continue;
    }
    text += ch;
  }
  return null;
}

/**
 * Scan `(…)` starting at the opening paren, honouring nesting and quotes, and
 * return the inner text plus the index of the closing paren.
 */
function readSubstitution(command: string, start: number): { inner: string; end: number } | null {
  let depth = 0;
  for (let index = start; index < command.length; index += 1) {
    const ch = command[index] as string;
    if (ch === "\\") {
      index += 1;
      continue;
    }
    if (ch === "'") {
      const close = command.indexOf("'", index + 1);
      if (close === -1) return null;
      index = close;
      continue;
    }
    if (ch === '"') {
      const close = closingDoubleQuote(command, index);
      if (close === null) return null;
      index = close;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return { inner: command.slice(start + 1, index), end: index };
    }
  }
  return null;
}

/** Index of the `"` closing the one at `start`, or `null`. */
function closingDoubleQuote(command: string, start: number): number | null {
  for (let index = start + 1; index < command.length; index += 1) {
    const ch = command[index];
    if (ch === "\\") {
      index += 1;
      continue;
    }
    if (ch === '"') return index;
  }
  return null;
}

/** Consume a heredoc body; returns the index after it, or `null` if unclosed. */
function skipHeredocBody(command: string, start: number, heredoc: PendingHeredoc): number | null {
  let index = start;
  for (;;) {
    if (index >= command.length) return null;
    const newline = command.indexOf("\n", index);
    const line = newline === -1 ? command.slice(index) : command.slice(index, newline);
    const compared = heredoc.stripTabs ? line.replace(/^\t+/u, "") : line;
    if (compared.trimEnd() === heredoc.terminator) {
      return newline === -1 ? command.length : newline + 1;
    }
    if (newline === -1) return null;
    index = newline + 1;
  }
}

// ===========================================================================
// The rule table
// ===========================================================================

/** Everything a refinement needs: the binary and the words that followed it. */
interface RuleContext {
  bin: string;
  /** Words after the binary, quotes already removed. */
  args: string[];
  /** Words after the binary that are not flags. */
  positionals: string[];
  /** The matched subcommand (first positional), or `null`. */
  sub: string | null;
}

/** A refinement's answer: a class and the rule id that chose it. */
interface Refinement {
  class: string;
  rule: string;
}

/**
 * One row of the classification table.
 *
 * `bins` + `subs` is the match; `class` is the answer. A row with a `refine`
 * looks at the flags before answering, and declares every class it can emit in
 * `emits` so the table stays enumerable (the dogfood test reads that list).
 */
export interface CommandRule {
  /** Stable identifier, printed by `hook classify` and pinned by the fixtures. */
  id: string;
  bins: readonly string[];
  /** Match only when the first positional is one of these. */
  subs?: readonly string[];
  class: string;
  /** Additional classes a refinement may return. */
  emits?: readonly string[];
  /** Flag-sensitive answer; falls back to `class` when it returns `null`. */
  refine?: (ctx: RuleContext) => Refinement | null;
}

/** Is `word` a flag rather than a positional? */
function isFlag(word: string): boolean {
  return word.startsWith("-") && word !== "-";
}

/** Does any argument match one of these exact flags? */
function hasFlag(args: readonly string[], names: readonly string[]): boolean {
  return args.some((arg) => {
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    return names.includes(name);
  });
}

/** Does any short-flag bundle (`-rf`) carry one of these letters? */
function hasShortFlag(args: readonly string[], letters: readonly string[]): boolean {
  return args.some((arg) => {
    if (!arg.startsWith("-") || arg.startsWith("--")) return false;
    const bundle = arg.slice(1);
    return letters.some((letter) => bundle.includes(letter));
  });
}

/**
 * A value the classifier cannot read: an unexpanded parameter, a glob, a home
 * shortcut. Every rule that reads one resolves to its stricter branch.
 */
function isUnknownValue(word: string): boolean {
  return word.includes("$") || word.includes("*") || word.includes("?") || word.startsWith("~");
}

/** `git push` — the three push classes turn on flags and refspecs. */
function refineGitPush(ctx: RuleContext): Refinement {
  const args = ctx.args.slice(1);
  if (hasFlag(args, ["--force", "-f", "--force-with-lease", "--force-if-includes"])) {
    return { class: "vcs.history.rewrite", rule: "git-push-force" };
  }
  const positionals = args.filter((arg) => !isFlag(arg));
  // A deletion, or a push with no refspec at all: the destination is either the
  // trunk or unknown, and unknown resolves to the stricter class.
  if (hasFlag(args, ["--delete", "-d"])) {
    return { class: "vcs.push.main", rule: "git-push-delete" };
  }
  const refspecs = positionals.slice(1);
  if (refspecs.length === 0) {
    return { class: "vcs.push.main", rule: "git-push-implicit" };
  }
  let sawMain = false;
  for (const refspec of refspecs) {
    if (refspec.startsWith("+")) {
      return { class: "vcs.history.rewrite", rule: "git-push-force" };
    }
    const colon = refspec.indexOf(":");
    const destination = colon === -1 ? refspec : refspec.slice(colon + 1);
    // `:branch` (empty source) and `src:` (empty destination) both delete a
    // remote ref. A deletion is destructive whatever it names, so it takes the
    // stricter class rather than the branch one.
    if (destination.length === 0 || (colon !== -1 && refspec.slice(0, colon).length === 0)) {
      return { class: "vcs.push.main", rule: "git-push-delete" };
    }
    if (isUnknownValue(destination)) {
      sawMain = true;
      continue;
    }
    const branch = destination.replace(/^refs\/heads\//u, "");
    if (branch === "main" || branch === "master") sawMain = true;
  }
  return sawMain
    ? { class: "vcs.push.main", rule: "git-push-main" }
    : { class: "vcs.push.branch", rule: "git-push-branch" };
}

/** `rm` — everything outside the workspace, and every unreadable path, is manual. */
function refineRm(ctx: RuleContext): Refinement {
  const recursive =
    hasFlag(ctx.args, ["--recursive"]) || hasShortFlag(ctx.args, ["r", "R"]);
  for (const path of ctx.positionals) {
    if (path.startsWith("/")) return { class: "files.delete.out_of_scope", rule: "rm-absolute" };
    if (pathSegments(path).includes("..")) {
      return { class: "files.delete.out_of_scope", rule: "rm-parent" };
    }
    if (isUnknownValue(path)) {
      return { class: "files.delete.out_of_scope", rule: "rm-unreadable-path" };
    }
    if (recursive && (path === "." || path === "..")) {
      return { class: "files.delete.out_of_scope", rule: "rm-recursive-root" };
    }
  }
  return { class: "files.write.workspace", rule: "rm-workspace" };
}

/** `git commit --amend` rewrites; a plain commit does not. */
function refineGitCommit(ctx: RuleContext): Refinement {
  return hasFlag(ctx.args, ["--amend"])
    ? { class: "vcs.history.rewrite", rule: "git-commit-amend" }
    : { class: "vcs.commit.branch", rule: "git-commit" };
}

/** `git reset --hard` discards committed work; a soft reset moves a pointer. */
function refineGitReset(ctx: RuleContext): Refinement {
  return hasFlag(ctx.args, ["--hard"])
    ? { class: "vcs.history.rewrite", rule: "git-reset-hard" }
    : { class: "vcs.commit.branch", rule: "git-reset" };
}

/** `git branch` reads until it is asked to delete, rename or force-set one. */
function refineGitBranch(ctx: RuleContext): Refinement {
  const mutating =
    hasFlag(ctx.args, ["--delete", "--move", "--copy", "--force", "--set-upstream-to"]) ||
    hasShortFlag(ctx.args, ["d", "D", "m", "M", "c", "C", "f"]);
  return mutating
    ? { class: "vcs.commit.branch", rule: "git-branch-write" }
    : { class: "read.shell", rule: "git-branch-read" };
}

/** `npm install` with a package name adds a dependency; without one it restores. */
function refineNpmInstall(ctx: RuleContext): Refinement {
  const packages = ctx.positionals.slice(1);
  return packages.length === 0
    ? { class: "deps.install", rule: "npm-install-lockfile" }
    : { class: "deps.add", rule: "npm-install-package" };
}

/** `sed -i` edits in place; every other `sed` reads. */
function refineSed(ctx: RuleContext): Refinement {
  const inPlace =
    hasFlag(ctx.args, ["--in-place"]) ||
    ctx.args.some((arg) => arg.startsWith("-i") && !arg.startsWith("--"));
  return inPlace
    ? { class: "files.write.workspace", rule: "sed-in-place" }
    : { class: "read.shell", rule: "sed-read" };
}

/** Does this path invoke the compiled `approval` CLI? */
function isGateEntrypoint(path: string): boolean {
  const segments = pathSegments(path);
  const last = segments[segments.length - 1];
  // The repository-root wrapper (`cli.js`, `./cli.js`), or the compiled entry
  // point under dist/. A `cli.js` in some other directory is just a script.
  if (last === "cli.js") {
    const dir = segments.slice(0, -1).filter((segment) => segment !== ".");
    return dir.length === 0;
  }
  if (last !== "main.js") return false;
  return segments.slice(0, -1).join("/").endsWith("dist/src/cli");
}

/**
 * `node` — an inline script is opaque, the gate's own entry point is
 * pass-through, and anything else is a workspace script.
 */
function refineNode(ctx: RuleContext): Refinement | null {
  if (hasFlag(ctx.args, ["-e", "--eval", "-p", "--print"])) return null;
  const script = ctx.positionals[0];
  if (script !== undefined && isGateEntrypoint(script)) {
    return { class: GATE_SELF_CLASS, rule: "node-approval-cli" };
  }
  return { class: "files.write.workspace", rule: "node-script" };
}

/**
 * The table.
 *
 * Order matters: the first row whose binary and subcommand match decides. Rows
 * are grouped by binary, strictest interpretation first within a binary, and
 * every class named here is one SPEC.md §7 declares (§7's developer-workstation
 * namespaces, plus `read.shell` / `read.vcs.remote` under `read.*`).
 */
export const COMMAND_RULES: readonly CommandRule[] = [
  // -- git -----------------------------------------------------------------
  {
    id: "git-push",
    bins: ["git"],
    subs: ["push"],
    class: "vcs.push.main",
    emits: ["vcs.push.branch", "vcs.push.main", "vcs.history.rewrite"],
    refine: refineGitPush,
  },
  {
    id: "git-rewrite",
    bins: ["git"],
    subs: ["rebase", "filter-branch", "filter-repo"],
    class: "vcs.history.rewrite",
  },
  { id: "git-reset", bins: ["git"], subs: ["reset"], class: "vcs.commit.branch", emits: ["vcs.history.rewrite"], refine: refineGitReset },
  { id: "git-commit", bins: ["git"], subs: ["commit"], class: "vcs.commit.branch", emits: ["vcs.history.rewrite"], refine: refineGitCommit },
  { id: "git-branch", bins: ["git"], subs: ["branch"], class: "read.shell", emits: ["vcs.commit.branch"], refine: refineGitBranch },
  { id: "git-tag", bins: ["git"], subs: ["tag"], class: "release.publish" },
  { id: "git-clone", bins: ["git"], subs: ["clone"], class: "network.call" },
  {
    id: "git-write",
    bins: ["git"],
    subs: [
      "add",
      "apply",
      "checkout",
      "cherry-pick",
      "merge",
      "mv",
      "pull",
      "restore",
      "revert",
      "rm",
      "stash",
      "switch",
      "worktree",
    ],
    class: "vcs.commit.branch",
  },
  {
    id: "git-remote-read",
    bins: ["git"],
    subs: ["fetch", "ls-remote", "remote"],
    class: "read.vcs.remote",
  },
  {
    id: "git-read",
    bins: ["git"],
    subs: [
      "blame",
      "describe",
      "diff",
      "grep",
      "log",
      "ls-files",
      "reflog",
      "rev-list",
      "rev-parse",
      "shortlog",
      "show",
      "status",
    ],
    class: "read.shell",
  },

  // -- gh ------------------------------------------------------------------
  { id: "gh-release", bins: ["gh"], subs: ["release"], class: "release.publish" },
  { id: "gh-api", bins: ["gh"], subs: ["api", "auth", "gist", "secret", "workflow"], class: "network.call" },
  {
    id: "gh-simple-read",
    bins: ["gh"],
    subs: ["browse", "search", "status"],
    class: "read.vcs.remote",
  },
  // `gh pr`, `gh issue`, `gh repo` and `gh run` split on their own second word;
  // the split is a refinement because the table matches one subcommand deep.
  {
    id: "gh",
    bins: ["gh"],
    subs: ["pr", "issue", "repo", "run", "cache"],
    class: "network.call",
    emits: ["read.vcs.remote", "network.call"],
    refine: refineGh,
  },

  // -- package managers ----------------------------------------------------
  { id: "npm-publish", bins: ["npm", "pnpm", "yarn", "bun"], subs: ["publish", "version", "deprecate", "dist-tag", "unpublish"], class: "release.publish" },
  { id: "npm-install", bins: ["npm", "bun"], subs: ["install", "i", "add"], class: "deps.add", emits: ["deps.install"], refine: refineNpmInstall },
  { id: "yarn-add", bins: ["yarn", "pnpm"], subs: ["add"], class: "deps.add" },
  { id: "yarn-install", bins: ["yarn", "pnpm"], subs: ["install"], class: "deps.install" },
  { id: "npm-ci", bins: ["npm", "pnpm", "yarn", "bun"], subs: ["ci"], class: "deps.install" },
  { id: "npm-update", bins: ["npm", "pnpm", "yarn", "bun"], subs: ["update", "upgrade", "up"], class: "deps.upgrade" },
  { id: "npm-remove", bins: ["npm", "pnpm", "yarn", "bun"], subs: ["uninstall", "remove", "rm", "un"], class: "deps.remove" },
  { id: "npm-link", bins: ["npm", "pnpm", "yarn", "bun"], subs: ["link"], class: "deps.add" },
  { id: "npm-network", bins: ["npm", "pnpm", "yarn", "bun"], subs: ["audit", "outdated", "view", "search", "info", "login", "whoami"], class: "network.call" },
  { id: "npm-list", bins: ["npm", "pnpm", "yarn", "bun"], subs: ["ls", "list", "config", "help"], class: "read.shell" },
  { id: "npm-script", bins: ["npm", "pnpm", "yarn", "bun"], subs: ["run", "run-script", "test", "start", "build", "lint", "exec"], class: "files.write.workspace" },

  // -- workspace tools -----------------------------------------------------
  { id: "node", bins: ["node"], class: "files.write.workspace", emits: [GATE_SELF_CLASS], refine: refineNode },
  { id: "approval", bins: ["approval"], class: GATE_SELF_CLASS },
  {
    id: "workspace-tool",
    bins: ["npx", "tsx", "ts-node", "tsc", "oxlint", "eslint", "prettier", "vitest", "jest", "backlog", "make"],
    class: "files.write.workspace",
  },
  {
    id: "workspace-write",
    bins: ["mkdir", "cp", "mv", "touch", "tee", "ln", "chmod", "truncate", "rmdir"],
    class: "files.write.workspace",
  },
  { id: "rm", bins: ["rm"], class: "files.write.workspace", emits: ["files.delete.out_of_scope"], refine: refineRm },
  { id: "sed", bins: ["sed"], class: "read.shell", emits: ["files.write.workspace"], refine: refineSed },

  // -- network -------------------------------------------------------------
  {
    id: "network",
    bins: ["curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "telnet", "ftp", "http", "httpie"],
    class: "network.call",
  },

  // -- reads ---------------------------------------------------------------
  {
    id: "read-shell",
    bins: [
      "basename",
      "cat",
      "cd",
      "cksum",
      "cut",
      "diff",
      "dirname",
      "du",
      "echo",
      "false",
      "file",
      "find",
      "grep",
      "head",
      "jq",
      "ls",
      "md5sum",
      "printf",
      "pwd",
      "readlink",
      "realpath",
      "rg",
      "shasum",
      "sha256sum",
      "sort",
      "stat",
      "tail",
      "test",
      "tr",
      "tree",
      "true",
      "type",
      "uniq",
      "wc",
      "which",
    ],
    class: "read.shell",
  },
];

/** `gh pr view` reads; `gh pr create` reaches the network on the repo's behalf. */
const GH_READ_ACTIONS: readonly string[] = [
  "view",
  "list",
  "status",
  "checks",
  "diff",
  "watch",
  "download",
];

function refineGh(ctx: RuleContext): Refinement {
  const action = ctx.positionals[1];
  if (action !== undefined && GH_READ_ACTIONS.includes(action)) {
    return { class: "read.vcs.remote", rule: "gh-read" };
  }
  return { class: "network.call", rule: "gh-write" };
}

/**
 * Binaries whose effect lives in a string this classifier will not interpret.
 *
 * A second parser for the same text is a second answer waiting to disagree with
 * the shell's, so these refuse instead. `bash -c "…"`, `eval`, `xargs` and the
 * `-e` interpreters can express anything at all; `sudo` and `env` re-launch
 * something else with different authority.
 */
const OPAQUE_BINS: Readonly<Record<string, string>> = {
  bash: "runs a shell script",
  sh: "runs a shell script",
  zsh: "runs a shell script",
  dash: "runs a shell script",
  ksh: "runs a shell script",
  fish: "runs a shell script",
  eval: "evaluates a constructed command",
  source: "runs another file in this shell",
  ".": "runs another file in this shell",
  exec: "replaces this shell with another command",
  sudo: "runs a command with different authority",
  doas: "runs a command with different authority",
  env: "runs a command with a modified environment",
  nohup: "detaches a command from this shell",
  xargs: "runs a command built from its input",
  watch: "re-runs a command on a timer",
  timeout: "runs another command under a timer",
  time: "runs another command under a timer",
};

/** Interpreters that are opaque only when handed inline source. */
const INLINE_SOURCE_BINS: Readonly<Record<string, readonly string[]>> = {
  python: ["-c"],
  python3: ["-c"],
  perl: ["-e", "-E"],
  ruby: ["-e"],
  deno: ["eval"],
};

// ===========================================================================
// Classification
// ===========================================================================

/** `VAR=value` prefixes, which are not the command. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/** Every class the table can emit, for docs and for the dogfood test. */
export const CLASSIFIER_CLASSES: readonly string[] = (() => {
  const seen = new Set<string>();
  for (const rule of COMMAND_RULES) {
    seen.add(rule.class);
    for (const extra of rule.emits ?? []) seen.add(extra);
  }
  // Emitted outside the binary table: the protected-path override, the
  // redirect-write override, and the bare-assignment segment.
  seen.add("policy.edit");
  seen.add("files.write.workspace");
  seen.add("read.shell");
  return [...seen].sort();
})();

/** Find the first table row matching this binary and subcommand. */
function matchRule(bin: string, sub: string | null): CommandRule | null {
  for (const rule of COMMAND_RULES) {
    if (!rule.bins.includes(bin)) continue;
    if (rule.subs !== undefined) {
      if (sub === null || !rule.subs.includes(sub)) continue;
    }
    return rule;
  }
  return null;
}

type SegmentOutcome =
  | { ok: true; class: string; rule: string }
  | { ok: false; code: ClassifierFailureCode; detail: string };

function classifySegment(segment: LexSegment): SegmentOutcome {
  if (segment.opaque !== null) {
    return { ok: false, code: "opaque", detail: segment.opaque };
  }

  // `$(…)` is classified recursively. A substitution that only reads is inert;
  // anything else taints the segment, because its effect happens before the
  // outer command even starts and the outer class would not describe it.
  for (const word of segment.words) {
    for (const inner of word.substitutions) {
      const nested = classifyCommand(inner);
      if (!nested.ok) {
        return {
          ok: false,
          code: nested.code === "unparseable" ? "unparseable" : nested.code,
          detail: `command substitution $(${inner}): ${nested.detail}`,
        };
      }
      const effectful = nested.classes.filter((cls) => !cls.startsWith("read."));
      if (effectful.length > 0) {
        return {
          ok: false,
          code: "opaque",
          detail: `command substitution $(${inner}) is ${effectful.join(", ")}; only read.* substitutions run unattended`,
        };
      }
    }
  }

  const words = segment.words.map((word) => word.text);
  let cursor = 0;
  while (cursor < words.length && ASSIGNMENT.test(words[cursor] as string)) cursor += 1;

  const writeTargets = segment.redirects
    .filter((redirect) => redirect.op !== "<")
    .map((redirect) => redirect.target.text);
  const protectedTarget = writeTargets.find((target) => isProtectedPath(target));
  if (protectedTarget !== undefined) {
    return { ok: true, class: "policy.edit", rule: "redirect-protected" };
  }

  const bin = words[cursor];
  if (bin === undefined) {
    // `VAR=value` alone, or a bare redirection. `> file` truncates, so it is a
    // write; an assignment on its own touches nothing.
    return writeTargets.length > 0
      ? { ok: true, class: "files.write.workspace", rule: "redirect-write" }
      : { ok: true, class: "read.shell", rule: "assignment" };
  }

  const basename = pathSegments(bin).slice(-1)[0] ?? bin;
  const opaqueReason = OPAQUE_BINS[basename];
  if (opaqueReason !== undefined) {
    return { ok: false, code: "opaque", detail: `${basename} ${opaqueReason}` };
  }

  const args = words.slice(cursor + 1);
  const inlineFlags = INLINE_SOURCE_BINS[basename];
  if (inlineFlags !== undefined && hasFlag(args, inlineFlags)) {
    return { ok: false, code: "opaque", detail: `${basename} runs inline source` };
  }

  const positionals = args.filter((arg) => !isFlag(arg));
  const sub = positionals[0] ?? null;
  const rule = matchRule(basename, sub);
  if (rule === null) {
    return {
      ok: false,
      code: "unclassified",
      detail:
        sub === null
          ? `no rule for ${basename}`
          : `no rule for ${basename} ${sub}`,
    };
  }

  const ctx: RuleContext = { bin: basename, args, positionals, sub };
  const refined = rule.refine === undefined ? null : rule.refine(ctx);
  if (rule.refine !== undefined && refined === null) {
    return { ok: false, code: "opaque", detail: `${basename} runs inline source` };
  }
  let cls = refined === null ? rule.class : refined.class;
  let ruleId = refined === null ? rule.id : refined.rule;

  // A protected path anywhere in an effectful segment is `policy.edit`: the
  // command is editing the rules, whatever else it is doing.
  if (!cls.startsWith("read.") && cls !== GATE_SELF_CLASS) {
    const named = positionals.find((arg) => isProtectedPath(arg));
    if (named !== undefined) return { ok: true, class: "policy.edit", rule: "protected-path" };
  }

  // A read command with a write redirection writes. `ls > out.txt` creates a
  // file, and the class has to say so.
  if (cls.startsWith("read.") && writeTargets.length > 0) {
    cls = "files.write.workspace";
    ruleId = "redirect-write";
  }

  return { ok: true, class: cls, rule: ruleId };
}

/**
 * Classify a shell command line into the classes it would produce.
 *
 * Every segment must classify: one unreadable segment refuses the whole
 * command, because a command line's effect is the union of its parts and a
 * partial answer would authorize the parts we happened to understand.
 */
export function classifyCommand(command: string): CommandClassification {
  const lexed = lex(command);
  if (!lexed.ok) {
    return { ok: false, code: "unparseable", segment: command.trim(), detail: lexed.detail };
  }
  if (lexed.segments.length === 0) {
    return { ok: false, code: "unclassified", segment: command.trim(), detail: "empty command" };
  }

  const segments: ClassifiedSegment[] = [];
  const classes: string[] = [];
  for (const segment of lexed.segments) {
    const outcome = classifySegment(segment);
    if (!outcome.ok) {
      return { ok: false, code: outcome.code, segment: segment.text, detail: outcome.detail };
    }
    segments.push({ text: segment.text, class: outcome.class, rule: outcome.rule });
    if (!classes.includes(outcome.class)) classes.push(outcome.class);
  }
  return { ok: true, segments, classes };
}
