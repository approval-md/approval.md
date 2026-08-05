---
id: APRV-24
title: 'QUEUE.md renderer: pure read-only projection'
status: To Do
assignee: []
created_date: '2026-08-05 10:50'
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
SPEC section 9.1: .approval/QUEUE.md is a rendered, read-only markdown view of pending requests (task, actions, declared effects, cost, TTL countdown) plus the sampled-audit backlog, regenerated whole on every relevant event — the screenshot, never the truth. Human-settled (2026-08-08): regenerated whole from the log, read-only, marked as such in a file header, with byte-identical output proven from identical logs. B3 applies: computed and claimed fields visibly distinguished using the APRV-22 tagging. TTL countdown must not break determinism: rendering takes the evaluation timestamp as an input (the caller supplies now), so identical log + identical timestamp = identical bytes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval render regenerates .approval/QUEUE.md whole from the log: pending requests with task, actions, declared effects, cost, TTL countdown, plus the audit backlog section
- [ ] #2 The file opens with a header marking it a generated read-only projection that must never be edited (the log is the truth)
- [ ] #3 A test proves byte-identical output from identical logs at an identical evaluation timestamp (the timestamp is an explicit input, never read ambiently in core)
- [ ] #4 Computed and claimed fields are visibly distinguished per B3 using the APRV-22 tagging
- [ ] #5 The renderer never writes anything except QUEUE.md and never modifies the log, covered by tests
<!-- AC:END -->
