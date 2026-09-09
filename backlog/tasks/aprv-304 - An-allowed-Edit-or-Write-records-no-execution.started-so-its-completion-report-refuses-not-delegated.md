---
id: APRV-304
title: >-
  An allowed Edit or Write records no execution.started, so its completion
  report refuses not-delegated
status: In Progress
assignee:
  - '@codex'
created_date: '2026-09-08 04:35'
updated_date: '2026-09-09 19:37'
labels:
  - harness
dependencies: []
ordinal: 224000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Since APRV-303 the post-execution hook surfaces its refusals at exit 2. Every Edit/Write tool call on an unprotected file now prints post-tool-gate-refused:not-delegated, because the pre-execution path allows the ordinary edit outright without appending an execution.started, so the completion has nothing to close. Harmless (the edit ran, nothing is appended), but it is noise on every edit and it means allowed edits never appear in the log as executions at all, while allowed Bash calls do.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The pre-execution path records an execution.started for an allowed Edit/Write on an unprotected file the same way it does for an allowed Bash call, or the design decision not to is written in SPEC 10.1 and the post path exits 0 quietly for that case; one of the two, stated in the notes
- [ ] #2 No not-delegated line on an ordinary Edit in a Claude Code session; a test in tests/cli-hook.test.ts covers PreToolUse allow followed by PostToolUse for an Edit through the real append path
- [ ] #3 docs/claude-code-hook.md describes what an allowed edit leaves in the log
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Remove ordinary Edit/Write passthrough from the shared hook description and both closed/open-window early returns; reuse existing policy, human-only, loop, budget, registration and execution paths. 2. Add real append-path Pre/Post tests for Edit and Write, manual and human-only restrictions, budgets, payload changes, duplicate reports and open-window bypass evidence, preserving Bash and protected-path behavior. 3. Update hook documentation; parent separately reviews the stale SPEC M8 autonomous-accounting sentence through the primary gate. 4. Run focused tests, then integrated full suite, lint/typecheck and CI parity, deliver reviewed task commit and PR. Do not add replayable quiet acknowledgement of bypassed posts.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-09-09 checkpoint: reviewed implementation proposal is at /private/tmp/aprv304-review-proposal/APRV304-rejected-source.patch with README.md. Automatic approval review rejected the first source patch as a security-critical hook accounting change requiring explicit APRV-304 authorization. No implementation source or SPEC change was applied. The exact proposal has been presented to Carter; awaiting reply. Preserve normal failure diagnostics and require exactly one verified, fully bound gate.bypassed record before acknowledging an unstarted completion. No execution outcome may be fabricated.

Fresh user authorization to handle all outstanding tasks explicitly picks up this task. Read-only review found a policy bypass beyond missing accounting: closed ordinary-file passthrough skips manual/supervised/budget checks; open-window passthrough precedes even the human-only check and emits no required gate.bypassed. Existing SPEC requires those checks. Prior scratch bypass-ack proposal rejected for missing replay consumption and incomplete actor/version binding. New isolated tree /private/tmp/approval-file-policy-enforcement, branch codex/file-policy-enforcement, base23a343a; old tree preserved. Sol owns hook source, tests and public hook docs; Astra owns protected amendments, task records and delivery.

Implemented and parent-reviewed: ordinary Edit/Write now uses the shared policy and execution path. Real append-path tests cover autonomous/supervised starts and completed/failed posts, manual waiting, human-only denial including an open window, budgets, payload binding, and duplicate outcome refusal. Open-window actions remain gate.bypassed records with visible unstarted-post diagnostics; the prior quiet-acknowledgement proposal was not implemented. Exact SPEC M8 correction completed through the primary gate at outcome seq30168. Fresh full npm test exit0: 4036 tests, 4035 passed, 1 skipped, 0 failed. Focused harness tests 146/146 exit0. Lint, typecheck, conformance (293 vectors, 142 controls), and diff checks exit0. Delivery remains pending; keep In Progress until GitHub confirms delivery.
<!-- SECTION:NOTES:END -->
