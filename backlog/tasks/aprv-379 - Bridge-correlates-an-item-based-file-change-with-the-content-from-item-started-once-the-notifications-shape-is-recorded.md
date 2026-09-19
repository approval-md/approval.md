---
id: APRV-379
title: >-
  Bridge correlates an item-based file change with the content from
  item/started, once the notification's shape is recorded
status: To Do
assignee: []
created_date: '2026-09-19 14:10'
updated_date: '2026-09-19 15:03'
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
<!-- SECTION:NOTES:END -->
