/**
 * The bits of git the CLI needs, run the way `cli/amend.ts` has always run
 * them: `spawnSync`, no shell, and every failure is a value rather than a throw.
 *
 * This module exists because APRV-125 gave a second and a third caller to the
 * primary-checkout resolution APRV-101 wrote for the hook. `approval log sync`
 * and `approval log advance` operate on the committed log, and the committed log
 * has exactly one home: the primary checkout. A copy of `primaryRoot` per caller
 * would be three chances for the three of them to disagree about where that is.
 *
 * Nothing here decides anything. It answers questions about a repository, and
 * the verbs decide what the answers mean.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePathSegments,
  sep,
} from "node:path";

/** One git invocation's result. `ok` is "exit status 0", nothing more. */
export interface GitRun {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function absolute(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolvePathSegments(cwd, value);
}

/**
 * Run git in `cwd`. Never throws: a git that did not run is `ok: false`.
 *
 * `env` is merged over `process.env`, and exists for exactly one caller:
 * {@link commitOnBase} points `GIT_INDEX_FILE` at a scratch index so that a
 * commit can be assembled without going anywhere near the operator's own.
 */
export function git(args: string[], cwd: string, env: Record<string, string> = {}): GitRun {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    ...(Object.keys(env).length === 0 ? {} : { env: { ...process.env, ...env } }),
  });
  if (result.error !== undefined || result.status === null) {
    return { ok: false, stdout: "", stderr: detail(result.error ?? "git did not run") };
  }
  return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
}

/** `gh`, run the way {@link git} runs git: never throws, always answers. */
export function gh(args: string[], cwd: string): GitRun {
  const result = spawnSync("gh", args, { cwd, encoding: "utf8" });
  if (result.error !== undefined || result.status === null) {
    return { ok: false, stdout: "", stderr: detail(result.error ?? "gh did not run") };
  }
  return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
}

/** The repository root containing `dir`, or `null` when there is none. */
export function repoRoot(dir: string): string | null {
  const result = git(["rev-parse", "--show-toplevel"], dir);
  if (!result.ok) return null;
  const root = result.stdout.trim();
  return root.length === 0 ? null : root;
}

/**
 * The primary checkout containing `cwd`, or `null` when git cannot say.
 *
 * `git rev-parse --git-common-dir` names the SHARED git directory: in a linked
 * worktree it is the primary checkout's `.git`, in a plain checkout it is this
 * checkout's own (printed as bare `.git` at the top level, absolute from a
 * subdirectory). Either way the primary root is its parent, so a plain checkout
 * resolves to itself.
 *
 * When git is absent, or `cwd` is not a repository at all, this returns `null`.
 * What that means is the caller's business: the hook falls back to `cwd`
 * (APRV-101), and the log verbs refuse, because a log ritual with no repository
 * to run it in has nothing to synchronize.
 */
export function primaryRoot(cwd: string): string | null {
  const result = git(["rev-parse", "--git-common-dir"], cwd);
  if (!result.ok) return null;
  const common = result.stdout.trim();
  if (common.length === 0) return null;
  return dirname(absolute(common, cwd));
}

/** `realpathSync` that answers the path itself when the path cannot be resolved. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The primary checkout, but only when `cwd` is standing in it.
 *
 * A linked worktree's toplevel is the worktree; its common git directory
 * belongs to the primary. So the two agree in the primary checkout and differ
 * in every linked one, which is the whole distinction. Symlinks are resolved on
 * both sides, because `/tmp` is `/private/tmp` on macOS and a checkout reached
 * through one spelling must not read as a different checkout from the other.
 */
export function primaryCheckout(
  cwd: string,
): { ok: true; root: string } | { ok: false; reason: string; worktreeRoot: string | null; primary: string | null } {
  const primary = primaryRoot(cwd);
  const top = repoRoot(cwd);
  if (primary === null || top === null) {
    return {
      ok: false,
      reason: "git could not say which repository this directory belongs to",
      worktreeRoot: top,
      primary,
    };
  }
  if (real(primary) !== real(top)) {
    return {
      ok: false,
      reason: `this is the linked worktree ${top}, whose primary checkout is ${primary}`,
      worktreeRoot: top,
      primary,
    };
  }
  return { ok: true, root: top };
}

/**
 * `realpathSync` for a path that may not exist yet.
 *
 * The existing part of the path is resolved and the missing tail is appended.
 * A log file that has not been created yet still has to produce the same
 * repo-relative spelling as one that has, or a check would answer differently
 * depending on whether it ran before or after the first append.
 */
function realish(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) return path;
    return join(realish(parent), basename(path));
  }
}

/**
 * A repo-relative, forward-slashed path, as git spells one.
 *
 * BOTH sides are resolved through `realpath` first (APRV-210). `git rev-parse
 * --show-toplevel` prints the physical path, so a checkout reached through a
 * symlinked spelling (`/tmp/x` for `/private/tmp/x` on macOS, a symlinked home
 * directory, a bind mount) hands this function a root and a path that live in
 * different spellings of the same place. `relative()` on those two produces a
 * path that climbs out of the repository (`../../private/tmp/…`), git has no
 * blob at `HEAD:<that>`, and the caller concludes the file has never been
 * committed. That is the misread APRV-210 recorded on a log with thousands of
 * committed records.
 */
export function repoPath(root: string, path: string): string {
  return relative(realish(root), realish(path)).split(sep).join("/");
}

/** The checked-out branch, or `null` on a detached HEAD. */
export function currentBranch(root: string): string | null {
  const result = git(["symbolic-ref", "--quiet", "--short", "HEAD"], root);
  if (!result.ok) return null;
  const name = result.stdout.trim();
  return name.length === 0 ? null : name;
}

/**
 * The bytes of `<rev>:<relative>`, or `null` when git has no such blob.
 *
 * Read as a Buffer, never as text: callers hash and compare these bytes, and an
 * encoding round-trip would silently change what is being compared.
 */
export function showBlob(root: string, rev: string, relative_: string): Buffer | null {
  const result = spawnSync("git", ["show", `${rev}:${relative_}`], { cwd: root });
  if (result.error !== undefined || result.status !== 0) return null;
  return result.stdout;
}

/** Everything git said about a run, as trimmed non-empty lines. */
export function outputLines(...texts: readonly string[]): string[] {
  return texts
    .join("\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// ---------------------------------------------------------------------------
// Basing a ceremony commit on the remote, without checking anything out
// ---------------------------------------------------------------------------

/**
 * Fetch one branch from one remote and answer the sha it now points at.
 *
 * The ceremony verbs (`policy amend`, `log advance`) own this step rather than
 * asking the operator to run it first (APRV-203). The failure that made it
 * theirs: a ceremony run in a checkout whose local `main` was behind origin
 * built its commit on the stale tip, so the pull request carried a parent that
 * was missing everything main had merged since, and CI went red for reasons
 * that had nothing to do with the amendment.
 *
 * `FETCH_HEAD` is read rather than `refs/remotes/<remote>/<branch>`, because a
 * fetch of an explicit refspec always writes the former and a repository
 * configured without remote-tracking refs would not have the latter.
 */
export function fetchBase(
  root: string,
  remote: string,
  branch: string,
): { ok: true; sha: string } | { ok: false; message: string; quote: readonly string[] } {
  const fetched = git(["fetch", remote, branch], root);
  if (!fetched.ok) {
    return {
      ok: false,
      message: `\`git fetch ${remote} ${branch}\` failed: ${failureText(fetched)}`,
      quote: outputLines(fetched.stderr, fetched.stdout),
    };
  }
  const resolved = git(["rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"], root);
  const sha = resolved.stdout.trim();
  if (!resolved.ok || sha.length === 0) {
    return {
      ok: false,
      message: `\`git fetch ${remote} ${branch}\` succeeded and named no commit: ${failureText(resolved)}`,
      quote: outputLines(resolved.stderr, resolved.stdout),
    };
  }
  return { ok: true, sha };
}

/** What {@link commitOnBase} is asked to build. */
export interface CommitOnBase {
  /** The commit the new one is parented on, as a sha. */
  base: string;
  /** Repo-relative paths taken from the WORKING TREE, laid over the base tree. */
  paths: readonly string[];
  message: string;
  /**
   * Blobs forced into the index after the working-tree paths are laid over it,
   * as `{path, sha}` (APRV-233).
   *
   * For a caller whose file is being written to concurrently and that has
   * already pinned the bytes it means. `approval log advance` hashes the log
   * under the append lock and then releases it for the slow half of the verb,
   * so the commit must carry the object it VERIFIED rather than whatever the
   * file grew into while `git fetch` was talking to the network. The blob has
   * to be in the object store already; `git hash-object -w` is how the caller
   * puts it there.
   */
  blobs?: readonly { path: string; sha: string }[];
}

/**
 * Build a commit on `base` carrying the working-tree state of `paths`, without
 * checking anything out (APRV-203).
 *
 * The whole method is one scratch index: `GIT_INDEX_FILE` points at a temporary
 * file, `read-tree` fills it from the base commit's tree, `add -A` lays the
 * named working-tree paths over it, and `write-tree` plus `commit-tree` turn
 * that into an object. HEAD never moves, the operator's index is never read or
 * written, and no file in the working tree is touched — which is what lets a
 * verb that MUST NOT check anything out (a branch switch rewinds `events.jsonl`
 * underneath whatever holds it open) still base its commit on the remote.
 *
 * `unchanged` is the honest answer when the base tree already carries exactly
 * these bytes: there is nothing to commit, and inventing an empty commit would
 * be the verb narrating its own no-op.
 */
export function commitOnBase(
  root: string,
  request: CommitOnBase,
):
  | { ok: true; sha: string; unchanged: false }
  | { ok: true; sha: null; unchanged: true }
  | { ok: false; step: string; message: string; quote: readonly string[] } {
  const scratch = mkdtempSync(join(tmpdir(), "approval-index-"));
  const env = { GIT_INDEX_FILE: join(scratch, "index") };
  const failed = (
    step: string,
    run: GitRun,
  ): { ok: false; step: string; message: string; quote: readonly string[] } => ({
    ok: false,
    step,
    message: `\`${step}\` failed: ${failureText(run)}`,
    quote: outputLines(run.stderr, run.stdout),
  });

  try {
    const read = git(["read-tree", request.base], root, env);
    if (!read.ok) return failed(`git read-tree ${request.base}`, read);

    const added = git(["add", "-A", "--", ...request.paths], root, env);
    if (!added.ok) return failed("git add", added);

    for (const blob of request.blobs ?? []) {
      const pinned = git(
        ["update-index", "--add", "--cacheinfo", `100644,${blob.sha},${blob.path}`],
        root,
        env,
      );
      if (!pinned.ok) return failed(`git update-index ${blob.path}`, pinned);
    }

    const tree = git(["write-tree"], root, env);
    if (!tree.ok) return failed("git write-tree", tree);
    const treeSha = tree.stdout.trim();

    const baseTree = git(["rev-parse", `${request.base}^{tree}`], root);
    if (baseTree.ok && baseTree.stdout.trim() === treeSha) {
      return { ok: true, sha: null, unchanged: true };
    }

    const commit = git(["commit-tree", treeSha, "-p", request.base, "-m", request.message], root, env);
    if (!commit.ok) return failed("git commit-tree", commit);
    const sha = commit.stdout.trim();
    if (sha.length === 0) {
      return { ok: false, step: "git commit-tree", message: "git commit-tree printed no sha", quote: [] };
    }
    return { ok: true, sha, unchanged: false };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The same, folded onto one line for a `--json` message string. */
export function failureText(run: GitRun): string {
  const lines = outputLines(run.stderr, run.stdout);
  return lines.length === 0 ? "git printed nothing" : lines.join(" | ");
}
