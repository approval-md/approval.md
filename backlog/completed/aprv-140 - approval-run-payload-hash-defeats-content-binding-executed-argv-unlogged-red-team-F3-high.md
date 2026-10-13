---
id: APRV-140
title: >-
  approval run --payload-hash defeats content binding; executed argv unlogged
  (red-team F3, high)
status: Done
assignee: []
created_date: '2026-08-25 13:41'
updated_date: '2026-08-26 20:27'
labels:
  - security
  - execute
  - cleanroom-review
dependencies:
  - APRV-138
references:
  - ../approval-md-redteam (findings-report.md
  - F3)
  - src/cli/execute.ts
  - src/core/execute.ts
  - src/core/token.ts
priority: high
type: bug
ordinal: 127000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
CONFIRMED and verified. src/cli/execute.ts ~398-407: when --payload-hash is present, runPayloadHash(childArgv, cwd) is never called; the supplied hash flows straight into presentedPayloadHash and consumeToken only checks presented-vs-grant (src/core/token.ts ~618), never presented-vs-actual-argv. So presenting the grants own hash while spawning arbitrary argv succeeds. Contradicts SPEC section 10.4: adapters and approval run MUST recompute the hash of the payload they are about to execute. It is a deliberate adapter door (comments and tests cli-resolve.test.ts assert the override), but on the same approval run verb with no gate distinguishing adapter from agent. Separately, the executed argv is logged nowhere: execution.started carries only class and est_cost_usd (src/core/execute.ts, src/core/token.ts), completion records only exit code, and the --json summary echoes the presented hash, so the audit trail records approved bytes when different bytes ran.

Also closes the residual left open by APRV-138 (F1): off the manual path no payload_hash binds execution to approved content, so a fresh key under an autonomous class plus approval run <key> -- <anything> is unauthenticated arbitrary execution. Extend the non-manual execute path to require and bind payload_hash (reuse payload-mismatch).

Fix direction: always recompute runPayloadHash and require any --payload-hash to equal it, or gate the override behind a distinct adapter-only path; record executed argv+cwd in execution.started; bind payload_hash on the non-manual path. SPEC section 6.2 amendment (extend the payload_hash MUST beyond manual) flagged for sign-off.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 approval run recomputes the payload hash from the argv and cwd it will spawn and refuses when a supplied --payload-hash differs, or the override is gated behind a distinct adapter path not reachable as a plain agent invocation
- [x] #2 execution.started records the executed argv and cwd (or a hash the operator can reproduce), so the log reflects what actually ran
- [x] #3 The non-manual execute path requires and binds payload_hash, reusing payload-mismatch; the APRV-138 residual test that pinned arbitrary-argv execution is flipped to assert refusal
- [x] #4 SPEC section 10.4 and section 6.2 amended (recompute on every execute path; payload_hash MUST beyond manual), marked for human sign-off
- [x] #5 npm test passes; lint clean
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built 2026-08-26, merged in PR #130. Direction chosen for AC 1: strict recomputation, adapter door DELETED from approval run — adapters hash their own bytes and call core directly, were never reachable as a plain run invocation, so the flag was pure hole. run always computes runPayloadHash(argv, cwd); a supplied --payload-hash is a check refused payload-mismatch before spawn and before any append. Non-manual path requires and binds payload_hash against the registered declaration (undeclared refuses); APRV-138's residual test flipped to four refusal-plus-bind assertions. AC 2 satisfied by the hash rather than raw argv, deliberately: command lines carry secrets and §11.1 keeps them out of the log; the recomputation guarantee makes the recorded hash operator-reproducible. SPEC §6.2/§10.4 amended pending sign-off, human-approved through the gate. The e2e-demo test was itself modelling the hole and now approves the command it runs. Merge note: reconciled twice (WYSIWYS, then string-money+conformance); the conformance vectors regenerated for the new codes in the same resolution.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
approval run executes only bytes whose hash it recomputed itself; the override flag is a check, the adapter door is gone, and every execution.started names the hash of what ran. The last red-team high (F3) closed; merged in PR #130.
<!-- SECTION:FINAL_SUMMARY:END -->
