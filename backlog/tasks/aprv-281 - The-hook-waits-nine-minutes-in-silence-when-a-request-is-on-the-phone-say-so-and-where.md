---
id: APRV-281
title: >-
  The hook waits nine minutes in silence when a request is on the phone; say so
  and where
status: To Do
assignee: []
created_date: '2026-09-06 07:19'
labels:
  - hook
  - ux
dependencies: []
type: enhancement
ordinal: 207000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
When a hook-gated command resolves to manual or a live sample, the hook blocks for up to 540 s and only then prints hook-timeout. During that wait the agent and the human see nothing. Print one line to stderr the moment the request is appended: the action key, the class, the channel it went to, and that a decision on the phone releases it; and if no listener is consuming the channel (the daemon socket refuses, or the last decision on any channel is older than the TTL), say that too, since 2026-09-05 showed taps piling up unconsumed while the hook waited. Also shorten the default wait for classes the policy resolves autonomous but a loop escalation overrode (see the loop-escalation task).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A hook-gated manual request prints one stderr line naming key, class and channel before it waits
- [ ] #2 When the daemon socket refuses connections, the line says no listener is running and names approval up
- [ ] #3 tests/cli-hook.test.ts covers both lines
<!-- AC:END -->
