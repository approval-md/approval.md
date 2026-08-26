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
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve as resolvePathSegments, sep } from "node:path";

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

/** Run git in `cwd`. Never throws: a git that did not run is `ok: false`. */
export function git(args: string[], cwd: string): GitRun {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
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

/** A repo-relative, forward-slashed path, as git spells one. */
export function repoPath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
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

/** The same, folded onto one line for a `--json` message string. */
export function failureText(run: GitRun): string {
  const lines = outputLines(run.stderr, run.stdout);
  return lines.length === 0 ? "git printed nothing" : lines.join(" | ");
}
