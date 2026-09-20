---
id: APRV-372
title: Apply cost-conscious Codex coordination guidance
status: In Progress
assignee:
  - '@codex'
created_date: '2026-09-18 20:01'
updated_date: '2026-09-20 00:48'
labels: []
dependencies: []
type: docs
ordinal: 289000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Apply the user-requested dev/meta coordination learnings to AGENTS.md while preserving approval policy, Cursor routing, per-task records, required checks and protected delivery.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Codex guidance uses bounded implementation and verification units, concise worker context, and completion or decision driven parent wakeups.
- [x] #2 Review guidance uses complete milestone diffs and impact-scoped rechecks without removing required per-task or critical Astra review.
- [ ] #3 Protected edit evidence and existing required validation pass, and the isolated feature PR reaches the repository delivery state.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Compare current guidance with the accepted personal-site update and dev/meta template. 2. Prepare an AGENTS.md-only policy edit through the primary gate. 3. Review the complete diff, run required validation and protected-path guard. 4. Commit task notes and guidance, push and merge the feature PR without touching shared checkout WIP.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Astra reviewed the complete AGENTS.md diff. Exact Edit payload executed through the public adapter gate under agent:codex-guidance: registration seq 56970, policy-authorized execution.started seq 56973 and execution.completed seq 56974 (exit 0). Payload hash c558e8e158138a71a8d17abbdffa9ba7ecdb58bf171a140edeb780b082813e38. Cursor routing, approval policy, per-task review and required validation remain intact. Independent refutation is skipped for this instruction-only diff; parent policy review is complete. git diff --check exited 0. Full validation and protected evidence delivery pending.

Validation: full ci:local exited 1 on Node 26.8.2: build and lint passed; 4628 tests, 4601 passed, 26 failed, 1 skipped. Failures were confined to five suites: Node 26 rejects IP TLS server names; inherited APPROVAL_HUMAN affected identity fixtures; the Node executable location affected the read-jail fixture. Targeted rechecks with installed Node 24 and identity unset passed: adapter-email 40/40, remaining four suites 127/127 (both exit 0). No runtime code changed. Protected-path guard remains red because committed remote evidence ends before this edit. Automatic approval review rejected the standard records publication for sensitive operational metadata export; user permission requested and still pending. No records publication attempted after rejection. Worktree /private/tmp/approval-cost-conscious-guidance; branch codex/cost-conscious-agent-guidance. Next action: publish records only after explicit permission, rerun guard/local CI as needed, then complete feature PR merge. Shared primary checkout remains untouched.
<!-- SECTION:NOTES:END -->
