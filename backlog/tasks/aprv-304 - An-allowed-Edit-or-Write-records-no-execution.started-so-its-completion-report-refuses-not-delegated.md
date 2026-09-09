---
id: APRV-304
title: >-
  An allowed Edit or Write records no execution.started, so its completion
  report refuses not-delegated
status: In Progress
assignee:
  - '@codex-sol'
created_date: '2026-09-08 04:35'
updated_date: '2026-09-09 03:49'
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
1. Remove hardcoded ordinary-file passthrough from the shared normal hook path. Keep the existing fileToolGate classifier and full Edit/Write payload binding; use the matched APPROVAL.md autonomy, attestation, budgets and loop floor exactly as Bash does. An allowed normal file mutation must record execution.started, and its post hook closes that runtime-authored start. 2. Remove the ordinary-file shortcut from the open-window path so authorized bypasses record gate.bypassed before allow. Preserve existing human-only, log-mutation and malformed-command boundaries. 3. Keep finishHarnessExecution unchanged. Only after its precise not-delegated refusal may the CLI acknowledge one exact verified gate.bypassed record matching harness kind, tool, session, tool-use ID, execution directory and recomputed full payload hash. Missing or ambiguous binding remains a visible refusal; acknowledgement appends no outcome and does not claim a delegated execution completed. Parent owns the narrow SPEC amendment for this counterpart and reconciliation of stale M8 accounting prose. 4. Test ordinary Edit/Write pre/post and failure outcomes, every autonomy level, exact payload changes, duplicate delivery, missing/wrong identifiers, unknown tool/outcome, protected paths, corrupt/unavailable logs and loop floors. Test exact recorded bypass acknowledgement versus mismatches without changing Bash execution behavior. 5. Update Claude hook documentation, run focused hook/regression checks plus build/lint/typecheck, then coordinate a full suite. Parent reviews the diff, processes protected SPEC edits and separate records delivery, commits with Codex co-author, opens/arms PR and verifies CI/merge.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-09-09 checkpoint: reviewed implementation proposal is at /private/tmp/aprv304-review-proposal/APRV304-rejected-source.patch with README.md. Automatic approval review rejected the first source patch as a security-critical hook accounting change requiring explicit APRV-304 authorization. No implementation source or SPEC change was applied. The exact proposal has been presented to Carter; awaiting reply. Preserve normal failure diagnostics and require exactly one verified, fully bound gate.bypassed record before acknowledging an unstarted completion. No execution outcome may be fabricated.
<!-- SECTION:NOTES:END -->
