---
id: APRV-505
title: >-
  Attestation diff budget: render say.<class> wording changes as one line per
  class so a card-template switch fits a phone card
status: To Do
assignee: []
created_date: '2026-10-07 03:40'
labels: []
dependencies: []
ordinal: 387000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Agent Village (DATA-370) switches every resident policy to channels.telegram.prompt.style: minimal plus a say block (~3.8k chars). The semantic diff of that switch renders at ~4081 chars / 51 lines against ATTESTATION_DIFF_MAX_CHARS 2400 / ATTESTATION_DIFF_MAX_LINES 60 (src/core/policy-proposal.ts:151,553), so a RESIDENT-attested box refuses the next settings change with diff-too-large and can never take the switch; the operator amendment path does not apply to resident-attested stores by design. Only the terminal path (approval policy amend --as human:<id> --require-load --commit) bypasses it. The budget protects against a card that shows two thirds of a policy change; say.* entries are wording the card shows to the human, not permissions, so they should not consume it the way class, autonomy, tier and path rules do. Proposed: the semantic diff renders a say.<class> add/change/remove as ONE line per class (e.g. 'say intent.publish.inferred.index: wording changed'), and channels.telegram.prompt.style as one line; the full wording stays readable in the terminal diff. Refute question for the lane: can a say change ever alter what the human is asked to approve (it must not), and does the one-line form hide an entry that silently falls back to the technical card (a misspelled class).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A policy diff that only adds or changes say.<class> entries and channels.telegram.prompt.style renders under the budget for a template-sized say block (test with the Agent Village template shape, ~15 classes)
- [ ] #2 A diff that changes any class, autonomy, tier or path rule renders exactly as before (existing tests unchanged)
- [ ] #3 The one-line say form names the class and says whether the entry was added, changed or removed; the terminal diff still shows the full wording
- [ ] #4 SPEC and CHANGELOG state the rule; the Behavior changes section explains why wording changes do not spend the card budget
- [ ] #5 Security refuter confirms a say change cannot change the approval decision or hide a technical-card fallback
<!-- AC:END -->
