---
id: APRV-359
title: >-
  Codex app-server probe: a run whose approve control produced no approval
  request and no effect is reported void, never as a hold
status: Done
assignee:
  - '@claude'
created_date: '2026-09-18 00:19'
updated_date: '2026-09-19 09:39'
labels:
  - probe
  - codex
  - bug
dependencies: []
priority: medium
ordinal: 276000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
On 2026-09-18 the probe ran five trials against codex-cli 0.152.1 with ~/.codex/config.toml pinning model gpt-6-astra. Every turn ended in task_complete with a 400 (the model requires a newer Codex) before any tool call, so zero approval requests were recorded and no marker landed anywhere, including the approve control. The report still printed the hold sentence (No effect landed on deny, crash, no-reply or malformed... silence and refusal both held), which is a false positive: a run that never reached a tool call proves nothing about interception. The verdict must be conditioned on the approve control having asked and landed, and the turn error text (the error notification and task_complete.error) must be captured in results.json so the reader does not have to open Codex rollouts to learn why.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 When the approve trial records zero approval requests or lands neither marker, the report prints a VOID verdict naming the reason and never prints the hold sentence
- [x] #2 The error and warning notification payloads, and any task_complete error, are stored verbatim (redacted) per trial in results.json and printed in the report
- [x] #3 The existing leak (FAILURE TO BLOCK) path is unchanged and still fires when a must-not-execute trial lands a marker
- [x] #4 Unit coverage for the three report outcomes: hold, leak, void
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Capture the diagnosis: a turn_errors field per trial, filled by carriesTrouble, which matches the method name AND the payload so a task_complete whose body carries a 400 is recorded even though its method says nothing.
2. Condition the verdict: voidReason asks whether the approve trial asked AND landed a marker; a run that fails that test prints VOID with the reason and never the hold sentence.
3. Leave the leak path alone and check it first, so evidence of a failure outranks the absence of evidence.
4. Print the errors and warnings block above the verdict, so the reason a run saw nothing is in the report rather than in the Codex rollouts.
5. Unit coverage driving buildReport and carriesTrouble directly for hold, the three void shapes, leak over void, and payload-shaped trouble.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
PR #451, commit 92cf2ad, armed with gh pr merge 451 --merge (autoMergeRequest enabledAt 2026-09-19T09:39:04Z, method MERGE). Branched from origin/main at 2a8de2b.

What was done. scripts/probes/codex-app-server.mjs gains two pure functions, both exported for the tests: voidReason, which asks whether the approve trial both asked and landed a marker, and carriesTrouble, which decides whether a notification carries an error or a warning. Each trial record gains turn_errors, filled verbatim and redacted. buildReport prints an errors and warnings block above the verdict, and the verdict is now three-way: leak first, then void, then hold.

Decisions. (1) The leak outranks the void. A run can be void AND leak, and the 2026-09-18 shape would have been void; a leak is positive evidence of a failure to block while a void is the absence of evidence about anything, so the leak sentence is printed and the void is not. (2) carriesTrouble matches the PAYLOAD as well as the method name, because the failure this task exists for arrived as a task_complete whose method said nothing. It is deliberately eager, in the manner of redactString: a routine notification recorded here costs a reader one extra block, and one that is missed costs a run. (3) The three outcomes are unit-tested against buildReport directly rather than through three more stub servers. A run that cannot reach a tool call is exactly the shape no stub can produce on purpose, and the report is a pure function of the results file, so the results file is the honest input. The five existing spawned-stub cases are untouched and still pass, which is what keeps AC3 honest.

Global invariants (SPEC section 11.1). None touched. This is a probe: it writes no log record, mints no class and changes no verdict. Invariant 3 (no raw secrets) is unchanged and still enforced by redact, which every new recording passes through; a test already asserts no token-shaped string reaches results.json.

Validation. npm run build, npm run typecheck, npm run lint clean. probe-codex-app-server: 9 tests, 9 pass (five existing spawned-stub cases plus four new). npm test 4668 tests, 4645 pass; the 22 failures are the SMTP and email adapter suites, which fail on this laptop under Node v26 (Setting the TLS ServerName to an IP address is not permitted, against the 127.0.0.1 mock) and are untouched by this diff. node scripts/protected-path-guard.mjs --base origin/main --head HEAD: no protected paths changed.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The probe no longer reports a hold it did not earn. The four must-not-execute trials are a control group, so their silence means refusal held only against an approve trial that asked and landed; when that control did not work the report prints VOID with the reason and never the hold sentence, and the leak path is checked first and unchanged. Every error and warning notification, including a task_complete carrying a 400 whose method says nothing, is now recorded verbatim per trial and printed, so the reason a run saw nothing is in the report rather than in the Codex rollouts. Verified by four new unit cases over buildReport and carriesTrouble covering hold, the three void shapes, leak over void, and payload-shaped trouble, with the five existing stub-server cases unchanged. PR #451, armed.
<!-- SECTION:FINAL_SUMMARY:END -->
