/**
 * The push-repository refinement (APRV-518).
 *
 * The classifier reads `git push` from its text (APRV-517's grammar). Four
 * things the text cannot show decide what some pushes send, and each is a
 * fact about the checkout the push runs in:
 *
 * - `remote.<name>.mirror`: a refspec-less push to a mirror remote deletes
 *   every remote branch the checkout lacks and force-updates the rest;
 * - `remote.<name>.push`: the refspecs of a refspec-less push, and the
 *   destination AND force of a colon-less refspec it maps
 *   (`+refs/heads/lane:refs/heads/main` makes `git push origin lane` a forced
 *   update of the trunk);
 * - the current branch, which is what `git push origin HEAD` or `@` pushes;
 * - local tags, `push.followTags` and submodule recursion, which add a tag
 *   publication or submodule trunks to an ordinary-looking push.
 *
 * So this step reads them, with plumbing only, in every directory the push
 * may run in, and hands them to the pure {@link gitPushSegmentClass}, which
 * answers the segment again. It follows APRV-108's discipline: the classifier
 * stays pure and its fixtures keep meaning what they say, and everything
 * environment-dependent is here, in one named step.
 *
 * Fail closed, on every axis:
 *
 * - a directory whose checkout cannot be read (git missing, a timeout, a
 *   config git cannot parse) makes the push UNREADABLE, and an unreadable push
 *   whose configuration decides its refs is `vcs.history.rewrite`;
 * - a `cd` this step cannot follow (`cd "$D"`, `cd -`, `pushd`) is the same;
 * - every directory the push MAY run in is read, the one a `cd` leads to and
 *   the one it started from (a `cd` that fails leaves the shell where it was
 *   when the segments are joined by `;` or `||`), and the strictest answer
 *   wins;
 * - a segment this step cannot re-read as one direct `git push` is
 *   `vcs.history.rewrite`.
 *
 * A directory that is not a repository at all (`git rev-parse` exits 128) is
 * no place a push can run: git refuses there exactly as `rev-parse` did, so it
 * adds nothing. The one answer this step lowers is the classifier's own
 * `git-push-head`: when every directory shows a current branch that is not a
 * trunk, `HEAD`/`@` is that branch, which is the `vcs.push.branch` the
 * classifier gave before APRV-518.
 *
 * IMPURE by design: git runs in each directory with the credential-stripped
 * environment, under one wall-clock budget for the whole command.
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { childEnvironment } from "../core/child-env.js";
import {
  CODE_EXECUTING_RULES,
  commandSegmentShapes,
  GIT_PUSH_RULES,
  gitPushSegmentClass,
  type ClassifiedSegment,
  type CommandClassification,
  type PushRepoFacts,
} from "../core/command-class.js";

/** The wall-clock budget for every git query one command needs. */
export const PUSH_REPO_BUDGET_MS = 1500;

const REWRITE_CLASS = "vcs.history.rewrite";
const UNREADABLE_RULE = "git-push-config-unreadable";

/** The configuration keys that change what a push sends. */
const PUSH_CONFIG_PATTERN =
  "^(remote\\..+\\.(mirror|push)|push\\.(followtags|recursesubmodules)|submodule\\.recurse)$";

/** What one directory says: facts, no repository at all, or no answer. */
type DirectoryFacts = { kind: "facts"; facts: PushRepoFacts } | { kind: "no-repository" } | { kind: "unreadable" };

interface Budget {
  deadline: number;
}

interface GitAnswer {
  status: number | null;
  stdout: string;
  failed: boolean;
}

function runGit(dir: string, args: readonly string[], budget: Budget): GitAnswer {
  const remaining = budget.deadline - Date.now();
  if (remaining <= 0) return { status: null, stdout: "", failed: true };
  const result = spawnSync("git", [...args], {
    cwd: dir,
    encoding: "utf8",
    env: childEnvironment().env,
    timeout: remaining,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error !== undefined || result.signal !== null) return { status: null, stdout: "", failed: true };
  return { status: result.status, stdout: result.stdout, failed: false };
}

/** git's boolean, read the strict way: anything that is not plainly false is true. */
function truthy(value: string | null): boolean {
  if (value === null) return true;
  return !["false", "no", "off", "0", ""].includes(value.trim().toLowerCase());
}

/** Entries of a directory, or `[]` when it does not exist; `null` when it cannot be read. */
function entriesOf(dir: string): string[] | null {
  try {
    return readdirSync(dir);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
}

/** Read what a push in `dir` would see. */
export function readPushRepoFacts(dir: string, budget: Budget = { deadline: Date.now() + PUSH_REPO_BUDGET_MS }): DirectoryFacts {
  const where = runGit(dir, ["rev-parse", "--git-common-dir"], budget);
  if (where.failed) return { kind: "unreadable" };
  if (where.status === 128) return { kind: "no-repository" };
  if (where.status !== 0) return { kind: "unreadable" };
  const commonLine = where.stdout.trim();
  if (commonLine.length === 0) return { kind: "unreadable" };
  const common = isAbsolute(commonLine) ? commonLine : join(dir, commonLine);

  // Exit 0 names the branch, exit 1 is a detached HEAD; anything else is no answer.
  const head = runGit(dir, ["symbolic-ref", "--quiet", "HEAD"], budget);
  if (head.failed || (head.status !== 0 && head.status !== 1)) return { kind: "unreadable" };
  const headRef = head.status === 0 ? head.stdout.trim() : "";
  const branch = headRef.startsWith("refs/heads/") ? headRef.slice("refs/heads/".length) : null;

  // Exit 1 is "no such key", a real answer; every other non-zero is not.
  const config = runGit(dir, ["config", "-z", "--get-regexp", PUSH_CONFIG_PATTERN], budget);
  if (config.failed || (config.status !== 0 && config.status !== 1)) return { kind: "unreadable" };
  const remotes = new Map<string, { mirror: boolean; push: string[] }>();
  let followTags = false;
  let recurse: string | null | undefined;
  let submoduleRecurse = false;
  for (const entry of config.stdout.split("\0")) {
    if (entry.length === 0) continue;
    const newline = entry.indexOf("\n");
    const key = newline === -1 ? entry : entry.slice(0, newline);
    const value = newline === -1 ? null : entry.slice(newline + 1);
    const lower = key.toLowerCase();
    if (lower === "push.followtags") {
      followTags = truthy(value);
      continue;
    }
    if (lower === "push.recursesubmodules") {
      recurse = value;
      continue;
    }
    if (lower === "submodule.recurse") {
      submoduleRecurse = truthy(value);
      continue;
    }
    const last = key.lastIndexOf(".");
    const name = key.slice("remote.".length, last);
    const variable = lower.slice(last + 1);
    const remote = remotes.get(name) ?? { mirror: false, push: [] };
    if (variable === "mirror") remote.mirror = remote.mirror || truthy(value);
    // A valueless `push` key is a refspec git cannot use, so it reads as one
    // that may reach anything.
    if (variable === "push") remote.push.push(value ?? "*");
    remotes.set(name, remote);
  }
  // `check` verifies and `no` turns it off; every other value, or an unset key
  // under `submodule.recurse`, pushes the submodules' own branches.
  const submodules =
    recurse === undefined
      ? submoduleRecurse
      : recurse === null || !["check", "no", "false", "off", "0"].includes(recurse.trim().toLowerCase());

  const refs = runGit(dir, ["for-each-ref", "--format=%(refname)%00%(symref)", "refs/tags", "refs/remotes/origin/HEAD"], budget);
  if (refs.failed || refs.status !== 0) return { kind: "unreadable" };
  const tags = new Set<string>();
  let originDefault: string | null = null;
  for (const line of refs.stdout.split("\n")) {
    if (line.length === 0) continue;
    const [refname, symref] = line.split("\0");
    if (refname === undefined) continue;
    if (refname.startsWith("refs/tags/")) {
      tags.add(refname.slice("refs/tags/".length));
      continue;
    }
    if (refname === "refs/remotes/origin/HEAD" && symref !== undefined && symref.startsWith("refs/remotes/origin/")) {
      originDefault = symref.slice("refs/remotes/origin/".length);
    }
  }

  const legacyRemotes = entriesOf(join(common, "remotes"));
  const legacyBranches = entriesOf(join(common, "branches"));
  if (legacyRemotes === null || legacyBranches === null) return { kind: "unreadable" };

  return {
    kind: "facts",
    facts: {
      head: branch,
      headIsDefault: branch !== null && (branch === "main" || branch === "master" || branch === originDefault),
      defaultBranch: originDefault,
      remotes,
      legacyRemotes: [...legacyRemotes, ...legacyBranches],
      tags,
      followTags,
      submodules,
    },
  };
}

/** A `cd` target the shell would reach, or `null` when this step cannot say. */
function cdTarget(args: readonly string[], from: string): string | null {
  const words = args[0] === "--" ? args.slice(1) : [...args];
  if (words.length === 0) return homedir();
  if (words.length !== 1) return null;
  const word = words[0] as string;
  if (word.startsWith("-") || /[$`*?[\]{}]/u.test(word)) return null;
  if (word === "~") return homedir();
  if (word.startsWith("~/")) return join(homedir(), word.slice(2));
  if (word.startsWith("~")) return null;
  return isAbsolute(word) ? word : resolve(from, word);
}

/** Does this segment text name a directory change this step must follow? */
const DIRECTORY_WORD = /(?:^|[\s;&|(])(?:cd|pushd|popd)(?:\s|$)/u;

/**
 * Every directory the segment at `index` may run in, from the segments before
 * it in order, or the reason the configuration it will run under cannot be
 * known from here.
 *
 * Besides a `cd` it cannot follow, two kinds of earlier segment make the
 * configuration unknowable, because this step reads the checkout BEFORE the
 * command runs: one that runs code the runtime did not author
 * ({@link CODE_EXECUTING_RULES}: `node x.js`, `npm test`, …), which may write
 * `.git/config`; and one that writes, or names in a writing command, a path
 * the shell expands (`> "$(git rev-parse --git-dir)/config"`, `cp x "$D"`).
 * A write the text names inside a `.git` directory is already
 * `vcs.history.rewrite` in the pure classifier.
 */
function directoriesFor(
  segments: readonly ClassifiedSegment[],
  index: number,
  cwd: string,
): { dirs: string[] } | { why: string } {
  let dirs = [cwd];
  for (const segment of segments.slice(0, index)) {
    if (CODE_EXECUTING_RULES.includes(segment.rule)) {
      return { why: `\`${segment.text}\` before it runs code that may rewrite the git configuration` };
    }
    const shapes = commandSegmentShapes(segment.text);
    if (shapes === null) {
      if (DIRECTORY_WORD.test(segment.text)) return { why: "a directory change before it cannot be followed" };
      continue;
    }
    for (const shape of shapes) {
      if (shape.expands.writes) {
        return { why: `\`${segment.text}\` before it writes a path the shell expands` };
      }
      if (!segment.class.startsWith("read.") && shape.expands.args && shape.bin !== "cd") {
        return { why: `\`${segment.text}\` before it writes where the shell decides` };
      }
      const bin = shape.bin === null ? null : (shape.bin.split("/").pop() ?? shape.bin);
      if (bin === "pushd" || bin === "popd") return { why: "a directory change before it cannot be followed" };
      if (bin !== "cd") continue;
      const next: string[] = [];
      for (const dir of dirs) {
        const target = cdTarget(shape.args, dir);
        if (target === null) return { why: "a directory change before it cannot be followed" };
        next.push(target);
      }
      dirs = [...new Set([...dirs, ...next])];
    }
  }
  return { dirs };
}

/** A classification plus one note per segment this step re-read. */
export interface PushRepoRefinement {
  result: CommandClassification;
  notes: string[];
}

/**
 * Re-read every `git push` segment under what its checkout says.
 *
 * `cwd` is the directory the command runs in, the same one every other impure
 * pass of {@link classifyForHook} reads.
 */
export function refinePushRepo(result: CommandClassification, cwd: string): PushRepoRefinement {
  if (!result.ok) return { result, notes: [] };
  const candidates = result.segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => GIT_PUSH_RULES.includes(segment.rule) && segment.class !== REWRITE_CLASS);
  if (candidates.length === 0) return { result, notes: [] };

  const budget: Budget = { deadline: Date.now() + PUSH_REPO_BUDGET_MS };
  const cache = new Map<string, DirectoryFacts>();
  const factsIn = (dir: string): DirectoryFacts => {
    const known = cache.get(dir);
    if (known !== undefined) return known;
    const read = readPushRepoFacts(dir, budget);
    cache.set(dir, read);
    return read;
  };

  const notes: string[] = [];
  const segments = [...result.segments];
  for (const { segment, index } of candidates) {
    const walked = directoriesFor(result.segments, index, cwd);
    let facts: PushRepoFacts[] | null = [];
    let why = "";
    if ("why" in walked) {
      facts = null;
      why = walked.why;
    } else {
      for (const dir of walked.dirs) {
        const read = factsIn(dir);
        if (read.kind === "no-repository") continue;
        if (read.kind === "unreadable") {
          facts = null;
          why = `the checkout at ${dir} could not be read`;
          break;
        }
        facts.push(read.facts);
      }
      // No directory is a repository: git refuses this push wherever it runs.
      if (facts !== null && facts.length === 0) continue;
    }
    const answer = gitPushSegmentClass(segment.text, facts) ?? { class: REWRITE_CLASS, rule: UNREADABLE_RULE };
    if (answer.rule === UNREADABLE_RULE && why.length === 0) why = "the segment could not be re-read as one git push";
    if (answer.class === segment.class && answer.rule === segment.rule && answer.path === segment.path) continue;
    const { path: _dropped, ...rest } = segment;
    segments[index] = { ...rest, class: answer.class, rule: answer.rule, ...(answer.path === undefined ? {} : { path: answer.path }) };
    notes.push(
      `push-repo: \`${segment.text}\` is ${answer.class} (${answer.rule}), was ${segment.class} (${segment.rule})${why.length === 0 ? "" : `: ${why}`}`,
    );
  }
  if (notes.length === 0) return { result, notes };
  const classes: string[] = [];
  for (const segment of segments) {
    if (!classes.includes(segment.class)) classes.push(segment.class);
  }
  return { result: { ok: true, segments, classes }, notes };
}
