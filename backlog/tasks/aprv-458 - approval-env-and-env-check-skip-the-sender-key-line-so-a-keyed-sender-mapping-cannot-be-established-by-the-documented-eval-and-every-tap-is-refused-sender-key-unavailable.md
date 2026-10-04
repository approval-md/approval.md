---
id: APRV-458
title: >-
  approval env and env --check skip the sender-key line, so a keyed sender
  mapping cannot be established by the documented eval and every tap is refused
  sender-key-unavailable
status: To Do
assignee: []
created_date: '2026-10-04 09:11'
labels:
  - dogfood
dependencies:
  - APRV-370
ordinal: 345000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-10-04 on the primary (Carter at the terminal). APPROVAL.md maps the operator's Telegram sender in the keyed form (APRV-370) and .approval/env carried a sender-key line pointing at the keychain item for this instance, yet after eval "$(approval env)" the listener started by approval up reported no key, approval doctor's sender-mapping row said the variable was unset in the process, and approval env --check listed every policy-named variable but not the sender key (it reported ok: every variable your policy names resolves). APRV-370 deliberately keeps the variable name out of the policy, which is exactly why env and env --check must carry it from the env file on their own: today the documented ceremony (setup sender-key, eval, restart) cannot establish the key, every tap on the keyed channel is refused, and the operator is steered toward re-minting, which replaces the keychain item and forces a policy amendment to swap the digest (which happened). Fix: env emits every line the env file holds (or at least the fixed list of runtime-read variables, sender key included), env --check lists it with its source, and doctor's fix text points at eval before suggesting a mint; setup sender-key bare warns loudly that replacing an existing key invalidates the mapped digest and prints the amend step.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 eval "$(approval env)" exports the sender key when .approval/env carries its line (keychain-backed or literal), under test
- [ ] #2 approval env --check lists the sender key with its source and never reports ok while a keyed mapping exists and the key does not resolve
- [ ] #3 approval setup sender-key, when a line already exists, says that replacing it invalidates every keyed mapping and prints the amend step before the prompt
- [ ] #4 docs/cli-reference.md env and setup sender-key sections state the above
<!-- AC:END -->
