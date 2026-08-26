/**
 * `approval log advance` (APRV-125) — the commit-and-push half of the log
 * ritual, as a verb.
 *
 * The APRV-92 flow, written down: the log's appends since the last commit are
 * staged, committed with a message naming the seq range they cover, and pushed
 * to a short-lived records branch that exists for exactly that commit. Main is
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
 * 2026-08-20. It commits on the branch you are standing on and pushes THAT
 * commit to a records branch by ref, which moves no HEAD and touches no file.
 *
 * **`log-advance-not-primary`.** Same rule as sync's: the committed log has one
 * home, and it is not a worktree.
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
  currentBranch,
  failureText,
  gh,
  git,
  outputLines,
  primaryCheckout,
  repoPath,
  showBlob,
} from "./git-scope.js";
import { compareChains, type LogDrift } from "../core/log-reconcile.js";
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
  /** Open the pull request through `gh` as well as pushing. */
  pr?: boolean;
  /** Report what would happen and stage, commit, and push nothing. */
  dryRun?: boolean;
  /** The date the default branch name is built from. Injected by the CLI edge. */
  today?: string;
}

export interface LogAdvanceReport {
  root: string;
  branch: string;
  recordsBranch: string;
  remote: string;
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

  // 1. The chain, verified. A commit of a log that does not verify would be
  //    publishing the break.
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

  // 3. What is owed: the seq range between the committed head and the working
  //    head. Read through the same comparison sync and doctor read.
  const committedBlob = showBlob(root, "HEAD", repoPath(root, logPath));
  const compared = compareChains(
    { label: `the working log ${logPath}`, text: textOfWorking(logPath) },
    {
      label: `the committed log HEAD:${repoPath(root, logPath)}`,
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
      code: "log-advance-unverified",
      message: `the working log and the committed log part at seq ${String(
        drift.firstDivergentSeq,
      )}: two chains, not one. Nothing is advanced over a fork. Run \`approval doctor\` for the log-drift report and reconcile by hand.`,
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
  const stagedNow = ADVANCE_PATHS.filter((path) => existsSync(join(root, path)));

  const report = (over: Partial<LogAdvanceReport>): LogAdvanceReport => ({
    root,
    branch,
    recordsBranch,
    remote,
    range,
    committedHead: drift.committedHead,
    workingHead: drift.workingHead,
    staged: stagedNow,
    message,
    commit: null,
    pushed: false,
    prUrl: null,
    dryRun,
    ...over,
  });

  if (range === null || dryRun) return { ok: true, report: report({ staged: range === null ? [] : stagedNow }) };

  // 4. Stage exactly those paths, by name. Never `git add -A`.
  const added = git(["add", "--", ...stagedNow], root);
  if (!added.ok) {
    return {
      ok: false,
      code: "log-advance-git-failed",
      message: `\`git add\` failed: ${failureText(added)}; nothing was committed.`,
      quote: outputLines(added.stderr, added.stdout),
    };
  }

  // 5. Commit on the branch we are standing on. No checkout, ever.
  const committed = git(["commit", "-m", message, "--", ...stagedNow], root);
  if (!committed.ok) {
    return {
      ok: false,
      code: "log-advance-git-failed",
      message: `\`git commit\` failed: ${failureText(committed)}`,
      quote: outputLines(committed.stderr, committed.stdout),
    };
  }
  const commit = git(["rev-parse", "HEAD"], root).stdout.trim();

  // 6. Push THAT commit to the records branch, by refspec. `HEAD:<branch>`
  //    moves no local ref and checks nothing out: the operator's branch stays
  //    exactly where they left it.
  const pushed = git(["push", remote, `HEAD:refs/heads/${recordsBranch}`], root);
  if (!pushed.ok) {
    return {
      ok: false,
      code: "log-advance-push-rejected",
      message: `the advance is committed LOCALLY on ${branch} as ${commit.slice(
        0,
        12,
      )}, but \`git push ${remote} HEAD:refs/heads/${recordsBranch}\` was REJECTED: ${failureText(
        pushed,
      )}. The commit exists and nothing was lost; push it when the remote will take it.`,
      quote: outputLines(pushed.stderr, pushed.stdout),
    };
  }

  if (options.pr !== true) {
    return { ok: true, report: report({ commit, pushed: true }) };
  }

  const pr = ghPullRequest(root, recordsBranch, range);
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
