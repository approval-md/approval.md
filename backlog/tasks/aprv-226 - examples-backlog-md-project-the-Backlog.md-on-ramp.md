---
id: APRV-226
title: 'examples/backlog-md-project: the Backlog.md on-ramp'
status: To Do
assignee: []
created_date: '2026-09-02 17:00'
labels:
  - docs
  - release
dependencies:
  - APRV-199
priority: medium
type: docs
ordinal: 183000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC section 14 lists examples/backlog-md-project/ in the repository layout, and it does not exist: examples/ holds the email, MCP, Telegram and web-agent demos. A stranger installing 0.1.0 has no worked example of the native Backlog.md integration that M6 shipped (envelope on a task file, register, request, wait, run). docs/backlog-md-pin.md covers the CLI pin and the upstream envelope-drop defect, not the happy path. This is the only Backlog.md item worth doing before launch; it fits APRV-199 AC1 (README front page current). Docs only: no runtime change, no new adapter (a Backlog.md adapter would hold no credential and cannot be a section 10.4 boundary; see the 2026-09-02 assessment recorded in this task). The example must run against a policy shipped with the example, not against the repo APPROVAL.md, so it stays valid when the dogfood policy changes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 examples/backlog-md-project/ holds a minimal backlog/tasks/ task file carrying an approval: envelope that validates against schema/envelope.schema.json (covered by the existing fixture test or a one-line addition to it)
- [ ] #2 A README in the example walks register, request, wait and run in that order against a policy file inside the example, with the expected output of each verb shown, and states that board status and approval state are independent (SPEC section 12)
- [ ] #3 The README says in one sentence why there is no Backlog.md adapter: task files hold no credential, so the envelope plus the log is the whole integration
- [ ] #4 README front page links the example beside the other demos; docs-guard stays green
<!-- AC:END -->
