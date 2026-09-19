---
id: APRV-382
title: >-
  log.advance is autonomous for the daemon actor and stays supervised for every
  other actor: proposal page, dogfood pin, and the advance path asserts who is
  running it
status: To Do
assignee: []
created_date: '2026-09-19 16:17'
labels:
  - policy
  - daemon
  - records
dependencies: []
priority: medium
ordinal: 296000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter asked on 2026-09-19 whether a records advance should be autonomous. The argument: the advance appends nothing and decides nothing, it publishes records already in the log to a records branch and opens a PR (files are the interface, the log is the truth, the committed copy is a cache); the CI guard reads grants that exist whether or not an advance ran, so no actor gains authority from timing one. The class was declared manual (seq 513) before the daemon existed, when any checkout could advance. Now the daemon is the single writer and already advances on a timer under --advance, so the remaining risk is mechanical (queue collision, duplicate branch), which the --pr path handles. Decision to propose: log.advance autonomous when the actor is the daemon, supervised for any other actor (a session in a worktree, a human terminal), so a lane still cannot publish the log. Agents do not edit APPROVAL.md: this task delivers a proposal page under docs/proposals/ in the byte-anchored form approval policy apply reads, the dogfood-suite pin change in the same PR (the pin-every-class rule, APRV-296), and a check in the advance path that the autonomous route is only taken when the running actor is the daemon (the cadence advance inside approval up or daemon run), refusing with a distinct code otherwise. Carter applies the page with approval policy apply <page> and restarts the daemon. Related: APRV-125 (log sync verb), APRV-284 (advance arms itself), APRV-215, APRV-296, APRV-360.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 docs/proposals/log-advance-daemon-2026-09.md exists in the form policy apply reads, with the rule for log.advance by actor and the cost seen that prompted it (three advances on 2026-09-19 each at a one-in-a-hundred live draw while the human was away)
- [ ] #2 The dogfood suite pin for log.advance moves in the same PR and the amend dry-run against the proposed policy passes on the laptop
- [ ] #3 The advance path distinguishes the daemon actor from any other and a non-daemon actor under an autonomous rule is refused with a machine-readable code, with tests through the real append path
- [ ] #4 docs/dogfood-cutover.md and docs/cli-reference.md say which actor may advance autonomously; build, typecheck, lint and the advance, daemon and policy suites pass
<!-- AC:END -->
