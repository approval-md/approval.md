/**
 * `approval log sync` (APRV-125) — the pull half of the log ritual, as a verb.
 *
 * ## The ritual this replaces
 *
 * Bringing the committed log up to date used to be a hand-run sequence: stash
 * the working `events.jsonl`, pull, pop the stash, hope. It was our own
 * sanctioned runbook and it was dangerous three ways.
 *
 * 1. It rewound the working log through git while a daemon held it open for
 *    append. That is fork 2 of 2026-08-20 (APRV-104's notes): a rewound file
 *    under a live appender, and two chains where there was one.
 * 2. It reached the approver's phone as `policy.edit` over a protected path —
 *    a true label that told the human nothing about what was happening.
 * 3. `git stash pop` can conflict, and on the day it did, it left conflict
 *    markers inside the log file mid-ceremony.
 *
 * The precedent for turning it into a verb is `policy amend` after the seq 2
 * incident: when a hand-ritual proves dangerous, it becomes deterministic code
 * the gate can read.
 *
 * ## The sequence, and why each step is where it is
 *
 * Everything below runs inside ONE hold of the append lockfile. The lock is
 * usually taken per-append; here it spans the whole operation, because an
 * append landing between the snapshot and the restore is precisely the
 * interleaving that forks a chain.
 *
 *  1. **Primary checkout only.** The committed log has one home. A worktree has
 *     no business synchronizing it, and `log-sync-not-primary` says so.
 *  2. **Verify before touching anything.** The working chain is walked and its
 *     head recorded. Nothing is decided from a log that does not verify.
 *  3. **Snapshot, not stash.** The working log is copied aside, atomically, to
 *     a file inside `.approval/`. `git stash` is never used, and the log never
 *     routes through git state mutation.
 *  4. **Baseline.** The working file is set to the bytes git has at `HEAD`, so
 *     the path is clean and a fast-forward merge can move over it. This is a
 *     plain write of bytes we already hold, not a checkout: the snapshot from
 *     step 3 is the only copy that matters and it is already safe.
 *  5. **Fetch, then a fast-forward CHECK, then the merge.** A non-fast-forward
 *     is named and refused rather than merged; a merge commit over a log is a
 *     merge of two hash chains, which is not a thing that exists.
 *  6. **Reconcile.** The committed chain must be a prefix of the snapshot, or
 *     equal to it, or an extension of it. Anything else is a fork:
 *     `log-diverged`, both heads, the first divergent seq, snapshot restored,
 *     nothing else touched. The comparison is `core/log-reconcile.ts`, shared
 *     with doctor's `log-drift` check.
 *  7. **Projections are REBUILT, never copied back.** QUEUE.md is re-rendered
 *     from the reconciled log and the index is reindexed from it. The direction
 *     is load-bearing: a projection restored from before the pull would be a
 *     screenshot asserting something the log no longer says.
 *  8. **Post-verify**, and only then is the snapshot removed.
 *
 * Any failure at any step restores the snapshot before returning. The working
 * log is never left in a half state, and the snapshot outlives every failure
 * path that could need it.
 *
 * ## This verb appends no event
 *
 * The log records decisions with real-world consequence. A fast-forward pull of
 * the file the log lives in is housekeeping on the container, not a decision
 * about the world, and an event for it would be the log narrating its own
 * filesystem. Nothing here calls `appendEvent`, and the tests pin that the head
 * seq is unchanged by a successful sync (SPEC §10.1, amended APRV-125).
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { writeQueue } from "../channels/render-queue.js";
import { withAppendLock } from "../core/log.js";
import {
  compareChains,
  describeHead,
  type LogDrift,
  type LogRelation,
} from "../core/log-reconcile.js";
import { reindex } from "../core/reindex.js";
import type { LogHead } from "../core/verify.js";
import { verify } from "../core/verify.js";
import {
  currentBranch,
  failureText,
  git,
  outputLines,
  primaryCheckout,
  repoPath,
  showBlob,
} from "./git-scope.js";
import { DEFAULT_INDEX_PATH, DEFAULT_LOG_PATH } from "./paths.js";
import { DEFAULT_QUEUE_PATH } from "./render.js";

/**
 * The steps, named. They are a public shape because the failure-injection hook
 * takes one, and because a refusal says which step it stopped at.
 */
export const LOG_SYNC_STEPS = [
  "primary",
  "verify",
  "snapshot",
  "baseline",
  "fetch",
  "ff-check",
  "merge",
  "reconcile",
  "projections",
  "post-verify",
] as const;

export type LogSyncStep = (typeof LOG_SYNC_STEPS)[number];

/**
 * Machine-readable refusal codes. Frozen public API, printed in the help.
 *
 * `log-diverged` is the one that matters and the one the runbook is written
 * for: it is the only outcome here that means a human has to reconcile two
 * chains by hand, because nothing in this codebase may do it for them.
 */
export const LOG_SYNC_REFUSAL_CODES = [
  "log-sync-not-primary",
  "log-sync-no-branch",
  "log-sync-unverified",
  "log-sync-not-fast-forward",
  "log-diverged",
  "log-sync-locked",
  "log-sync-git-failed",
  "log-sync-projection-failed",
  "log-sync-restore-failed",
  "log-sync-io",
] as const;

export type LogSyncRefusalCode = (typeof LOG_SYNC_REFUSAL_CODES)[number];

/** Test-only seams. Nothing in the CLI sets these; the suites do. */
export interface LogSyncHooks {
  /**
   * Fail just before this step runs, as an injected I/O error would.
   *
   * This exists so the snapshot-restore guarantee can be tested per step
   * rather than argued for. It is a parameter of the FUNCTION and not a CLI
   * flag on purpose: the shipped surface has no way to ask for a failure.
   */
  failBefore?: LogSyncStep;
}

export interface LogSyncOptions {
  cwd: string;
  /** Remote to fetch from. Default `origin`. */
  remote?: string;
  /** Branch to fast-forward onto. Default: the checked-out branch. */
  branch?: string | null;
  hooks?: LogSyncHooks;
}

/** What a successful sync did. The `--json` success shape is built from this. */
export interface LogSyncReport {
  root: string;
  logPath: string;
  remote: string;
  branch: string;
  commitBefore: string;
  commitAfter: string;
  /** How many commits the fast-forward brought in. */
  pulled: number;
  headBefore: LogHead | null;
  headAfter: LogHead | null;
  relation: LogRelation;
  ahead: number;
  behind: number;
  /** True when the snapshot was written back (the working chain was ahead). */
  restored: boolean;
  queue: { path: string; bytes: number };
  index: "rebuilt" | "absent";
}

export type LogSyncResult =
  | { ok: true; report: LogSyncReport }
  | {
      ok: false;
      code: LogSyncRefusalCode;
      message: string;
      /** The step that refused, for the report and the tests. */
      step: LogSyncStep;
      /** Present on `log-diverged`: the whole comparison. */
      drift?: LogDrift;
      /** Verbatim git output, for a runbook's quote block. */
      quote?: readonly string[];
      /** True when the working log is back exactly as it was found. */
      restored: boolean;
    };

/** Where the snapshot of a file lives while the ritual runs. */
function snapshotPathFor(path: string): string {
  return `${path}.sync-snapshot`;
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Place `bytes` at `path` atomically: write a sibling temp file, then rename.
 *
 * A rename within a directory is atomic on every filesystem this runtime
 * supports, so a reader sees the whole previous file or the whole new one. A
 * log half-overwritten by a crash mid-restore would be the exact damage this
 * verb exists to prevent.
 */
function placeAtomically(path: string, bytes: Buffer): void {
  const temp = `${path}.tmp-${String(process.pid)}-${String(Date.now())}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temp, bytes, { flag: "wx" });
  renameSync(temp, path);
}

/** The bytes at `path`, or `null` when there is no such file. */
function readIfPresent(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

/** One file the ritual moves aside and puts back. */
interface Guarded {
  path: string;
  snapshot: string;
  /** True when the file existed when the snapshot was taken. */
  existed: boolean;
}

/**
 * `approval log sync`, as a function.
 *
 * The CLI wrapper does argv, exit codes, and formatting; everything that could
 * damage a log is here, in one sequence, with one restore path.
 */
export function logSync(options: LogSyncOptions): LogSyncResult {
  const { cwd, hooks } = options;
  const remote = options.remote ?? "origin";

  const fails = (step: LogSyncStep): boolean => hooks?.failBefore === step;

  // ---- step 1: the primary checkout, before anything is read ----
  if (fails("primary")) {
    return {
      ok: false,
      code: "log-sync-io",
      message: "injected failure before the primary-checkout check",
      step: "primary",
      restored: true,
    };
  }
  const primary = primaryCheckout(cwd);
  if (!primary.ok) {
    return {
      ok: false,
      code: "log-sync-not-primary",
      message: `log sync runs in the PRIMARY checkout only: ${primary.reason}. The committed log has one home, and a worktree that synchronized it would be advancing a chain it is not the writer of. Run this in ${primary.primary ?? "the primary checkout"}.`,
      step: "primary",
      restored: true,
    };
  }
  const root = primary.root;
  const logPath = join(root, DEFAULT_LOG_PATH);
  const queuePath = join(root, DEFAULT_QUEUE_PATH);
  const indexPath = join(root, DEFAULT_INDEX_PATH);

  const branch = options.branch ?? currentBranch(root);
  if (branch === null) {
    return {
      ok: false,
      code: "log-sync-no-branch",
      message: `HEAD in ${root} is detached, so there is no branch to fast-forward. Check out the branch the log lives on and run this again.`,
      step: "primary",
      restored: true,
    };
  }

  // Everything from here runs under the append lock: no daemon, no hook, and no
  // other CLI verb can append while the working log is moved aside.
  const held = withAppendLock<LogSyncResult>(logPath, () =>
    syncUnderLock({ cwd, root, logPath, queuePath, indexPath, remote, branch, fails }),
  );
  if (held.ok) return held.value;
  return {
    ok: false,
    code: held.error.code === "lock-timeout" ? "log-sync-locked" : "log-sync-io",
    message:
      held.error.code === "lock-timeout"
        ? `${held.error.message}. Another writer holds the append lock; sync takes it for the WHOLE operation, because an append landing mid-sync is how a chain forks. Stop the daemon (or wait for the append to finish) and run this again.`
        : held.error.message,
    step: "primary",
    restored: true,
  };
}

interface UnderLock {
  cwd: string;
  root: string;
  logPath: string;
  queuePath: string;
  indexPath: string;
  remote: string;
  branch: string;
  fails: (step: LogSyncStep) => boolean;
}

/**
 * The ceremony proper, with the lock already held.
 *
 * Written as one linear sequence on purpose. Splitting it into a step-runner
 * would hide the ordering, and the ordering IS the safety property.
 */
function syncUnderLock(ctx: UnderLock): LogSyncResult {
  const { root, logPath, queuePath, indexPath, remote, branch, fails } = ctx;

  // ---- step 2: verify before touching anything ----
  if (fails("verify")) {
    return refuseBefore("verify", "log-sync-io", "injected failure before the pre-verify");
  }
  const before = verify(logPath);
  if (before.status !== "clean") {
    return {
      ok: false,
      code: "log-sync-unverified",
      message:
        before.status === "torn-tail"
          ? `${logPath} ends without a newline: the final record is truncated, the signature of a crashed write. Sync touches nothing until a human has accounted for it; run \`approval log verify\`.`
          : `${logPath} does not verify (${before.reason}${
              before.firstBadSeq === null ? "" : ` at seq ${String(before.firstBadSeq)}`
            }): ${before.message}. Nothing is synchronized from a log that does not verify.`,
      step: "verify",
      restored: true,
    };
  }
  const headBefore = before.head;

  // ---- step 3: the snapshot ----
  if (fails("snapshot")) {
    return refuseBefore("snapshot", "log-sync-io", "injected failure before the snapshot");
  }
  const guarded: Guarded[] = [];
  try {
    for (const path of [logPath, queuePath]) {
      const snapshot = snapshotPathFor(path);
      rmSync(snapshot, { force: true });
      const existed = existsSync(path);
      // A plain copy rather than a rename: the original stays in place until
      // the baseline step deliberately replaces it, so a crash between the two
      // leaves the working file untouched rather than absent.
      if (existed) copyFileSync(path, snapshot);
      guarded.push({ path, snapshot, existed });
    }
  } catch (cause) {
    restoreAll(guarded);
    return {
      ok: false,
      code: "log-sync-io",
      message: `the snapshot could not be taken: ${detail(cause)}. Nothing was pulled and nothing was changed.`,
      step: "snapshot",
      restored: true,
    };
  }

  /**
   * Put everything back and refuse. Every failure path below goes through here,
   * which is what makes "the working log is never left in a half state" a
   * property of the code rather than of the author's diligence.
   */
  const abort = (
    step: LogSyncStep,
    code: LogSyncRefusalCode,
    message: string,
    extra: { drift?: LogDrift; quote?: readonly string[] } = {},
  ): LogSyncResult => {
    const restored = restoreAll(guarded);
    if (!restored) {
      return {
        ok: false,
        code: "log-sync-restore-failed",
        message: `${message} — AND THE SNAPSHOT COULD NOT BE PUT BACK. The working log may not be what you left; the snapshot is still at ${snapshotPathFor(logPath)} and nothing has removed it. Copy it back by hand and run \`approval log verify\` before anything appends.`,
        step,
        restored: false,
        ...extra,
      };
    }
    return { ok: false, code, message, step, restored: true, ...extra };
  };

  // ---- step 4: the baseline, so a fast-forward can move over these paths ----
  if (fails("baseline")) {
    return abort("baseline", "log-sync-io", "injected failure before the baseline");
  }
  try {
    for (const entry of guarded) {
      const blob = showBlob(root, "HEAD", repoPath(root, entry.path));
      if (blob === null) rmSync(entry.path, { force: true });
      else placeAtomically(entry.path, blob);
    }
  } catch (cause) {
    return abort(
      "baseline",
      "log-sync-io",
      `the working files could not be set to their committed bytes: ${detail(cause)}. Nothing was pulled.`,
    );
  }

  const commitBefore = revision(root, "HEAD");

  // ---- step 5a: fetch ----
  if (fails("fetch")) {
    return abort("fetch", "log-sync-git-failed", "injected failure before the fetch");
  }
  const fetched = git(["fetch", remote, branch], root);
  if (!fetched.ok) {
    return abort(
      "fetch",
      "log-sync-git-failed",
      `\`git fetch ${remote} ${branch}\` failed: ${failureText(fetched)}. Nothing was pulled and the working log is back as it was.`,
      { quote: outputLines(fetched.stderr, fetched.stdout) },
    );
  }

  // ---- step 5b: the fast-forward CHECK, before the merge is attempted ----
  if (fails("ff-check")) {
    return abort("ff-check", "log-sync-git-failed", "injected failure before the fast-forward check");
  }
  const target = revision(root, "FETCH_HEAD");
  const ancestor = git(["merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"], root);
  if (!ancestor.ok) {
    return abort(
      "ff-check",
      "log-sync-not-fast-forward",
      `${remote}/${branch} (${short(target)}) is not a fast-forward of HEAD (${short(commitBefore)}): this checkout carries commits the remote does not. Sync only fast-forwards, because a merge commit over ${DEFAULT_LOG_PATH} is a merge of two hash chains, and chains do not merge. Land your commits first (\`approval log advance\`), then sync.`,
    );
  }

  // ---- step 5c: the merge itself ----
  if (fails("merge")) {
    return abort("merge", "log-sync-git-failed", "injected failure before the merge");
  }
  const merged = git(["merge", "--ff-only", "FETCH_HEAD"], root);
  if (!merged.ok) {
    return abort(
      "merge",
      "log-sync-git-failed",
      `\`git merge --ff-only FETCH_HEAD\` failed: ${failureText(merged)}. The working log is back as it was.`,
      { quote: outputLines(merged.stderr, merged.stdout) },
    );
  }
  const commitAfter = revision(root, "HEAD");

  // ---- step 6: reconcile ----
  if (fails("reconcile")) {
    return abort("reconcile", "log-sync-io", "injected failure before the reconcile");
  }
  const snapshotText = textOf(snapshotPathFor(logPath));
  const committedText = textOf(logPath);
  const compared = compareChains(
    { label: `the working log ${logPath}`, text: snapshotText },
    { label: `the committed log at ${short(commitAfter)}`, text: committedText },
  );
  if (!compared.ok) {
    return abort("reconcile", "log-sync-unverified", compared.message);
  }
  const drift = compared.drift;

  if (drift.relation === "diverged") {
    return abort(
      "reconcile",
      "log-diverged",
      `the committed log and the working log are two different chains. They agree through seq ${String(
        (drift.firstDivergentSeq ?? 1) - 1,
      )} and part at seq ${String(drift.firstDivergentSeq)}: working head ${describeHead(
        drift.workingHead,
      )}, committed head ${describeHead(
        drift.committedHead,
      )}. Nothing was merged and nothing was re-chained — re-chaining is fabrication, and hash chains do not survive a merge. Your working log has been restored exactly as it was found; the pull DID advance the git checkout to ${short(
        commitAfter,
      )}. A human has to decide which chain is the log.`,
      { drift },
    );
  }

  // A prefix relationship in either direction is safe, and the two directions
  // are handled differently for one reason: whichever chain is LONGER contains
  // the other whole, so adopting it extends and never rewinds.
  //   ahead  — the committed baseline is a prefix of ours: put the snapshot back.
  //   behind — the pull brought records we did not have: keep the pulled file.
  //   equal  — nothing to do; the file on disk is already the chain.
  let restored = false;
  if (drift.relation === "ahead") {
    const snapshot = readIfPresent(snapshotPathFor(logPath));
    if (snapshot === null) {
      return abort(
        "reconcile",
        "log-sync-io",
        `the snapshot at ${snapshotPathFor(logPath)} disappeared before it could be restored.`,
      );
    }
    try {
      placeAtomically(logPath, snapshot);
      restored = true;
    } catch (cause) {
      return abort(
        "reconcile",
        "log-sync-io",
        `the snapshot could not be restored over ${logPath}: ${detail(cause)}.`,
      );
    }
  }

  // ---- step 7: projections, REBUILT from the reconciled log ----
  if (fails("projections")) {
    return abort("projections", "log-sync-projection-failed", "injected failure before the projection rebuild");
  }
  const rendered = writeQueue(logPath, queuePath, { policy: { dir: root } }, new Date().toISOString());
  if (!rendered.ok) {
    return abort(
      "projections",
      "log-sync-projection-failed",
      `the queue projection could not be rebuilt from the reconciled log (${rendered.code}): ${rendered.message}`,
    );
  }
  let index: "rebuilt" | "absent" = "absent";
  if (existsSync(indexPath)) {
    const reindexed = reindex(logPath, indexPath, { force: true });
    if (!reindexed.ok) {
      return abort(
        "projections",
        "log-sync-projection-failed",
        `the index could not be rebuilt from the reconciled log (${reindexed.error.code}): ${reindexed.error.message}`,
      );
    }
    index = "rebuilt";
  }

  // ---- step 8: post-verify, and only then is the snapshot let go ----
  if (fails("post-verify")) {
    return abort("post-verify", "log-sync-unverified", "injected failure before the post-verify");
  }
  const after = verify(logPath);
  if (after.status !== "clean") {
    return abort(
      "post-verify",
      "log-sync-unverified",
      `the reconciled log does not verify (${
        after.status === "torn-tail" ? "torn-tail" : after.reason
      }). The working log has been restored to what it was before the sync.`,
    );
  }

  for (const entry of guarded) rmSync(entry.snapshot, { force: true });

  return {
    ok: true,
    report: {
      root,
      logPath,
      remote,
      branch,
      commitBefore,
      commitAfter,
      pulled: countCommits(root, commitBefore, commitAfter),
      headBefore,
      headAfter: after.head,
      relation: drift.relation,
      ahead: drift.ahead,
      behind: drift.behind,
      restored,
      queue: { path: rendered.path, bytes: rendered.bytes },
      index,
    },
  };
}

/** A refusal from before the snapshot exists: there is nothing to put back. */
function refuseBefore(
  step: LogSyncStep,
  code: LogSyncRefusalCode,
  message: string,
): LogSyncResult {
  return { ok: false, code, message, step, restored: true };
}

/**
 * Put every guarded file back exactly as it was found, and drop the snapshots.
 *
 * Returns false when any file could not be restored, which is the one outcome
 * that must never be reported quietly: the caller turns it into
 * `log-sync-restore-failed` and leaves the snapshot on disk.
 */
function restoreAll(guarded: readonly Guarded[]): boolean {
  let ok = true;
  for (const entry of guarded) {
    try {
      if (entry.existed) {
        const bytes = readIfPresent(entry.snapshot);
        if (bytes === null) {
          ok = false;
          continue;
        }
        placeAtomically(entry.path, bytes);
      } else {
        rmSync(entry.path, { force: true });
      }
    } catch {
      ok = false;
      continue;
    }
    try {
      rmSync(entry.snapshot, { force: true });
    } catch {
      // The file is back; a leftover snapshot is untidy, never unsafe.
    }
  }
  return ok;
}

/** A file's text, or the empty string when it is not there. */
function textOf(path: string): string {
  const bytes = readIfPresent(path);
  return bytes === null ? "" : bytes.toString("utf8");
}

/** `git rev-parse <rev>`, or the empty string. */
function revision(root: string, rev: string): string {
  const result = git(["rev-parse", rev], root);
  return result.ok ? result.stdout.trim() : "";
}

/** How many commits `to` carries beyond `from`. */
function countCommits(root: string, from: string, to: string): number {
  if (from.length === 0 || to.length === 0 || from === to) return 0;
  const result = git(["rev-list", "--count", `${from}..${to}`], root);
  if (!result.ok) return 0;
  const parsed = Number.parseInt(result.stdout.trim(), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** A commit, as a human reads one. */
export function short(commit: string): string {
  return commit.length === 0 ? "none" : commit.slice(0, 12);
}
