---
id: APRV-423
title: >-
  Daemon TTL below the harness cap: approval.expired lands before the harness
  blocks on its own timeout
status: To Do
assignee: []
created_date: '2026-09-21 06:42'
labels:
  - daemon
  - hook
  - ttl
dependencies: []
priority: medium
ordinal: 324000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Harness hooks bound the wait: Hermes caps a pre_tool_call entry at 300 seconds (docs/hermes-hook.md), Claude Code and Cursor have their own ceilings. When the harness times out first, the hook returns a block while the request is still pending on the phone, and a later tap becomes a grant on a call nobody holds (the shape APRV-410 describes from the retry side). Add a per-request TTL derived from the harness cap, so the daemon expires the request and appends approval.expired before the harness gives up, and the two records agree. The hook knows its harness and can pass the cap; the daemon takes the smaller of the policy TTL and the harness-derived one.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A hook-originated request carries the harness cap; the daemon's TTL for it is the smaller of policy TTL and cap minus a documented margin
- [ ] #2 In a test with a fake clock the daemon appends approval.expired strictly before the harness cap elapses, and the hook's block message names the expiry
- [ ] #3 A tap arriving after expiry is refused with the existing code for a request no longer pending and never becomes a grant
- [ ] #4 docs/hermes-hook.md and docs/claude-code-hook.md state the effective window
<!-- AC:END -->
