---
id: APRV-334
title: >-
  Stale comments in the repo policy: paste-ready draft correcting APPROVAL.md
  comments that contradict their rule
status: In Progress
assignee:
  - '@claude'
created_date: '2026-09-14 04:04'
updated_date: '2026-09-14 04:05'
labels: []
dependencies: []
references:
  - docs/proposals/repo-values-block.md
ordinal: 252000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The comment under policy.edit.spec in APPROVAL.md (lines 57-59) says the class is undeclared and "one in five live" while the rule sets live_rate: 0.01. Other comments may also describe a rule the line no longer states (vcs.push.main says "gated by per-task human review", which describes manual rather than supervised-retro). Carter reads the file to understand the policy, so confident stale comments are exactly the documentation failure the operator values block names. Agents may not write APPROVAL.md (policy.core, human-only), so the deliverable is a paste-ready draft under docs/proposals/, following docs/proposals/repo-values-block.md, that Carter pastes and re-attests with `approval policy amend`. This task creates docs/proposals/approval-md-2026-09.md; the alias and values tasks append their sections to the same doc so Carter pastes once.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 docs/proposals/approval-md-2026-09.md exists with a "Before you paste" runbook (approval policy amend, approval doctor) and the APRV-273 wrapper-fence warning
- [ ] #2 Every APPROVAL.md line the draft replaces is quoted byte-for-byte from the current file, next to its replacement, so the paste is unambiguous
- [ ] #3 The policy.edit.spec comment is corrected to describe live_rate 0.01; every other class comment in the block is checked against its rule and any contradiction is corrected in the draft
- [ ] #4 npm test and lint are unchanged by this task (docs only)
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Diff every class comment in the APPROVAL.md policy block against its rule (autonomy, rate, built-in classifier paths).
2. Write docs/proposals/approval-md-2026-09.md: Before-you-paste runbook (copied from repo-values-block.md), then a Stale comments section quoting each current line byte-for-byte with its replacement.
3. Leave placeholders for the APRV-335 and APRV-336 sections so the doc is one paste.
4. npm test, lint, commit as its own commit on the PR stack.
<!-- SECTION:PLAN:END -->
