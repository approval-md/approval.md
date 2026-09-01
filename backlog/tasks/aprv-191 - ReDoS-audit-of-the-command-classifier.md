---
id: APRV-191
title: ReDoS audit of the command classifier
status: To Do
assignee: []
created_date: '2026-09-01 03:15'
labels: []
dependencies: []
references:
  - docs/postmortem-2026-08-31-hook-cpu.md
  - src/core/command-class.ts
priority: high
type: task
ordinal: 166000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The command classifier (src/core/command-class.ts, plus the web/gh/npm refinements) runs on attacker-controlled command strings on every hook invocation, before anything is gated. If any regex there has catastrophic backtracking, a rogue agent could pin a core with a single small crafted command, a cheap asymmetric denial of service that is strictly worse than the O(log length) log-growth burn (APRV-186), since it needs no log growth and no concurrency. Audit every regex on the hook's synchronous classification path for super-linear behavior: the lexer/segmenter, PROTECTED_FILENAMES and path matching, the flag parsers, and each refine* function (refineWebFetch, refineGhApi, refineGh, refineNpmInstall, refineGitPush, refineRm, refineSed, refineApproval, etc.). Where a pattern is nested-quantifier or backtracking-prone, prove a bound (linear-time engine construction, atomic groups/possessive equivalents, input length caps, or rewrite), and add adversarial-input tests (pathological strings) asserting classification stays within a time budget. Fail-closed posture is preserved: an over-long or suspicious input should classify to the stricter path or be refused, never run an unbounded match. Security follow-up to APRV-186; see docs/postmortem-2026-08-31-hook-cpu.md (unverified corner).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Every regex on the hook's synchronous classify path is reviewed for catastrophic backtracking; findings (safe / bounded / rewritten) are recorded per pattern
- [ ] #2 Any super-linear pattern is bounded (rewrite, linear-time construction, or input-length cap) with the fix explained in the notes
- [ ] #3 Adversarial-input tests assert classification of pathological strings completes within a fixed time budget and yields a safe (stricter-or-refused) class
- [ ] #4 An over-long or unclassifiable command fails closed, never runs an unbounded match; npm test passes; lint clean
<!-- AC:END -->
