---
id: APRV-167
title: 'Amend ceremony UX: show progress during the silent pre-diff verify'
status: To Do
assignee: []
created_date: '2026-08-30 23:07'
labels:
  - cli
  - ux
dependencies: []
ordinal: 146000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed by Carter 2026-08-30: approval policy amend sat silent for ~33 seconds before printing the Policy/Changes/Load block, and read as frozen; the human nearly abandoned a live ceremony (and earlier DID abandon one mid-run, leaving the repo gate fail-closed for every agent session until a second attempt). The silence is the chain re-verify plus baseline recovery over a ~3000-record log before anything prints. Wanted: immediate output when the verb starts (what it is doing, record count), and progress for any step that can exceed a couple of seconds (verify N/M records, baseline recovery), on stderr so --json stdout stays clean. Same treatment for other verbs that re-verify the whole chain before speaking (wait, status on large logs) is in scope to survey, amend is the priority.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval policy amend prints a first line within ~1s of invocation naming the step in progress
- [ ] #2 Chain verification over large logs reports progress (count-based, stderr), and --json output is byte-unchanged on stdout
- [ ] #3 A survey note in the task lists which other verbs share the silent-verify pattern and whether each got the same treatment or a reasoned skip
<!-- AC:END -->
