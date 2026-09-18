---
id: APRV-370
title: >-
  Sender mapping accepts a hashed id, so a public policy and a public log never
  carry the raw Telegram account id
status: To Do
assignee: []
created_date: '2026-09-18 06:20'
labels:
  - channel
  - telegram
  - privacy
dependencies: []
priority: medium
ordinal: 287000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Raised by the operator on 2026-09-18 while applying the sender line (APRV-324): approvers.<id>.senders.telegram takes the raw numeric callback_query.from.id, and once applied every approval.granted, approval.rejected and audit.decision_refused record carries payload.sender.id too. On a public repository that publishes both the policy and the log (this one), the account id is disclosed once in APPROVAL.md and then on every phone decision. The id is an identifier rather than a credential and the gate does not depend on its secrecy (the transport authenticates the tap), so this is a disclosure question, not a security hole. Proposal: accept senders.telegram as either the raw id or sha256:<hex of the id string>; the channel hashes the observed from.id before comparing when the mapping is hashed; decision records carry the same form the policy uses (a hashed mapping records the digest as payload.sender.id with an explicit payload.sender.hashed true, or a sibling field, so a reader can still correlate taps to one account without learning it). The refusal record for an unmapped sender must still carry the observed id in hashed form only when the policy is hashed. Docs: docs/proposals/sender-identity-2026-09.md and the sender-mapping doctor row explain both forms. Migration: this repository re-amends to the hashed form; git history keeps the raw id and that is stated rather than rewritten.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 senders.<channel> accepts sha256:<hex> and the channel matches a hashed observed id against it; raw ids keep working
- [ ] #2 Decision and refusal records under a hashed mapping carry the digest and never the raw id; a schema change for the new field is its own task if one is needed
- [ ] #3 approval doctor sender-mapping reports which form is in use; docs updated
- [ ] #4 This repository policy is re-amended to the hashed form by the operator and one live approve carries the digest
<!-- AC:END -->
