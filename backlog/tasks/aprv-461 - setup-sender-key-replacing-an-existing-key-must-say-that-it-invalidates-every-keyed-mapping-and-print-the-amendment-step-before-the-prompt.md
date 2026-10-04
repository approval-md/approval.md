---
id: APRV-461
title: >-
  setup sender-key: replacing an existing key must say that it invalidates every
  keyed mapping and print the amendment step before the prompt
status: To Do
assignee: []
created_date: '2026-10-04 09:22'
labels:
  - ergonomics
dependencies:
  - APRV-370
ordinal: 348000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Evidence 2026-10-04: the env file already carried a sender-key line pointing at the keychain item; the bare verb asked replace the line? [y/N] with no consequence named; Carter answered y; the keychain item was overwritten with a fresh key; the policy's mapped Telegram digest (computed under the old key) no longer resolved; a policy amendment ceremony (APPROVAL.md edit, policy amend --pr, listener restart) was needed before a single tap could record. APRV-370's design note says losing the key costs the ability to resolve accounts; the prompt should say so.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 When a sender-key line or keychain item already exists, the bare verb prints, before the prompt, that replacing it invalidates every hmac-sha256: mapping in APPROVAL.md and lists the amendment step (setup sender-key --id, policy amend --pr, restart), and defaults to No
- [ ] #2 A --re-establish (or similar) path rewrites the env line from the existing keychain item without minting, for the case where only the env line is lost
- [ ] #3 docs/cli-reference.md setup sender-key section says the above
<!-- AC:END -->
