---
id: APRV-409
title: >-
  Classifier: a quoted prose argument that begins with a protected directory
  path classifies as that path, so a backlog task description sat nine minutes
  on the gate
status: To Do
assignee: []
created_date: '2026-09-20 19:06'
labels:
  - classifier
  - hook
  - bug
dependencies: []
documentation:
  - src/core/command-class.ts
priority: high
ordinal: 316000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-09-20 (log seq 64337, 64338). A backlog task create whose third --ac argument began with the literal text of a workflow path followed by prose (the argument, after shell parsing, was one word: the path, a space, and a sentence) classified policy.edit.ci by rule protected-path, sat the full nine-minute wait on the gate, and was denied on timeout. The command writes one task file. Reproduction: approval hook classify -- "backlog task create x --ac WORKFLOW_PATH_THEN_A_SENTENCE" answers policy.edit.ci / protected-path when the argument starts with the .github workflows directory path, while the same argument starting with CLAUDE.md or APPROVAL.md answers files.write.workspace, and the same path inside a sentence rather than at its head also answers files.write.workspace. Cause: strictestProtected in src/core/command-class.ts (called from the protected-path pass after refinement, the block commented "A protected path anywhere in an effectful segment takes that path class") tests every positional word with protectedPathClass. pathSegments splits the word on slashes, so a word whose first segments are a protected DIRECTORY entry prefix-matches whatever follows, including a sentence with spaces; an exact-file entry does not, which is why CLAUDE.md prose passes. The word was never a path the command would touch. This is a strictness bug rather than a widening, and the fix must stay on that side: a word containing whitespace or a newline is prose, not a path, and is skipped by the positional scan only; write-redirection targets and the apply-patch and hook file paths, which are real paths by construction, keep their behaviour. Care: an argument with an embedded space CAN be a real path (a file named with a space); the safe rule is narrow, skip only words containing whitespace whose protected match came from a directory-prefix entry and whose remainder after the matched prefix contains whitespace, or require that the matched word, taken as a path, ends at a segment boundary. Decide in the plan and pin it with vectors. Related: the journal entry of 2026-09-20 from the APRV-406 session, and APRV-407 whose description carried the sentence.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval hook classify answers files.write.workspace for a backlog task create whose quoted argument starts with a protected directory path followed by a sentence, and for the same shape under cp, tee and any other effectful row
- [ ] #2 A bare path argument, a path with a real embedded space when quoted as one word, a path inside a sentence, and a protected file (CLAUDE.md) at the head of a sentence each keep their current answer; vectors in tests/command-class-quoting.test.ts or a sibling file pin all five shapes
- [ ] #3 The conformance vector suite gains the shapes above and command-class bumps its version
- [ ] #4 Implementation notes state that the change narrows nothing on the strict side: every word that classified as a protected path before and IS a path still does
<!-- AC:END -->
