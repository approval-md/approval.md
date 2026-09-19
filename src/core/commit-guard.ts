/**
 * The unit of judgment: one commit (APRV-375).
 *
 * ## What a grant binds
 *
 * A `policy.edit` grant binds ONE edit: a before-state, an after-state, and a
 * human who was shown them. The protected-path guard of
 * `core/protected-path-guard.ts` decides whether a change is made of such
 * material, and everything it answers is relative to the pair of blobs the
 * caller hands it. So the caller's choice of pair is the whole question, and
 * until this module the CI guard chose the pull request's COMBINED diff: base
 * tree against head tree, every commit's work replayed as one change.
 *
 * That pairing has no grant. PR #427 is the worked example (APRV-357's
 * reproduction, PR #452): three lane commits, each granted, plus two merges of
 * `origin/main` made while four other lanes were editing `SPEC.md`. Replayed as
 * one change it failed `uncovered-hunk` with fourteen uncovered lines, twenty
 * nine records naming the path and twenty seven covering part of it, because a
 * grant binds a before-state that the combined base no longer carries once an
 * earlier commit in the range has moved those bytes. Replayed per commit all
 * three pass, in well under a second each.
 *
 * `approval doctor`'s dark-session arm A reached the same conclusion from the
 * other side (APRV-369): it used to replay a whole window as one change and
 * failed a change CI had passed, at every session start. It now replays per
 * commit. This module is where the two meet, so the agreement is by
 * construction rather than by two code paths kept in step.
 *
 * ## The security argument
 *
 * Judging per commit asks a SMALLER question than judging the combined diff, so
 * it owes an argument that nothing escapes. It is this:
 *
 * 1. Every byte that differs between the base tree and the head tree was
 *    written by some commit in `base..head`. Two-dot range semantics is what
 *    makes that true: a commit reachable from base is excluded, and a commit
 *    reachable from base changed nothing about the difference between the two
 *    trees that its own history did not already carry.
 * 2. A non-merge commit's whole contribution is its diff against its parent,
 *    which is exactly what this module hands the guard.
 * 3. A merge commit contributes only what it resolved: the bytes its result
 *    carries that no parent carried. That is git's DENSE combined diff
 *    (`--cc`), and a merge with a non-empty one on a guarded path is judged
 *    against its first parent here. A merge whose result on a path is some
 *    parent's bytes verbatim invented nothing and is listed as skipped.
 *
 * Together: every changed byte is inside some judged unit, and each unit is
 * judged against the before-state a grant for it would have bound. The guard
 * stops asking about the combined diff because the combined diff is a change
 * nobody ever made and nobody could have approved.
 *
 * ## One thing is NOT per commit: whole-file evidence
 *
 * A grant binds a hunk, so it is evidence about one commit. A sign-off
 * (APRV-338), an organ attestation (APRV-272) and the policy attestation say a
 * human read the file AS IT NOW STANDS, so they are evidence about the bytes
 * the range INSTALLS: every commit is offered the digests at the RANGE HEAD.
 * {@link digestsAt} carries the reasoning, and it matters because matching them
 * per commit would have repealed the escape hatch for every edit before the
 * last one.
 *
 * ## What this does NOT do
 *
 * It does not re-judge work the branch absorbed by merging `origin/main`. Those
 * commits are main's, they passed their own pull requests, and two-dot
 * `base..head` excludes them by construction: CI computes base as `git
 * merge-base origin/main HEAD`, so a branch that merged main has every absorbed
 * commit reachable from base. Nothing is skipped by a rule about authorship or
 * about who pushed what; the range is simply the commits this pull request is
 * proposing to add.
 *
 * It also does not relax the exact-replay byte budget of
 * `core/protected-path-guard.ts`. Per commit that budget is not reached in any
 * case observed, which is why APRV-357 closes as superseded rather than fixed.
 */

import { createHash } from "node:crypto";

import type {
  ChangeBlobs,
  ChangeTimestamps,
  GuardFinding,
  GuardInput,
  GuardReport,
  LogWindow,
} from "./protected-path-guard.js";
import { evaluateProtectedPaths, isGuardedPath } from "./protected-path-guard.js";

/** SHA-256 of a UTF-8 string, hex. */
function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * One git invocation's stdout, or `null` when git failed or could not be run.
 *
 * A seam rather than a direct `spawnSync` because the two callers run git
 * differently and must not stop doing so: `scripts/protected-path-guard.mjs`
 * runs it in the checked-out repository CI cloned, and `core/dark-session.ts`
 * runs it in a scrubbed environment with `GIT_DIR` and `GIT_WORK_TREE` removed
 * and `GIT_TERMINAL_PROMPT=0` (APRV-205), inside whichever checkout it is
 * observing. What they share is the QUESTIONS, and those are here.
 */
export type GitReader = (args: readonly string[]) => string | null;

/** A commit as this module judges it. */
export interface JudgedCommit {
  sha: string;
  /** Parents in git's own order; empty for a root commit. */
  parents: readonly string[];
  /** Both of git's dates (APRV-339), or nulls when git could not say. */
  ts: ChangeTimestamps;
  /**
   * The paths this commit is judged for.
   *
   * For a non-merge commit, everything it touched. For a merge, only the paths
   * whose result differs from every parent hunk by hunk — git's dense combined
   * diff — so a merge that took one parent's bytes verbatim is judged for
   * nothing.
   */
  changedPaths: readonly string[];
}

/** Is this commit a merge? */
export function isMerge(commit: JudgedCommit): boolean {
  return commit.parents.length > 1;
}

/**
 * The revision a commit is judged AGAINST: its first parent.
 *
 * First parent and not the merge base of the parents, for a merge, because the
 * first parent is the state the branch was in before the merge and the merge's
 * own contribution is measured from there. `null` for a root commit, which has
 * no before-state at all and whose every path is an add.
 */
export function baseRevOf(commit: JudgedCommit): string | null {
  return commit.parents.length === 0 ? null : `${commit.sha}^1`;
}

/**
 * Record and field separators inside `git log --pretty`.
 *
 * ASCII 30 and 31, for the reason `core/dark-session.ts` states where it uses
 * the same pair: git quotes any path containing a control character, so a
 * filename engineered to carry one arrives escaped and cannot forge a commit
 * boundary in output the guard parses.
 */
const RS = "";
const FS = "";

function datesOf(author: string | undefined, committer: string | undefined): ChangeTimestamps {
  const a = author === undefined || author.length === 0 ? null : author;
  const c = committer === undefined || committer.length === 0 ? null : committer;
  return { author: a, committer: c ?? a };
}

/**
 * The commits of `base..head`, oldest first, each with the paths it is judged
 * for.
 *
 * `judged` narrows the per-path work a MERGE costs: git's dense combined diff
 * has to be asked for one path at a time (see below), and asking it about every
 * file a large merge touched would be a git invocation per file for no verdict.
 * A non-merge commit's path list is not narrowed at all, so the guard still
 * reports exempt paths and still sees everything it might protect.
 *
 * The two-step merge question is not an optimization, it is correctness.
 * `git log -c --name-only` lists the files "modified from all parents", which
 * OVER-reports: at PR #427's merge `e66ba9e` it lists `SPEC.md`, whose result
 * differs from both parents as a blob while every hunk of it came verbatim from
 * one side. The dense (`--cc`) rendering is the one that drops hunks a parent
 * already carried, and a path whose dense rendering is empty invented nothing.
 * So each candidate is re-asked with a per-path `--cc` patch, and passing the
 * path as a pathspec rather than parsing it out of a `diff --cc` header keeps
 * quoted and unusual filenames out of the parser entirely.
 */
export function listCommits(
  read: GitReader,
  base: string,
  head: string,
  judged: (path: string) => boolean,
): { ok: true; commits: JudgedCommit[] } | { ok: false; message: string } {
  const log = read([
    "log",
    "--reverse",
    `--pretty=format:${RS}%H${FS}%P${FS}%aI${FS}%cI`,
    "--name-only",
    `${base}..${head}`,
  ]);
  if (log === null) {
    return { ok: false, message: `\`git log ${base}..${head}\` failed` };
  }

  const commits: JudgedCommit[] = [];
  for (const chunk of log.split(RS)) {
    const lines = chunk.split("\n").filter((line) => line.length > 0);
    const header = lines.shift();
    if (header === undefined) continue;
    const [sha, parents, authored, committed] = header.split(FS);
    if (sha === undefined || sha.length === 0) continue;
    const parentList = (parents ?? "")
      .split(" ")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const commit: JudgedCommit = {
      sha,
      parents: parentList,
      ts: datesOf(authored, committed),
      // `--name-only` reports nothing for a merge; the dense pass below fills it.
      changedPaths: parentList.length > 1 ? denseCombinedPaths(read, sha, judged) : lines,
    };
    commits.push(commit);
  }
  return { ok: true, commits };
}

/**
 * The guarded paths a merge commit's result carries that no parent carried:
 * the merge's own work, which is what an evil merge is made of.
 *
 * EXPORTED because arm A of `core/dark-session.ts` asks the same question of a
 * merge it finds on main (APRV-374), and two implementations of "what did this
 * merge invent" would be two things to keep in step — the disagreement APRV-369
 * was filed about. The observer there lists a window rather than a range, so it
 * cannot reuse {@link listCommits}; it reuses this.
 *
 * The two-step shape is the correctness (see {@link listCommits}): `-c
 * --name-only` gives candidates and over-reports, and the per-path `--cc` patch
 * is the discriminator, empty for every merge whose every hunk came from a
 * parent verbatim.
 */
export function denseCombinedPaths(
  read: GitReader,
  sha: string,
  judged: (path: string) => boolean,
): string[] {
  const listed = read(["log", "-1", "-c", "--name-only", "--pretty=format:", sha]);
  if (listed === null) return [];
  const dense: string[] = [];
  for (const line of listed.split("\n")) {
    const path = line.trim();
    if (path.length === 0 || !judged(path)) continue;
    const patch = read(["log", "-1", "--cc", "--pretty=format:", sha, "--", path]);
    if (patch !== null && patch.trim().length > 0) dense.push(path);
  }
  return dense;
}

/**
 * The git-dependent half of a {@link GuardInput}, for one commit.
 *
 * Everything here reads a COMMIT's tree and never the working tree, for the
 * reason the CI guard's header gives: a guard that read the checkout could be
 * told a different story than the one the commit carries.
 */
export interface CommitGuardParts {
  blobsFor: (path: string) => ChangeBlobs | null;
  /**
   * SHA-256 of a path's bytes at THIS commit.
   *
   * NOT what the `attested` verdict is fed. Whole-file evidence is matched at
   * the RANGE head ({@link digestsAt}), for the reason stated there; this stays
   * because a caller judging a single commit as its own range has the same
   * head, and because it is the natural thing for a caller to want.
   */
  sha256At: (path: string) => string | null;
  /** This commit's own date pair, whatever path is asked about (APRV-339). */
  changeTsFor: (path: string) => ChangeTimestamps;
  /** Short base and head labels for the finding text. */
  window: { base: string; head: string };
}

export function commitGuardInputParts(
  read: GitReader,
  commit: { sha: string; parents?: readonly string[]; ts: ChangeTimestamps },
): CommitGuardParts {
  const parents = commit.parents;
  const baseRev =
    parents !== undefined && parents.length === 0 ? null : `${commit.sha}^1`;
  const blobCache = new Map<string, ChangeBlobs | null>();
  const digestCache = new Map<string, string | null>();

  const inTree = (rev: string, path: string): boolean => {
    const listed = read(["ls-tree", "--name-only", rev, "--", path]);
    return listed !== null && listed.trim().length > 0;
  };
  const show = (rev: string, path: string): string | null => read(["show", `${rev}:${path}`]);

  return {
    blobsFor: (path) => {
      const cached = blobCache.get(path);
      if (cached !== undefined) return cached;
      const baseHas = baseRev !== null && inTree(baseRev, path);
      const headHas = inTree(commit.sha, path);
      const baseText = baseHas && baseRev !== null ? show(baseRev, path) : null;
      const headText = headHas ? show(commit.sha, path) : null;
      // A blob git cannot show, or one with a NUL byte in it, answers null and
      // the guard fails the path `change-unreadable` rather than falling back
      // to the path-level rule. The fallback is the hole (APRV-202).
      const unreadable =
        (baseHas && baseText === null) ||
        (headHas && headText === null) ||
        (baseText !== null && baseText.includes(" ")) ||
        (headText !== null && headText.includes(" "));
      const value: ChangeBlobs | null = unreadable ? null : { base: baseText, head: headText };
      blobCache.set(path, value);
      return value;
    },
    sha256At: (path) => {
      const cached = digestCache.get(path);
      if (cached !== undefined) return cached;
      const blob = show(commit.sha, path);
      const value = blob === null ? null : sha256Hex(blob);
      digestCache.set(path, value);
      return value;
    },
    changeTsFor: () => commit.ts,
    window: {
      base: baseRev === null ? "(root)" : `${commit.sha.slice(0, 12)}^1`,
      head: commit.sha.slice(0, 12),
    },
  };
}

/**
 * SHA-256 of any path's bytes AT ONE REVISION, cached.
 *
 * ## Why whole-file evidence is matched at the range head and not per commit
 *
 * The two kinds of evidence answer different questions, so they are anchored to
 * different things:
 *
 * - A GRANT binds a hunk — a before-state, an after-state, a human who was
 *   shown them — so it is evidence about ONE COMMIT and is matched per commit,
 *   which is what APRV-375 is about.
 * - A SIGN-OFF (`gate.path.signed_off`, APRV-338), an ORGAN attestation
 *   (`gate.organ.attested`, APRV-272) and the POLICY attestation
 *   (`policy.updated`) are whole-file records: a human read the file AS IT NOW
 *   STANDS and ratified those exact bytes. What they are about is the bytes the
 *   pull request INSTALLS, which is the blob at the range head.
 *
 * Matching them per commit would have quietly repealed the escape hatch. A
 * two-commit branch whose first commit has no grant could no longer be rescued
 * by a sign-off at head, because the intermediate blob is not the ratified one;
 * a policy amendment split over two commits would fail on the first. So every
 * commit in a range is offered the digests at the range head, whatever its own
 * blob hashes to. The ordering APRV-338 asked for is untouched: the evaluator
 * reaches the sign-off only after every grant search has failed, so hunk
 * evidence still leads the reasons wherever it exists.
 */
export function digestsAt(read: GitReader, rev: string): (path: string) => string | null {
  const cache = new Map<string, string | null>();
  return (path) => {
    const cached = cache.get(path);
    if (cached !== undefined) return cached;
    const blob = read(["show", `${rev}:${path}`]);
    const value = blob === null ? null : sha256Hex(blob);
    cache.set(path, value);
    return value;
  };
}

/** Why a commit was not judged. */
export type CommitSkipReason = "no-guarded-path" | "clean-merge";

/** One commit's verdict. */
export interface CommitVerdict {
  sha: string;
  /** The revision it was judged against: its first parent, or `null` at a root. */
  base: string | null;
  merge: boolean;
  /** `false` when nothing about this commit needed evidence. */
  judged: boolean;
  skipped: CommitSkipReason | null;
  ok: boolean;
  findings: readonly GuardFinding[];
  exempt: readonly string[];
  /** Every record seq that covered a passing finding here, in report order. */
  covered: readonly number[];
}

/** A finding, carrying the commit it was reached on. */
export type CommitFinding = GuardFinding & { commit: string };

export interface CommitGuardReport {
  /** The conjunction: every judged commit passed. */
  ok: boolean;
  /** Every commit in `base..head`, oldest first. */
  commits: readonly CommitVerdict[];
  /** Every judged commit's findings, in commit order, each naming its commit. */
  findings: readonly CommitFinding[];
  /** The union of the exempt paths the judged commits reported. */
  exempt: readonly string[];
  /** The pull request's own range, for the report heading. */
  window: LogWindow;
  /** Non-null when git could not be asked; the caller cannot look. */
  unavailable: string | null;
}

/** Everything a {@link GuardInput} carries that is not per-commit. */
export type SharedGuardInput = Omit<
  GuardInput,
  | "changedPaths"
  | "blobsFor"
  | "organSha256AtHead"
  | "pathSha256AtHead"
  | "policySha256AtHead"
  | "changeTsFor"
  | "window"
> & { window: LogWindow };

/**
 * Judge every commit of `base..head` on its own records, and report the
 * conjunction.
 *
 * `evaluateProtectedPaths` is unchanged and is what decides each commit: this
 * function chooses the unit and nothing else. A commit that changed no guarded
 * path costs one evaluator call that finds nothing, and a clean merge costs no
 * evaluator call at all.
 */
export function judgeCommits(options: {
  read: GitReader;
  base: string;
  head: string;
  shared: SharedGuardInput;
}): CommitGuardReport {
  const { read, base, head, shared } = options;
  const empty = {
    ok: false,
    commits: [] as CommitVerdict[],
    findings: [] as CommitFinding[],
    exempt: [] as string[],
    window: shared.window,
  };
  const listed = listCommits(read, base, head, (path) =>
    isJudgedPath(path, shared),
  );
  if (!listed.ok) return { ...empty, unavailable: listed.message };

  // Whole-file evidence is about the bytes this pull request INSTALLS, so it is
  // matched at the RANGE head for every commit in the range. See {@link digestsAt}.
  const atRangeHead = digestsAt(read, head);
  const policySha256AtHead = atRangeHead(shared.policyPath);

  const commits: CommitVerdict[] = [];
  const findings: CommitFinding[] = [];
  const exempt = new Set<string>();
  for (const commit of listed.commits) {
    const merge = isMerge(commit);
    const baseRev = baseRevOf(commit);
    if (commit.changedPaths.length === 0) {
      commits.push({
        sha: commit.sha,
        base: baseRev,
        merge,
        judged: false,
        skipped: merge ? "clean-merge" : "no-guarded-path",
        ok: true,
        findings: [],
        exempt: [],
        covered: [],
      });
      continue;
    }
    const parts = commitGuardInputParts(read, commit);
    const report: GuardReport = evaluateProtectedPaths({
      ...shared,
      policySha256AtHead,
      changedPaths: [...commit.changedPaths].sort(),
      blobsFor: parts.blobsFor,
      organSha256AtHead: atRangeHead,
      pathSha256AtHead: atRangeHead,
      changeTsFor: parts.changeTsFor,
      window: { ...shared.window, base: parts.window.base, head: parts.window.head },
    });
    for (const path of report.exempt) exempt.add(path);
    for (const finding of report.findings) findings.push({ ...finding, commit: commit.sha });
    const covered: number[] = [];
    for (const finding of report.findings) {
      if (!finding.ok) continue;
      for (const seq of finding.coveredBy ?? (finding.seq === undefined ? [] : [finding.seq])) {
        if (!covered.includes(seq)) covered.push(seq);
      }
    }
    const nothingToJudge = report.findings.length === 0 && report.exempt.length === 0;
    commits.push({
      sha: commit.sha,
      base: baseRev,
      merge,
      judged: !nothingToJudge,
      skipped: nothingToJudge ? (merge ? "clean-merge" : "no-guarded-path") : null,
      ok: report.ok,
      findings: report.findings,
      exempt: report.exempt,
      covered,
    });
  }

  return {
    ok: commits.every((commit) => commit.ok),
    commits,
    findings,
    exempt: [...exempt],
    window: shared.window,
    unavailable: null,
  };
}

/**
 * Would the guard have an opinion about this path?
 *
 * Only used to keep the merge pass cheap, so it is deliberately the PERMISSIVE
 * side of the question: the policy's widening entries plus the built-in set,
 * which is what `isGuardedPath` asks. A path this answers `true` for still has
 * to earn its verdict from the evaluator.
 */
function isJudgedPath(path: string, shared: SharedGuardInput): boolean {
  return isGuardedPath(path, shared.policyProtectedPaths);
}

/** The report as the lines CI prints. Pure. */
export function renderCommitGuardReport(report: CommitGuardReport): string {
  const lines: string[] = [];
  const judged = report.commits.filter((commit) => commit.judged);
  lines.push(
    `protected-path guard: ${report.window.base}..${report.window.head}, judged one commit at a time (${String(
      report.commits.length,
    )} commit(s) in the range, ${String(judged.length)} with a protected change)`,
  );
  if (report.unavailable !== null) {
    lines.push(`  the guard could not look: ${report.unavailable}`);
    return `${lines.join("\n")}\n`;
  }
  if (report.exempt.length > 0) {
    lines.push(
      `  exempt (the daemon's own append surface, evidence rather than a protected write): ${report.exempt.join(", ")}`,
    );
  }
  if (report.commits.length === 0) {
    lines.push("  no commits in the range");
    return `${lines.join("\n")}\n`;
  }
  for (const commit of report.commits) {
    const sha = commit.sha.slice(0, 12);
    const against = commit.base === null ? "a root commit" : `base ${sha}^1`;
    if (!commit.judged) {
      const why =
        commit.skipped === "clean-merge"
          ? "merge, and its result on every guarded path is one parent's bytes verbatim"
          : "no protected path changed";
      lines.push(`  SKIP ${sha} (${against}): ${why}`);
      continue;
    }
    const covered =
      commit.covered.length === 0
        ? ""
        : `, covered by seq ${commit.covered.slice(0, 8).join(", ")}${
            commit.covered.length > 8 ? ", …" : ""
          }`;
    lines.push(
      `  ${commit.ok ? "PASS" : "FAIL"} ${sha} (${against})${commit.merge ? ", merge resolution" : ""}${covered}`,
    );
    for (const finding of commit.findings) {
      lines.push(
        finding.ok
          ? `    PASS ${finding.path} [${finding.evidence}]`
          : `    FAIL ${finding.path} [${finding.code}]`,
      );
      lines.push(`         ${finding.detail}`);
    }
  }
  if (judged.length === 0) lines.push("  no protected paths changed");
  return `${lines.join("\n")}\n`;
}
