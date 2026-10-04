---
id: APRV-464
title: >-
  A pending request must survive the requester's own read-only calls: past the
  retry grace only a gated WRITE-class call withdraws it, or the grace equals
  the TTL
status: To Do
assignee: []
created_date: '2026-10-04 09:23'
labels:
  - ergonomics
dependencies: []
priority: high
ordinal: 351000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Evidence 2026-10-04: a network.call request for a git clone waited the hook's nine minutes, was denied into its five-minute retry grace, and was then withdrawn (approval.withdrawn, reason timeout) by the requester's next gated call, which was an autonomous read (a grep in a sweep). The human, who had just restarted the listener, found nothing to tap and the request had to be re-issued, twice. The withdrawal-by-next-call rule (APRV-106, APRV-410) is right for ownership; the trigger is too broad. A read that resolves autonomous should not consume the grace of an unrelated pending manual request, and the grace should not be shorter than the time a human needs to restart a listener.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A pending request is withdrawn by the requester's next gated call only when that call's class is not read-only (or when the requester issues an explicit withdraw); autonomous read classes leave it pending; tests on both
- [ ] #2 The retry grace is configurable and defaults to the policy's approval_ttl for hook-originated requests outside the harness cap, with the hook message stating the actual window
- [ ] #3 The hook's denial message names the pending request's action key and says which classes of later calls will withdraw it
<!-- AC:END -->
