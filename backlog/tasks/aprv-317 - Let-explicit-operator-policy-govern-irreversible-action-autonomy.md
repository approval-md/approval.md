---
id: APRV-317
title: Let explicit operator policy govern irreversible action autonomy
status: In Progress
assignee:
  - '@codex-sol'
created_date: '2026-09-08 20:26'
updated_date: '2026-09-09 08:16'
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

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add optional class-rule allow_irreversible boolean: absent/false preserves manual floor, true is valid only for autonomous and supervised variants; defaults and action metadata cannot opt in. 2. Require every equally most-specific matching rule to opt in; carry capability through protected policy.edit inheritance and compare effective irreversible route outcomes. 3. Keep manual and human-only controls unchanged; expose governing decisions in explain and show allow-only edits in amendment diffs. 4. Test matcher, schema, protected routes, execution, live/retro sampling, attestation drift, and metadata forgery. 5. Parent applies narrow reviewed SPEC amendment through primary gate; update schema dictionary and CLI guidance. Record ZZZ wrapper follow-up explicitly. 6. Review frozen diff, run focused checks then full tests/lint/typecheck/conformance/CI parity, deliver reviewed feature PR and verify merge.

Extend shared adapter CLI integration so an omitted token reaches the existing executeThroughAdapter policy decision, instead of unconditionally failing usage before resolution. Manual and selected-live actions continue to require a real grant token; no synthetic grant or reversible:true workaround is permitted. Preserve vault and env-passphrase authority: nonmanual execution uses only the existing human-established provider environment, with no implicit source-map fallback without a token. Update adapter help and registry contracts, test default/manual and explicit autonomous/supervised/live cases, and observe a ZZZ mock POST only through the correct policy-authorized execution path. Parent reviews any SPEC 10.4 mismatch before protected edits.

7. Complete adapter CLI parity against the prepared SPEC 10.4 amendment: permit omitted tokens to reach executeThroughAdapter, keep manual and sampled-live token requirements, preserve token-only environment source-map credential fallback, and verify autonomous, supervised-retro, selected and non-selected supervised-live, metadata-forgery, and adapter outcome paths with focused tests.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
APRV-317 adapter parity checkpoint (2026-09-09): added a shared read-only execution eligibility preflight before credentials and provider precheck. It validates the canonical principal actor, verified token or attested nonmanual policy, approval-cycle custody, payload binding, idempotency, loops and budgets; startExecution still rechecks and compare-appends after provider precheck. Budget denials retain budget.exceeded, and a head-moved append retries the full eligibility cycle. Direct no-token supervised-live execution reuses existing request intake and daemon sampling with fields derived from the verified declaration, retains the exact already-hashed payload for selected human display, never redraws an existing pending/rejected/expired cycle, and binds an unselected draw policy digest through eligibility and start. Selected/unavailable/stale/invalid draws create the ordinary pending request and stop before credentials. Manual delivered tokens stay token-authorized. Token-free policy execution cannot use the token-scoped environment source-map fallback. Added actor-invalid, policy-drift, and reachable request/payload-store refusal codes. Parent gate evidence for the applied adapter SPEC amendments: immutable declaration codex-aprv317-adapter-spec at seq 30122; successful outcomes at seq 30124, 30126, and 30128. Those were policy-authorized nonmanual edits, not a human grant, and the pending-sign-off suffix remains. Further narrow SPEC wording for verified pre-credential eligibility, existing supervised-live intake, pending fallback, exact payload retention, and post-precheck policy binding remains for parent protected-edit handling. Focused validation: build exit 0; lint exit 0; conformance 296/296 vectors and 142 controls exit 0; adapter/ZZZ/vault focused suite 92/92 exit 0 when permitted to bind loopback. The managed sandbox run failed exit 1 solely because listen 127.0.0.1 returned EPERM. Parent owns the full suite, protected amendment, integration, review and delivery.
<!-- SECTION:NOTES:END -->
