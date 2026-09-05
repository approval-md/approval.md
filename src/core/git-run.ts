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

/**
 * How much of a child's output this runtime will hold, in bytes.
 *
 * `spawnSync` defaults `maxBuffer` to one mebibyte, and a child that writes
 * more than that is KILLED: `error` is set to `ENOBUFS`, `status` comes back
 * null, and `stdout` holds a truncated prefix. Nothing about that is loud. The
 * caller sees a failed run with no exit code and, if it only checks whether it
 * got bytes, sees nothing at all.
 *
 * That default cost this project a live regression. `git show <rev>:<log>` is
 * how every committed copy of `events.jsonl` is read (the anchor check, the
 * published-seq count, the sync's incoming blob), and the committed log passed
 * a megabyte long ago. Every one of those reads had been failing, silently, for
 * as long as the log had been over the ceiling: `approval log verify --anchor`
 * reported no committed copy in a checkout where `git show` printed one, the
 * daemon's started line said anchor none, the doctor's log-drift row misread,
 * and the advance cadence put the highest published seq at 0.
 *
 * A cap is still a cap and this one can still be reached. Two things make that
 * survivable rather than silent: it is not preallocated, so naming a large
 * number costs nothing until a child actually produces that much; and every
 * caller that reads a blob now reports the command it ran and what the runner
 * said when it comes back empty-handed, so the next ceiling arrives as a
 * sentence naming the command rather than as a wrong answer.
 */
export const GIT_OUTPUT_LIMIT_BYTES = 512 * 1024 * 1024;

/** One process invocation's result. `ok` is "exit status 0", nothing more. */
export interface GitRun {
  ok: boolean;
  stdout: string;
  stderr: string;
  /**
   * The child's exit status, or `null` when it never got one — it failed to
   * start, was killed by a signal, or outran {@link GIT_OUTPUT_LIMIT_BYTES}.
   *
   * `ok` cannot carry that distinction and a diagnostic needs it: "exited 128"
   * is a git that answered, and `null` is a git that was stopped mid-sentence.
   */
  status: number | null;
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
    maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
    ...(Object.keys(env).length === 0 ? {} : { env: { ...process.env, ...env } }),
  });
  if (result.error !== undefined || result.status === null) {
    return {
      ok: false,
      stdout: "",
      stderr: detail(result.error ?? `${bin} did not run`),
      status: null,
    };
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
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
