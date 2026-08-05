---
id: APRV-32
title: 'README and ceremony docs, incident-grounded, with transcript guard'
status: To Do
assignee: []
created_date: '2026-08-05 12:19'
labels: []
milestone: m-6
dependencies:
  - APRV-28
  - APRV-29
  - APRV-30
  - APRV-31
priority: medium
type: docs
ordinal: 32000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up 5 plus the two accepted doc riders (human-approved 2026-08-09). A real README structured around the three human ceremonies: first attestation; amending your policy (citing the live log's seq 2 by number as the incident the amend verb exists to prevent); approving from your phone. States plainly, in user-facing prose rather than module headers: the token-delivery asymmetry (telegram listener stdout vs web response page, and why) and the web CSRF stance (no auth, loopback trust boundary, speed-bump Origin check). Points at CLAUDE.md for how this repo builds itself. Ships the grep-guard test binding examples/ transcripts to executed reality (exit-code table and refusal strings asserted against exit-codes.ts and live messages). Depends on the four ergonomics tasks so the ceremonies it documents exist. Prose per the repo style rule: no em dashes, affirmative statements.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 README.md covers the three ceremonies with runnable command sequences: first attestation; policy amendment via approval policy amend citing log seq 2 as the motivating incident; phone approval via the telegram channel
- [ ] #2 Token-delivery asymmetry and web CSRF stance stated plainly in user-facing prose with their rationales
- [ ] #3 README points at CLAUDE.md for repo self-development; prose follows the style rule (no em dashes, affirmative)
- [ ] #4 A guard test asserts examples/ transcripts still match executed reality: exit-code table vs exit-codes.ts, refusal strings vs live CLI messages; drift fails npm test
<!-- AC:END -->
