---
id: APRV-541
title: >-
  environment assignments in front of any classified command fail closed (one
  helper, the APRV-540 table)
status: In Progress
assignee: []
created_date: '2026-11-28 14:31'
labels:
  - classifier
  - security
dependencies:
  - APRV-540
priority: high
ordinal: 411000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Lead ruling on APRV-540 (binding, 0.4.10): writers get the same rule in 0.4.10 as a third PR, because the hole is the same one (the program that runs is not the one classified); one helper used by every classified command, not a second list; deny accepted, no new class now (an always-ask class is a SPEC row for 0.4.11). On the readers branch PATH=. touch x and PATH=. mkdir x stay files.write.workspace (autonomous under approval init's policy) and run ./touch; PATH=. approval status stays gate.self; NODE_OPTIONS=--require=./x node --version stays files.write.workspace; the asked classes (deps.add, release.publish, network.call, vcs.pr.open, harness.launch.*) are asked about a line whose program the class does not describe. Built on branch build-2/env-before-any-command (lane:claude-build-2@edge2), cut from build-2/env-before-reader.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 One helper judges the assignments in front of every classified command with the APRV-540 table (admitted / steering / unknown) and the same deny; git keeps its own admitted list and text through the same helper as parameters; a bare cd keeps its own rules
- [ ] #2 A bare steering assignment earlier on the line refuses every covered command after it, as it refused readers
- [ ] #3 The scope is one named predicate: every class (the ruling, committed) or the classes approval init's policy runs without a person; the count of existing lines each choice moves is reported
- [ ] #4 A before/after sweep of the conformance vectors, the overlay corpus and expected.json and the test literals lists every line that moves; a shipped overlay line that moves from allowed to refused is listed with the narrowest admitted pattern that would keep it, as a question for the lead
- [ ] #5 Tests first (red on the tests commit) per class family, through the pure classifier and the built hook under approval init's class rows; cost lines under the existing bound; conformance vectors at a minor bump
<!-- AC:END -->
