/**
 * `approval log advance` (APRV-125) — the commit-and-push half of the log
 * ritual, as a verb.
 *
 * The APRV-92 flow, written down: the log's appends the remote does not have
 * yet are gathered into a commit whose message names the seq range they cover,
 * and pushed to a short-lived records branch that exists for it. Main is
 * protected here, so the commit reaches it through a pull request, and the PR
 * step is `--pr`, which runs the ordinary gated `gh` path.
 *
 * ## The three refusals that are the point
 *
 * **`log-advance-dirty-stage`.** The staged set must be EXACTLY the log, the
 * queue projection, and the payload store — nothing else. The failure this
 * prevents is the one CLAUDE.md's rule is written against: a log commit riding
 * a branch that carries other work. A verb that ran `git add -A` and hoped
 * would be a worse version of the hand-ritual it replaces, so anything else
 * already staged is a refusal and not a thing to unstage. Unstaging someone
 * else's work is not this verb's decision to make.
 *
 * **`log-advance-checkout-required`.** This verb never checks out anything. The
 * checkout is the footgun: a branch switch with an uncommitted working log
 * rewinds `events.jsonl` under whatever holds it open, which is fork 2 of
 * 2026-08-20. It builds the commit with a scratch index and pushes THAT commit
 * to a records branch by refspec, which moves no HEAD and touches no file.
 *
 * ## The base is the remote, not the local branch (APRV-203)
 *
 * The verb used to commit on the branch you were standing on, which made the
 * operator responsible for that branch being current. A checkout whose local
 * `main` was behind origin produced a records commit parented on a stale tip,
 * carrying a tree that silently reverted everything main had merged since. So
 * the verb fetches first and bases its commit on the remote's tip: `git
 * read-tree` fills a scratch index from origin's tree, the log, the queue
 * projection and the payload store are laid over it from the working tree, and
 * `commit-tree` parents the result on origin. HEAD, the operator's index and
 * every file in the working tree are exactly as they were found.
 *
 * **`log-advance-not-primary`.** Same rule as sync's: the committed log has one
 * home, and it is not a worktree.
 *
 * A local branch that is AHEAD of origin with commits this verb did not make is
 * not a refusal: the advance is based on origin either way, and those commits
 * are simply not part of it. What IS refused is a working log that origin's log
 * is not a prefix of, in either direction, because an advance is only ever the
 * records origin does not have yet.
 *
 * ## This verb appends no event
 *
 * For the same reason `log sync` appends none: committing the file the log
 * lives in is housekeeping on the container, not a decision about the world.
 * The commit is already the record of itself, in git, where a reader can see
 * exactly which bytes moved (SPEC §10.1, amended APRV-125).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { withAppendLock } from "../core/log.js";
import type { LogHead } from "../core/verify.js";
import { verify } from "../core/verify.js";
import {
  commitOnBase,
  currentBranch,
  failureText,
  fetchBase,
  gh,
  git,
  outputLines,
  primaryCheckout,
  repoPath,
  showBlob,
} from "./git-scope.js";
import { compareChains, type LogDrift } from "../core/log-reconcile.js";
import { silentProgress, type ProgressReporter } from "./progress.js";
import { DEFAULT_LOG_PATH } from "./paths.js";
import { DEFAULT_QUEUE_PATH } from "./render.js";

/** SPEC §9: the payload store, the third and last path an advance may carry. */
const DEFAULT_PAYLOADS_DIR = ".approval/payloads";

/**
 * The only paths an advance may stage, as git spells them.
 *
 * A closed list, checked in both directions: everything staged must be in it,
 * and nothing outside it may be staged. Widening it is a reviewable diff.
 */
export const ADVANCE_PATHS: readonly string[] = [
  DEFAULT_LOG_PATH,
  DEFAULT_QUEUE_PATH,
  DEFAULT_PAYLOADS_DIR,
];

/** Machine-readable refusal codes. Frozen public API, printed in the help. */
export const LOG_ADVANCE_REFUSAL_CODES = [
  "log-advance-not-primary",
  "log-advance-no-branch",
  "log-advance-dirty-stage",
  "log-advance-checkout-required",
  "log-advance-unverified",
  "log-advance-locked",
  "log-advance-fetch-failed",
  "log-advance-behind-remote",
  "log-advance-remote-diverged",
  "log-advance-git-failed",
  "log-advance-push-rejected",
  "log-advance-pr-failed",
] as const;

export type LogAdvanceRefusalCode = (typeof LOG_ADVANCE_REFUSAL_CODES)[number];

export interface LogAdvanceOptions {
  cwd: string;
  /** The records branch to push to. Default `records-log-<YYYY-MM-DD>`. */
  branch?: string | null;
  remote?: string;
  /**
   * The remote branch the records commit is parented on. Defaults to the branch
   * the checkout is standing on, which in the primary checkout is the trunk.
   */
  base?: string | null;
  /** Open the pull request through `gh` as well as pushing. */
  pr?: boolean;
  /** Report what would happen and stage, commit, and push nothing. */
  dryRun?: boolean;
  /** The date the default branch name is built from. Injected by the CLI edge. */
  today?: string;
  /**
   * Where the phase narration goes (APRV-167/APRV-203). The CLI edge passes a
   * reporter over stderr, and `--json` passes none: a machine consumer parses
   * one object and progress on its stream would corrupt it.
   */
  progress?: ProgressReporter;
}

export interface LogAdvanceReport {
  root: string;
  /** The branch the checkout is standing on. It is not moved, ever. */
  branch: string;
  recordsBranch: string;
  remote: string;
  /** The remote branch this commit is parented on, and the sha it was at. */
  base: { branch: string; sha: string } | null;
  /** The seq range this advance carries, inclusive; null when nothing is owed. */
  range: { from: number; to: number } | null;
  committedHead: LogHead | null;
  workingHead: LogHead | null;
  staged: readonly string[];
  message: string;
  commit: string | null;
  pushed: boolean;
  prUrl: string | null;
  dryRun: boolean;
}

export type LogAdvanceResult =
  | { ok: true; report: LogAdvanceReport }
  | {
      ok: false;
      code: LogAdvanceRefusalCode;
      message: string;
      /** Paths that were staged and should not have been. */
      offending?: readonly string[];
      quote?: readonly string[];
    };

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** `YYYY-MM-DD`, the shape the default records branch name carries. */
export function defaultRecordsBranch(today: string): string {
  return `records-log-${today.slice(0, 10)}`;
}

/**
 * Everything currently staged, as repo-relative paths.
 *
 * `--name-only --cached` is the whole index against HEAD; the `-z` form is used
 * because a path with a space in it is a path, and a split on newlines would
 * quietly mangle it.
 */
function stagedPaths(root: string): { ok: true; paths: string[] } | { ok: false; message: string } {
  const result = git(["diff", "--cached", "--name-only", "-z"], root);
  if (!result.ok) return { ok: false, message: failureText(result) };
  const paths = result.stdout.split("\0").filter((entry) => entry.length > 0);
  return { ok: true, paths };
}

/** Is `path` inside one of the three paths an advance is allowed to carry? */
function isAdvancePath(path: string): boolean {
  return ADVANCE_PATHS.some((allowed) => path === allowed || path.startsWith(`${allowed}/`));
}

/** `approval log advance`, as a function. The CLI wrapper formats its answer. */
export function logAdvance(options: LogAdvanceOptions): LogAdvanceResult {
  const remote = options.remote ?? "origin";
  const dryRun = options.dryRun === true;

  const primary = primaryCheckout(options.cwd);
  if (!primary.ok) {
    return {
      ok: false,
      code: "log-advance-not-primary",
      message: `log advance runs in the PRIMARY checkout only: ${primary.reason}. Log-touching commits are made where the log lives, never from a worktree. Run this in ${primary.primary ?? "the primary checkout"}.`,
    };
  }
  const root = primary.root;
  const logPath = join(root, DEFAULT_LOG_PATH);

  const branch = currentBranch(root);
  if (branch === null) {
    return {
      ok: false,
      code: "log-advance-no-branch",
      message: `HEAD in ${root} is detached, so there is no branch to commit on. This verb never checks anything out; check out the branch the log lives on yourself and run it again.`,
    };
  }

  const held = withAppendLock<LogAdvanceResult>(logPath, () =>
    advanceUnderLock({ root, logPath, branch, remote, dryRun, options }),
  );
  if (held.ok) return held.value;
  return {
    ok: false,
    code: held.error.code === "lock-timeout" ? "log-advance-locked" : "log-advance-git-failed",
    message:
      held.error.code === "lock-timeout"
        ? `${held.error.message}. Advance holds the append lock while it READS the chain, so the seq range it names is the range it commits. Wait for the append to finish and run this again.`
        : held.error.message,
  };
}

interface UnderLock {
  root: string;
  logPath: string;
  branch: string;
  remote: string;
  dryRun: boolean;
  options: LogAdvanceOptions;
}

function advanceUnderLock(ctx: UnderLock): LogAdvanceResult {
  const { root, logPath, branch, remote, dryRun, options } = ctx;
  const progress = options.progress ?? silentProgress;

  // 1. The chain, verified. A commit of a log that does not verify would be
  //    publishing the break.
  progress.phase("verifying the log chain before anything is committed from it");
  const verified = verify(logPath);
  if (verified.status !== "clean") {
    return {
      ok: false,
      code: "log-advance-unverified",
      message:
        verified.status === "torn-tail"
          ? `${logPath} ends without a newline: the final record is truncated. Nothing is committed from a torn log; run \`approval log verify\`.`
          : `${logPath} does not verify (${verified.reason}): ${verified.message}. Nothing is committed from a log that does not verify.`,
    };
  }

  // 2. The staged set: exactly the three paths, and nothing else.
  const staged = stagedPaths(root);
  if (!staged.ok) {
    return {
      ok: false,
      code: "log-advance-git-failed",
      message: `the index could not be read: ${staged.message}`,
    };
  }
  const offending = staged.paths.filter((path) => !isAdvancePath(path));
  if (offending.length > 0) {
    return {
      ok: false,
      code: "log-advance-dirty-stage",
      offending,
      message: `${String(offending.length)} path(s) are staged that an advance may not carry: ${offending.join(
        ", ",
      )}. An advance commits the log, the queue projection and the payload store, and nothing else — a log commit that rides other work is the thing the one-commit rule exists to forbid. Unstage them yourself (\`git restore --staged <path>\`) and run this again; this verb will not unstage anyone's work for them.`,
    };
  }

  // 3. The base: the remote's tip, fetched by this verb rather than by the
  //    operator (APRV-203). Everything after this is measured against it.
  const baseBranch = options.base ?? branch;
  progress.phase(`fetching ${remote}/${baseBranch}: an advance is based on the remote, not on this checkout`);
  const fetched = fetchBase(root, remote, baseBranch);
  if (!fetched.ok) {
    return {
      ok: false,
      code: "log-advance-fetch-failed",
      message: `${fetched.message}. An advance bases its commit on ${remote}/${baseBranch}, so it cannot proceed without knowing where that is. Nothing was committed. Fix the remote (network, credentials, or a branch named something else — pass \`--base <branch>\`) and run this again.`,
      quote: fetched.quote,
    };
  }
  const baseSha = fetched.sha;

  // 4. What is owed: the seq range between ORIGIN's committed log and the
  //    working head. Read through the same comparison sync and doctor read.
  const committedBlob = showBlob(root, baseSha, repoPath(root, logPath));
  const compared = compareChains(
    { label: `the working log ${logPath}`, text: textOfWorking(logPath) },
    {
      label: `the committed log ${remote}/${baseBranch}:${repoPath(root, logPath)}`,
      text: committedBlob === null ? "" : committedBlob.toString("utf8"),
    },
  );
  if (!compared.ok) {
    return { ok: false, code: "log-advance-unverified", message: compared.message };
  }
  const drift: LogDrift = compared.drift;
  if (drift.relation === "diverged") {
    return {
      ok: false,
      code: "log-advance-remote-diverged",
      message: `the working log and ${remote}/${baseBranch}'s log part at seq ${String(
        drift.firstDivergentSeq,
      )}: two chains, not one. Nothing is advanced over a fork, and nothing was committed. Run \`approval doctor\` for the log-drift report; hash chains do not merge, so which of the two is the log is a human decision.`,
    };
  }
  if (drift.relation === "behind") {
    return {
      ok: false,
      code: "log-advance-behind-remote",
      message: `${remote}/${baseBranch} carries records this working log does not (its head is ${String(
        drift.committedHead?.seq ?? 0,
      )}, the working head is ${String(
        drift.workingHead?.seq ?? 0,
      )}). An advance publishes records the remote lacks, so there is nothing here to publish and committing would propose an older chain than the one already on the remote. Run \`approval log sync\` first, then run this again. Nothing was committed.`,
    };
  }
  const committedSeq = drift.committedHead?.seq ?? 0;
  // `null` when there is nothing owed. A no-op advance is a SUCCESS, exactly as
  // a no-op `policy amend` is: an operator who runs it on an already-committed
  // log has established what they wanted to establish.
  const range =
    drift.relation === "ahead"
      ? { from: committedSeq + 1, to: drift.workingHead?.seq ?? committedSeq }
      : null;

  const recordsBranch =
    options.branch ?? defaultRecordsBranch(options.today ?? new Date().toISOString());
  if (recordsBranch === "main" || recordsBranch === "master") {
    return {
      ok: false,
      code: "log-advance-checkout-required",
      message: `--branch ${recordsBranch} would push the advance straight at the trunk. An advance goes to a records branch and reaches the trunk through a pull request; pick another name.`,
    };
  }

  const message = range === null ? "" : advanceMessage(range, branch);
  const carried = ADVANCE_PATHS.filter((path) => existsSync(join(root, path)));

  const report = (over: Partial<LogAdvanceReport>): LogAdvanceReport => ({
    root,
    branch,
    recordsBranch,
    remote,
    base: { branch: baseBranch, sha: baseSha },
    range,
    committedHead: drift.committedHead,
    workingHead: drift.workingHead,
    staged: carried,
    message,
    commit: null,
    pushed: false,
    prUrl: null,
    dryRun,
    ...over,
  });

  if (range === null || dryRun) return { ok: true, report: report({ staged: range === null ? [] : carried }) };

  // 5. Build the commit on the remote's tip, in a scratch index. Exactly those
  //    paths, laid over origin's tree; the operator's index is never touched
  //    and nothing is checked out.
  progress.phase(
    `building the records commit on ${remote}/${baseBranch} ${baseSha.slice(0, 12)} (nothing is checked out)`,
  );
  const built = commitOnBase(root, { base: baseSha, paths: carried, message });
  if (!built.ok) {
    return {
      ok: false,
      code: "log-advance-git-failed",
      message: `${built.message}; nothing was committed and the checkout is untouched.`,
      quote: built.quote,
    };
  }
  if (built.unchanged) {
    // The chains said records were owed and the trees say otherwise, which
    // means the log file on the remote already carries these bytes under a
    // different commit. Nothing to publish, and an empty commit would say
    // otherwise.
    return { ok: true, report: report({ commit: null, staged: [] }) };
  }
  const commit = built.sha;

  // 6. Anchor the commit before pushing, so a rejected push loses nothing. A
  //    ref under `refs/approval/` rather than a branch: it keeps the object
  //    reachable without adding a branch nobody asked for, and it moves no HEAD.
  const anchor = `refs/approval/advance/${recordsBranch}`;
  git(["update-ref", anchor, commit], root);

  // 7. Push THAT commit to the records branch, by refspec. A sha on the left
  //    moves no local ref and checks nothing out: the operator's branch stays
  //    exactly where they left it.
  progress.phase(`pushing ${commit.slice(0, 12)} to ${remote} ${recordsBranch}`);
  const pushed = git(["push", remote, `${commit}:refs/heads/${recordsBranch}`], root);
  if (!pushed.ok) {
    return {
      ok: false,
      code: "log-advance-push-rejected",
      message: `the advance is built on ${remote}/${baseBranch} as ${commit.slice(
        0,
        12,
      )} and held at ${anchor}, but \`git push ${remote} ${commit.slice(
        0,
        12,
      )}:refs/heads/${recordsBranch}\` was REJECTED: ${failureText(
        pushed,
      )}. The commit exists and nothing was lost; push it when the remote will take it (\`git push ${remote} ${commit.slice(
        0,
        12,
      )}:refs/heads/${recordsBranch}\`). Your checkout is exactly as you left it, on ${branch}.`,
      quote: outputLines(pushed.stderr, pushed.stdout),
    };
  }

  if (options.pr !== true) {
    progress.done();
    return { ok: true, report: report({ commit, pushed: true }) };
  }

  progress.phase(`opening the pull request for ${recordsBranch}`);
  const pr = ghPullRequest(root, recordsBranch, range);
  progress.done();
  if (!pr.ok) {
    return {
      ok: false,
      code: "log-advance-pr-failed",
      message: `the advance is committed and pushed to ${recordsBranch}, but \`gh pr create\` failed: ${pr.message}. Open the pull request by hand and merge it with a merge commit.`,
    };
  }
  return { ok: true, report: report({ commit, pushed: true, prUrl: pr.url }) };
}

/** The working log's text, or the empty string when there is no file. */
function textOfWorking(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw new Error(`log ${path} could not be read: ${detail(cause)}`);
  }
}

/** The canonical commit subject. It names the seq range, so the log is findable. */
export function advanceMessage(range: { from: number; to: number }, branch: string): string {
  const span =
    range.from === range.to ? `seq ${String(range.from)}` : `seq ${String(range.from)}..${String(range.to)}`;
  return `Log advance: ${span} (${branch})`;
}

/** `gh pr create` for the records branch. Read-only about the log itself. */
function ghPullRequest(
  root: string,
  recordsBranch: string,
  range: { from: number; to: number },
): { ok: true; url: string | null } | { ok: false; message: string } {
  const title = `Log advance: ${
    range.from === range.to ? `seq ${String(range.from)}` : `seq ${String(range.from)}..${String(range.to)}`
  }`;
  const body =
    "This branch carries exactly one commit: the append-only log advance, its queue projection, and the payload files the records reference. " +
    "Merge with a MERGE COMMIT. Nothing else may ride this branch: a log commit alongside other work is what the one-commit rule forbids.";
  const created = gh(["pr", "create", "--title", title, "--body", body, "--head", recordsBranch], root);
  if (!created.ok) {
    return { ok: false, message: failureText(created) };
  }
  const url =
    created.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("http"))
      .pop() ?? null;
  return { ok: true, url };
}
