---
id: APRV-325.2
title: Implement a policy-bound typed Codex workspace change broker
status: To Do
assignee: []
created_date: '2026-09-09 07:39'
updated_date: '2026-09-09 08:47'
labels: []
dependencies:
  - APRV-325.1
  - APRV-317
references:
  - docs/codex-boundary-probe.md
parent_task_id: APRV-325
priority: high
type: feature
ordinal: 244000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Make the canonical workspace writable only through a distinct narrow broker that computes operation classification and applies attested APPROVAL.md. This follows preparation/diagnostics and is not a flag on the broad MCP server.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Caller input cannot override actor, policy, log, workspace root, class, reversibility, credentials or sandbox posture; server enforces a positive tool allowlist.
- [ ] #2 Exact change payloads include stable identity and verified preimages; create/replace/delete/move targets and patch source/destination paths are canonicalized and checked for traversal, symlink, hardlink, protected-path and concurrent-edit attacks.
- [ ] #3 Policy determines autonomy without fabricated human grants; manual/live decisions use genuine gate authority, and changed payloads, duplicate execution, replay, unavailable logs and attestation drift refuse before unauthorized writes.
- [ ] #4 Crash and partial-write behavior preserves evidence and reports indeterminate outcomes honestly; broker runtime, policy, log and launcher remain outside agent write custody.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. After APRV325.1 and317 integrate, define a closed typed create/replace/delete/move broker with fixed installation-owned actor, roots, runtime and policy/log paths. Materialize complete before/after bytes and server proposal identity into one immutable payload. 2. Derive one registered action per distinct protected/path class; do not collapse classes and lose rosters/budgets. Use an attested single-read policy snapshot and expected policy digest for intake. 3. Reject traversal, symlinks, hardlinks, path aliases and unsupported files; require OS-exclusive write custody, serialize transactions and revalidate all preimage identities and hashes. Preflight all actions, start all before mutations. 4. Stage and fsync same-filesystem preimages and new files with a durable journal; recover only proven all-before/all-after states. Mixed or unreadable states use an honest existing indeterminate event with a separately reviewed reason amendment; never fabricate success or replay. 5. Add adversarial policy, replay, grant, path, concurrency and crash tests; parent reviews protected contracts before protected edits and final GitHub delivery.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Sol read-only design completed. Reuse parseApplyPatch/protectedPathClass but not caller-cwd classification as custody proof. POSIX multi-file rename is not atomic, so durable recovery and OS-excluded writers are required. Current indeterminate reason union only act-threw needs a truthful workspace-commit-unknown amendment before crash implementation. Task remains To Do with dependencies; no broker implementation or enforcement claim.
<!-- SECTION:NOTES:END -->
