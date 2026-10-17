/**
 * `git push` read the way git 2.50's option parser reads it (APRV-517).
 *
 * The classifier's `git-push` row used to look for flags by exact spelling:
 * `--delete` and `-d`, `--force` and `-f`. git's parser accepts more than
 * that, and every extra spelling it accepts did the same thing as the one it
 * stands for while classifying as a plain push:
 *
 * - a short bundle: `-ud`, `-du`, `-fd`, `-dn` carry `-d` (and `-f`);
 * - a long-option abbreviation by unique prefix: `--de`, `--del`, `--dele`
 *   and `--delet` are `--delete`, `--m` is `--mirror`, `--pru` is `--prune`;
 * - a deleting option the exact list never named: `--prune` removes every
 *   remote ref a wildcard refspec no longer matches;
 * - the words after a value-taking option (`-o x`, `--repo x`) shift the
 *   positionals, and a global option in front of `push` (`git --no-pager
 *   push origin`) shifted them too.
 *
 * So this file is the closed rule: it walks the argv exactly as git's
 * `parse-options.c` does over the option table of `builtin/push.c` in git
 * 2.50, and reports what the push does rather than which words it contains.
 * Anything it cannot walk is a refusal, never a guess:
 *
 * - `unreadable`: a word the shell may split or expand into words this walk
 *   never saw (`$`, a backtick, a glob, a brace expansion), a word that came
 *   out of a command substitution, or an assignment or global option in
 *   front of `push` that steers which configuration git reads (`GIT_*=`,
 *   `HOME=`, `XDG_CONFIG_HOME=`, `--git-dir=`, `--work-tree=`,
 *   `--config-env=`: `remote.origin.push=:refs/heads/main` deletes the trunk
 *   with no refspec on the command line, and `remote.<name>.mirror` turns a
 *   plain push into a mirror). Any of these can hold `-d`, `:main` or `+main`;
 * - `unparseable`: an option git does not know, an ambiguous abbreviation, a
 *   value where none is taken, a missing value, or a global option in front
 *   of `push` this file does not know. git refuses all of these itself, so
 *   refusing them costs nothing, and a newer git that grew an option this
 *   table lacks is refused rather than read as a plain push;
 * - `runs-program`: `--receive-pack` / `--exec` name the program git starts
 *   for the far side, which for a local or `file://` remote runs on this
 *   machine, and `git --exec-path=` picks where git finds its helpers. What it runs is a command line this classifier is not reading,
 *   the reason `find -exec` is opaque (APRV-283).
 *
 * Negations (`--no-delete`) never clear a flag an earlier word set: a push
 * that both deletes and un-deletes is read as deleting, which only ever picks
 * the stricter class for a spelling nobody writes.
 *
 * The walk is checked against the real binary: tests/git-push-delete-spellings
 * runs every deleting spelling against a bare local remote and asserts the ref
 * is gone, and the generated differential there runs the corpus through git
 * and asserts every deletion and every forced update it observed was
 * classified at least that strictly.
 */

/** What an option does to the push, for the options whose effect matters. */
type PushEffect =
  | "force"
  | "mirror"
  | "remove"
  | "prune"
  | "tags"
  | "all"
  | "submodules"
  | "program"
  | "help";

interface PushOption {
  /** The long name as `builtin/push.c` spells it (`no-verify` keeps its `no-`). */
  long: string;
  short?: string;
  /** `required`: the next word when not `=`-joined. `optional`: `=`-joined only. */
  value: "none" | "required" | "optional";
  /** `PARSE_OPT_NONEG`: no `--no-` form. */
  noneg?: boolean;
  /** `OPT_ALIAS`: an abbreviation matching this and its target is not ambiguous. */
  aliasOf?: string;
  effect?: PushEffect;
}

/**
 * `git push -h` on git 2.50, in `builtin/push.c` order. Order matters only for
 * which candidate an ambiguity error names, never for which option matches.
 */
export const GIT_PUSH_OPTIONS: readonly PushOption[] = [
  { long: "verbose", short: "v", value: "none" },
  { long: "quiet", short: "q", value: "none" },
  { long: "repo", value: "required" },
  { long: "all", value: "none", effect: "all" },
  { long: "branches", value: "none", aliasOf: "all", effect: "all" },
  { long: "mirror", value: "none", effect: "mirror" },
  { long: "delete", short: "d", value: "none", effect: "remove" },
  { long: "tags", value: "none", effect: "tags" },
  { long: "dry-run", short: "n", value: "none" },
  { long: "porcelain", value: "none" },
  { long: "force", short: "f", value: "none", effect: "force" },
  { long: "force-with-lease", value: "optional", effect: "force" },
  { long: "force-if-includes", value: "none", effect: "force" },
  { long: "recurse-submodules", value: "required", effect: "submodules" },
  { long: "thin", value: "none" },
  { long: "receive-pack", value: "required", effect: "program" },
  { long: "exec", value: "required", effect: "program" },
  { long: "set-upstream", short: "u", value: "none" },
  { long: "progress", value: "none" },
  { long: "prune", value: "none", effect: "prune" },
  { long: "no-verify", value: "none" },
  { long: "follow-tags", value: "none", effect: "tags" },
  { long: "signed", value: "optional" },
  { long: "atomic", value: "none" },
  { long: "push-option", short: "o", value: "required" },
  { long: "ipv4", short: "4", value: "none", noneg: true },
  { long: "ipv6", short: "6", value: "none", noneg: true },
];

/**
 * The help options parse-options itself answers, by exact spelling only
 * (`-h` is the short one): each prints usage and exits without pushing, so it
 * adds nothing to the reading.
 */
const INTERNAL_LONG: readonly string[] = ["help", "help-all"];

/**
 * Global options in front of the subcommand (`git.c` `handle_options`, git
 * 2.50), matched by exact spelling, as git matches them. These take no value
 * and change nothing about what a push sends.
 */
const GIT_GLOBAL_BARE: readonly string[] = [
  "-p",
  "--paginate",
  "-P",
  "--no-pager",
  "--no-replace-objects",
  "--no-lazy-fetch",
  "--no-optional-locks",
  "--no-advice",
  "--bare",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
];
/** `=`-joined globals that change nothing about what a push sends either. */
const GIT_GLOBAL_JOINED: readonly string[] = ["--namespace=", "--attr-source="];
/**
 * `=`-joined globals that decide which configuration the push runs under:
 * another repository's `.git/config` (`--git-dir`, `--work-tree`) or a value
 * injected from the environment (`--config-env`). Configuration can carry a
 * deleting refspec or `mirror = true`, so these read like a steering
 * assignment.
 */
const GIT_GLOBAL_STEERING: readonly string[] = ["--git-dir=", "--work-tree=", "--config-env="];
/** `--exec-path=` picks the directory git runs its helper programs from. */
const GIT_GLOBAL_PROGRAM = "--exec-path";
// Anything else in front of `push` is refused, the separate-value forms
// (`-C dir`, `-c k=v`, `--git-dir dir`) included: there the word the
// classifier took for the subcommand may have been that option's value.

/** Assignments in front of `git` that steer which configuration it reads. */
const STEERING_ENV = /^(?:GIT_[A-Za-z0-9_]*|HOME|XDG_CONFIG_HOME)=/u;

/** `$`, a backtick, or a glob character: the shell may expand the word into others. */
const EXPANDING_CHAR = /[$`*?[\]]/u;
/** A brace expansion: `{a,b}` or `{1..3}`. A reflog `@{1}` is neither. */
const BRACE_EXPANSION = /\{[^{}]*(?:,|\.\.)[^{}]*\}/u;

/** Can the shell turn this word into a different word, or into several? */
export function isUnreadablePushWord(word: string): boolean {
  return EXPANDING_CHAR.test(word) || BRACE_EXPANSION.test(word);
}

/** What a `git push` argv does, as far as its class is concerned. */
export interface GitPushReading {
  /** `--force`, `-f`, `--force-with-lease`, `--force-if-includes`, `--mirror`. */
  force: boolean;
  /** `--delete` / `-d`: every refspec is a ref being removed. */
  remove: boolean;
  /** `--prune`: removes the remote refs a refspec pattern no longer matches. */
  prune: boolean;
  /** `--tags` / `--follow-tags`. */
  tags: boolean;
  /** `--all`, `--branches`, `--mirror`, or a submodule push: the trunk among them. */
  all: boolean;
  /** Non-option words: the repository, then the refspecs. */
  positionals: string[];
}

export type GitPushParse =
  | { ok: true; reading: GitPushReading }
  | { ok: false; kind: "unreadable" | "unparseable" | "runs-program"; detail: string };

interface Matched {
  option: PushOption;
  /** The `--no-` form. */
  unset: boolean;
}

/** Are these two options one option under two names (`OPT_ALIAS`)? */
function isAlias(a: PushOption, b: PushOption): boolean {
  return a.aliasOf === b.long || b.aliasOf === a.long || (a.aliasOf !== undefined && a.aliasOf === b.aliasOf);
}

/**
 * `parse_long_opt` in git 2.50's `parse-options.c`, over `name` (the text
 * after `--` and before any `=`).
 *
 * An exact spelling wins outright. Otherwise every option the text is a
 * prefix of is a candidate, positively or through `no-`; two candidates that
 * are not aliases of each other are ambiguous, which git refuses.
 */
function matchLong(name: string): Matched | "ambiguous" | null {
  let abbrev: Matched | null = null;
  let ambiguous = false;
  const candidate = (option: PushOption, unset: boolean): void => {
    if (abbrev !== null && !isAlias(abbrev.option, option)) ambiguous = true;
    abbrev = { option, unset };
  };
  for (const option of GIT_PUSH_OPTIONS) {
    let long = option.long;
    let optUnset = false;
    if (long.startsWith("no-")) {
      long = long.slice(3);
      optUnset = true;
    }
    if (name.startsWith(long)) {
      if (name === long) return { option, unset: optUnset };
      continue;
    }
    if (long.startsWith(name)) {
      candidate(option, optUnset);
      continue;
    }
    if (option.noneg === true) continue;
    if ("no-".startsWith(name)) {
      candidate(option, !optUnset);
      continue;
    }
    if (!name.startsWith("no-")) continue;
    const rest = name.slice(3);
    if (rest.startsWith(long)) {
      if (rest === long) return { option, unset: !optUnset };
      continue;
    }
    if (long.startsWith(rest)) candidate(option, !optUnset);
  }
  if (ambiguous) return "ambiguous";
  return abbrev;
}

/** The option a short letter names, or `null`. */
function matchShort(letter: string): PushOption | null {
  return GIT_PUSH_OPTIONS.find((option) => option.short === letter) ?? null;
}

/**
 * Split the words after `git` at the `push` subcommand: the global options in
 * front of it, and the push's own argv after it.
 */
export function splitGitPush(gitArgs: readonly string[]): { globals: string[]; words: string[] } | null {
  const at = gitArgs.findIndex((word) => !(word.startsWith("-") && word !== "-"));
  if (at === -1 || gitArgs[at] !== "push") return null;
  return { globals: gitArgs.slice(0, at), words: gitArgs.slice(at + 1) };
}

/** The global options in front of `push`, judged; `null` when they change nothing. */
function judgeGlobals(globals: readonly string[]): GitPushParse | null {
  for (const word of globals) {
    if (isUnreadablePushWord(word)) {
      return { ok: false, kind: "unreadable", detail: `the shell may expand ${word} into other words` };
    }
    if (GIT_GLOBAL_BARE.includes(word)) continue;
    if (GIT_GLOBAL_JOINED.some((prefix) => word.startsWith(prefix))) continue;
    if (GIT_GLOBAL_STEERING.some((prefix) => word.startsWith(prefix))) {
      return {
        ok: false,
        kind: "unreadable",
        detail: `git ${word.slice(0, word.indexOf("=") + 1)}… decides which configuration the push reads`,
      };
    }
    if (word === GIT_GLOBAL_PROGRAM || word.startsWith(`${GIT_GLOBAL_PROGRAM}=`)) {
      return { ok: false, kind: "runs-program", detail: "git --exec-path picks the directory git runs its helpers from" };
    }
    return {
      ok: false,
      kind: "unparseable",
      detail: `git ${word} in front of push: this classifier does not read that global option`,
    };
  }
  return null;
}

/**
 * Walk a `git push` argv (the words after `push`) the way git does.
 *
 * `assignments` are the `NAME=value` words in front of `git`, `substituted`
 * says whether any word came out of a command substitution, and `globals` are
 * the git options in front of `push` ({@link splitGitPush}).
 */
export function parseGitPushArgv(
  words: readonly string[],
  assignments: readonly string[] = [],
  substituted = false,
  globals: readonly string[] = [],
): GitPushParse {
  const globalRefusal = judgeGlobals(globals);
  if (globalRefusal !== null) return globalRefusal;
  if (substituted) {
    return { ok: false, kind: "unreadable", detail: "a word of this push is a command substitution's output" };
  }
  const steering = assignments.find((word) => STEERING_ENV.test(word));
  if (steering !== undefined) {
    return {
      ok: false,
      kind: "unreadable",
      detail: `${steering.slice(0, steering.indexOf("="))}=… in front of git steers which configuration the push reads`,
    };
  }
  const unreadable = words.find(isUnreadablePushWord);
  if (unreadable !== undefined) {
    return { ok: false, kind: "unreadable", detail: `the shell may expand ${unreadable} into other words` };
  }

  const reading: GitPushReading = {
    force: false,
    remove: false,
    prune: false,
    tags: false,
    all: false,
    positionals: [],
  };
  const unparseable = (detail: string): GitPushParse => ({ ok: false, kind: "unparseable", detail });
  const apply = (option: PushOption, unset: boolean, value: string | undefined): GitPushParse | null => {
    if (unset) return null;
    switch (option.effect) {
      case "force":
        reading.force = true;
        break;
      case "mirror":
        reading.force = true;
        reading.all = true;
        break;
      case "remove":
        reading.remove = true;
        break;
      case "prune":
        reading.prune = true;
        break;
      case "tags":
        reading.tags = true;
        break;
      case "all":
        reading.all = true;
        break;
      case "submodules":
        // `check` only verifies and `no` turns it off; `on-demand` and `only`
        // push the submodules' own branches, which may be their trunks.
        if (value !== "check" && value !== "no") reading.all = true;
        break;
      case "program":
        return {
          ok: false,
          kind: "runs-program",
          detail: `git push --${option.long} names the program git runs for the far side`,
        };
      default:
        break;
    }
    return null;
  };

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] as string;
    if (word === "--" || word === "--end-of-options") {
      reading.positionals.push(...words.slice(index + 1));
      break;
    }
    if (word.startsWith("--")) {
      const body = word.slice(2);
      const equals = body.indexOf("=");
      const name = equals === -1 ? body : body.slice(0, equals);
      if (INTERNAL_LONG.includes(body)) continue;
      const matched = matchLong(name);
      if (matched === "ambiguous") return unparseable(`git push --${name} is ambiguous`);
      if (matched === null) return unparseable(`git push has no option --${name}`);
      const { option, unset } = matched;
      let value: string | undefined;
      if (equals !== -1) {
        if (unset || option.value === "none") return unparseable(`git push --${name} takes no value`);
        value = body.slice(equals + 1);
      } else if (!unset && option.value === "required") {
        if (index + 1 >= words.length) return unparseable(`git push --${name} requires a value`);
        index += 1;
        value = words[index];
      }
      const refusal = apply(option, unset, value);
      if (refusal !== null) return refusal;
      continue;
    }
    if (word.startsWith("-") && word !== "-") {
      const letters = word.slice(1);
      for (let at = 0; at < letters.length; at += 1) {
        const letter = letters[at] as string;
        if (letter === "h") break;
        const option = matchShort(letter);
        if (option === null) return unparseable(`git push has no switch -${letter}`);
        if (option.value === "required") {
          // The rest of the bundle is the value, or else the next word.
          if (at + 1 >= letters.length) {
            if (index + 1 >= words.length) return unparseable(`git push -${letter} requires a value`);
            index += 1;
          }
          const refusal = apply(option, false, undefined);
          if (refusal !== null) return refusal;
          break;
        }
        const refusal = apply(option, false, undefined);
        if (refusal !== null) return refusal;
      }
      continue;
    }
    reading.positionals.push(word);
  }
  return { ok: true, reading };
}
