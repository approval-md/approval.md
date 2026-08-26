---
id: APRV-139
title: >-
  Hook autonomous fast path skips attestation and loop-escalation (red-team F2,
  high)
status: Done
assignee: []
created_date: '2026-08-25 13:41'
updated_date: '2026-08-26 17:39'
labels:
  - security
  - hook
  - cleanroom-review
dependencies: []
references:
  - ../approval-md-redteam (findings-report.md
  - F2)
  - src/cli/hook.ts
  - src/core/execute.ts
  - src/core/attest.ts
priority: high
type: bug
ordinal: 126000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
CONFIRMED and verified against source. The Claude Code hook autonomous fast path (src/cli/hook.ts ~1343-1351) allows when every class resolves autonomous, reading on-disk APPROVAL.md, with no checkAttestation and no isLoopEscalated. This is asymmetric with the runtimes own non-manual executor (src/core/execute.ts ~477-487), which enforces both for the same classes. Consequence: an edited-but-valid unattested policy (attestation status hash-mismatch or not-attested) is fully trusted by the hook for allow, nothing appended, and because the harness executes the tool call directly on allow, core/execute.ts attestation check is never reached. Whoever can write the policy file (a merge, a second agent, a branch checkout) reclassifies any class to autonomous and the hook lets the command through. The supervised fast path (hook.ts ~1075-1090) has the same shape. SPEC.md states the intent this breaks: an edited policy is inoperative until a human re-attests it.

Fix direction: before the autonomous/supervised allow, verify attestation and loop-escalation (both require reading the log, so the existing log-unreachable deny must move above the fast path); fail closed to manual on unattested or hash-mismatch policy. Decide whether a hook that cannot reach the log denies outright.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The hook autonomous and supervised allow paths verify policy attestation before allowing, and fail closed (to manual, or deny) on not-attested or hash-mismatch policy
- [x] #2 The hook consults loop-escalation before a non-manual allow, matching core/execute.ts
- [x] #3 Test reproduces an allow under an edited-unattested policy and asserts it now denies or routes to manual
- [x] #4 SPEC section 11.1 scope note: state whether the attestation-required list names the hook enforcement surface, marked for human sign-off
- [x] #5 npm test passes; lint clean
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Builder observation 2026-08-26, filed as its own task: harness loop-escalation is near-vacuous per-invocation (task id minted per tool call, no failure signal from the harness); session-scoped streaks are the follow-up design. Second observation, recorded here: register does not check attestation (only request/decide/consumeHarnessGrant do), so task.registered can land under an unattested policy via the manual path; harmless today because the request that follows refuses, and it is the asymmetry that justified 139's guard denying directly rather than routing through gateAndWait.

Built 2026-08-26, merged in PR #127 (commit 56a6de2 plus merge 2291438). unattendedGuard verifies attestation and loop-escalation against the VERIFIED log before any non-manual verdict; the log-unreachable deny moved above the fast paths; the task id is minted once so escalation and registration name the same task. Accepted builder deviation, argued on the PR: the guard denies with the gate's frozen codes (hook-gate-refused:policy-not-attested / loop-escalated) instead of routing to gateAndWait, because under an unattested policy the manual path reaches the byte-identical refusal plus a junk task.registered under an inoperative policy; recovery (policy attest) is GATE_SELF_CLASS and unaffected. SPEC §11.1 invariant 1 scope note added (pending sign-off, human-approved through the gate). F2's attack reproduced and pinned: an on-disk reclassification to autonomous under an attested-then-edited policy now denies with nothing appended. Merge note: the conflict with PR #126 forced startHarnessExecution onto the readPolicyOnce pattern, composing 139 with 142.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The hook's unattended verdicts (autonomous and all-supervised allows) verify policy attestation and loop-escalation against the verified log and fail closed; the F2 policy-edit bypass reproduces as a deny. Merged in PR #127.
<!-- SECTION:FINAL_SUMMARY:END -->
