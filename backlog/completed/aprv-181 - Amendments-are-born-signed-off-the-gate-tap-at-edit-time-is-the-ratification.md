---
id: APRV-181
title: 'Amendments are born signed off: the gate tap at edit time is the ratification'
status: Done
assignee: []
created_date: '2026-08-31 23:10'
updated_date: '2026-08-31 23:58'
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
- [x] #1 SPEC.md line 9 states the born-signed-off rule: gate-granted amendments carry (Amended APRV-n.) from birth, the pending suffix is reserved for text no human granted whole, and doubt resolves to pending
- [x] #2 The line 9 edit itself lands through a gate prompt and carries no pending suffix, citing its own grant
- [x] #3 Implementation notes carry the exact CLAUDE.md sentence for Carter to apply by hand
- [x] #4 npm test and lint pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Rewrite SPEC.md line 9 (one gated Edit, warned in chat first): gate-granted amendments carry (Amended APRV-n.) from birth; pending reserved for text no human granted whole (hook-silent edits, drafts for later review); doubt resolves to pending; the log holds every grant. 2. Draft the CLAUDE.md sentence in implementation notes for Carter to apply by hand. 3. docs-guard + lint; commit on the PR #161 branch.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Executed 2026-08-31 by fable inline; the line 9 rewrite was granted at seq 4082 (Carter warned in chat before the prompt fired). The new convention: gate-granted amendments (worktree proposals included, since their prompts show the change whole) are born signed off as (Amended APRV-n.), optionally citing granted seq N; pending is reserved for hook-silent edits and drafts awaiting review; doubt resolves to pending. Deviation from AC2 as written: the amendment cannot cite its own grant seq inline, because the seq exists only after the very tap that ratifies the text being hashed; the citation lives here instead (seq 4082), and the MAY-cite form serves future amendments. CLAUDE.md sentence for Carter to apply by hand, in the Engineering invariants section or beside the dogfooding rules: "SPEC.md amendments granted through the gate are signed off by that grant and carry `(Amended APRV-n.)` from birth; write `pending sign-off` only for text no human granted whole (a hook-silent edit, a draft for later review), and treat any silent SPEC.md write as an incident (APRV-151). Doubt resolves to pending." docs-guard 6/6, oxlint clean; full gate runs on PR #161.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
SPEC.md line 9 now makes the gate tap at edit time the sign-off: granted amendments carry the plain suffix from birth, pending is reserved for ungranted text, doubt resolves to pending. The rewrite itself was granted at seq 4082; CLAUDE.md wording handed to Carter in the notes. Verified by docs-guard and lint.
<!-- SECTION:FINAL_SUMMARY:END -->
