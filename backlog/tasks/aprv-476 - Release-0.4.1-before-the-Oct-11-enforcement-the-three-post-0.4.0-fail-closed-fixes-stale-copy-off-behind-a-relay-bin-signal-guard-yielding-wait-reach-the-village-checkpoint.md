---
id: APRV-476
title: >-
  Release 0.4.1 before the Oct 11 enforcement: the three post-0.4.0 fail-closed
  fixes (stale-copy off behind a relay, bin signal guard, yielding wait) reach
  the village checkpoint
status: To Do
assignee: []
created_date: '2026-10-05 02:08'
labels:
  - agent-village
dependencies:
  - APRV-453
priority: high
ordinal: 362000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
0.4.0 was tagged at fb0cf987 on 2026-10-04 20:22Z; after it, three security fixes merged to main that the Agent Village fleet should run before APPROVALD_ENFORCE=1 on Oct 11: APRV-456 (#605, a tap whose nonce the listener is not holding is refused behind a relay, closing the forged-card path through the stale-copy fallback), APRV-466 (#604, the Hermes hook's signal guard lives in the bin so a signal during module load prints the block directive), APRV-473 (#608, the Hermes wait yields so a SIGTERM withdraws the question and no execution.started is appended after an interruption). The hosted image's shell_hooks patch covers the signal cases on Hermes's side as the other belt, and the relay case matters only once the relay is live, so 0.4.0 can run on dogfood now; the fleet should be cut from 0.4.1. Same ceremony as APRV-453: a release PR (changelog section, version strings, release notes naming the three), Carter's gated tag and push, Trusted Publishing, read-backs, then DATA-228 rebakes the checkpoint at 0.4.1 and HOSTED-32's pin moves. Include APRV-467/468/469/474/475 only if they land in time; do not wait for them.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Release PR opened with the 0.4.1 section naming 456, 466 and 473 and anything else merged since fb0cf987; CI green; not armed
- [ ] #2 Carter tags and pushes v0.4.1 through the gate; publish run green; read-backs recorded
- [ ] #3 DATA-228 and HOSTED-32 told the version; the checkpoint rebuilt at 0.4.1 before the Oct 11 roll
<!-- AC:END -->
