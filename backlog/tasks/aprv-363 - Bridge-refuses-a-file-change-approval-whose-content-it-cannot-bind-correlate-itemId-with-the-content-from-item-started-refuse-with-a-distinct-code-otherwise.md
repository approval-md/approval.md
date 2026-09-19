---
id: APRV-363
title: >-
  Bridge refuses a file-change approval whose content it cannot bind: correlate
  itemId with the content from item/started, refuse with a distinct code
  otherwise
status: Done
assignee:
  - '@claude'
created_date: '2026-09-18 01:30'
updated_date: '2026-09-19 14:20'
labels:
  - codex
  - bridge
dependencies:
  - APRV-361
priority: high
ordinal: 280000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From docs/codex-app-server-bridge.md follow-up 3 (APRV-349). Observed 2026-09-18: item/fileChange/requestApproval carries only itemId, threadId, turnId, startedAtMs, reason null and grantRoot null; no patch content and no cwd. The content arrives earlier on a different notification. A client that approves the identifier approves a reference, not bytes. The bridge must correlate the itemId with the content it recorded from item/started (or the turn diff), classify that content, and refuse with a distinct machine-readable code when the correlation cannot be made or the recorded content is absent.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A LEGACY applyPatchApproval, whose fileChanges arrive inline on the request, is classified against that content (the paths it changes, through the same protected-path rules every harness uses) and the registered payload binds the sha256 of the content AS RECEIVED beside those paths; nothing is re-rendered and no correlation is made
- [x] #2 An item-based item/fileChange/requestApproval, which carries an identifier and no content, stays declined under bridge-file-change-unbound exactly as today, and that code is in the conformance refusal union
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
NOT STARTED as code by lane 4 (2026-09-19), escalated with the options below. What the lane established first, so the next session does not repeat it.

WHAT IS MISSING BEFORE ANY CODE. The shape of the frame the content arrives on is not recorded anywhere in this repository. docs/codex-app-server-bridge.md states that the content is delivered earlier on the item/started notification for the file-change item and that the approval request refers to it by itemId, and the 2026-09-18 observation records the REQUEST fields exactly (itemId, threadId, turnId, startedAtMs, reason null, grantRoot null) and says nothing about the notification. AC1 cannot be implemented against a shape nobody wrote down, and inventing one would be the second-worst outcome here: a correlation that silently matches nothing.

THE DESIGN QUESTION, which is why this is not a mechanical task. classifyApplyPatch and parseApplyPatch (src/core/apply-patch.ts) take one exact apply_patch ENVELOPE (Begin Patch, Add/Delete/Update File, End Patch) and the Codex item API carries a fileChanges MAP of path to change (add content, delete, update with a unified diff and an optional move). Turning the map into an envelope is a RE-RENDERING, which is the exact hazard APRV-362 exists for on the command side: the bytes classified would be bytes this client wrote, not bytes the server sent.

THE OPTIONS.
(a) CLASSIFY THE PATHS, BIND THE BYTES. Do not re-render. Classify each path in the recorded change set through protectedPathClass and the file-write classes, exactly as the hook classifies a file tool, and bind {itemId, paths, sha256 of the recorded content as it arrived} in the payload. Nothing is invented, and the human sees the paths and the digest. The cost: no hunk-level evidence, so a grant covers a path rather than a diff, which is weaker than what the protected-path guard gets from an Edit.
(b) RE-RENDER TO AN ENVELOPE AND ROUND-TRIP IT. Build an apply_patch envelope from the change set, classify it with the existing machinery, and refuse with a distinct code when the envelope does not reproduce the received change set field for field. Strongest evidence, and the most surface: it is a second implementation of Codex patch semantics inside this project, and every future change to their format is a silent divergence until something refuses.
(c) STAY REFUSED on the item-based API, and implement the correlation only for the legacy applyPatchApproval, whose params carry fileChanges INLINE on the request (v1.rs:138-150), so there is no correlation to get wrong at all. Smallest and most honest; it leaves the item-based API, which is the one the observed server speaks, exactly where it is today.

A FOURTH THING TO DECIDE UNDER ANY OF THEM: whether the bridge may reuse the hook decision path for a file change at all. decideHarnessCall derives its classes from describeToolCall, whose only Codex file-tool branch is apply_patch and wants the envelope; (a) needs a way to hand the hook pre-computed classes, and adding one is a change to the hook shared by every harness, which is a bigger decision than this task.

WHAT DOES NOT NEED A RULING: AC2 is already satisfied in shape. bridge-file-change-unbound exists, is emitted today for every file-change request, and is already in the bridge_refusal_codes conformance union; after this task it narrows to "no correlated content", which is a description change in the vectors rather than a new code.

DONE 2026-09-19 by lane 4, branch lane/bridge-legacy-patch-363, under the orchestrator ruling (c) of 2026-09-19.

WHAT CHANGED. A legacy applyPatchApproval is now DECIDED rather than declined. Its fileChanges map rides on the request, so there is nothing to correlate and nothing is re-rendered: src/cli/hook.ts describeToolCall gained a branch for an apply_patch call carrying a CHANGE MAP instead of an envelope, which classifies each path it names through protectedPathClass and the workspace-write class (the file tools own rule, not a second one) and binds {tool, rule, cwd, paths, content_sha256, changes}. src/cli/codex-bridge.ts routes such a request through the same decideHarnessCall the exec half uses.

WHERE THE DESCRIPTION LIVES, and why it matters. The classes are computed INSIDE describeToolCall rather than handed to the hook by the bridge. The alternative considered (a described override on DecideInput) would have let a caller choose the classes its own call is judged under, which is the party under oversight choosing its own scrutiny (SPEC section 11.1 invariant 4). One describer, one answer to what is this call.

WHAT THE DIFF HIDES. The HookInput the bridge builds carries command beside file_changes, holding the change CANONICAL JSON. That is identity, not content: the Codex adapter derives one task id per call from the call own bytes (hook-codex.ts codexBinding), and a call with no such string throws. Canonical so the same change is the same call whatever key order the server used. Nothing classifies it and nothing executes it; the classification is built from the map and the payload a human sees is the map. Also: a change naming an absolute path, or one that resolves outside the directory the server named, is refused hook-io before any class is computed, because a classification against the wrong tree is the failure the hook exists to prevent.

SCOPE, as ruled. The item-based item/fileChange/requestApproval stays declined under bridge-file-change-unbound, unchanged, and the correlation is APRV-379, filed with the factual blocker in the orchestrator words: the shape of the item/started frame is recorded nowhere here, a correlation written against a guessed shape silently matches nothing, and closing it needs a probe capture on Carter Codex login or a source read that an agent lane may not perform (a network read beyond gh is a manual class here). The refusal detail and the doc now point at 379 rather than at this task.

NO NEW REFUSAL CODE and no conformance change: bridge-file-change-unbound already existed and is already in the union; what changed is which requests reach it. bridge-request-unbound covers a map with no directory, which is the same fact an exec request with no cwd carries.

INVARIANTS. Nothing in SPEC section 11 is weakened. Self-reported fields never reduce scrutiny: the paths come from the server frame and are classified against the directory the server named, and the only widening possible is a protected class being ADDED. Fail closed: no directory, no map, or an unplaceable path each refuse before anything is appended, and the tests assert the log did not grow.

VERIFICATION. build, typecheck, lint clean. node --test dist/tests/codex-bridge.test.js: 18 tests, 18 pass, exit 0 (four new, one reworded). npm test: 4715 tests, 4692 pass, 22 fail, exit 1, the same pre-existing Node v26 SMTP and email adapter failures.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The legacy applyPatchApproval, whose fileChanges map rides on the request, is now decided through the same hook path an exec request takes: classified by the paths it names (protected class or files.write.workspace, the file tools own rule) and registered with a payload carrying those paths, the change verbatim and content_sha256 over the map as it arrived. Nothing is correlated and nothing is re-rendered into an apply_patch envelope, so the bytes judged are the bytes the server sent. The item-based request, which carries an identifier and no content, stays declined under bridge-file-change-unbound; its correlation is APRV-379, blocked on a frame shape nobody has recorded. Verified by four new cases in tests/codex-bridge.test.ts driving the real CLI against the stub: a protected path registers a manual request whose stored payload carries the paths and the digest, an ordinary path is answered without a human, a path resolving outside the server directory is refused hook-io with nothing appended, and a map with no directory is bridge-request-unbound.
<!-- SECTION:FINAL_SUMMARY:END -->
