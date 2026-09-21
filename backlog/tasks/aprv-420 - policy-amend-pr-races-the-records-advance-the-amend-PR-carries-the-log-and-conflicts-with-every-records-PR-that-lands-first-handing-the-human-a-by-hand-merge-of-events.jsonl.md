---
id: APRV-420
title: >-
  policy amend --pr races the records advance: the amend PR carries the log and
  conflicts with every records PR that lands first, handing the human a by-hand
  merge of events.jsonl
status: To Do
assignee: []
created_date: '2026-09-21 03:41'
labels:
  - policy
  - records
  - cli
dependencies: []
priority: high
ordinal: 322000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-09-21 (Carter): approval policy amend --as human:carter --pr opened PR 530 carrying APPROVAL.md, .approval/log/events.jsonl and a payload file. Two records advances (PR 529, PR 531) landed first and carried the same records (the attestation at seq 65736 and its payload are on main through PR 531), so PR 530 went DIRTY and lost its arm; re-running amend answered nothing to amend because the attestation exists; the repair was a hand merge in a throwaway worktree taking main's log and payload, which is exactly the log-touching hand work the idioms exist to remove. Fix options to decide: (a) when the attestation and payload are already on main (or on the open records branch), the amend PR carries only the policy bytes, so it cannot conflict with the log; (b) the amend joins the records branch: the policy commit rides the open records-log PR, which already self-arms (APRV-284), so one PR carries policy and log together and there is no race; (c) amend --pr detects a DIRTY state on re-run and re-merges the log from main itself, since main's log is a superset by construction. Also the re-run message should say what to do when the PR exists and is dirty rather than nothing to amend. Related: APRV-284, APRV-360 (policy apply publishes by refspec), APRV-412 (amend named as the way), APRV-389 (log sync under a daemon).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 An amend PR opened while a records advance is pending or landing merges cleanly, by carrying only the policy bytes when the log records are already published or by riding the records branch; the choice is recorded in the notes and docs/cli-reference.md policy amend
- [ ] #2 Re-running amend against an existing dirty amend PR repairs it (re-merging main's log, which is a superset) or says exactly what to run, never nothing to amend
- [ ] #3 A test builds the race through the real append and advance paths (attest, open the amend PR, land a records advance, re-run) and asserts a clean merge; build, typecheck, lint and the policy and advance suites pass
<!-- AC:END -->
