---
id: APRV-317
title: Let explicit operator policy govern irreversible action autonomy
status: To Do
assignee: []
created_date: '2026-09-08 20:26'
labels: []
dependencies: []
references:
  - SPEC.md
  - src/core/policy-match.ts
  - /Users/carter/dev/ZZZ/scripts/approval-room-creation.mjs
priority: high
type: feature
ordinal: 228000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter requests that APPROVAL.md remain authoritative for the autonomy of irreversible actions: an operator must be able to explicitly select manual, supervised, or autonomous behavior without a hard-coded irreversibility floor silently overriding that choice.

Concrete integration: ZZZ declares room creation reversible: false. Its policy sets zzz.room.create.public to manual and zzz.room.create.private to supervised, but the pinned approval-md 0.1.0 runtime (78baf52) resolves both to manual regardless of policy. ZZZ also currently expects manual workflow evidence; its integration will need a separate compatibility update after the runtime contract is settled.

This intentionally requests a change to SPEC section 7, which currently forbids autonomous/supervised execution for reversible: false. Preserve truthful action metadata: do not solve this by relabeling irreversible actions as reversible or dropping their declarations. The operator policy, not agent-supplied metadata, must authorize any relaxation. This item tracks future design and implementation only; it authorizes no current policy changes or deployment.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 An explicit operator-authored policy can select manual, supervised modes, or autonomous execution for an irreversible action, with documented precedence and migration behavior.
- [ ] #2 Omitted or malformed override configuration fails safely; agent action metadata alone cannot authorize reduced scrutiny, and human-only and protected-policy controls remain enforced.
- [ ] #3 Policy check/explain and execution agree on effective autonomy and identify the governing policy decision; all supported entry points apply the same semantics.
- [ ] #4 Tests cover explicit manual, supervised live/retro where supported, autonomous, missing/invalid configuration, policy attestation changes, and attempts to relax policy through action metadata.
- [ ] #5 SPEC, schema, CLI documentation and examples explain the new contract, including when Telegram approval occurs versus sampled or retrospective review; ZZZ compatibility requirements are recorded.
<!-- AC:END -->
