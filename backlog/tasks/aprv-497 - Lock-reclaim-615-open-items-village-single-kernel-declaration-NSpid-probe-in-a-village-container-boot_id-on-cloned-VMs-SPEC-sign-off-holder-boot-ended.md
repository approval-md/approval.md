---
id: APRV-497
title: >-
  Lock reclaim (#615) open items: village single-kernel declaration, NSpid probe
  in a village container, boot_id on cloned VMs, SPEC sign-off,
  holder-boot-ended
status: To Do
assignee: []
created_date: '2026-10-05 15:40'
labels:
  - log
  - lock
dependencies: []
priority: medium
ordinal: 381000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Open notes left by PR #615 (APRV-479, lock reclaim) that need a person or a probe; the PR body has no list numbered N1-N5, so these are the items it marks 'Needs a human decision', 'For the human' and 'residue', gathered here with their sources. (1) S4/N4: a lock whose holder recorded another pid namespace or another boot id is kept forever, which is the village's recreated-sandbox case; the operator clears it with rm -v .approval/log/events.jsonl.lock (prints removed '.approval/log/events.jsonl.lock', not logged). Decision: may a deployment declare its log volume single-kernel/single-attach (env flag or policy key) so a different boot id on the same host counts as gone? Code default stays live. (2) R3-9 (b87db195): procIsOwnNamespace requires the NSpid line in /proc/self/status to hold exactly one field equal to the pid; the pin was proven on Linux node:22-bookworm-slim --privileged and was not run in a village container: run grep NSpid /proc/self/status in one and record the output (one field means the check passes there). (3) R3-10: boot_id is shared by snapshot-restored VMs or sandboxes on one volume; macOS hostname plus boot within 60 s versus cloned VMs; deployment-dependent, not the village (Railway, one container per volume). (4) conformance: holder-boot-ended stays in the closed reason set though nothing produces it; dropping it waits for a regeneration. (5) SPEC sections 8, 11.1, 11.2 hunks sit in the APRV-479 task notes pending the owner's sign-off. Round 4 residue also stated: a writer stalled by SIGSTOP or a debugger for a whole wait still reads as dead; a dead claimant's take file from another container stays beside the lock, export-excluded.

Decision to make: for each of (1) and (4), accept or act; (2) is a probe whose output decides whether (1) is needed in the village. The PR is not armed until (5) is signed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The single-attach declaration is decided (build it as its own task, or record the decision to keep manual rm and put the operator step in docs)
- [ ] #2 The output of grep NSpid /proc/self/status in a village container is pasted in the notes
- [ ] #3 holder-boot-ended is either dropped with a conformance regeneration or recorded as kept, with the reason
- [ ] #4 The SPEC hunks are signed off or refused, with the date and who
<!-- AC:END -->
