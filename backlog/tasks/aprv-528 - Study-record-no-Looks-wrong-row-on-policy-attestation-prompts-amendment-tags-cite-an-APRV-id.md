---
id: APRV-528
title: >-
  Study record: no Looks wrong row on policy attestation prompts; amendment tags
  cite an APRV id
status: Done
assignee: []
created_date: '2026-10-20 06:33'
labels: []
dependencies: []
ordinal: 404000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner read of PR #660 (the Telegram Looks wrong button, amended SPEC.md section 8 the study record) found two small items. N1: the study row was drawn on policy attestation prompts too, where a tap is routed to the attestation path that records no study reason, so the detection line would count a flag no log record holds. N2: the public SPEC.md amendment tags for the study record named an internal workstream instead of an APRV id like every other amendment. This task folds both into #660.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 studyRows returns no row for a request carrying policy_diff or a policy.attest: key, in both card styles; an ordinary action card still carries the row (tests/telegram-study.test.ts G2-3c)
- [ ] #2 SPEC.md amendment tags for the study record read (Amended APRV-528 ...) and the three study test headers cite APRV-528
- [ ] #3 git grep -i for the internal workstream name returns nothing outside the committed log
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
N1: the guard is in TelegramChannel.studyRows (src/channels/telegram.ts). It checks request.policy_diff and isAttestationActionKey, the predicate channels/contract.ts routes on, so either signal alone suppresses the row. Mutant (guard removed) fails G2-3c. N2: SPEC.md tags at the study record bullet (section 8) and the study-reason-not-channel refusal row now cite APRV-528; this changes the SPEC.md sha256, so the release attest uses the recomputed hash. No global invariant is weakened: the change only removes a button whose gesture was already a plain decline.
<!-- SECTION:NOTES:END -->
