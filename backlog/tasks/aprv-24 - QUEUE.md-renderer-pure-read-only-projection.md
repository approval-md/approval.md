---
id: APRV-24
title: 'QUEUE.md renderer: pure read-only projection'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 10:50'
updated_date: '2026-08-05 15:32'
labels: []
milestone: m-5
dependencies:
  - APRV-22
priority: medium
type: feature
ordinal: 24000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC section 9.1: .approval/QUEUE.md is a rendered, read-only markdown view of pending requests (task, actions, declared effects, cost, TTL countdown) plus the sampled-audit backlog, regenerated whole on every relevant event — the screenshot, never the truth. Human-settled (2026-08-05): regenerated whole from the log, read-only, marked as such in a file header, with byte-identical output proven from identical logs. B3 applies: computed and claimed fields visibly distinguished using the APRV-22 tagging. TTL countdown must not break determinism: rendering takes the evaluation timestamp as an input (the caller supplies now), so identical log + identical timestamp = identical bytes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 approval render regenerates .approval/QUEUE.md whole from the log: pending requests with task, actions, declared effects, cost, TTL countdown, plus the audit backlog section
- [x] #2 The file opens with a header marking it a generated read-only projection that must never be edited (the log is the truth)
- [x] #3 A test proves byte-identical output from identical logs at an identical evaluation timestamp (the timestamp is an explicit input, never read ambiently in core)
- [x] #4 Computed and claimed fields are visibly distinguished per B3 using the APRV-22 tagging
- [x] #5 The renderer never writes anything except QUEUE.md and never modifies the log, covered by tests
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented by Opus subagent in isolated worktree; fable review found nothing to override. Placement: src/channels/ (display layer; core must not import channels), third consumer of tagging.ts so QUEUE.md cannot disagree with the gate. Flagged design choices, both accepted and surfaced to the human in the m-4 report: (1) no full payload in the queue (collects no decision; would put every pending body/argv into a world-readable regenerated file; carries payload_hash + pointer to decision channels per section 10.4); (2) consequence: manual requests whose material the CLI does not hold are listed in a could-not-summarize section, never dropped, since tagging.ts refuses manual without material and no payload store exists in v0.1 — follow-up proposed (payload store per spec, or summary-only tagging mode), guard NOT weakened. Forged-marker defense tested (claimed summary containing a computed line neutralized). Byte-determinism with now as explicit input. Merge note: help.ts conflicted with APRV-23 (both append constants); resolved keeping both, one missing template terminator fixed by fable. Verified on merged tree: 754 total tests pass, lint, typecheck.

Date corrected in place per the 2026-08-05 human ruling (log-is-authoritative, applied to all APRV-46 findings): prose previously claimed 2026-08-08; this task's own created_date (2026-08-05) is the cited source. The wrong date was orchestrator confabulation, part of the systematic drift reported in APRV-46.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
src/channels/render-queue.ts + approval render: deterministic read-only QUEUE.md projection (byte-identical at identical log+now), B3-marked rendering with forged-marker defense, could-not-summarize listing for material-less manual requests, atomic single-file writes. 25 tests. Verified on merged tree with lint and typecheck green.
<!-- SECTION:FINAL_SUMMARY:END -->
