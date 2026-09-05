---
id: APRV-271
title: >-
  doctor audit-sampling consults the running daemon before saying sampling is
  disabled
status: To Do
assignee: []
created_date: '2026-09-05 17:58'
labels: []
dependencies: []
priority: low
ordinal: 201000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
approval doctor reports audit-sampling as disabled (secret-unset) whenever the shell running doctor lacks APPROVAL_SAMPLING_SECRET, even while the daemon in another window has it exported and is sampling. Seen 2026-09-05: doctor red, daemon banner confirming the secret in use. Since APRV-208 the live draw is answered by the daemon over local IPC, so doctor can ask the daemon whether sampling is enabled and at what rates instead of inferring from its own environment. The row should say which process answered: "sampling enabled per the running daemon (pid, socket)" or, with no daemon reachable, the current wording plus "no daemon answered; the daemon shell decides". Read-only; no verdict changes; the secret value is never printed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 doctor audit-sampling asks the running daemon over the APRV-208 IPC for sampling state and reports it as the source when the daemon answers
- [ ] #2 With no daemon reachable the row keeps its current meaning and adds that the daemon shell decides
- [ ] #3 The secret value never appears in doctor output or --json; tests cover both branches with a fake daemon socket
- [ ] #4 docs/cli-reference.md doctor section documents the row
<!-- AC:END -->
