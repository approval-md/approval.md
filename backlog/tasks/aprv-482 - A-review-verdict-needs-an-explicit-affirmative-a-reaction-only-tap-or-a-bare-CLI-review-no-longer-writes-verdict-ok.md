---
id: APRV-482
title: >-
  A review verdict needs an explicit affirmative: a reaction-only tap or a bare
  CLI review no longer writes verdict ok
status: To Do
assignee: []
created_date: '2026-10-05 06:51'
labels:
  - agentvillage
dependencies: []
priority: high
ordinal: 367000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Supervised-retro core piece (in scope for Oct 11). Today a bare reaction or a CLI review with no verdict can write verdict ok, which would count as individual approval without an affirmative act. Require an explicit form per channel.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Bare paths (reaction-only tap, bare CLI review) are refused with a named code and write no verdict
- [ ] #2 The explicit forms are documented per channel
- [ ] #3 A test per channel covers the refusal and the explicit form
<!-- AC:END -->
