/**
 * The dark-session detector (APRV-192): the log is asked what git already knows.
 *
 * ## The hole this closes
 *
 * APRV-151 built the CI-side grant cross-check, and its root cause is the thing
 * that check cannot reach. A session whose harness never invoked the hook writes
 * NO records at all: not a grant, not a refusal, not a request. Nothing inside
 * such a session is in a position to notice, because the component that would
 * have written the record is the component that did not run, and asking a
 * session whether it is hooked asks the party under oversight to report its own
 * oversight (SPEC.md §11). The CI guard sees only the diffs that reach a pull
 * request; a session that ran dark and pushed nothing, or pushed to a branch
 * nobody opened a pull request for, leaves the guard with nothing to read.
 *
 * So the direction is reversed. APRV-42's git evidence asks "does every log
 * entry match git?"; this asks **"does every piece of git activity match a log
 * entry?"** Git is the artifact a session cannot help producing: a commit has an
 * author, a date and a tree, a linked worktree has a root and a birth, and none
 * of those is authored by the runtime's hook. The absence of a record beside
 * them is the signal.
 *
 * ## Two arms, because there are two questions
 *
 * **Arm A, evidence.** For each commit in the window, every guarded path it
 * changed must carry evidence in the verified log that a human decided it. This
 * is not reimplemented: it is {@link evaluateProtectedPaths}, APRV-151's own
 * evaluator, called per commit, so the verdict vocabulary (`attested`,
 * `granted-file`, `granted-command`), the recency bound, the exempt evidence
 * surface and the `no-evidence` code are one implementation with two callers.
 * Arm A runs over EVERY checkout, the primary included, because a guarded-path
 * commit with no evidence is dark wherever it was made.
 *
 * **Arm B, silence.** A linked worktree that produced commits in the window (or
 * that came into existence in it) and to which NOT ONE record in the window can
 * be attributed is a dark session, whatever it touched. This is the arm that
 * catches the APRV-151 root cause on paths the CI guard never sees, and it is
 * the arm that needs an attribution rule.
 *
 * ## How a record is attributed to a worktree
 *
 * Hook task ids are `hook:<session>:<tool-use>` and carry no checkout, so the
 * id is not the key. The bound material is. Every gated file-tool call binds
 * `{tool, rule, file, …}` with `file` ABSOLUTE (`cli/hook.ts`), and every gated
 * shell call binds `{command, cwd}` with `cwd` absolute. A record whose bound
 * material names a path inside a worktree root was written by a session working
 * in that worktree. That is PR #169's checkout-root anchoring, which APRV-151's
 * notes recorded as the stronger answer to the two-checkouts problem and did not
 * have a caller for; it has one now.
 *
 * The branch name is the second key, and a weak one: a branch `aprv-192-…`
 * names task `APRV-192`, and a `task.registered` for that id in the window is
 * attribution. Weak because a branch name is chosen by the party under
 * oversight, so it may only ever ADD attribution (SPEC.md §11.1 invariant 4:
 * a self-reported field may raise scrutiny and never lower it) — which is
 * exactly what it does here, since attribution is what stops an alarm. Stated
 * plainly rather than hidden: a session that names its branch after a task some
 * other session registered escapes arm B. It does not escape arm A, and the
 * cost of the alternative (no branch key at all) is an alarm on every worktree
 * whose session worked entirely outside the payload store's reach.
 *
 * ## Fail closed in the report
 *
 * Uncertainty is never "fine". A log that does not verify, a payload whose
 * bytes will not resolve, a commit git could not date, a worktree whose root
 * cannot be placed: each is its own `undetermined` verdict with its own code,
 * counted separately from the clean ones, and the renderer never folds an
 * undetermined subject into the pass count. What this module does NOT do is
 * escalate on uncertainty, because a detector is not an enforcement path: it
 * reports, a human reads, and nothing here changes what the gate authorizes.
 *
 * ## What keeps the human's own commits quiet (AC4)
 *
 * Three exemptions, narrow and documented, and each of them fails NOISY when it
 * does not apply:
 *
 * 1. A commit that touches only the daemon's own append surface
 *    ({@link EXEMPT_PREFIXES}) is a records advance carrying evidence, not a
 *    session doing work. Requiring evidence for the evidence is circular.
 * 2. A commit authored by the git-evidence identity is the daemon's own
 *    (`daemon/git-evidence.ts`), and the daemon is not a session.
 * 3. Arm B's subject is LINKED WORKTREES ONLY. The agent-session artifact is
 *    the worktree; the human commits in the primary checkout, where the policy
 *    ceremony and the genesis events are made. The primary is not thereby
 *    passed: it stays wholly subject to arm A, so a ceremony commit passes on
 *    its attestation and an unevidenced guarded-path commit there is still
 *    reported. And the limit is stated on every report as its own coverage
 *    line, so an agent session that ran in the primary checkout shows up as a
 *    gap in the report rather than as silence.
 *
 * ## Layout
 *
 * The evaluator ({@link evaluateDarkSessions}) is PURE: no IO, no clock, no
 * git, so a fixture is enough to test it and a repository is never required.
 * The observing half below the fold does run git and read the payload store,
 * and it lives here rather than under `daemon/` because `approval doctor`
 * reports the same findings and `src/cli/` may not import `src/daemon/`
 * (APRV-59). The one thing that stays in `daemon/dark-session.ts` is the
 * append, which is the one thing a reader must never do.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { policyBytesHash } from "./attest.js";
import { childEnvironment } from "./child-env.js";
import { tick as readClock, type Clock } from "./clock.js";
import { loadPayload, payloadStoreDirFor } from "./payload-store.js";
import { loadPolicy, type LoadPolicyOptions } from "./policy-load.js";
import {
  EXEMPT_PREFIXES,
  evaluateProtectedPaths,
  isExemptPath,
  isGuardedPath,
  type GuardFinding,
  type LogWindow,
  type ChangeBlobs,
} from "./protected-path-guard.js";
import type { EventRecord } from "./log.js";

/**
 * The events a hooked session cannot avoid writing.
 *
 * A registration opens the question, a request puts it to a human, and a start
 * records that something ran. A session that made any gated tool call at all
 * wrote at least one of these; a session that wrote none of them made no gated
 * call the runtime ever saw, which is the definition of dark.
 */
export const SESSION_EVENTS: readonly string[] = [
  "task.registered",
  "approval.requested",
  "execution.started",
  // APRV-214. A tool call the open window let through is recorded rather than
  // authorized, and it is recorded loudly: a session running behind a window is
  // the opposite of dark, and counting it as dark would report the one state a
  // human deliberately created as the state this sweep exists to find.
  "gate.bypassed",
];

/**
 * How a subject came out. **Frozen union**, additive-only, in the same sense as
 * every other verdict vocabulary here (SPEC.md §11.1 invariant 6).
 */
export const DARK_SESSION_VERDICTS = ["hooked", "dark", "exempt", "undetermined"] as const;

export type DarkSessionVerdict = (typeof DARK_SESSION_VERDICTS)[number];

/**
 * Why a subject got the verdict it got. **Frozen union**, additive-only.
 *
 * `no-evidence` is spelled exactly as APRV-151 spells it, because it IS
 * APRV-151's finding, arrived at through the same evaluator.
 */
export const DARK_SESSION_CODES = [
  /** Arm B: git activity in the window, and not one attributable record. */
  "no-records",
  /** Arm A: a guarded path changed and the log carries no evidence for it. */
  "no-evidence",
  /** Exempt: the commits touch only the daemon's own append surface. */
  "evidence-surface",
  /** Exempt: authored by the daemon's own git identity. */
  "daemon-authored",
  /** Exempt from arm B (never from arm A): the primary checkout. */
  "primary-checkout",
  /** Undetermined: the log did not verify, so nothing may be read from it. */
  "log-unverified",
  /** Undetermined: git could not be run, or answered nothing. */
  "git-unavailable",
  /** Undetermined: bound material would not resolve, so records cannot be placed. */
  "payload-unresolvable",
  /** Undetermined: git named no usable date for the activity. */
  "activity-undated",
] as const;

export type DarkSessionCode = (typeof DARK_SESSION_CODES)[number];

/** One commit the observer saw, as git reported it. */
export interface ObservedCommit {
  /** The full sha. */
  sha: string;
  /** Author instant, ISO-8601, or `null` when git would not say. */
  ts: string | null;
  /** `Name <email>`, verbatim from git. */
  author: string;
  /** The author's email alone, lowercased, or `""` when git named none. */
  authorEmail: string;
  /** Repository-relative, `/`-separated paths this commit changed. */
  changedPaths: readonly string[];
  /** The branch or worktree this commit was observed on, for the message. */
  ref: string;
}

/** One checkout the observer saw: the primary, or a linked worktree. */
export interface ObservedCheckout {
  /** Absolute, symlink-resolved root. */
  root: string;
  /** How it is named in the report (the worktree directory's base name). */
  name: string;
  /** True for the primary checkout, false for a linked worktree. */
  primary: boolean;
  /** The checked-out branch, or `null` on a detached HEAD. */
  branch: string | null;
  /** Its birth instant, when the observer could stat it; else `null`. */
  born: string | null;
  /** Commits observed on it inside the window. */
  commits: readonly ObservedCommit[];
}

/** What the observer gathered, and what it could not. */
export interface GitActivity {
  checkouts: readonly ObservedCheckout[];
  /**
   * Why git could not be asked, when it could not. A non-null value makes every
   * subject `undetermined` rather than passing them for lack of evidence.
   */
  unavailable: string | null;
}

/** The window the sweep judged, as instants. */
export interface DarkSessionWindow {
  from: string;
  to: string;
}

export interface DarkSessionInput {
  activity: GitActivity;
  /**
   * Records from the log that have passed chain verification, or `null` when it
   * did not verify. `null` makes every subject `undetermined`; nothing here
   * reads an unverified record (SPEC.md §11.1 invariant 1).
   */
  records: readonly EventRecord[] | null;
  /** Why the log could not be used, when `records` is `null`. */
  logDetail?: string;
  /** `policy.protected_paths`, widening the built-in guarded set. */
  policyProtectedPaths: readonly string[];
  /** The policy file's repository-relative path, e.g. `APPROVAL.md`. */
  policyPath: string;
  /** SHA-256 of the policy bytes now on disk, for the `attested` verdict. */
  policySha256: string | null;
  /** Resolve bound material by hash from the live payload store. */
  payloadFor: (hash: string) => unknown | null;
  /** Author emails whose commits are the daemon's own, lowercased. */
  daemonEmails: readonly string[];
  /** The instants the observer swept between. */
  window: DarkSessionWindow;
  /** Override the recency bound `evaluateProtectedPaths` applies. */
  lookbackMs?: number;
}

/** One subject's verdict. A subject is one checkout. */
export interface DarkSessionFinding {
  /** The checkout's name — the worktree directory, or `primary`. */
  subject: string;
  root: string;
  primary: boolean;
  branch: string | null;
  verdict: DarkSessionVerdict;
  code: DarkSessionCode | null;
  /** Commits observed on this subject in the window. */
  commits: number;
  /** Guarded paths this subject changed in the window. */
  guardedPaths: readonly string[];
  /** Records in the window attributed to this subject. */
  attributed: readonly number[];
  /**
   * The newest sha observed on this subject, or `null` when it produced no
   * commit. Half of the observation key: an alarm is about a state of the
   * world, and the same state must not be recorded twice.
   */
  newestSha: string | null;
  /** Stable across ticks for one observation; see {@link observationKey}. */
  key: string;
  /** Prose a reader can act on, on every verdict. */
  detail: string;
}

export interface DarkSessionReport {
  /** True when no subject came out `dark`. Says nothing about what was seen. */
  ok: boolean;
  /**
   * True when every subject was ESTABLISHED, one way or the other.
   *
   * Kept separate from {@link DarkSessionReport.ok} on purpose. A report with
   * no dark subject and three undetermined ones is not a clean sweep, and a
   * single boolean would have to lie about one of the two facts: either it
   * alarms on uncertainty (and an operator learns to ignore the alarm) or it
   * calls uncertainty fine (and the detector reports a pass it did not earn).
   * Two booleans say both things, and every surface reads the one it means.
   */
  settled: boolean;
  findings: readonly DarkSessionFinding[];
  window: DarkSessionWindow;
  /**
   * What this sweep could not see, always stated. Arm B covers linked worktrees
   * only, so a session that ran in the primary checkout is outside it, and a
   * report that did not say so would be claiming coverage it does not have.
   */
  coverage: string;
}

/** The observation key: one subject, one state of the world. */
export function observationKey(subject: string, newestSha: string | null, born: string | null): string {
  return `${subject}@${newestSha ?? "no-commit"}#${born ?? "unknown-birth"}`;
}

/** A record's payload as a map. The log's payload shape is open at v0.1. */
function payloadOf(record: EventRecord): Record<string, unknown> {
  const value = record.payload;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Every `payload_hash` a record names, on the record or on its envelope actions. */
function hashesOf(record: EventRecord): string[] {
  const payload = payloadOf(record);
  const found: string[] = [];
  const direct = payload["payload_hash"];
  if (typeof direct === "string") found.push(direct);
  const envelope = payload["envelope"];
  const actions =
    typeof envelope === "object" && envelope !== null && !Array.isArray(envelope)
      ? (envelope as Record<string, unknown>)["actions"]
      : payload["actions"];
  if (Array.isArray(actions)) {
    for (const action of actions) {
      if (typeof action !== "object" || action === null) continue;
      const hash = (action as Record<string, unknown>)["payload_hash"];
      if (typeof hash === "string") found.push(hash);
    }
  }
  return found;
}

/** The absolute paths one piece of bound material names. */
function pathsIn(material: unknown): string[] {
  if (typeof material !== "object" || material === null || Array.isArray(material)) return [];
  const map = material as Record<string, unknown>;
  const found: string[] = [];
  for (const key of ["file", "cwd", "path"]) {
    const value = map[key];
    if (typeof value === "string" && value.length > 0) found.push(value);
  }
  const argv = map["argv"];
  if (Array.isArray(argv)) {
    for (const word of argv) if (typeof word === "string" && word.startsWith("/")) found.push(word);
  }
  return found;
}

/** Is `path` inside `root`, or `root` itself? Both are absolute and resolved. */
function inside(path: string, root: string): boolean {
  if (path === root) return true;
  return path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/** The Backlog.md task id a branch name begins with, upper-cased (`aprv-192-x`). */
export function taskIdFromBranch(branch: string | null): string | null {
  if (branch === null) return null;
  const match = /^([A-Za-z][A-Za-z0-9_]*-\d+)/u.exec(branch);
  return match?.[1]?.toUpperCase() ?? null;
}

/** Records inside the window, in log order. */
function inWindow(
  records: readonly EventRecord[],
  window: DarkSessionWindow,
): EventRecord[] {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  if (Number.isNaN(from) || Number.isNaN(to)) return [...records];
  return records.filter((record) => {
    const at = Date.parse(record.ts);
    return !Number.isNaN(at) && at >= from && at <= to;
  });
}

/** One subject's attribution: which windowed records were written from it. */
interface Attribution {
  seqs: number[];
  /** True when a bound payload could not be resolved, so placement is partial. */
  unresolved: boolean;
}

function attribute(
  checkout: ObservedCheckout,
  windowed: readonly EventRecord[],
  payloadFor: (hash: string) => unknown | null,
): Attribution {
  const seqs: number[] = [];
  let unresolved = false;
  const branchTask = taskIdFromBranch(checkout.branch);

  for (const record of windowed) {
    if (!SESSION_EVENTS.includes(record.event)) continue;

    // The strong key: bound material naming a path inside this checkout.
    let placed = false;
    for (const hash of hashesOf(record)) {
      const material = payloadFor(hash);
      if (material === null) {
        unresolved = true;
        continue;
      }
      if (pathsIn(material).some((path) => inside(path, checkout.root))) {
        placed = true;
        break;
      }
    }

    // The weak key: this checkout's branch names a task this record is under.
    // It may only ADD attribution, never remove it (invariant 4).
    if (!placed && branchTask !== null && typeof record.task === "string") {
      placed = record.task.toUpperCase().startsWith(branchTask);
    }

    if (placed) seqs.push(record.seq);
  }
  return { seqs, unresolved };
}

/** Did this commit touch anything but the daemon's own append surface? */
function touchesOnlyEvidence(commit: ObservedCommit): boolean {
  return commit.changedPaths.length > 0 && commit.changedPaths.every((path) => isExemptPath(path));
}

/** The limit arm B carries, repeated wherever the primary checkout is reported. */
const coverageNote =
  "A session that ran in the primary checkout is not covered by arm B; that is a stated limit of this detector, not a clean bill.";

/**
 * Evaluate what git showed against what the log carries. Pure: no IO, no clock.
 */
export function evaluateDarkSessions(input: DarkSessionInput): DarkSessionReport {
  const coverage =
    "arm B (a checkout with git activity and no records) covers LINKED WORKTREES only: the " +
    "agent-session artifact is the worktree, and the primary checkout is where the human's " +
    "policy ceremony and genesis commits are made. A session that ran IN the primary checkout " +
    "is outside arm B and is covered only by arm A (guarded paths must carry evidence).";

  const findings: DarkSessionFinding[] = [];
  for (const checkout of input.activity.checkouts) {
    findings.push(judge(checkout, input));
  }
  return {
    ok: findings.every((finding) => finding.verdict !== "dark"),
    settled: findings.every((finding) => finding.verdict !== "undetermined"),
    findings,
    window: input.window,
    coverage,
  };
}

function base(
  checkout: ObservedCheckout,
  verdict: DarkSessionVerdict,
  code: DarkSessionCode | null,
  guardedPaths: readonly string[],
  attributed: readonly number[],
  detail: string,
): DarkSessionFinding {
  const newestSha = checkout.commits.length === 0 ? null : (checkout.commits[0] as ObservedCommit).sha;
  return {
    subject: checkout.name,
    root: checkout.root,
    primary: checkout.primary,
    branch: checkout.branch,
    verdict,
    code,
    commits: checkout.commits.length,
    guardedPaths,
    attributed,
    newestSha,
    key: observationKey(checkout.name, newestSha, checkout.born),
    detail,
  };
}

function judge(checkout: ObservedCheckout, input: DarkSessionInput): DarkSessionFinding {
  const where = `${checkout.name} (${checkout.root}${
    checkout.branch === null ? ", detached HEAD" : `, branch ${checkout.branch}`
  })`;

  if (input.activity.unavailable !== null) {
    return base(
      checkout,
      "undetermined",
      "git-unavailable",
      [],
      [],
      `${where}: git could not be asked what happened here (${input.activity.unavailable}), so this sweep establishes nothing about it. Reported as uncertainty rather than as a pass.`,
    );
  }

  if (input.records === null) {
    return base(
      checkout,
      "undetermined",
      "log-unverified",
      [],
      [],
      `${where}: the log does not verify (${input.logDetail ?? "no detail"}), and nothing in this runtime reads evidence out of records that have not passed chain verification. Reported as uncertainty rather than as a pass.`,
    );
  }
  const records = input.records;

  // The daemon's own commits, and a records advance carrying evidence, are not
  // sessions. Both exemptions are computed BEFORE any alarm, and both are
  // narrow: a commit doing anything else on the same subject removes them.
  const substantive = checkout.commits.filter(
    (commit) =>
      !input.daemonEmails.includes(commit.authorEmail.toLowerCase()) && !touchesOnlyEvidence(commit),
  );
  if (checkout.commits.length > 0 && substantive.length === 0) {
    const daemonAuthored = checkout.commits.every((commit) =>
      input.daemonEmails.includes(commit.authorEmail.toLowerCase()),
    );
    return base(
      checkout,
      "exempt",
      daemonAuthored ? "daemon-authored" : "evidence-surface",
      [],
      [],
      daemonAuthored
        ? `${where}: every one of the ${String(checkout.commits.length)} commit(s) here was authored by the daemon's own git identity, which is the runtime witnessing the log rather than a session doing work`
        : `${where}: every one of the ${String(checkout.commits.length)} commit(s) here touches only the daemon's append surface (${EXEMPT_PREFIXES.join(", ")}) — a records advance carrying evidence, and requiring evidence for the evidence is circular`,
    );
  }

  // ---------------------------------------------------------------------
  // Arm A: guarded paths need evidence, in every checkout.
  // ---------------------------------------------------------------------
  const guarded = new Set<string>();
  for (const commit of substantive) {
    for (const path of commit.changedPaths) {
      if (isGuardedPath(path, input.policyProtectedPaths)) guarded.add(path);
    }
  }
  const guardedPaths = [...guarded].sort();

  const failures: GuardFinding[] = [];
  if (guardedPaths.length > 0) {
    const changeTs = new Map<string, string | null>();
    for (const commit of substantive) {
      for (const path of commit.changedPaths) {
        if (!guarded.has(path)) continue;
        const seen = changeTs.get(path);
        if (seen === undefined || (commit.ts !== null && seen !== null && commit.ts > seen)) {
          changeTs.set(path, commit.ts);
        }
      }
    }
    const logWindow: LogWindow = {
      firstSeq: records.length === 0 ? null : (records[0] as EventRecord).seq,
      lastSeq: records.length === 0 ? null : (records[records.length - 1] as EventRecord).seq,
      firstTs: records.length === 0 ? null : (records[0] as EventRecord).ts,
      lastTs: records.length === 0 ? null : (records[records.length - 1] as EventRecord).ts,
      base: input.window.from,
      head: `${checkout.name}@${(substantive[0] as ObservedCommit).sha.slice(0, 12)}`,
    };
    // APRV-202 made the guard ask whether THIS change was granted, so it needs
    // the path's bytes on both sides of the change. Here the change is the span
    // of substantive commits that touched the path: base is the parent of the
    // oldest of them, head is the newest. A blob git cannot show, or one that
    // is binary, answers null and the guard fails the path as
    // change-unreadable rather than falling back to the path-level rule.
    const blobCache = new Map<string, ChangeBlobs | null>();
    const blobsFor = (path: string): ChangeBlobs | null => {
      const cached = blobCache.get(path);
      if (cached !== undefined) return cached;
      const touching = substantive.filter((commit) => commit.changedPaths.includes(path));
      let value: ChangeBlobs | null = null;
      if (touching.length > 0) {
        const byTime = [...touching].sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
        const baseRev = `${(byTime[0] as ObservedCommit).sha}^`;
        const headRev = (byTime[byTime.length - 1] as ObservedCommit).sha;
        const inTree = (rev: string): boolean => {
          const listed = git(["ls-tree", "--name-only", rev, "--", path], checkout.root);
          return listed.ok && listed.stdout.trim().length > 0;
        };
        const show = (rev: string): string | null => {
          const shown = git(["show", `${rev}:${path}`], checkout.root);
          return shown.ok ? shown.stdout : null;
        };
        const baseHas = inTree(baseRev);
        const headHas = inTree(headRev);
        const baseText = baseHas ? show(baseRev) : null;
        const headText = headHas ? show(headRev) : null;
        const unreadable =
          (baseHas && baseText === null) ||
          (headHas && headText === null) ||
          (baseText !== null && baseText.includes("\u0000")) ||
          (headText !== null && headText.includes("\u0000"));
        if (!unreadable) value = { base: baseText, head: headText };
      }
      blobCache.set(path, value);
      return value;
    };
    const report = evaluateProtectedPaths({
      changedPaths: guardedPaths,
      blobsFor,
      records,
      logStatus: "ok",
      policyProtectedPaths: input.policyProtectedPaths,
      policySha256AtHead: input.policySha256,
      policyPath: input.policyPath,
      payloadFor: input.payloadFor,
      changeTsFor: (path) => changeTs.get(path) ?? null,
      ...(input.lookbackMs === undefined ? {} : { lookbackMs: input.lookbackMs }),
      window: logWindow,
    });
    for (const finding of report.findings) if (!finding.ok) failures.push(finding);
  }

  const attribution = attribute(checkout, inWindow(records, input.window), input.payloadFor);

  if (failures.length > 0) {
    return base(
      checkout,
      "dark",
      "no-evidence",
      guardedPaths,
      attribution.seqs,
      `${where}: ${String(failures.length)} guarded path(s) changed here in ${input.window.from}..${input.window.to} with no evidence in the log that a human decided them — ${failures
        .map((finding) => `${finding.path}: ${finding.detail}`)
        .join(" | ")}`,
    );
  }

  // ---------------------------------------------------------------------
  // Arm B: silence, in a linked worktree.
  // ---------------------------------------------------------------------
  if (checkout.primary) {
    return base(
      checkout,
      "exempt",
      "primary-checkout",
      guardedPaths,
      attribution.seqs,
      `${where}: the primary checkout is outside arm B by design — it is where the human's policy ceremony and genesis commits are made, and the agent-session artifact this detector keys on is the linked worktree. Arm A did run here and found evidence for every one of the ${String(guardedPaths.length)} guarded path(s) it changed. ${coverageNote}`,
    );
  }

  const produced = substantive.length > 0 || checkout.born !== null;
  if (!produced) {
    return base(
      checkout,
      "hooked",
      null,
      guardedPaths,
      attribution.seqs,
      `${where}: no commits in ${input.window.from}..${input.window.to} and no birth inside it, so there is no git activity for the log to owe a record against`,
    );
  }

  if (attribution.seqs.length > 0) {
    return base(
      checkout,
      "hooked",
      null,
      guardedPaths,
      attribution.seqs,
      `${where}: ${String(substantive.length)} commit(s) in the window, and ${String(
        attribution.seqs.length,
      )} record(s) in the log are attributable to this checkout (seq ${attribution.seqs
        .slice(0, 5)
        .join(", ")}${attribution.seqs.length > 5 ? ", …" : ""}), so a hook ran here`,
    );
  }

  if (attribution.unresolved) {
    return base(
      checkout,
      "undetermined",
      "payload-unresolvable",
      guardedPaths,
      [],
      `${where}: ${String(substantive.length)} commit(s) in the window and no attributable record, but at least one record's bound material would not resolve from the payload store, so a record written from HERE may exist and be unplaceable. Reported as uncertainty rather than as an alarm or as a pass; the repair is the payload store, and \`approval doctor\` reports its health.`,
    );
  }

  if (substantive.length > 0 && substantive.every((commit) => commit.ts === null)) {
    return base(
      checkout,
      "undetermined",
      "activity-undated",
      guardedPaths,
      [],
      `${where}: git reported ${String(substantive.length)} commit(s) here and dated none of them, so whether this activity falls in ${input.window.from}..${input.window.to} cannot be established. Reported as uncertainty rather than as a pass.`,
    );
  }

  return base(
    checkout,
    "dark",
    "no-records",
    guardedPaths,
    [],
    `${where}: DARK SESSION. ${
      substantive.length === 0
        ? `this worktree came into existence at ${checkout.born ?? "an unknown instant"} inside the window`
        : `${String(substantive.length)} commit(s) were made here in the window (newest ${(
            substantive[0] as ObservedCommit
          ).sha.slice(0, 12)} by ${(substantive[0] as ObservedCommit).author})`
    }, and NOT ONE ${SESSION_EVENTS.join("/")} record in ${input.window.from}..${input.window.to} can be attributed to it. A session whose harness hook never fired writes exactly this: no grant, no refusal, no request. What this establishes is the absence, not what the session did; the repair is \`approval doctor\`'s harness-hook-wiring row in that checkout and \`approval instructions hook\`.`,
  );
}

/** The report as lines an operator reads. Pure. */
export function renderDarkSessionReport(report: DarkSessionReport): string {
  const lines: string[] = [`dark-session sweep: ${report.window.from} .. ${report.window.to}`];
  if (report.findings.length === 0) {
    lines.push("  no checkouts observed");
  }
  for (const finding of report.findings) {
    const label =
      finding.verdict === "dark"
        ? `  DARK ${finding.subject} [${finding.code ?? "?"}]`
        : finding.verdict === "undetermined"
          ? `  UNDETERMINED ${finding.subject} [${finding.code ?? "?"}]`
          : `  ${finding.verdict === "exempt" ? "EXEMPT" : "OK"} ${finding.subject}${
              finding.code === null ? "" : ` [${finding.code}]`
            }`;
    lines.push(label);
    lines.push(`       ${finding.detail}`);
  }
  lines.push(
    `  ${report.ok ? "no dark session" : "DARK SESSION(S) FOUND"}; ${
      report.settled ? "every subject established" : "SOME SUBJECTS NOT ESTABLISHED"
    }`,
  );
  lines.push(`  coverage: ${report.coverage}`);
  return `${lines.join("\n")}\n`;
}

// ===========================================================================
// Observing: git, the payload store, and the clock
// ===========================================================================

/**
 * Everything below this line does IO, and it lives here rather than in
 * `daemon/` for one reason: `approval doctor` reports the same findings and
 * `src/cli/` may not import `src/daemon/` (APRV-59, `tests/layering.test.ts`).
 * Two observers would be two answers to one question, so there is one, and the
 * daemon's module keeps only the thing a reader must never do — the append.
 */

/** How far back a sweep looks, absent an operator saying otherwise. */
export const DEFAULT_DARK_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How often the sweep runs, absent an operator saying otherwise. */
export const DEFAULT_DARK_INTERVAL_MS = 15 * 60 * 1000;

/**
 * The git identities whose commits are the runtime's own.
 *
 * Spelled here rather than imported from `daemon/git-evidence.ts`, which is
 * where the daemon's commit identity is defined: core must not depend on the
 * daemon. `tests/dark-session.test.ts` pins the two against each other so they
 * cannot drift apart, the same device `APPROVALD_VERSION` uses for its own
 * duplicate of the package version.
 */
export const DAEMON_EVIDENCE_EMAILS: readonly string[] = ["approvald@noreply.approval.md"];

/** The opt-in, as the daemon carries it. */
export interface DarkSessionWatch {
  /** How far back each sweep looks. */
  windowMs: number;
  /** How often a sweep runs. The tick interval is the floor. */
  intervalMs: number;
}

/**
 * Record and field separators inside `git log --pretty`.
 *
 * ASCII 30 and 31, which cannot reach the parser inside a path: git quotes any
 * path containing a control character, so a filename engineered to carry one of
 * these arrives escaped and cannot forge a commit boundary. That matters more
 * here than in an ordinary parser, because the party who chooses the filenames
 * is the party this module reports on.
 */
const RS = "\u001e";
const FS = "\u001f";

interface GitRun {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function detailOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * One git invocation, non-interactive, in a scrubbed environment.
 *
 * The same shape `daemon/git-evidence.ts` uses and for the same reasons: an
 * inherited `GIT_DIR` would redirect the command at another repository, a
 * terminal prompt would hang a daemon silently, and the sweep has no use for a
 * credential (APRV-205's scrub).
 */
function git(args: string[], cwd: string): GitRun {
  const env: NodeJS.ProcessEnv = { ...childEnvironment().env, GIT_TERMINAL_PROMPT: "0" };
  delete env["GIT_DIR"];
  delete env["GIT_WORK_TREE"];
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env, maxBuffer: 32 * 1024 * 1024 });
  if (result.error !== undefined || result.status === null) {
    return { ok: false, stdout: "", stderr: detailOf(result.error ?? "git did not run") };
  }
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * When this checkout came into being, as git and the filesystem can say.
 *
 * A linked worktree's `.git` is a FILE written at `git worktree add`, so its
 * birth is the worktree's. The primary's `.git` is a directory whose birth is
 * the clone's, which is why arm B never reads this for the primary. `null` when
 * the platform reports no usable birth time, which is a reporting gap and never
 * a correctness one: a worktree with no birth and no commits simply produces no
 * activity for the log to owe a record against.
 */
function birthOf(root: string): string | null {
  try {
    const stats = statSync(join(root, ".git"));
    const born = stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.mtimeMs;
    if (!Number.isFinite(born) || born <= 0) return null;
    return new Date(born).toISOString();
  } catch {
    return null;
  }
}

/** The checkouts git knows about: the primary first, then every linked one. */
function worktrees(
  root: string,
): { ok: true; found: ObservedCheckout[] } | { ok: false; message: string } {
  const listed = git(["worktree", "list", "--porcelain"], root);
  if (!listed.ok) {
    return {
      ok: false,
      message: `\`git worktree list\` failed in ${root}: ${listed.stderr.trim() || "no output"}`,
    };
  }

  const found: ObservedCheckout[] = [];
  let path: string | null = null;
  let branch: string | null = null;
  const flush = (): void => {
    if (path === null) return;
    found.push({
      root: path,
      name: found.length === 0 ? "primary" : basename(path),
      primary: found.length === 0,
      branch,
      born: birthOf(path),
      commits: [],
    });
    path = null;
    branch = null;
  };
  for (const line of listed.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      path = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    }
  }
  flush();
  return { ok: true, found };
}

/** The trunk to exclude a worktree's own commits from, or `null` when there is none. */
function trunkOf(root: string): string | null {
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    if (git(["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], root).ok) return candidate;
  }
  return null;
}

/** Parse `git log`'s record-separated output into commits. */
function parseCommits(text: string, ref: string): ObservedCommit[] {
  const commits: ObservedCommit[] = [];
  for (const chunk of text.split(RS)) {
    const lines = chunk.split("\n").filter((line) => line.length > 0);
    const header = lines.shift();
    if (header === undefined) continue;
    const [sha, ts, author, email] = header.split(FS);
    if (sha === undefined || sha.length === 0) continue;
    commits.push({
      sha,
      ts: ts === undefined || ts.length === 0 ? null : ts,
      author: author ?? "",
      authorEmail: (email ?? "").toLowerCase(),
      changedPaths: lines,
      ref,
    });
  }
  return commits;
}

/**
 * Commits on one checkout inside the window, newest first.
 *
 * For a linked worktree the range is `HEAD --not <trunk>`: a branch carries all
 * of the trunk's history, and counting the trunk's commits as this worktree's
 * would attribute every merged commit to whichever worktree happened to branch
 * from it. For the primary the range is plain `HEAD`, because the primary's own
 * commits are exactly what arm A is there to check.
 */
function commitsOf(
  checkout: ObservedCheckout,
  trunk: string | null,
  from: string,
  to: string,
): { ok: true; commits: ObservedCommit[] } | { ok: false; message: string } {
  const range = checkout.primary || trunk === null ? ["HEAD"] : ["HEAD", "--not", trunk];
  const run = git(
    [
      "log",
      ...range,
      `--since=${from}`,
      `--until=${to}`,
      `--pretty=format:${RS}%H${FS}%aI${FS}%an <%ae>${FS}%ae`,
      "--name-only",
    ],
    checkout.root,
  );
  if (!run.ok) {
    return {
      ok: false,
      message: `\`git log\` failed in ${checkout.root}: ${run.stderr.trim() || "no output"}`,
    };
  }
  return { ok: true, commits: parseCommits(run.stdout, checkout.branch ?? "HEAD") };
}

/** Everything git could tell the sweep about a repository in one window. */
export function observeGitActivity(root: string, from: string, to: string): GitActivity {
  const listed = worktrees(root);
  if (!listed.ok) return { checkouts: [], unavailable: listed.message };

  const trunk = trunkOf(root);
  const checkouts: ObservedCheckout[] = [];
  for (const checkout of listed.found) {
    if (!existsSync(checkout.root)) continue;
    const found = commitsOf(checkout, trunk, from, to);
    if (!found.ok) return { checkouts: [], unavailable: found.message };
    checkouts.push({ ...checkout, commits: found.commits });
  }
  return { checkouts, unavailable: null };
}

export interface DarkSessionSweepOptions {
  logPath: string;
  /** The checkout to observe. The daemon's own `cwd`; never an agent worktree. */
  root: string;
  /** Policy location, with `loadPolicy`'s semantics. */
  policy: { dir?: string; file?: string };
  schemaDir?: string;
  /** The write-boundary clock (amended SPEC.md §8). */
  clock?: Clock;
  windowMs: number;
  /** Verified records. The caller has already read them; nothing re-reads. */
  records: readonly EventRecord[] | null;
  logDetail?: string;
  /** Test seam: an observer that answers without running git. */
  observe?: (root: string, from: string, to: string) => GitActivity;
}

/** The policy file's name and byte digest, for the `attested` verdict. */
function policyFacts(options: DarkSessionSweepOptions): {
  path: string;
  sha256: string | null;
  protectedPaths: readonly string[];
} {
  const where: LoadPolicyOptions =
    options.policy.file !== undefined
      ? { file: options.policy.file }
      : { dir: options.policy.dir ?? options.root };
  if (options.schemaDir !== undefined) where.schemaDir = options.schemaDir;
  const load = loadPolicy(where);
  // Fail closed exactly as the daemon's TTL read does: a policy that will not
  // load widens nothing, so the guarded set is the built-in one and no path is
  // quietly dropped out of it.
  const protectedPaths = load.ok ? (load.policy.protected_paths ?? []) : [];
  const path = options.policy.file ?? join(options.policy.dir ?? options.root, "APPROVAL.md");
  let sha256: string | null = null;
  try {
    sha256 = policyBytesHash(readFileSync(path));
  } catch {
    sha256 = null;
  }
  return { path: basename(path), sha256, protectedPaths };
}

/**
 * Observe and judge, appending nothing.
 *
 * The read-only half, which is the half `approval doctor` calls: doctor reports
 * and the daemon writes, so two processes never become two writers of one fact.
 */
export function reportDarkSessions(options: DarkSessionSweepOptions): {
  report: DarkSessionReport;
  window: DarkSessionWindow;
} {
  const now = readClock(options.clock === undefined ? {} : { clock: options.clock });
  const at = Date.parse(now);
  const from = new Date((Number.isNaN(at) ? Date.now() : at) - options.windowMs).toISOString();
  const observe = options.observe ?? observeGitActivity;
  const activity = observe(options.root, from, now);

  const facts = policyFacts(options);
  const storeDir = payloadStoreDirFor(options.logPath);
  const cache = new Map<string, unknown | null>();
  const payloadFor = (hash: string): unknown | null => {
    if (cache.has(hash)) return cache.get(hash) ?? null;
    const loaded = loadPayload(storeDir, hash);
    const value = loaded.ok ? loaded.value : null;
    cache.set(hash, value);
    return value;
  };

  const report = evaluateDarkSessions({
    activity,
    records: options.records,
    ...(options.logDetail === undefined ? {} : { logDetail: options.logDetail }),
    policyProtectedPaths: facts.protectedPaths,
    policyPath: facts.path,
    policySha256: facts.sha256,
    payloadFor,
    daemonEmails: DAEMON_EVIDENCE_EMAILS,
    window: { from, to: now },
  });
  return { report, window: { from, to: now } };
}
