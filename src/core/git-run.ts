/**
 * Running `git` and `gh` as values rather than as exceptions.
 *
 * This used to live in `cli/git-scope.ts`, which is the wrong home for it since
 * APRV-245: the coverage sources under `core/coverage-sources/` shell out to git
 * to learn what actually happened in a repository, and core code that imported a
 * CLI module would invert the direction `tests/layering.test.ts` exists to keep.
 * So the two runners moved down here and `cli/git-scope.ts` re-exports them; its
 * callers are unchanged and there is still exactly one spelling of "run git".
 *
 * Nothing here decides anything. `ok` means "exit status 0", a process that did
 * not start is `ok: false` with the reason in `stderr`, and no call throws.
 */

import { spawnSync } from "node:child_process";

/** One process invocation's result. `ok` is "exit status 0", nothing more. */
export interface GitRun {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Run `bin` with `args` in `cwd`, answering rather than throwing. */
function run(
  bin: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): GitRun {
  const result = spawnSync(bin, args, {
    cwd,
    encoding: "utf8",
    ...(Object.keys(env).length === 0 ? {} : { env: { ...process.env, ...env } }),
  });
  if (result.error !== undefined || result.status === null) {
    return { ok: false, stdout: "", stderr: detail(result.error ?? `${bin} did not run`) };
  }
  return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Run git in `cwd`. Never throws: a git that did not run is `ok: false`.
 *
 * `env` is merged over `process.env`, and exists for exactly one caller:
 * `commitOnBase` points `GIT_INDEX_FILE` at a scratch index so that a commit can
 * be assembled without going anywhere near the operator's own.
 */
export function git(args: string[], cwd: string, env: Record<string, string> = {}): GitRun {
  return run("git", args, cwd, env);
}

/** `gh`, run the way {@link git} runs git: never throws, always answers. */
export function gh(args: string[], cwd: string): GitRun {
  return run("gh", args, cwd);
}

/**
 * Is `bin` reachable on this process's PATH?
 *
 * Asked with the tool's own `--version`, because `which` is one more program
 * that may be absent and a PATH walk would have to reimplement the platform's
 * lookup rules. A binary that is present and refuses `--version` is reported
 * absent, which is the fail-quiet direction for a reporting verb: the coverage
 * report says the source is unavailable rather than inventing a gap.
 */
export function onPath(bin: string, cwd: string): boolean {
  return run(bin, ["--version"], cwd).ok;
}
