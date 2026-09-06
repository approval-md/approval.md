---
id: APRV-286
title: >-
  sandbox-probe control test depends on the host network: EHOSTUNREACH where it
  expects a timeout
status: To Do
assignee: []
created_date: '2026-09-06 11:59'
labels:
  - tests
  - flaky
dependencies: []
type: bug
ordinal: 212000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
tests/sandbox-probe: the CONTROL assertion "outside the sandbox, the non-routable address times out rather than being refused" fails on some networks (seen 2026-09-06 on Carter's laptop, twice, on unmodified main and on the release stack) because the host answers the non-routable address with EHOSTUNREACH in ~120 ms instead of letting it time out. The security assertion beside it ("outbound network inside the sandbox is DENIED, not merely slow") passes, so the sandbox is fine and the control is host-dependent. Make the control robust: accept any outcome that is not an immediate refusal-by-sandbox (timeout, EHOSTUNREACH, ENETUNREACH), or pick a target the host cannot answer synchronously (a blackhole documentation address behind a route), and say in the test which shapes count as "not sandboxed".
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The control passes on a host that answers the non-routable address with EHOSTUNREACH and on one that times out, and still fails if the address is refused by the sandbox denial path
- [ ] #2 The security assertion is unchanged
<!-- AC:END -->
