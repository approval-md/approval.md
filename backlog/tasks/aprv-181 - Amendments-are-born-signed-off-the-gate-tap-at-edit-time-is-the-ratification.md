---
id: APRV-181
title: 'Amendments are born signed off: the gate tap at edit time is the ratification'
status: To Do
assignee: []
created_date: '2026-08-31 23:10'
labels: []
dependencies:
  - APRV-180
ordinal: 149000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The pending-sign-off suffix (SPEC.md line 9, from APRV-103) made every builder amendment enter a pending state that only a later manual sweep could exit, and 55 markers accumulated in ten days. Carter's intent (2026-08-31): sign-off happens through the Telegram prompt at amendment time. The machinery already exists: every SPEC.md edit gates as policy.edit, the prompt shows the change whole (WYSIWYS, APRV-119/124/162), and the log records the grant with payload and display hashes. So amend the convention: an amendment whose exact text a human granted through the gate is signed off at grant and written (Amended APRV-n.), optionally citing the grant seq; worktree-proposal grants count because their prompts show the diff whole. The pending suffix survives only for text that did not pass through such a grant: hook-silent edits (the APRV-151 incident class) and text drafted for later review. Fail closed: when in doubt, mark pending. CLAUDE.md needs a matching sentence; it is agent-protected, so the exact wording is drafted in implementation notes for Carter to apply by hand (APRV-160 precedent).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 SPEC.md line 9 states the born-signed-off rule: gate-granted amendments carry (Amended APRV-n.) from birth, the pending suffix is reserved for text no human granted whole, and doubt resolves to pending
- [ ] #2 The line 9 edit itself lands through a gate prompt and carries no pending suffix, citing its own grant
- [ ] #3 Implementation notes carry the exact CLAUDE.md sentence for Carter to apply by hand
- [ ] #4 npm test and lint pass
<!-- AC:END -->
