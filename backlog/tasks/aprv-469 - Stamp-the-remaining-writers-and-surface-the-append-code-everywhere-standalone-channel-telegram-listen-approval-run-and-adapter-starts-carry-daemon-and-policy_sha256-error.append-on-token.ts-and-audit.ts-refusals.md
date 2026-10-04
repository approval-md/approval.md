---
id: APRV-469
title: >-
  Stamp the remaining writers and surface the append code everywhere: standalone
  channel telegram listen, approval run and adapter starts carry daemon and
  policy_sha256; error.append on token.ts and audit.ts refusals
status: To Do
assignee: []
created_date: '2026-10-04 12:36'
labels:
  - ergonomics
dependencies:
  - APRV-447
  - APRV-448
ordinal: 356000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-ups raised by both C7 (APRV-447, PR #587) and C8 (APRV-448, PR #588) on 2026-10-04. (1) A standalone approval channel telegram listen declares no daemon identity and writes decisions without the daemon field, the same gap the webhook had before APRV-448; give it the same declaration and allowlist refresh per dispatch cycle. (2) approval run and an adapter's act path record execution.started without policy_sha256 (APRV-447 stamped only harness paths); decide whether they should carry it (they resolve a class against the attested policy too) and stamp them from the same helper, or document why not. (3) APRV-448 added error.append (the write boundary's refusal code beside append-failed) to gate.ts and execute.ts JSON refusals; token.ts and audit.ts still bury it in message text, which SPEC section 11.1 invariant 6 (refusals machine-readable and distinct) argues against.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 channel telegram listen declares the resolved id and refreshes the allowlist each cycle; a tap through it carries daemon; an excluding list refuses; tests with the fake Bot API
- [ ] #2 approval run and adapter starts either carry policy_sha256 from the shared helper (tests on both) or the task notes and docs/README-extended.md say why they do not
- [ ] #3 token.ts and audit.ts JSON refusals carry error.append; a test per emitter
<!-- AC:END -->
