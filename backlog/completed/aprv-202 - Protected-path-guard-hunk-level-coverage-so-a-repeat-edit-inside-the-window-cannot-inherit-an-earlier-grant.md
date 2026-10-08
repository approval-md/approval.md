---
id: APRV-202
title: >-
  Protected-path guard: hunk-level coverage, so a repeat edit inside the window
  cannot inherit an earlier grant
status: Done
assignee:
  - 'agent:opus-lane-q'
created_date: '2026-09-01 22:04'
updated_date: '2026-09-02 08:57'
labels:
  - security
  - ci
  - gate
dependencies:
  - APRV-151
priority: high
ordinal: 166000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
APRV-151 shipped the CI guard with a stated weakest joint: evidence is path-level plus a 7-day recency bound either side of the change commit, so a second edit to the same protected path inside the window inherits the first edit's grant. Observed on 2026-09-01 on the very PR that introduced the guard job (PR #187): its CI workflow and spec edits, granted at seq 7282 that afternoon, were passed by the guard on the strength of seq 2787 (2026-08-30, a different ci.yml edit in another worktree) and seq 4576 (2026-09-01 01:57, a different spec edit), because both sat within 7 days. The verdict was correct and the reason was wrong, and a grantless edit to either path this week would have passed the same way. Fix: trace every added or removed hunk of a protected path in base..head to the bound material of some grant (the after/content bytes of a file-tool grant, or the bytes a granted command wrote, where the payload store carries them), and pass a path only when its hunks are covered; keep attested (content-level) as is; keep the path-level match as diagnosis, never as a verdict. Interaction with the ordering rule (the log advance carrying the grant must merge before or with the PR) is unchanged.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A protected path passes only when every hunk in base..head is covered by the bound material of a grant in the committed log; a repeat edit inside the window with no grant of its own fails no-evidence, pinned by a test built through the real append path
- [x] #2 Attested verdict unchanged; path-level matches appear in failure diagnosis only
- [x] #3 Replayed against the real committed log, PR #187's changes pass only via seq 7282 (the granted script run) and fail if that grant is removed from the window
- [x] #4 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Give the pure core the CHANGE, not only the path: new GuardInput.blobsFor(path) -> {base, head} | null, read at both commits by the script (git show <ref>:<path>), null for unreadable/binary.
2. Line-level hunks: added = multiset(head lines) - multiset(base lines), removed = the converse. A blob that differs with identical multisets (a pure reordering) counts as one uncovered hunk rather than as no change, so a reorder cannot pass on an empty diff.
3. File-tool coverage from the bound material (APRV-124 shapes): {before,after} covers the added lines contained in 'after' only when 'after' occurs verbatim in the head blob, and the removed lines contained in 'before' only when 'before' occurs in the base blob; {content} equal to the head blob covers the path outright, and otherwise contributes its lines only if it occurs in head; the {input} fallback shape carries no material and covers nothing (diagnosis only).
4. Command coverage: a payload cannot describe hunks, so a granted command covers the whole path only when (a) classifyCommand still says a segment writes this path, (b) the log carries an execution.started (and completed, when present) for that grant's action_key, and (c) that execution sits within a NEW, much tighter attribution window (DEFAULT_COMMAND_ATTRIBUTION_MS, 6h) of the change commit. The finding names which command run it attributed the change to.
5. Coverage may be assembled from several grants; the headline stays strongest-then-nearest (granted-file before granted-command, then distance), and the detail lists every contributing seq.
6. New failure codes, appended to GUARD_FAILURE_CODES (nothing renamed, APRV-192 reads the existing names): 'uncovered-hunk' when grants DO name the path in the window but some added or removed line is traced to no granted material, and 'change-unreadable' when the blobs could not be read so coverage could not be established. 'no-evidence' keeps its meaning (nothing names the path at all). Path-level matches drop to diagnosis on both.
7. attested is untouched: content-level, no hunk analysis, no recency bound.
8. Fixtures through the real append path: repeat edit (two edits, one grant) fails uncovered-hunk; the exact edit passes; a Write whose content equals head passes; the command batch passes on its own grant and a later unrelated edit to the same path fails; the reorder case fails.
9. Script side: blobsFor via showBlob at base and head, NUL-byte detection for binary.
10. Replay against the real committed log in this worktree (never the primary checkout): PR #187's range, with and without seq 7282 in the window.
11. Docs: the guard section of docs/claude-code-hook.md and the doctor row text in docs/cli-reference.md. Draft the SPEC wording in the notes flagged pending sign-off.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What was built

Hunk-level coverage in the CI grant cross-check. The guard used to ask 'was this path granted in the last seven days'; it now asks 'is this change made of granted material'. The window survives as a cheap pre-filter in front of the real question.

### The core (src/core/protected-path-guard.ts)

- New required input `blobsFor(path) -> {base, head} | null`, the path's bytes at both commits. The change is reduced to the SUBSTANTIVE lines added and removed (multiset difference over non-blank lines). Bytes that differ while the line multiset does not are a REORDERING and count as one uncovered hunk, so a rewrite that only moves paragraphs cannot pass on a diff that looks empty. A change that alters no substantive line (whitespace, a mode bit) has no hunk to cover, and there the pre-APRV-202 rule still stands: a naming grant inside the window is the evidence. That is the only surviving path-level pass and it is narrow by construction.
- `granted-file` became hunk-level. The bound material (APRV-124 shapes) is anchored before it covers anything: the granted `after` must occur verbatim in the blob at head, the granted `before` in the blob at base, and each covers the lines it contains. A Write whose `content` equals the head blob covers the path outright; one that is neither equal to nor contained in head covers nothing (all or nothing, since it describes a whole file). The `{input}` fallback shape binds no bytes and covers nothing.
- `granted-command` became attributed rather than covered, on three tests, because a command payload describes no bytes. (1) The write lands on THIS checkout's copy of the path: `cwd` joined with the repository-relative path must equal the word the classifier matched. (2) The grant was SPENT: an `execution.started` for its `action_key` (what `consumeHarnessGrant` and `approval run` append). (3) That run sits within six hours of the change commit and does not START after it. A command's effect follows its own execution.started, so a later run did not write an earlier commit; five minutes of grace covers clock skew between the log and git's author date.
- Coverage assembles across grants (one pull request may carry several approved edits to one file) and the finding lists every contributor. Ranking is unchanged (strongest, then nearest) with one addition: when the change RESTS on a command attribution, the finding leads with the attributing grant instead of a file grant that covered a line or two. That is the same 'true verdict, misleading reason' failure APRV-151 fixed once.

### New codes

`GUARD_FAILURE_CODES` gains two, appended (nothing renamed; APRV-192 reads the existing names, and the three `EvidenceKind` verdicts are untouched):

- `uncovered-hunk` — grants DO name the path in the window and some line traces to none of their material. Distinct from `no-evidence` because the reader's next move differs: `no-evidence` says nobody approved anything about this file and the question is whether the hook fired; `uncovered-hunk` says somebody approved something and it was not this, so take the change to the gate. The failure prints the uncovered lines and why each naming grant was set aside (capped at six reasons).
- `change-unreadable` — the blobs could not be read at both commits (git failed, or the blob is binary). Fails rather than falling back to the path-level rule, because the fallback is the hole.

### Proof runs against the real committed log

Replayed with the pure core over PR #187's range (73c9fea..956d0b4), reading records and payloads from the log at `origin/main` (seq 1..8379). #187's own head carries the log only to seq 5977, so its own tree cannot see the grant that authorized it; that is the log-lag ordering rule rather than a coverage question, and the guard says so.

- With the full log: both protected paths PASS, and both name **seq 7282** as the evidence, the granted `apply-wave1-all.mjs` run. `.github/workflows/ci.yml` coveredBy 2787, 7282; `SPEC.md` coveredBy 24 grants including 7282.
- With seq 7282 removed from the records: both paths FAIL `uncovered-hunk`. AC3 holds.

Two laundering channels showed up only in that replay, and both are now closed:

1. **Dry runs.** Three grants that would have carried #187's SPEC.md change wrote `$SCRATCH/dry/SPEC.md` in a temporary directory. Each classifies `policy.edit` on a path ending `SPEC.md`, and none touched the file the pull request changed. Command attribution now anchors the write to the recorded `cwd`.
2. **Later runs.** APRV-203 batches from 2026-09-02, four hours AFTER #187's commit, sat inside a symmetric six-hour window and would have carried it. Attribution now refuses a run that STARTS after the change commit (five minutes of skew grace).

A third thing the replay showed, worth the orchestrator's judgment: `ClassifiedSegment.path` holds ONE path and a batch names several, so 7282's argv reported `SPEC.md` and left `ci.yml` unattributed. The other words of a segment the classifier ALREADY called a protected write are now considered too, and only on the strict test (the word must resolve, against `cwd`, to exactly this checkout's copy of this path). A mention cannot pass that, and a non-granting segment is never scanned, so APRV-151's mention protections are intact.

### Invariants touched

SPEC section 11.1 invariant 1 (enforcement paths read only verified records) is unchanged and still holds: the caller hands the guard verified records or none, and the two log codes fire before any evidence is sought. No other global invariant is touched; the module still appends nothing, reads no clock and performs no IO.

**Draft SPEC amendment, section 11.1, for human sign-off — nothing was edited.**

> 10. **Evidence binds the change, not the name.** Where a surface accepts a log record as evidence that a human decided an action, the match is against the material the decision bound: the bytes of the payload, a digest of the content, or a spent execution inside its attribution window. The name of the thing acted on is never sufficient on its own. A grant for one edit to a file is not evidence for a later edit to the same file, and a grant for a copy of a file elsewhere is not evidence for this one (`tests/protected-path-guard.ts`). (Amended APRV-202, pending sign-off.)

### Decisions an orchestrator might overrule

- **Six hours for command attribution** (`DEFAULT_COMMAND_ATTRIBUTION_MS`), against seven days for the path pre-filter. A command grant has no bytes to check, so time is the whole attribution; a week of it re-opens the hole. A batch that legitimately spans longer is asked for a fresh approval.
- **Several qualifying command grants are allowed, and the nearest is reported**, rather than refusing when attribution is ambiguous. The task's wording ('attributable to ONE granted command … and reports which') reads either way; this is the less brittle reading, and the anchoring plus direction rules already cut the candidate set to the plausible ones.
- **Coverage is by line text, not by position.** A line whose exact text was approved counts wherever it landed. Position-sensitivity would fail every rebase and re-indent.
- **A change altering no substantive line still passes on a naming grant.** That is the one surviving path-level pass, for whitespace and mode changes; refusing it would fail changes that alter nothing a human could have read.
- **AC3 nuance.** #187's `ci.yml` is ALSO covered by seq 2787, a file grant whose after-state is literally the block that landed. That is content-level evidence and stronger than the path-level frame AC3 was written in; the pass still requires 7282, since without it neither path is fully covered.

AC4 evidence: full `npm test` on this branch is **2721 tests, 2720 pass, 0 fail, 1 skipped** (781s). Guard suite alone 31/31. `npm run lint` (oxlint src tests) clean; `npm run build` clean. The guard's own shipped script was exercised end to end over PR #187's range against this worktree's copy of the committed log.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The CI grant cross-check now asks whether the CHANGE was granted rather than whether the path ever was. src/core/protected-path-guard.ts takes the blobs at base and head, reduces the diff to the substantive lines added and removed, and requires each to trace to bound material: a file grant covers the lines its own before/after (or content) bytes contain, and only when those bytes are anchored to the blobs they claim; a command grant, which describes no bytes, is attributed on three tests (the write lands on this checkout's copy of the path, the grant was spent, and its run sits within six hours of the commit without starting after it). Coverage assembles across grants and the finding names every contributor, strongest and nearest first, leading with the attributing grant when the change rests on it. Two new failure codes, appended: uncovered-hunk (grants name the path, the change is not made of them) and change-unreadable (blobs unreadable, so no fallback to the path rule); the three EvidenceKind verdicts are untouched. Verified two ways: 31 guard tests, every log built through the real append path, pinning the repeat edit, the exact edit, whole-file writes, assembled coverage, reordering, the unreadable change, the command batch with its own run and the later edit that must not inherit it, an unspent grant, a run after the commit, and a dry-run copy; and a replay over PR #187's real range against the committed log at origin/main, where both protected paths pass naming seq 7282, the granted script run, and both fail uncovered-hunk when 7282 is removed. That replay is what caught two laundering channels the unit tests could not have invented: dry runs writing a scratch copy of SPEC.md, and an APRV-203 batch four hours after the commit. Full npm test 2721 tests / 2720 pass / 0 fail / 1 skipped; lint and build clean. Docs updated in docs/claude-code-hook.md (coverage, attribution, the two new codes) and the doctor row text; a section 11.1 invariant is drafted in the notes for human sign-off, and no protected file was edited.
<!-- SECTION:FINAL_SUMMARY:END -->
