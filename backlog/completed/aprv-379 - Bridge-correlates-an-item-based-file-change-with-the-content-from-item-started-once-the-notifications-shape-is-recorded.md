---
id: APRV-379
title: >-
  Bridge correlates an item-based file change with the content from
  item/started, once the notification's shape is recorded
status: Done
assignee:
  - '@claude'
created_date: '2026-09-19 14:10'
updated_date: '2026-09-19 20:29'
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
- [x] #1 The item/started shape for a file-change item is recorded in docs/codex-app-server-bridge.md from a real capture or a source read, before any code
- [x] #2 An item-based file-change request whose content the bridge recorded is classified against that content and the registered payload binds the content sha256 beside the paths
- [x] #3 A request whose content cannot be produced from the bridge own record stays declined under bridge-file-change-unbound, and a correlation that matched the wrong item is impossible or refused (say which)
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. AC1 first, no code: write the observed item/started and item/completed frames, the request key paths and the API form into docs/codex-app-server-bridge.md (question 1, the patch request) under an observed (2026-09-19) marker, saying which readings the capture supports and which (update, delete) it does not.

2. src/cli/hook.ts, the APRV-363 branch inside describeToolCall. codexFileChanges accepts the item-based ARRAY of {path, kind, diff} as well as the legacy map of path to change; describeCodexFileChanges normalises both into (declared path, change) entries and is otherwise unchanged: one class per path (protectedPathClass or files.write.workspace), the payload binds changes VERBATIM in the shape they arrived with, content_sha256 over them as received, nothing re-rendered and nothing parsed out of diff. The blanket refusal of an absolute path is replaced by the containment check that already follows it, because the observed item frame names absolute paths and an absolute path inside the directory the server named is exactly as placeable as a relative one; a path outside it is still hook-io.

3. src/cli/codex-bridge.ts, the correlation. An item index (Map of item id to {type, changes, threadId, turnId, completed}) is kept for the thread life; every item/started records its item and every item/completed marks it. On item/fileChange/requestApproval the itemId is correlated to that index and the frame changes are fed to the same describeToolCall branch through decideFileChangeRequest.

4. The refusals. Existing bridge-file-change-unbound covers: no item/started for that itemId, an item that is not a fileChange, and a fileChange frame carrying no readable changes. Thread and turn MUST match the frame (a request naming a different thread or turn than the frame it would bind is a correlation this client cannot establish, so it is unbound). A NEW code bridge-file-change-already-completed for an item whose item/completed arrived BEFORE the request: a change applied before it was asked about is not something this client can decide, and the repair differs from a missing frame, so it is its own code.

5. The directory. The item-based request carries no cwd and grantRoot was null in the capture, so the item-based path falls back to the workspace THIS CLIENT named on thread/start after cwd and grantRoot. That is this client own binding rather than a guess or a server claim, and containment still decides: an absolute change path outside it is refused. The legacy path is untouched and keeps its bridge-request-unbound.

6. tests/fixtures/codex-app-server-stub.mjs gains notification script entries ({notify, params}) so a case can send item/started, then the request, then item/completed in the observed order.

7. tests/codex-bridge.test.ts: the happy path (started, request, decision, completed) for an ordinary path and for a protected path (payload binds paths and content_sha256); each refusal (no frame, wrong item type, thread mismatch, turn mismatch); the timestamp-order case (completed before the request). The old bridge-file-change-unbound test keeps its code and loses its APRV-379 detail assertion.

8. Conformance: refusal-unions gains bridge-file-change-already-completed, vectors_version 17.0.0 (a union growth is a changed expectation, so major), with the reasoning comment the file keeps. npm run conformance.

9. docs/codex-app-server-bridge.md usage section and docs/cli-reference.md refusal list; the task notes carry what was decided; build, typecheck, lint, test.
<!-- SECTION:PLAN:END -->

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

OBSERVED, codex-cli 0.155.0, run by Carter 2026-09-19T20:08Z (probe scratch results.json on the operator machine; the approve-patch trial APRV-379 added to the probe). Recorded verbatim, and docs/codex-app-server-bridge.md carries the same.

THE APPROVAL REQUEST. method item/fileChange/requestApproval; params key paths grantRoot, itemId, reason, startedAtMs, threadId, turnId. No cwd, no command bytes, NO patch content, no decisions advertised. API form: item-based, itemId = exec-57f5bb5e-45de-4100-ae6b-0867086606ff.

THE CONTENT ARRIVES EARLIER, on item/started with params.item.type === "fileChange":

{"method":"item/started","params":{"item":{"type":"fileChange","id":"exec-57f5bb5e-45de-4100-ae6b-0867086606ff","changes":[{"path":"/var/folders/.../workspaces/approve-patch/probe-patch-marker.txt","kind":{"type":"add"},"diff":"patched\n"}],"status":"inProgress"},"threadId":"01a0bb49-...","turnId":"01a0bb49-...","startedAtMs":1789848549897},"emittedAtMs":1789848549898}

item/completed repeats the SAME item with status: "completed" (completedAtMs 1789848549947).

READINGS THE ABOVE SUPPORTS, and the ones it does not:
- changes is an ARRAY of {path, kind: {type}, diff}, not the map of path to change the legacy applyPatchApproval carries. The path is ABSOLUTE.
- for an add, diff is the file content. For update and delete the shape is UNOBSERVED. Nothing here parses diff; it is carried as the change bytes as received.
- other item types seen on the wire: userMessage, agentMessage (with phase), plus turn/diff/updated and serverRequest/resolved notifications.
- grantRoot was null in the 2026-09-18 capture and the key is present in the 09-19 key paths; no cwd on the request either way.

WHAT WAS BUILT AND DECIDED (lane, 2026-09-19).

AC1 first, before any code: docs/codex-app-server-bridge.md question 1 gains a subsection with the verbatim item/started frame, the request key paths, the API form, and an explicit list of what the capture does and does not support.

THE DESIGN, option (a) as extended by APRV-363, per the orchestrator ruling.
- src/cli/hook.ts: codexFileChanges now accepts the item-based ARRAY of {path, kind, diff} as well as the legacy map of path to change, and describeCodexFileChanges normalises both through codexChangePaths. One describer, one answer to what is this call, for both APIs. The payload carries the change set in the shape it arrived in, with content_sha256 over it as received; nothing reads diff or kind.
- The blanket refusal of an absolute path is gone; the containment check that already followed it decides. The observed frame names ABSOLUTE paths, and an absolute path inside the directory is exactly as placeable as a relative one. A path outside is still hook-io, whichever way it is spelled. This is the one behaviour change to the APRV-363 path and it narrows nothing.
- src/cli/codex-bridge.ts: an ItemIndex (Map of item id to {type, changes, threadId, turnId, completed}) is kept for the THREAD life and written from every item/started and item/completed notification, above the request dispatch and above every phase test. item/completed marks completed and does NOT refresh the recorded change set: the frame this client decides against is the one it held when the question arrived (pinned by its own test).

THE REFUSALS, and the three judgement calls in them.
1. TURN AND THREAD MUST MATCH. Decided yes: a request naming a thread or turn the frame does not is bridge-file-change-unbound. Item ids are server-minted and observed unique, so this should never fire, and that is why it is checked rather than assumed. Absence is not disagreement: a frame or request naming NEITHER field is not held to it, and the observed frames carry both.
2. A DISTINCT CODE for completed-before-request: yes, bridge-file-change-already-completed. Unbound says the content could not be produced; this says it WAS produced and the order was wrong. The repairs differ (a missed frame or a changed protocol versus a session not under the pinned approval policy), which is the same reasoning APRV-362 used for bridge-command-unbound.
3. THE DIRECTORY. The item-based request carries no cwd and grantRoot was null in both captures, so the item-based path falls back after cwd and grantRoot to the workspace THIS CLIENT named on thread/start. That is this client own binding rather than a guess or a server claim, and it widens nothing: the observed paths are absolute, every path is resolved against that directory, and one landing outside is refused hook-io (its own test). The LEGACY path is untouched and still refuses bridge-request-unbound without a directory.

NO SPEC, SCHEMA OR PROTECTED-PATH EDIT was needed, as expected. docs/ is not a protected path in APPROVAL.md (SPEC.md, design/, .github/workflows/ are).

CONFORMANCE: refusal-unions vectors_version 16.0.0 to 17.0.0, a major bump because the vector pins the whole array in definition order. Regenerated through scripts/regen-conformance-vectors.mjs; npm run conformance is 402/402 with 167 controls.

TESTS, all through the stub app-server in the observed shape. The stub gained notification script entries ({notify, params}) so a case can send item/started, the request, and item/completed in the order the probe recorded. Ten cases: the happy path for an ordinary path (accepted, execution.started, no approval.requested); the protected path (registered as policy.edit, payload binds the array verbatim with content_sha256, hook-timeout); a path outside the workspace (hook-io); each unbound case (no frame, wrong item type, empty change set, thread mismatch, turn mismatch); the timestamp-order case (bridge-file-change-already-completed, nothing appended); and the completion-does-not-overwrite case.

GLOBAL INVARIANTS TOUCHED (SPEC section 11.1): invariant 4 (self-reported fields never reduce scrutiny) is the one this task lives next to, and it holds: nothing in the correlation comes from a caller-supplied description, the change set comes from a server frame, and the directory fallback is a value this client itself sent on thread/start. Invariant 7 (refusals machine-readable and distinct) gains a member, pinned by the closed-vocabulary test and the conformance union. Nothing appends on any refusal path, checked by a before/after log comparison in every refusal test.

VERIFICATION: npm run build, npm run typecheck, npm run lint all clean. npm run conformance 402/402. Full npm test: 4802 tests, 4779 pass, 22 fail, exit 1; all 22 are the pre-existing local SMTP suite failures on Node v26.8.2 (CI runs Node 22). The codex-bridge suite alone: 52 tests, 52 pass, exit 0.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The item-based file-change request is now correlated to the item/started frame its itemId names, and decided against that frame content through the same describeToolCall branch APRV-363 built for the legacy inline map. AC1 landed first: docs/codex-app-server-bridge.md carries the verbatim 0.155.0 item/started frame, the request key paths and the API form, with what the capture does and does not support stated. The bridge keeps every item the thread announces for the thread life; the change set reaches the classifier in the shape the server sent it (an array of {path, kind, diff}, absolute paths), each path takes its protected class or files.write.workspace, and the payload binds the changes verbatim with content_sha256 over them as received. Nothing is re-rendered and nothing parses diff. Five ways the correlation can fail are declines rather than resolutions in favour of going ahead: no item/started for that id, an item that is not a fileChange, an empty change set, and a frame belonging to another thread or turn are all bridge-file-change-unbound, and an item whose item/completed arrived before the question is the new bridge-file-change-already-completed (refusal-unions 17.0.0). Verified by ten new cases against the stub app-server in the observed shape, covering the happy path, each refusal and the timestamp order; codex-bridge suite 52/52 exit 0, conformance 402/402, build, typecheck and lint clean. Full npm test is 4779/4802 with 22 pre-existing local SMTP failures on Node 26.
<!-- SECTION:FINAL_SUMMARY:END -->
