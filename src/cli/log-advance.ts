/**
 * `approval log advance` (APRV-125) — the commit-and-push half of the log
 * ritual, as a verb.
 *
 * The APRV-92 flow, written down: the log's appends the remote does not have
 * yet are gathered into a commit whose message names the seq range they cover,
 * and pushed to a short-lived records branch that exists for it. Main is
 * protected here, so the commit reaches it through a pull request, and the PR
 * step is `--pr`, which runs the ordinary gated `gh` path. Since APRV-284 that
 * step also ARMS the merge (`gh pr merge <branch> --merge --auto`, off with
 * `--no-auto-merge`): a records pull request carries only evidence paths, so
 * the click it was waiting for was never a review. {@link armAutoMerge} carries
 * the reasoning and the guard that keeps it true.
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
 * ## One records branch, and one pull request, per day (APRV-204)
 *
 * The daemon advances on a cadence, so an advance is no longer a once-a-day
 * ceremony and the day's records branch usually already exists. When it does,
 * and its log is a prefix of the working log, the commit is parented on THAT
 * branch rather than on the trunk: parenting every advance on the trunk makes
 * the second push of the day a non-fast-forward of a branch a pull request is
 * already open on. `--pr` asks whether an open pull request exists for the head
 * branch before creating one, so a day gets a single pull request that later
 * advances grow.
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

import { isAdvanceBookkeeping } from "../core/advance-cycle.js";
import { withAppendLock, type EventRecord } from "../core/log.js";
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
import { anchorRevs, defaultRecordsBranch } from "./log-anchor.js";
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

/** What became of the auto-merge arm. Closed (SPEC.md §11.1 invariant 6). */
export type AutoMergeState = "armed" | "withheld" | "refused" | "off";

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
  /**
   * Arm auto-merge on the pull request `--pr` opens or updates (APRV-284).
   *
   * Defaults to true and is read only when {@link pr} is set: there is nothing
   * to arm without a pull request. `false` is the opt-out, and it is an opt-out
   * rather than an opt-in because a records pull request that sits at CLEAN
   * waiting for a hand click is the thing this option exists to remove.
   */
  autoMerge?: boolean;
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
  /** The remote branch the advance was measured against, and the sha it was at. */
  base: { branch: string; sha: string } | null;
  /**
   * The commit this advance is actually parented on (APRV-204): the base
   * branch's tip on the first advance of a day, and the day's records branch on
   * every advance after it, so the push fast-forwards the branch the day's pull
   * request is open on.
   */
  parent?: { ref: string; sha: string };
  /** True when the parent was the day's existing records branch. */
  reusedRecordsBranch?: boolean;
  /**
   * True when the day's branch existed and did NOT contain the base, so this
   * advance rebuilt it on the base rather than stacking on its tip (APRV-234).
   */
  rebuilt?: boolean;
  /** The ref and sha the rebuild was parented on, when there was one. */
  rebuiltOn?: { ref: string; sha: string };
  /**
   * The branch this advance would have pushed to, when the rebuilt commit was
   * refused there and a fresh `records-log-<date>-<n>` was opened instead.
   * `null` whenever `recordsBranch` is the branch that was asked for.
   */
  fallbackFrom?: string | null;
  /** True when this run OPENED the pull request; false when one already stood. */
  prCreated?: boolean;
  /**
   * What became of the auto-merge arm (APRV-284). A closed set, machine-read.
   *
   * - `null` — no pull request step ran at all (`pr` was not asked for, or
   *   nothing was owed and nothing was pushed).
   * - `"off"` — the caller turned the arm off (`--no-auto-merge`).
   * - `"armed"` — `gh pr merge <branch> --merge --auto` succeeded: the pull
   *   request lands as a merge commit when its checks and its branch rules
   *   say so, and never before.
   * - `"withheld"` — THIS verb declined to arm, because the branch it pushed
   *   carries something outside {@link ADVANCE_PATHS}. See
   *   {@link autoMergeNote}.
   * - `"refused"` — `gh` said no (auto-merge disabled on the repository, a
   *   merge queue, a pull request already mergeable). The pull request is open
   *   either way, so this is reported and never fatal.
   */
  autoMerge?: AutoMergeState | null;
  /** Why the arm was withheld or refused, verbatim; `null` when it was not. */
  autoMergeNote?: string | null;
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

// Re-exported rather than defined here (APRV-219). The anchor check and this
// verb must name the day's records branch identically, and `cli/log-anchor.ts`
// is the module that owns which revs a committed copy of the log may live at.
export { defaultRecordsBranch };

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

/**
 * Does `commit` already carry `candidate` in its history? (APRV-234)
 *
 * The question the day's records branch has to answer before another commit is
 * stacked on it: a branch that no longer contains the trunk cannot be
 * fast-forwarded into it, and everything built on it inherits that. Answered
 * with `merge-base --is-ancestor`, whose exit status IS the answer; anything
 * that is not a clean "yes" reads as "no", which is the direction that rebuilds
 * rather than the direction that stacks on a base nobody checked.
 */
function contains(root: string, commit: string, candidate: string): boolean {
  return git(["merge-base", "--is-ancestor", candidate, commit], root).ok;
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

  // The lock covers the READ of the log and nothing after it (APRV-233).
  //
  // It used to wrap this whole function, `git fetch`, `git push` and `gh pr
  // create` included, and on 2026-09-02 that stalled every harness hook on the
  // machine: each one asked for the append lock, waited the full two seconds
  // and refused its command `append-failed`, for as long as each advance's
  // network round-trips took. Nothing in the git half of the verb appends
  // anything, so nothing in it needs the lock. What the lock IS for is the
  // consistency of one read: the chain must verify, the seq range must be
  // measured, and the bytes that get committed must be the bytes that were
  // verified — so the log's exact content is pinned as a git blob HERE, under
  // the lock, and the commit is assembled from that object rather than from a
  // file another writer may have grown in the meantime.
  (options.progress ?? silentProgress).phase(
    "verifying the log chain before anything is committed from it",
  );
  const held = withAppendLock<SnapshotResult>(logPath, () => snapshotUnderLock(root, logPath));
  if (!held.ok) {
    return {
      ok: false,
      code: held.error.code === "lock-timeout" ? "log-advance-locked" : "log-advance-git-failed",
      message:
        held.error.code === "lock-timeout"
          ? `${held.error.message}. Advance holds the append lock while it READS the chain, so the seq range it names is the range it commits. Wait for the append to finish and run this again.`
          : held.error.message,
    };
  }
  if (!held.value.ok) return held.value;
  return advanceOnSnapshot({ root, logPath, branch, remote, dryRun, options }, held.value);
}

interface UnderLock {
  root: string;
  logPath: string;
  branch: string;
  remote: string;
  dryRun: boolean;
  options: LogAdvanceOptions;
}

/**
 * The verified log, as bytes and as a git object, taken at one instant.
 *
 * `text` is what the seq range is measured against and `blob` is what the
 * commit carries, and they are the same bytes by construction: both are taken
 * under the append lock, before it is released for the slow half of the verb.
 */
interface LogSnapshot {
  ok: true;
  text: string;
  /** The sha of the blob holding exactly `text`, already in the object store. */
  blob: string;
  staged: readonly string[];
}

type SnapshotResult = LogSnapshot | Extract<LogAdvanceResult, { ok: false }>;

/**
 * Everything the advance must read from the log, read once and pinned.
 *
 * Short by design: a chain verify, an index read and one `git hash-object`, all
 * local. Every writer on the machine waits on this and on nothing else.
 */
function snapshotUnderLock(root: string, logPath: string): SnapshotResult {
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

  // 3. The bytes, pinned. `hash-object -w` writes the blob into the object
  //    store and answers its sha, so the commit built after the lock is
  //    released carries exactly what was verified above, however much the file
  //    has grown by then.
  const text = textOfWorking(logPath);
  const hashed = git(["hash-object", "-w", "--", repoPath(root, logPath)], root);
  const blob = hashed.stdout.trim();
  if (!hashed.ok || blob.length === 0) {
    return {
      ok: false,
      code: "log-advance-git-failed",
      message: `the working log could not be written to the object store: ${failureText(hashed)}; nothing was committed.`,
    };
  }
  return { ok: true, text, blob, staged: staged.paths };
}

function advanceOnSnapshot(ctx: UnderLock, snapshot: LogSnapshot): LogAdvanceResult {
  const { root, logPath, branch, remote, dryRun, options } = ctx;
  const progress = options.progress ?? silentProgress;

  // 4. The base: the remote's tip, fetched by this verb rather than by the
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

  // 5. What is owed: the seq range between the committed log and the working
  //    head. Measured against the SNAPSHOT (APRV-233), which is the same bytes
  //    the commit will carry, so the range this names is the range it commits
  //    even though the lock is no longer held.
  const workingText = snapshot.text;
  const against = (
    sha: string,
    label: string,
  ): { ok: true; drift: LogDrift } | LogAdvanceResult => {
    const blob = showBlob(root, sha, repoPath(root, logPath));
    const compared = compareChains(
      { label: `the working log ${logPath}`, text: workingText },
      {
        label: `the committed log ${label}:${repoPath(root, logPath)}`,
        text: blob === null ? "" : blob.toString("utf8"),
      },
    );
    if (!compared.ok) {
      return { ok: false, code: "log-advance-unverified", message: compared.message };
    }
    if (compared.drift.relation === "diverged") {
      return {
        ok: false,
        code: "log-advance-remote-diverged",
        message: `the working log and ${label}'s log part at seq ${String(
          compared.drift.firstDivergentSeq,
        )}: two chains, not one. Nothing is advanced over a fork, and nothing was committed. Run \`approval doctor\` for the log-drift report; hash chains do not merge, so which of the two is the log is a human decision.`,
      };
    }
    if (compared.drift.relation === "behind") {
      return {
        ok: false,
        code: "log-advance-behind-remote",
        message: `${label} carries records this working log does not (its head is ${String(
          compared.drift.committedHead?.seq ?? 0,
        )}, the working head is ${String(
          compared.drift.workingHead?.seq ?? 0,
        )}). An advance publishes records the remote lacks, so there is nothing here to publish and committing would propose an older chain than the one already on the remote. Run \`approval log sync\` first, then run this again. Nothing was committed.`,
      };
    }
    return { ok: true, drift: compared.drift };
  };

  const trunk = against(baseSha, `${remote}/${baseBranch}`);
  if (!("drift" in trunk)) return trunk;

  const recordsBranch =
    options.branch ?? defaultRecordsBranch(options.today ?? new Date().toISOString());
  if (recordsBranch === "main" || recordsBranch === "master") {
    return {
      ok: false,
      code: "log-advance-checkout-required",
      message: `--branch ${recordsBranch} would push the advance straight at the trunk. An advance goes to a records branch and reaches the trunk through a pull request; pick another name.`,
    };
  }

  // 4a. One records branch per day, updated rather than re-created (APRV-204).
  //
  // The day's branch usually already exists: the daemon advances on a cadence
  // and every tick after the first would otherwise build ANOTHER commit on the
  // trunk, which the remote rejects as a non-fast-forward of the branch a pull
  // request is already open on. So when the records branch exists and its log
  // is a prefix of the working log, THAT is the parent: the push fast-forwards
  // and the open pull request grows by one commit.
  //
  // A fetch failure here is read as "no such branch", which is what it is
  // whenever the trunk fetch a moment ago succeeded. The alternative — treating
  // it as a network failure and refusing — would refuse every first advance of
  // every day, since the branch genuinely does not exist yet.
  //
  // 4b. Unless the trunk has moved under the branch (APRV-234).
  //
  // Observed 2026-09-02: a ceremony commit landed on main carrying its own copy
  // of the log, so `records-log-2026-09-02` no longer contained the trunk. The
  // daemon went on stacking advance commits on the branch tip — six of them —
  // each built on a base that was missing main's copy, and the pull request
  // went DIRTY and stayed DIRTY. Nothing the cadence could do would clear it;
  // it took a hand `git merge -X ours origin/main` by a person, which is
  // precisely the tap this feature exists to remove.
  //
  // So: stack only while the branch still contains the base. When it does not,
  // REBUILD — the same commit content, parented on the current trunk instead —
  // and push it over the branch. That is sound here for a reason peculiar to
  // this verb: the only paths it carries are the append-only log, its
  // projection and its content-addressed payloads, and the trunk check above
  // has already refused unless the working log is a SUPERSET of the trunk's
  // (`log-advance-behind-remote` in one direction, `log-advance-remote-diverged`
  // in the other). A rebuilt commit is therefore the trunk's own log plus the
  // tail it lacks, never a revert of anything the trunk merged.
  let parent = { ref: `${remote}/${baseBranch}`, sha: baseSha };
  let drift: LogDrift = trunk.drift;
  let reusedRecordsBranch = false;
  let rebuilt = false;
  let rebuiltOn: { ref: string; sha: string } | undefined;
  const existing = fetchBase(root, remote, recordsBranch);
  if (existing.ok) {
    if (contains(root, existing.sha, baseSha)) {
      const onBranch = against(existing.sha, `${remote}/${recordsBranch}`);
      if (!("drift" in onBranch)) return onBranch;
      parent = { ref: `${remote}/${recordsBranch}`, sha: existing.sha };
      drift = onBranch.drift;
      reusedRecordsBranch = true;
    } else {
      // The branch exists and does not contain the trunk. Keep `parent` at the
      // trunk and say so: the range is measured against the trunk's log, which
      // is what `trunk.drift` already holds.
      rebuilt = true;
      rebuiltOn = { ref: `${remote}/${baseBranch}`, sha: baseSha };
    }
  }

  const committedSeq = drift.committedHead?.seq ?? 0;
  // `null` when there is nothing owed. A no-op advance is a SUCCESS, exactly as
  // a no-op `policy amend` is: an operator who runs it on an already-committed
  // log has established what they wanted to establish.
  const range =
    drift.relation === "ahead"
      ? { from: committedSeq + 1, to: drift.workingHead?.seq ?? committedSeq }
      : null;

  const message = range === null ? "" : advanceMessage(range, branch);
  const carried = ADVANCE_PATHS.filter((path) => existsSync(join(root, path)));

  const report = (over: Partial<LogAdvanceReport>): LogAdvanceReport => ({
    root,
    branch,
    recordsBranch,
    remote,
    base: { branch: baseBranch, sha: baseSha },
    parent: { ref: parent.ref, sha: parent.sha },
    reusedRecordsBranch,
    rebuilt,
    ...(rebuiltOn === undefined ? {} : { rebuiltOn }),
    prCreated: false,
    autoMerge: null,
    autoMergeNote: null,
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
    `building the records commit on ${parent.ref} ${parent.sha.slice(0, 12)} (nothing is checked out)`,
  );
  const built = commitOnBase(root, {
    base: parent.sha,
    paths: carried,
    message,
    // APRV-233. The log goes in as the blob taken under the append lock, not as
    // whatever the file holds now: the lock was released before the fetch, and
    // a record appended since is a record this commit's message does not claim.
    blobs: carried.includes(DEFAULT_LOG_PATH)
      ? [{ path: repoPath(root, logPath), sha: snapshot.blob }]
      : [],
  });
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
  // A rebuilt commit does not descend from the branch it replaces, so it needs
  // the `+`. It is not a history rewrite in the sense the rule forbids: the
  // branch is a proposal nobody has merged, every record it carried is in the
  // new commit's log, and the alternative is a pull request that cannot land.
  const refspec = `${rebuilt ? "+" : ""}${commit}:refs/heads/${recordsBranch}`;
  let target = recordsBranch;
  let fallbackFrom: string | null = null;
  let pushed = git(["push", remote, refspec], root);
  if (!pushed.ok && rebuilt) {
    // The branch cannot be updated in place: a protected-branch ruleset
    // (GH006), or a pull request the merge queue has already taken. The records
    // still have to reach a branch somebody can merge, so they get a fresh one
    // and the report says which (APRV-234).
    const rejection = failureText(pushed);
    for (let n = 2; n <= 9 && !pushed.ok; n += 1) {
      const alternate = `${recordsBranch}-${String(n)}`;
      const attempt = git(["push", remote, `${commit}:refs/heads/${alternate}`], root);
      if (attempt.ok) {
        pushed = attempt;
        fallbackFrom = recordsBranch;
        target = alternate;
        git(["update-ref", `refs/approval/advance/${alternate}`, commit], root);
        progress.phase(
          `${recordsBranch} would not take the rebuilt commit (${rejection}); opened ${alternate} instead`,
        );
      }
    }
  }
  if (!pushed.ok) {
    return {
      ok: false,
      code: "log-advance-push-rejected",
      message: `the advance is built on ${parent.ref} as ${commit.slice(
        0,
        12,
      )} and held at ${anchor}, but \`git push ${remote} ${refspec}\` was REJECTED: ${failureText(
        pushed,
      )}. The commit exists and nothing was lost; push it when the remote will take it (\`git push ${remote} ${refspec}\`). Your checkout is exactly as you left it, on ${branch}.`,
      quote: outputLines(pushed.stderr, pushed.stdout),
    };
  }

  if (options.pr !== true) {
    progress.done();
    return {
      ok: true,
      report: report({ commit, pushed: true, recordsBranch: target, fallbackFrom }),
    };
  }

  progress.phase(`opening or updating the pull request for ${target}`);
  const pr = ghPullRequest(root, target, range);
  if (!pr.ok) {
    progress.done();
    return {
      ok: false,
      code: "log-advance-pr-failed",
      message: `the advance is committed and pushed to ${target}, but \`gh pr ${pr.step}\` failed: ${pr.message}. Open the pull request by hand and merge it with a merge commit.`,
    };
  }

  // APRV-284. The arm, and never a refusal of the verb: the records are
  // committed, pushed and open as a pull request whatever `gh` says next.
  const arm =
    options.autoMerge === false
      ? { state: "off" as const, note: null }
      : armAutoMerge(root, target, { baseSha, commit });
  if (arm.state === "armed") {
    progress.phase(`auto-merge armed on ${target}`);
  } else if (arm.note !== null) {
    progress.phase(`auto-merge was not armed on ${target}: ${arm.note}`);
  }
  progress.done();

  return {
    ok: true,
    report: report({
      commit,
      pushed: true,
      recordsBranch: target,
      fallbackFrom,
      prUrl: pr.url,
      prCreated: pr.created,
      autoMerge: arm.state,
      autoMergeNote: arm.note,
    }),
  };
}

// ---------------------------------------------------------------------------
// What is not yet published (APRV-204)
// ---------------------------------------------------------------------------

/** Where the records that are already published end. */
export interface PublishedState {
  /** The highest seq this chain reaches on a records branch, the trunk, or HEAD. */
  publishedSeq: number;
  /** The working log's head seq. */
  workingSeq: number;
  /** Working records above `publishedSeq`, advance bookkeeping included. */
  pending: number;
  /** The same count with the daemon's own advance cycles removed. */
  substantive: number;
  /**
   * The rev the published head was read from, or `null` when no rev carried a
   * copy of this chain (APRV-210).
   *
   * A row that says "N records are not yet on a records branch" is unreadable
   * without it: a rev that resolved to nothing and a rev that carried nothing
   * are the same number and completely different facts, and the doctor's
   * cadence row reported the first as the second on a log whose first 8,379
   * records had been merged to the trunk an hour earlier.
   */
  publishedRev: string | null;
  /** Every rev that was consulted, in the order they were tried. */
  revs: readonly string[];
  /**
   * Where the OWED SPAN ends: the highest unpublished seq that is not an
   * advance cycle's own bookkeeping, or {@link publishedSeq} when none is
   * (APRV-211).
   *
   * `workingSeq` was the wrong end of the span for the daemon's idempotency
   * key. One gated attempt appends its own `task.registered` and
   * `approval.requested`, which move the head, so the next tick computed a
   * DIFFERENT key for the SAME owed work and asked the human a second question.
   * Measured over substantive records, the span is stable for exactly as long
   * as the owed work is unchanged, which is what makes one owed advance one
   * question — and it still moves the moment a real record lands, so the
   * payload hash still differs per distinct advance and the `supervised-live`
   * draw is never re-rolled for the same span.
   *
   * Never below `publishedSeq`: a span that ran backwards would name a range
   * the commit could not carry.
   */
  substantiveSeq: number;
}

/**
 * The chain head of one git rev's copy of the log, or `null`.
 *
 * `null` covers three cases that mean the same thing here: no such rev, no such
 * blob, and a copy that is not this chain (a fork, or a chain somehow ahead of
 * the working log). None is evidence that any working record has been
 * published, and treating any of them as evidence would UNDER-count what is
 * owed, which is the direction that loses records.
 */
function publishedHeadAt(
  root: string,
  logPath: string,
  workingText: string,
  rev: string,
): number | null {
  const blob = showBlob(root, rev, repoPath(root, logPath));
  if (blob === null) return null;
  const compared = compareChains(
    { label: "the working log", text: workingText },
    { label: rev, text: blob.toString("utf8") },
  );
  if (!compared.ok) return null;
  if (compared.drift.relation === "diverged" || compared.drift.relation === "behind") return null;
  return compared.drift.committedHead?.seq ?? 0;
}

/**
 * How much of the working log is already on a records branch or the trunk.
 *
 * Reads git's object store and NEVER the network: this is asked on every daemon
 * tick and by `approval doctor`, and a status question must not depend on a
 * remote being reachable. The revs consulted are the local advance anchors
 * (`refs/approval/advance/*`, which {@link logAdvance} writes before it pushes),
 * the remote-tracking refs for the base branch and the day's records branch, and
 * `HEAD`. The highest head among the copies that are a PREFIX of this chain
 * wins; anything else is ignored, which can only make a caller advance less
 * eagerly.
 *
 * It lives here rather than beside the daemon's cadence because `approval
 * doctor` reports the same number and a CLI module may not import the daemon.
 */
export function publishedState(
  root: string,
  logPath: string,
  records: readonly EventRecord[],
  where: { remote: string; base: string | null },
  today: string,
): PublishedState {
  const workingSeq = records.length === 0 ? 0 : (records[records.length - 1]?.seq ?? 0);
  let workingText: string;
  try {
    workingText = readFileSync(logPath, "utf8");
  } catch {
    workingText = "";
  }

  const revs = anchorRevs(root, { remote: where.remote, base: where.base, today });
  let publishedSeq = 0;
  let publishedRev: string | null = null;
  for (const rev of revs) {
    const head = publishedHeadAt(root, logPath, workingText, rev);
    if (head !== null && head > publishedSeq) {
      publishedSeq = head;
      publishedRev = rev;
    }
  }

  const unpublished = records.filter((record) => record.seq > publishedSeq);
  const substantive = unpublished.filter((record) => !isAdvanceBookkeeping(record));
  return {
    publishedSeq,
    workingSeq,
    pending: unpublished.length,
    substantive: substantive.length,
    substantiveSeq: substantive[substantive.length - 1]?.seq ?? publishedSeq,
    publishedRev,
    revs,
  };
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

/** The first `http…` line of a `gh` run's output, which is how `gh` names a PR. */
function urlOf(text: string): string | null {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("http"))
      .pop() ?? null
  );
}

/**
 * The day's pull request for the records branch: opened once, updated after.
 *
 * ONE PR PER DAY, not one per advance (APRV-204). The daemon advances on a
 * cadence, so `gh pr create` on every run would either fail (a PR for the head
 * branch already exists) or, on a remote that allows it, litter the repository
 * with a pull request per tick. The push has already updated the branch by the
 * time this runs, so an open pull request for that head IS the updated one and
 * this function's whole job is to notice it.
 *
 * `gh pr list` is a read (`read.vcs.remote` in this project's own taxonomy) and
 * asks nothing of the remote's state.
 */
function ghPullRequest(
  root: string,
  recordsBranch: string,
  range: { from: number; to: number },
):
  | { ok: true; url: string | null; created: boolean }
  | { ok: false; step: "list" | "create"; message: string } {
  const listed = gh(
    ["pr", "list", "--head", recordsBranch, "--state", "open", "--json", "url"],
    root,
  );
  if (!listed.ok) {
    return { ok: false, step: "list", message: failureText(listed) };
  }
  const open = parsePrList(listed.stdout);
  if (open.length > 0) {
    return { ok: true, url: open[0] ?? null, created: false };
  }

  const title = `Log advance: ${
    range.from === range.to ? `seq ${String(range.from)}` : `seq ${String(range.from)}..${String(range.to)}`
  }`;
  const body =
    "This branch carries the append-only log advance, its queue projection, and the payload files the records reference — one commit per advance, and nothing else. " +
    "Merge with a MERGE COMMIT. Nothing else may ride this branch: a log commit alongside other work is what the one-commit rule forbids.";
  const created = gh(["pr", "create", "--title", title, "--body", body, "--head", recordsBranch], root);
  if (!created.ok) {
    return { ok: false, step: "create", message: failureText(created) };
  }
  return { ok: true, url: urlOf(created.stdout), created: true };
}

/**
 * Arm auto-merge on the day's records pull request (APRV-284).
 *
 * ## Why a records pull request may arm its own merge
 *
 * A records commit carries EXACTLY the log, `QUEUE.md` and
 * `.approval/payloads/` (the `log-advance-dirty-stage` refusal is the other
 * half of that rule), those three are the paths CI's protected-path guard
 * exempts, and there is nothing in them a reviewer reviews: the log is
 * append-only evidence and the queue is a projection of it. So a records pull
 * request is the one shape in this repository that never needs a human to read
 * it, and leaving it at CLEAN until somebody clicks is exactly the failure mode
 * CLAUDE.md's workflow item 7 exists to remove.
 *
 * ## What the arm is, in this project's own taxonomy
 *
 * `gh pr merge <branch> --merge --auto` — the same command with the same class
 * (`vcs.push.main`, `core/command-class.ts`'s `gh-pr-merge` row) a session runs
 * to arm its own pull request. Nothing here mints a class, claims an exemption,
 * or asks a second question: this runs inside whatever authorized the advance,
 * which for the daemon is the `log.advance` grant APRV-204 opened and for a
 * session is the harness hook's answer on the verb.
 *
 * ## The guard, and why the arm is not unconditional
 *
 * The reasoning above holds only while the branch really does carry nothing
 * else. It is a branch on a shared remote, so a commit this verb did not make
 * can be sitting on it, and the advance would fast-forward over that commit and
 * then arm a merge for it. So the arm is preceded by a check of the pushed
 * branch against the base it is measured from, and anything outside
 * {@link ADVANCE_PATHS} WITHHOLDS the arm and names what it saw. Everything
 * ambiguous withholds too: an unreadable diff, a base that could not be
 * resolved. A withheld arm costs a human one click; an unconditional one would
 * land whatever rode the branch.
 *
 * ## An arm `gh` says no to is not a failure
 *
 * Auto-merge disabled on the repository, a merge queue, a pull request already
 * mergeable: `gh` refuses all three, and the advance is committed, pushed and
 * open as a pull request regardless. The refusal is reported and the verb still
 * succeeds — the same rule `cli/amend.ts`'s ceremony arm has followed since
 * APRV-130.
 */
function armAutoMerge(
  root: string,
  recordsBranch: string,
  span: { baseSha: string; commit: string },
): { state: AutoMergeState; note: string | null } {
  const carried = branchDiffPaths(root, span.baseSha, span.commit);
  if (carried === null) {
    return {
      state: "withheld",
      note: `\`git diff --name-only ${span.baseSha.slice(0, 12)} ${span.commit.slice(
        0,
        12,
      )}\` could not be read, so what ${recordsBranch} carries is unknown`,
    };
  }
  const foreign = carried.filter((path) => !isAdvancePath(path));
  if (foreign.length > 0) {
    return {
      state: "withheld",
      note: `${recordsBranch} carries paths an advance does not: ${foreign.join(
        ", ",
      )}. A records pull request arms its own merge because it carries only evidence; this one does not, so it wants a reviewer`,
    };
  }

  const merged = gh(["pr", "merge", recordsBranch, "--merge", "--auto"], root);
  if (merged.ok) return { state: "armed", note: null };
  return {
    state: "refused",
    note: outputLines(merged.stderr, merged.stdout)[0] ?? failureText(merged),
  };
}

/**
 * Every path `from..to` touches, or `null` when git would not say.
 *
 * `null` is not "nothing changed": an empty diff is `[]`, and the two must not
 * collapse, because the caller treats the unknown as a reason to withhold and
 * the empty as a branch carrying nothing foreign.
 */
function branchDiffPaths(root: string, from: string, to: string): string[] | null {
  if (from.length === 0 || to.length === 0) return null;
  const diff = git(["diff", "--name-only", `${from}..${to}`], root);
  if (!diff.ok) return null;
  return diff.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * The urls in `gh pr list --json url` output.
 *
 * Unparseable output answers "no open pull request", which is the conservative
 * reading in exactly one direction: the verb then tries to create one, and a
 * `gh pr create` that finds an existing PR fails loudly with the reason. The
 * opposite default would silently skip opening the day's pull request.
 */
function parsePrList(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim().length === 0 ? "[]" : text) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const urls: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const url = (entry as Record<string, unknown>)["url"];
    if (typeof url === "string" && url.length > 0) urls.push(url);
  }
  return urls;
}
