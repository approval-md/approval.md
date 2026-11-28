---
id: APRV-541
title: >-
  environment assignments in front of any classified command fail closed (one
  helper, the APRV-540 table)
status: In Progress
assignee: []
created_date: '2026-11-28 14:31'
updated_date: '2026-11-28 14:48'
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
- [x] #1 One helper judges the assignments in front of every classified command with the APRV-540 table (admitted / steering / unknown) and the same deny; git keeps its own admitted list and text through the same helper as parameters; a bare cd keeps its own rules
- [x] #2 A bare steering assignment earlier on the line refuses every covered command after it, as it refused readers
- [x] #3 The scope is one named predicate: every class (the ruling, committed) or the classes approval init's policy runs without a person; the count of existing lines each choice moves is reported
- [x] #4 A before/after sweep of the conformance vectors, the overlay corpus and expected.json and the test literals lists every line that moves; a shipped overlay line that moves from allowed to refused is listed with the narrowest admitted pattern that would keep it, as a question for the lead
- [x] #5 Tests first (red on the tests commit) per class family, through the pure classifier and the built hook under approval init's class rows; cost lines under the existing bound; conformance vectors at a minor bump
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented on build-2/env-before-any-command (lane:claude-build-2@edge2), cut from build-2/env-before-reader at 73f62b35.

One helper: assignmentRefusal(prefix, program, table) in src/core/command-class.ts. COMMAND_ASSIGNMENTS (APRV-540's admitted list and text) is the default table, and GIT_ASSIGNMENTS (git's list and its unchanged text) is passed by gitAssignmentRefusal. assignmentGate in classifySegmentWithVerb puts every answer the segment gives (the protected redirect's and the walk's) through it, whatever the class. It also refuses a covered command after a steering name the line sets (readerEnvWrite). A reader is covered whatever it answers (verbClass). A bare cd keeps its own rules.

Scope: ASSIGNMENT_RULE_SCOPE, one line. Committed: every-class (the ruling). Alternative: unasked-by-default, ASSIGNMENT_RULE_UNASKED_CLASSES = read.*, files.write.workspace, files.write.out_of_scope, calendar.write.own, communicate.email.draft and gate.self; a test pins the list to scaffold.ts CANONICAL_POLICY. Existing lines moved against 73f62b35 (vectors, overlay corpus and expected.json, test literals; 1,556 commands): every-class 21, unasked-by-default 18. The 3 that differ: FOO=1 grok run, APPROVAL_RELAY_SECRET=… approval channel relay, X=.. rm -rf $X. Overlay corpus and expected.json: 0 moved under either; overlay-recipes-check --json is byte-identical before and after.

The narrower scope gives no relief for the common developer lines (NODE_ENV=test npm test, DEBUG=x node script.js, FOO=bar make, PORT=3000 npm start, TMPDIR=… bun test): files.write.workspace is unasked by default, so they are refused under both. Relief would need either admitted name and value patterns or an exemption for the rules that already run project code (npm-script, node-script, workspace-tool). Both are open questions for the lead; neither is implemented.

Conformance command-class 3.0.0 (MAJOR: harness-launch-env-prefixed moved), plus ten vectors.

Credentials: the rule only adds refusals. curl -H with a Bearer $TOKEN header and no assignment stays read.web (APRV-533), and TOKEN=$(cat .approval/env) curl … stays opaque before and after.
<!-- SECTION:NOTES:END -->
