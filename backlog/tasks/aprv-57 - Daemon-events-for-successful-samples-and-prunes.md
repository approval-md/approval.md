---
id: APRV-57
title: Daemon events for successful samples and prunes
status: To Do
assignee: []
created_date: '2026-08-17 15:51'
labels: []
dependencies: []
priority: low
type: feature
ordinal: 56000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
APRV-40 and APRV-41 deliberately emitted no DaemonEvent on a successful audit.sampled or payload.pruned append, to keep the frozen DaemonEvent union untouched inside their one-hook file boundary. Operators running approval daemon run --json therefore see failures for those subsystems but not successes. Add sampled and pruned event variants to the union additively, pinned by tests, rendered by cli/daemon.ts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 DaemonEvent union gains sampled and pruned variants additively, pinned by a test
- [ ] #2 approval daemon run --json emits one line per successful sample and per successful prune
<!-- AC:END -->
