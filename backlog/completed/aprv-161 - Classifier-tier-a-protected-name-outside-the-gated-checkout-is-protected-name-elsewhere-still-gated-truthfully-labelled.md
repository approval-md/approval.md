---
id: APRV-161
title: >-
  Classifier tier: a protected name outside the gated checkout is
  protected-name-elsewhere, still gated, truthfully labelled
status: Done
assignee: []
created_date: '2026-08-30 21:47'
updated_date: '2026-08-30 23:35'
labels: []
dependencies: []
ordinal: 138000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Protected-path matching is filename-based and unanchored, so a scratchpad demo APPROVAL.md classifies identically to an edit of the live policy: class policy.edit, rule protected-path, and a prompt note claiming the edit targets the LIVE checkout. Carter reads every prompt as a policy edit because the message says so even when the target is a scratch file. Fix the label, keep the gate: file-tool targets whose resolved path is outside the primary checkout gate exactly as before (class stays policy.edit, autonomy manual) but carry a distinct rule, protected-name-elsewhere, and a summary/note that states plainly the target is a file NAMED like a policy file, not this repo's live policy. Fail closed: unresolvable root or no git means the live-tier loud treatment. Shell/Bash-segment classification stays live-loud (classifyCommand is pure, no cwd); record that as deliberate. Class deliberately stays policy.edit so APRV-151's proposed log cross-check keyed on policy.edit grants is unaffected and no APPROVAL.md vocabulary amendment is needed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A file-tool protected match resolved under the primary checkout (outside agent worktrees) keeps rule protected-path and current summary/note wording
- [x] #2 A match under .claude/worktrees/<name>/ keeps rule protected-path-proposal, unchanged
- [x] #3 A match whose resolved path is not under the primary root carries rule protected-name-elsewhere, class policy.edit, and a summary beginning with the tier ("file named like a policy file, outside this gated checkout: <tool> <file>")
- [x] #4 The hook verdict note for the elsewhere tier names the gated checkout root and states the file is named like a policy file, not the live policy, and gates because the name is protected wherever it sits
- [x] #5 When the primary root cannot be resolved (no git), classification falls back to the live protected-path tier (fail closed)
- [x] #6 protectedPathView (wysiwys) accepts protected-name-elsewhere in PROTECTED_RULE_NAMES so the computed protected_path row shows the true rule; the hashed note branch in changeRegionText is NOT touched in this task
- [x] #7 The elsewhere tier applies to all file-tool protected matches: bare PROTECTED_FILENAMES, .approval/ segments, .claude/settings*, and policy protected_paths entries
- [x] #8 tests/cli-hook.test.ts covers all three tiers plus the no-git fallback; tests/channels-contract.test.ts accepts the new rule and still rejects invented rules
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read src/cli/hook.ts proposalWorktree (:777+), fileToolGate (:850-901), verdict note (:1775-1779) and src/core/git-scope.ts primaryRoot.
2. Refactor proposalWorktree into tierOf(target, cwd) -> {rule, worktree|null}: proposal (under <root>/.claude/worktrees/), elsewhere (resolved path not under root), live (under root, or root unresolvable - fail closed). Add rule constant protected-name-elsewhere.
3. Third summary arm leading with the tier; third verdict-note arm naming the root and the named-like-a-policy-file fact.
4. Add the rule to PROTECTED_RULE_NAMES in src/core/wysiwys.ts (protectedPathView only; the hashed note branch is deferred to APRV-162).
5. Tests: cli-hook tier cases incl. no-git fallback and symlink resolution; channels-contract accepts the new rule, still rejects invented ones.
6. npm test + lint; implementation notes record the deliberate live-loud shell-segment scope.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built 2026-08-30 by an Opus subagent, reviewed by fable. proposalWorktree became tierOf(target, cwd) -> {rule, worktree, root}: one primaryRoot resolution, three outcomes, fail closed on every axis (unresolvable root or target -> live; the proposal test runs before the root comparison so a symlinked worktrees dir stays a proposal). Class stays policy.edit for all tiers; only the rule and prose change (APRV-151 log cross-check on policy.edit grants unaffected). summaryFor/fileTierNote extracted; elsewhere note names the resolved checkout root. PROTECTED_RULE_NAMES in wysiwys.ts gained the rule so protectedPathView shows it; the hashed changeRegionText note branch keys on startsWith("protected-path") independently and is deliberately untouched — the elsewhere qualifier lands in APRV-162 with the version bump. Shell/Bash-segment classification stays live-loud by design: classifyCommand is pure (no cwd/disk) and a wrong "elsewhere" would soften a live edit. Deviation from AC #8 wording: the tier tests live in tests/cli-hook-scope.test.ts, where every existing tier fixture (APRV-124) already lives; cli-hook.test.ts untouched. The verdict note only rides allow verdicts, so its wording is pinned via a policy making policy.edit autonomous; the deny path pins class and gate separately. In-scope addition: docs/claude-code-hook.md and docs/cursor-hook.md enumerate the rule vocabulary and listed two tiers; both gained the third, since a doc describing the labels this task makes truthful must not itself be stale. Session note: the live policy went unattested mid-task (gate refused everything); Carter re-attested before finalization. 2406 tests pass, oxlint clean.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
A protected name resolving outside the gated checkout now carries rule protected-name-elsewhere with a summary and verdict note saying it is a file NAMED like a policy file, not the live policy; still gated as policy.edit, fail closed to live-tier when git cannot prove otherwise. Verified by tier tests in cli-hook-scope.test.ts (elsewhere/live/proposal/no-git, wording pinned) and channels-contract (rule survives to the computed line, invented rules still rejected); full suite 2406/2406, lint clean.
<!-- SECTION:FINAL_SUMMARY:END -->
