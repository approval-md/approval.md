---
id: APRV-198
title: 'Classifier splits policy.edit: the gate''s own organs are not prose'
status: To Do
assignee: []
created_date: '2026-09-01 05:14'
labels:
  - gate
  - security
  - design
dependencies:
  - APRV-185
priority: high
ordinal: 165000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
2026-09-01, found while drafting the human-only additions Carter asked for: the classifier emits one class, policy.edit, for every protected touch — SPEC.md and CLAUDE.md prose edits, CI config, APPROVAL.md itself, and .approval/* including the redirect-protected rule that catches writes aimed at .approval/log/events.jsonl. APRV-184 (policy.edit to supervised-live 0.1, Carter-approved in principle) is therefore BLOCKED: sampling at 0.1 would let roughly nine in ten APPROVAL.md edits and log-redirect writes execute unprompted. Attestation makes a silent APPROVAL.md edit fail closed rather than loosen (edited-but-unattested policy refuses everything), and chain verify detects log tampering after the fact, but both are detection or denial-of-service where the Never list promises prevention.

Scope: split the classifier's protected-path output into three classes the policy can rule on separately. (1) policy.edit narrows to the prose-and-config surface: SPEC.md, CLAUDE.md, protected_paths entries, CI/release config. (2) policy.core, new: APPROVAL.md and .approval/* (env, payloads, keys, QUEUE.md — everything under the gate's own directory except the log redirect). (3) log.mutate, new: any write, redirect, append, or truncation aimed at .approval/log/. cp stays direction-blind (copies FROM these paths classify the same class). Update the schema/class taxonomy in SPEC section 7 if it enumerates classes (flag per convention), the hook docs tables, and tests pinning classifier output for representative commands of each of the three. defaults.autonomy manual keeps unsplit strays gated, so the split is additive and fail-closed.

Sequencing: this lands FIRST, then one amend ceremony (Carter's) applies APRV-184's supervised-live 0.1 to the narrowed policy.edit and declares policy.core and log.mutate human-only alongside the other human-only lines (draft in APRV-185 notes, updated by the orchestrator). Related: APRV-194 (account.credential rules, same shape of work — consider one lane for both).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Classifier emits policy.edit only for SPEC.md, CLAUDE.md, protected_paths entries, and CI/release config; representative commands pinned by test
- [ ] #2 policy.core emitted for APPROVAL.md and .approval/* touches outside the log; log.mutate for anything aimed at .approval/log/; cp direction-blindness preserved; both pinned by test
- [ ] #3 SPEC section 7 taxonomy and hook docs updated, flagged per the amendment convention
- [ ] #4 Unsplit or ambiguous protected touches still fail to a gated class, never autonomous; tested
- [ ] #5 APRV-184's task notes updated to depend on this task, with the proposed APPROVAL.md block naming all three classes
<!-- AC:END -->
