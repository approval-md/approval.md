---
id: APRV-199
title: >-
  Release 0.1.0 through the gate: npm publish as the first release.publish
  ceremony
status: To Do
assignee: []
created_date: '2026-09-01 18:46'
updated_date: '2026-09-02 16:31'
labels:
  - release
  - dogfood
dependencies:
  - APRV-198
  - APRV-194
  - APRV-224
priority: high
ordinal: 165000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Every SPEC section 14 milestone (M0 to M8) has shipped, package.json already reads 0.1.0, and the log verifies clean. The launch itself is one action in the release.publish class (manual in the repo policy): npm publish, run from the primary checkout through the envelope flow (approval register, request, wait, run) with the granted sealed token, so the first public release of approval.md is approved via approval.md. The same grant is a real manual-class action and doubles as the end-to-end sealed-delivery proof APRV-166 AC3 still needs. This task carries the preconditions a stranger installing the package would notice; the decision to run it is the human operator's.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Preflight recorded: npm pack --dry-run contents reviewed (files and bin fields; no .approval, backlog, or private material shipped), README front page current, LAUNCH.md or CHANGELOG carries the 0.1.0 line
- [ ] #2 Envelope on this task: register, request, wait, run for npm publish from the primary checkout; grant seq and execution seq recorded in the notes; no human relayed a token (APRV-166 AC3 evidence)
- [ ] #3 v0.1.0 tag pushed through its own gated action and the package installs on a clean machine under the published name; verified and recorded
- [ ] #4 The human decides go or no-go; the agent prepares and never triggers the publish
<!-- AC:END -->
