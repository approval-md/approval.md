---
id: APRV-516
title: >-
  A rejection recorded between two hook posts is not delivered to the next
  identical post: findHarnessCarry carries a grant or a pending question, never
  a rejection
status: To Do
assignee: []
created_date: '2026-10-16 17:55'
labels:
  - hook
  - gate
dependencies: []
priority: medium
ordinal: 394000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-09-29 in the hosted hermetic demo (approval-md-hosted docs/handoffs/2026-09-29-core-issues-to-file.md item 2): the hosted shim posts the same envelope repeatedly until the harness cap. A grant between two posts is adopted by the next post; a rejection between two posts is not, and the next post opens a new approval.requested, so the approver is asked again for an action they just refused. Enforcement holds (nothing runs). Cause on main: HarnessCarryKind is "pending" | "granted" (src/core/gate.ts:3522) and findHarnessCarry (src/core/gate.ts:3645-3724) skips a rejected derivation, so the hook falls through to a fresh request. The in-process wait already reports hook-rejected (src/cli/hook.ts:5340); only the re-post path loses it.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A byte-identical re-post (same payload_hash, class, execution harness) inside the rejected request's window returns a block with its own machine-readable code and appends nothing
- [ ] #2 Test: reject between post 1 and post 2; post 2 blocks; the log holds one approval.requested and one approval.rejected; log verify passes
- [ ] #3 The window a rejection sticks for is stated (the request's TTL or the hook's wait plus grace) in docs/claude-code-hook.md and docs/hermes-hook.md, with a SPEC hunk drafted in the notes if §11.2 needs the code
<!-- AC:END -->
