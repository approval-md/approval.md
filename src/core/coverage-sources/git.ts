/**
 * The git coverage source (APRV-245).
 *
 * Git history is the cheapest witness this project has that it does not write:
 * a commit, a merge into the trunk and a tag are all effects an agent produced,
 * all recorded by a tool with no idea approval.md exists, and all readable back
 * long after the session that made them is gone.
 *
 * **Never the working tree.** Every fact here comes from `git log`, `git show`
 * and `git for-each-ref` over committed objects. An uncommitted edit is not an
 * effect yet — it is a file a person can still delete — and reading the tree
 * would make the report depend on whatever happened to be lying around when it
 * ran, which is the opposite of the determinism a witness needs.
 *
 * ## The class mapping
 *
 * The classes are SPEC.md §7's own, spelled as `core/command-class.ts` spells
 * them, because a source that invented a class would produce effects no record
 * could ever match:
 *
 * - a commit REACHABLE FROM `origin/main` is `vcs.push.main`. What the class
 *   names is the trunk moving, and a commit on the trunk moved it however it
 *   got there (a merge, a fast-forward, a direct push);
 * - a commit the trunk does not reach but SOME remote-tracking ref does
 *   (`refs/remotes/*`) is `vcs.push.branch`, which is the class the classifier
 *   gives `git push origin <branch>`: the commit left the machine, and the
 *   action a task declares for that is the push, never the commit;
 * - any other commit in the range is `vcs.commit.branch`, which is the class the
 *   classifier gives a bare `git commit`: it exists only here;
 * - a tag is `release.publish`, which is the class the classifier gives
 *   `git tag`;
 * - a protected path a commit changed is `policy.edit`, reported as its own
 *   effect carrying the `path`, so `core/coverage.ts` can put the
 *   protected-path guard's byte-level verdict against it rather than the
 *   class-and-window rule.
 *
 * A merge commit is a `vcs.push.main` like any other trunk commit and says so in
 * its detail line; it is not given a class of its own, because the policy has
 * none for it and an effect nobody can declare is an effect nothing can cover.
 *
 * Nothing here reads the clock: every timestamp is git's author date for the
 * object being reported.
 */

import { isProtectedPath } from "../command-class.js";
import type { ObservedEffect } from "../coverage.js";
import { git } from "../git-run.js";

/** The result of asking one source what it saw. */
export interface SourceObservation {
  name: string;
  available: boolean;
  /** Why it is unavailable, or what qualifies an available answer. */
  reason?: string;
  effects: ObservedEffect[];
}

/** The default trunk ref. Overridable so a fork with another name still reports. */
export const DEFAULT_TRUNK_REF = "origin/main";

/**
 * How many commits one run will describe.
 *
 * A bound rather than a stream, because each commit costs one `git show` for
 * its changed paths and an unbounded range would turn a reporting verb into a
 * repository walk. A truncated run says so in the source's `reason`, so the
 * number is never quietly wrong.
 */
export const MAX_COMMITS = 200;

export interface GitSourceOptions {
  /** Exclusive lower bound of the commit range. */
  base: string;
  /** Inclusive upper bound. */
  head: string;
  /** The ref that decides `vcs.push.main`. Defaults to {@link DEFAULT_TRUNK_REF}. */
  trunk?: string;
  /** `policy.protected_paths` from the policy, widening the built-in set. */
  policyProtectedPaths?: readonly string[];
  /** Override {@link MAX_COMMITS}. */
  maxCommits?: number;
}

/** The unit separator: it cannot occur in a subject line or an email address. */
const SEP = "";

const LOG_FORMAT = ["%H", "%aI", "%aE", "%aN", "%P", "%s"].join(SEP);

interface Commit {
  sha: string;
  at: string;
  email: string;
  name: string;
  parents: string[];
  subject: string;
}

function parseCommits(stdout: string): Commit[] {
  const commits: Commit[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    const parts = line.split(SEP);
    if (parts.length < 6) continue;
    commits.push({
      sha: parts[0] as string,
      at: parts[1] as string,
      email: parts[2] as string,
      name: parts[3] as string,
      parents: (parts[4] as string).split(" ").filter((word) => word.length > 0),
      subject: parts[5] as string,
    });
  }
  return commits;
}

/** The paths one commit changed, from `git show`. Empty when git could not say. */
function changedPaths(root: string, sha: string): string[] {
  const shown = git(["show", "--no-color", "--pretty=format:", "--name-only", sha], root);
  if (!shown.ok) return [];
  return shown.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** A short sha, the way a person reads one. */
function short(sha: string): string {
  return sha.slice(0, 12);
}

/** The first non-empty line of whatever a failed command printed. */
export function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "no output";
}

/**
 * What git witnessed between `base` and `head`.
 *
 * Never throws: a directory that is not a repository, a ref that does not
 * resolve and an absent git all come back as `available: false` with the reason
 * git printed. A reporting verb that crashed on a checkout without a remote
 * would be a verb people stop running.
 */
export function observeGit(root: string, options: GitSourceOptions): SourceObservation {
  const unavailable = (reason: string): SourceObservation => ({
    name: "git",
    available: false,
    reason,
    effects: [],
  });

  const inside = git(["rev-parse", "--show-toplevel"], root);
  if (!inside.ok) return unavailable("not a git checkout");

  const range = `${options.base}..${options.head}`;
  const listed = git(["log", `--format=${LOG_FORMAT}`, range], root);
  if (!listed.ok) {
    return unavailable(`git log ${range} failed: ${firstLine(listed.stderr)}`);
  }
  const all = parseCommits(listed.stdout);
  const max = options.maxCommits ?? MAX_COMMITS;
  const commits = all.slice(0, max);

  // The trunk set, in ONE call: `rev-list <range> --not <trunk>` names the
  // commits of the range that the trunk does NOT reach, so everything else in
  // the range does. Asking `merge-base --is-ancestor` per commit would be one
  // process per commit for the same answer.
  const trunk = options.trunk ?? DEFAULT_TRUNK_REF;
  const offTrunk = new Set<string>();
  let trunkKnown = false;
  const excluded = git(["rev-list", range, "--not", trunk], root);
  if (excluded.ok) {
    trunkKnown = true;
    for (const line of excluded.stdout.split("\n")) {
      const sha = line.trim();
      if (sha.length > 0) offTrunk.add(sha);
    }
  }

  // The published set, the same way: `rev-list <range> --not --remotes` names
  // the commits no remote-tracking ref reaches, so everything else in the range
  // has been pushed somewhere. A checkout with no remotes answers with the whole
  // range, which is the right answer: nothing there has left the machine.
  const unpublished = new Set<string>();
  let remotesKnown = false;
  const local = git(["rev-list", range, "--not", "--remotes"], root);
  if (local.ok) {
    remotesKnown = true;
    for (const line of local.stdout.split("\n")) {
      const sha = line.trim();
      if (sha.length > 0) unpublished.add(sha);
    }
  }

  const protectedPaths = options.policyProtectedPaths ?? [];
  const effects: ObservedEffect[] = [];
  for (const commit of commits) {
    // With no trunk ref to compare against (a checkout with no remote, a fresh
    // fixture repository), every commit is reported as a branch commit. That is
    // the lower claim about an unknown, and the source says the trunk was
    // unknown in its own reason so the choice stays visible.
    const onTrunk = trunkKnown && !offTrunk.has(commit.sha);
    const pushed = remotesKnown && !unpublished.has(commit.sha);
    const merge = commit.parents.length > 1;
    const who = commit.email.length > 0 ? commit.email : commit.name;
    effects.push({
      source: "git",
      id: commit.sha,
      class: onTrunk ? "vcs.push.main" : pushed ? "vcs.push.branch" : "vcs.commit.branch",
      at: commit.at,
      actorHint: who.length > 0 ? who : null,
      detail: `${merge ? "merge " : ""}commit ${short(commit.sha)} ${commit.subject}`,
    });
    for (const path of changedPaths(root, commit.sha)) {
      if (!isProtectedPath(path, protectedPaths)) continue;
      effects.push({
        source: "git",
        id: `${short(commit.sha)}:${path}`,
        class: "policy.edit",
        at: commit.at,
        actorHint: who.length > 0 ? who : null,
        detail: `${path} changed by ${short(commit.sha)}`,
        path,
      });
    }
  }

  for (const tag of observeTags(root, new Set(commits.map((commit) => commit.sha)))) {
    effects.push(tag);
  }

  const notes: string[] = [];
  if (all.length > commits.length) {
    notes.push(
      `${all.length - commits.length} older commit(s) beyond the ${max}-commit bound are not reported`,
    );
  }
  if (!trunkKnown) notes.push(`${trunk} does not resolve, so no commit is reported as trunk`);
  return {
    name: "git",
    available: true,
    ...(notes.length === 0 ? {} : { reason: notes.join("; ") }),
    effects,
  };
}

/** Tags whose target commit is inside the range, from `git for-each-ref`. */
function observeTags(root: string, inRange: ReadonlySet<string>): ObservedEffect[] {
  const format = [
    "%(refname:short)",
    "%(creatordate:iso-strict)",
    "%(objectname)",
    "%(*objectname)",
    "%(taggeremail)",
  ].join(SEP);
  const listed = git(["for-each-ref", `--format=${format}`, "refs/tags"], root);
  if (!listed.ok) return [];
  const effects: ObservedEffect[] = [];
  for (const line of listed.stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    const parts = line.split(SEP);
    if (parts.length < 5) continue;
    const name = parts[0] as string;
    const at = parts[1] as string;
    // An annotated tag's `%(objectname)` is the tag object and `%(*objectname)`
    // the commit it points at; a lightweight tag has only the first.
    const starred = parts[3] as string;
    const target = starred.length > 0 ? starred : (parts[2] as string);
    if (!inRange.has(target)) continue;
    const tagger = (parts[4] as string).replace(/^<|>$/gu, "");
    effects.push({
      source: "git",
      id: `tag:${name}`,
      // `git tag` classifies release.publish (core/command-class.ts), and a tag
      // in this project's history is how a release is cut.
      class: "release.publish",
      at,
      actorHint: tagger.length > 0 ? tagger : null,
      detail: `tag ${name} on ${short(target)}`,
    });
  }
  return effects;
}

/**
 * The default commit range: `merge-base <trunk> HEAD`, falling back to `HEAD~20`.
 *
 * The fallback is announced rather than silent. A checkout with no `origin/main`
 * (a fresh clone of a fork, a fixture repository, a detached CI checkout) has no
 * merge base to take, and a range of "the last twenty commits" is a guess; a
 * reader has to be able to see that the answer they are looking at came from a
 * guess and not from the trunk.
 */
export function defaultRange(
  root: string,
  trunk: string = DEFAULT_TRUNK_REF,
): { base: string; head: string; note?: string } {
  const merged = git(["merge-base", trunk, "HEAD"], root);
  const sha = merged.stdout.trim();
  if (merged.ok && sha.length > 0) return { base: sha, head: "HEAD" };
  return {
    base: "HEAD~20",
    head: "HEAD",
    note: `${trunk} does not resolve here, so the range is the last 20 commits rather than everything since the trunk`,
  };
}
