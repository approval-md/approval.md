---
id: APRV-498
title: >-
  Review note prompt over a relay depends on the relay's 10-minute licence
  between a held grade and the verdict tap; SPEC section 10.3 does not name it
status: To Do
assignee: []
created_date: '2026-10-05 15:40'
labels:
  - review
  - relay
  - docs
dependencies: []
priority: medium
ordinal: 382000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Since APRV-482 (#614) core holds a lone loved or disliked grade and asks for the note at the later verdict tap (askForNote at the ✅, or at the second 🛑). The EdgeOS control-plane relay forwards core's ForceReply note prompt only under a licence: an unused grade tap by the approver on that card, at most REPLY_LICENCE_MS (10 minutes) old. Before cp#84 a reviewer who graded, waited over 10 minutes, then tapped the verdict had the prompt refused (force_reply_unlicensed) and no note was collected. cp#84 fixed the relay side: a verdict tap by the same account on the same card within 10 minutes also licenses the prompt, bounded by the grade tap's queue lifetime (expires_at, 72 h by default). The core-side fact that remains: a held grade is process memory with no expiry in core, so a reviewer can verdict long after the grade, and whether the note is then collected depends entirely on the operator's relay window, which no core document names.

SPEC section 10.3 'Review delivered through a channel' (SPEC.md, the paragraph that begins 'Review delivered through a channel (amended APRV-299)') ends its gesture rules with: "A reaction that requires the human's own words (§5.2) MUST collect them before anything is appended." The relay table in the same section and relay_refusal_codes in section 11.2 (relay-gesture-stale: issued_at more than five minutes from the relay's clock) name a different window, so a reader could mistake the two. A sentence to add after the quoted one, for the owner to approve (this task does not edit SPEC.md): 'Where the card's transport is a relay, whether the words prompt may be sent is the relay's decision, over a window the operator sets; a relay that refuses the prompt leaves the review unrecorded until the reviewer is asked again, never recorded without the words.' Decision: add that sentence, or put the same note in docs/cli-reference.md only.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The owner decides: SPEC section 10.3 sentence, or docs-only; the decision and date are in the notes
- [ ] #2 docs/cli-reference.md and the operator relay docs say a note prompt over a relay depends on the relay's licence window and that a held grade in core does not expire
- [ ] #3 A channels-telegram test pins that a refused ForceReply (403, no licence) leaves nothing appended and the review still completable (confirm against APRV-492's relay fake)
- [ ] #4 SPEC.md is edited only in a PR the owner opened or approved
<!-- AC:END -->
