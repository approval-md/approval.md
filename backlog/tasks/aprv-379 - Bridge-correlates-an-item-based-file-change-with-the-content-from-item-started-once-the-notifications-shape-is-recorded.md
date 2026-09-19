---
id: APRV-379
title: >-
  Bridge correlates an item-based file change with the content from
  item/started, once the notification's shape is recorded
status: To Do
assignee: []
created_date: '2026-09-19 14:10'
updated_date: '2026-09-19 19:23'
labels:
  - codex
  - bridge
dependencies:
  - APRV-363
priority: medium
ordinal: 293000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Split from APRV-363 on the orchestrator ruling of 2026-09-19 (option c): 363 binds the LEGACY applyPatchApproval, whose fileChanges arrive inline, and leaves the item-based request declined under bridge-file-change-unbound. This task is the item-based half.

THE FACTUAL BLOCKER, and it is why this is not startable today. The shape of the frame the content arrives on is recorded nowhere in this repository. docs/codex-app-server-bridge.md says the content is delivered earlier on the item/started notification for the file-change item and that the approval request refers to it by itemId, and the 2026-09-18 observation records the REQUEST fields exactly (itemId, threadId, turnId, startedAtMs, reason null, grantRoot null) while saying nothing about the notification. A correlation written against a guessed shape silently matches nothing, which is worse than the refusal it replaces. Closing this needs a probe run that captures an item/started for a file-change item (billable on Carter Codex login) or a source read of v2/item.rs. NOTE: an agent lane must not fetch that source itself; a network read beyond gh on this repository is a manual class here.

THE DESIGN CHOICE, once the shape is known.
(a) CLASSIFY THE PATHS, BIND THE BYTES. Classify each path in the recorded change set through protectedPathClass and the file-write classes, and bind {itemId, paths, sha256 of the content as it arrived}. Nothing is invented. The cost is that a grant covers a path rather than a hunk, which is weaker evidence than an Edit gives the protected-path guard. This is the shape APRV-363 landed for the legacy request, so following it here keeps one answer rather than two.
(b) RE-RENDER TO AN apply_patch ENVELOPE and refuse unless the envelope reproduces the received change set field for field, which buys hunk-level evidence at the price of a second implementation of Codex patch semantics living in this repository.

UNDER (a) THERE IS A THIRD THING: decideHarnessCall derives its classes from describeToolCall, whose only Codex file-tool branch wants an apply_patch envelope. APRV-363 added the branch inside describeToolCall that reads an inline change map instead of an envelope; this task should extend that branch rather than growing a second one. There is deliberately no caller-supplied description to reach for: a caller that could hand the hook its own classes would be the party under oversight choosing its own scrutiny (SPEC section 11.1 invariant 4).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The item/started shape for a file-change item is recorded in docs/codex-app-server-bridge.md from a real capture or a source read, before any code
- [ ] #2 An item-based file-change request whose content the bridge recorded is classified against that content and the registered payload binds the content sha256 beside the paths
- [ ] #3 A request whose content cannot be produced from the bridge own record stays declined under bridge-file-change-unbound, and a correlation that matched the wrong item is impossible or refused (say which)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
CORRECTION (lane 4, 2026-09-19, orchestrator accepted): the description above says APRV-363 added a SEAM that lets a caller hand the hook a description it computed itself. It did not, and the difference matters. APRV-363 added a BRANCH inside describeToolCall in src/cli/hook.ts, for an apply_patch call carrying a change map instead of an envelope. There is deliberately no caller-supplied description: a caller that could hand the hook its own classes would be the party under oversight choosing its own scrutiny (SPEC section 11.1 invariant 4). This task extends that branch rather than using a seam that does not exist.

PROBE CAPTURE ADDED (lane, 2026-09-19, branch lane/probe-item-frames-379). The probe now records the two facts this task is blocked on, so the next step is a human one and the task stays To Do.

WHAT CHANGED in scripts/probes/codex-app-server.mjs:
- Every item/started, item/updated and item/completed notification is stored VERBATIM (through the same redact walk) per trial in results.json under item_notifications, each entry { at, method, item_type, carries_content, verbatim }. The old item_started_with_content boolean is kept and unchanged.
- A sixth trial, approve-patch, asks Codex to create the marker file with its file editing tool and forbids the shell for that file, so the server reaches a FILE-CHANGE item rather than a command item. It is outside the leak, hold and void verdict logic: approve is still the only positive control, and the four refusal trials are measured against exactly what they were before.
- Each file-change approval request records api_form, one of: legacy (inline change set), item-based (itemId, content delivered earlier), both (inline content AND itemId), unknown. It is read from the request key paths rather than from the method name, so a renamed method still reports honestly.
- --report prints, per trial, the item notification methods, the item types and whether any carried content; then the API form line; then the verbatim file-change frame itself.

WHAT CARTER RUNS, in order, from the primary checkout (/Users/carter/dev/approval-md), once this is on main:

  node scripts/probes/codex-app-server.mjs --setup
  node scripts/probes/codex-app-server.mjs --run
  node scripts/probes/codex-app-server.mjs --report

No new flag is needed: --run does all six trials. To spend one billable turn instead of six, run node scripts/probes/codex-app-server.mjs --run --trial approve-patch instead of the plain --run. The report then prints VOID for the APRV-349 interception verdict, because the approve control did not run; that is correct and says nothing about the capture this task needs.

The run uses the existing Codex login and is a billable model call. --setup prints the scratch root; results.json lands at <root>/results.json, and --report prints that same path near the end.

WHAT TO PASTE INTO THIS TASK, from the report:
1. The block under the heading "file-change item frames, verbatim" (the whole item/started frame). That is AC1, and it is the shape the correlation gets written against.
2. The line under the heading "file-change approval, which API arrived". That is the second fact: legacy inline change set versus item-based itemId.
If the report prints NONE under the frames heading, the model used the shell anyway or never reached a file change. The errors and warnings section printed above it says why, and nothing should be written against a guess.

AC1 remains open after the run: the shape still has to be written into docs/codex-app-server-bridge.md before any bridge code.
<!-- SECTION:NOTES:END -->
