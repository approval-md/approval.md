---
id: APRV-139
title: >-
  Hook autonomous fast path skips attestation and loop-escalation (red-team F2,
  high)
status: To Do
assignee: []
created_date: '2026-08-25 13:41'
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
- [ ] #1 The hook autonomous and supervised allow paths verify policy attestation before allowing, and fail closed (to manual, or deny) on not-attested or hash-mismatch policy
- [ ] #2 The hook consults loop-escalation before a non-manual allow, matching core/execute.ts
- [ ] #3 Test reproduces an allow under an edited-unattested policy and asserts it now denies or routes to manual
- [ ] #4 SPEC section 11.1 scope note: state whether the attestation-required list names the hook enforcement surface, marked for human sign-off
- [ ] #5 npm test passes; lint clean
<!-- AC:END -->
