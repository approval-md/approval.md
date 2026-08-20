---
id: APRV-129
title: >-
  Recovery refusals read like runbooks: sectioned push-rejected output, one
  command per line, no reset --hard
status: Done
assignee: []
created_date: '2026-08-20 19:23'
updated_date: '2026-08-20 20:58'
labels:
  - cli
  - ux
milestone: m-12
dependencies: []
priority: high
ordinal: 121000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
2026-08-20, from the human after the first live push-rejected refusal (APRV-111's loud failure, working as intended): 'i zoned out seeing all those run-on sentences and just focused on the word REJECTED'. The refusal was correct and complete and unreadable: one paragraph carrying the remote's error, the local state, the recovery commands, and the merge-commit rationale as run-on prose. A refusal that must be READ AND ACTED ON is a runbook, and the CLI already has the register for it (the token panel, doctor's line-per-check).

Restructure the human-facing output of push-rejected (and audit the other multi-step recovery refusals in amend.ts and execute.ts for the same shape):
- A short headline naming what happened (the remote refused the push).
- A YOUR STATE section: three or four short lines (committed locally on main, not on origin, origin holds the previous policy, attested seq N).
- A NEXT STEPS section: numbered, ONE runnable command per line, no prose between command and its effect beyond a trailing comment. The merge-commit rationale compresses to one line with a docs pointer instead of an inline essay.
- Remove git reset --hard origin/main from the recovery entirely: with an uncommitted working log it rewinds events.jsonl under the daemon (the fork-2 mechanism). Until APRV-125's log sync exists, the recovery ends with 'pull with the log set aside; docs/dogfood-cutover.md shows the safe sequence' rather than a destructive command.
- The refusal code, exit code, and --json shape are frozen API and do not change; this is the human rendering only. docs/cli-reference.md transcript updated.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 push-rejected renders headline, YOUR STATE, and numbered NEXT STEPS with one runnable command per line; test asserts the structure
- [x] #2 reset --hard appears nowhere in any recovery output; the log-safe sequence is pointed to instead
- [x] #3 Machine surface unchanged: same refusal code, exit code, and --json fields, pinned by existing tests
- [x] #4 Other multi-step recovery refusals audited; any reshaped ones listed in the notes
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Merged as PR 112 (branch aprv-129-recovery-refusals). Six recovery sites in amend.ts reshaped into the runbook register (headline, quoted remote stderr indented, YOUR STATE in 3-4 short lines, NEXT STEPS numbered with one runnable command per line, one-line rationale with docs pointer): both push-rejected flows, pr-failed, and three git-failed cases that previously said 'run the printed commands' without printing them (a shared gitFailed closure now prints exactly the commands still owed, sliced past what already ran). execute.ts audited: its failures are single-fact one-liners with no runbook shape to take, left alone. git reset --hard removed from every recovery surface (human and JSON) and replaced with the log-safe pull pointer to docs/dogfood-cutover.md, because a hard reset rewinds the uncommitted working log under the daemon (the fork-2 mechanism); non-recovery mentions (classifier comments, rewrite-detection fixtures) deliberately kept. Machine surface frozen: same codes, exit 4, same --json fields, pinned. Structure survives NO_COLOR and APPROVAL_ASCII, tested. The runbook() helper landed reusable, which APRV-130 consumed the same evening as its fallback. +9 tests.
<!-- SECTION:NOTES:END -->
