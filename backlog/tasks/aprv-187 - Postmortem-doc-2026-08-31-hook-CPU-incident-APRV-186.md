---
id: APRV-187
title: 'Postmortem doc: 2026-08-31 hook CPU incident (APRV-186)'
status: Done
assignee:
  - 'agent:claude-code'
created_date: '2026-09-01 02:52'
updated_date: '2026-09-01 02:53'
labels: []
dependencies: []
type: docs
ordinal: 162000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter asked for a written record of the hook CPU-spinning incident: headline numbers, root cause, what was ruled out, and the learnings, so the incident's evidence outlives the session that found it. Lives in docs/ beside the other runbooks.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 docs/ contains a postmortem with the measured before/after numbers (cold read ~100s -> ~80ms, load-68 incident context)
- [x] #2 It names the root cause (per-record Ajv rebuild in the chain walk x one-shot hook processes) and what was ruled out (the wait loop)
- [x] #3 It records the remaining risk (cold walk still scales with log length) and the proposed follow-up
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Write docs/postmortem-2026-08-31-hook-cpu.md from the APRV-186 investigation evidence; PR it from a fresh branch off origin/main.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Written from the APRV-186 evidence: benchmark table, ruled-out section (wait loop + read cache), three-factor root cause, five learnings, daemon-served-reads follow-up. Numbers copied from the recorded bench output, and no new claims beyond what APRV-186 verified.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
docs/postmortem-2026-08-31-hook-cpu.md added with headline numbers (cold read 90.9-116.7s -> 68-118ms, load-68 impact) and learnings; PR from docs/hook-cpu-postmortem branch.
<!-- SECTION:FINAL_SUMMARY:END -->
