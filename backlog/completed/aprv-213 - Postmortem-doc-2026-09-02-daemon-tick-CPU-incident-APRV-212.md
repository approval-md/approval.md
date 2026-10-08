---
id: APRV-213
title: 'Postmortem doc: 2026-09-02 daemon tick CPU incident (APRV-212)'
status: Done
assignee:
  - 'agent:claude-code'
created_date: '2026-09-02 09:26'
updated_date: '2026-09-02 10:16'
labels: []
dependencies: []
references:
  - APRV-212
  - APRV-188
  - APRV-187
  - docs/postmortem-2026-08-31-hook-cpu.md
type: docs
ordinal: 176000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Write docs/postmortem-2026-09-02-daemon-tick-cpu.md in the shape of docs/postmortem-2026-08-31-hook-cpu.md (APRV-187): headline numbers before/after, impact, root cause, what was ruled out, the fix, learnings, remaining risk, verification trail. The incident is APRV-212: the daemon's own tick pinned a core against a 10k-record log (7m05s CPU in 8m34s wall, %CPU samples 0/47/96/84/91/14, 6.8 MB log, 10,364 records of which 9,425 execution.started, ~20 hook appends/min from concurrent sessions, 206 task files, 249 payloads). APRV-188 is the prior fix that did not cover this path: it moved hooks behind the daemon's snapshot and its per-read publication is one of the costs. Include the per-phase timing table from APRV-212's profile and the explicit self-feed verdict (snapshot into the watched log directory: yes; QUEUE.md: no).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 docs/postmortem-2026-09-02-daemon-tick-cpu.md exists with headline before/after table, impact, root cause, ruled-out list, fix, learnings, remaining risk, verification trail
- [x] #2 It links APRV-212 as the incident and APRV-188 (and APRV-186/187) as the prior fix that did not cover this path, with the measured numbers from the report
- [x] #3 The self-feed question is answered explicitly with the mechanism named
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Wait for APRV-212's before/after per-phase table and self-wake confirmation. 2. Write docs/postmortem-2026-09-02-daemon-tick-cpu.md in the APRV-187 shape. 3. Link from the APRV-212 notes; land in the same PR as its own commit.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Written from APRV-212's before/after profiles (synthetic 10k fixture with the live mix; the live log is human-only to copy). Table: 2,926 -> 208 ms per tick steady state, 210 -> 5 reads, supervisedExecutions 3,313 -> 18 ms, self-wake 18 -> 1 ticks in 45 s. Self-feed answered explicitly: the verified-head snapshot rename into the watched log directory; QUEUE.md ruled out.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
docs/postmortem-2026-09-02-daemon-tick-cpu.md in the APRV-187 shape: headline table, impact, root cause (per-task-file reads, snapshot publish into the watched dir, quadratic audit scan), ruled-out list, fix, learnings, remaining risk, verification trail; links APRV-212, APRV-188 and APRV-186/187.
<!-- SECTION:FINAL_SUMMARY:END -->
