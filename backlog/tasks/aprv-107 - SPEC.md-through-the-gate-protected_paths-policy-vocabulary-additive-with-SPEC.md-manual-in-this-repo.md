---
id: APRV-107
title: >-
  SPEC.md through the gate: protected_paths policy vocabulary (additive) with
  SPEC.md manual in this repo
status: Done
assignee:
  - '@fable'
created_date: '2026-08-19 17:15'
updated_date: '2026-08-19 17:42'
labels:
  - policy
  - hook
  - spec
milestone: m-11
dependencies: []
priority: medium
ordinal: 99000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Human decision 2026-08-19: SPEC.md is the design source of truth and agents have been editing it on feature branches with a "flagged for sign-off" note that APRV-103 found is invisible in the file itself. It should go through the gate prospectively (manual, not sampled: amendments are rare and should be signed before they merge). TODAY: the protected set is hard-coded in src/core/command-class.ts PROTECTED_FILENAMES (APPROVAL.md, APPROVALS.md, CLAUDE.md, AGENTS.md, .npmrc) plus .approval/, .claude/settings*, .github/workflows; isProtectedPath maps them to policy.edit; the hook gates Edit/Write tools and shell redirects by the same function. The policy itself cannot name a file. DESIGN: (1) policy vocabulary policy.protected_paths: a list of repo-relative path globs (SPEC 5.2 grammar decision for the builder: exact paths and trailing-slash directory prefixes; no negation), ADDITIVE to the built-ins and never subtractive, so a policy cannot un-protect APPROVAL.md (fail closed); schema + SPEC 5.2 same commit, fixtures both ways; isProtectedPath takes the loaded policy list (pure, tested); the hook and the classify verb pass it. (2) This repo: APPROVAL.md gains protected_paths: [SPEC.md] next to policy.edit, applied by the human through approval policy amend (agents never edit the policy); the amend ceremony attests it. (3) Docs: claude-code-hook.md deny table and CLAUDE.md Permissions summary ("Require approval first" gains SPEC.md; CLAUDE.md is the human file, drafted in the notes). Consequence accepted: any builder touching SPEC.md waits on a phone tap; pair with APRV-106 so an abandoned wait retires cleanly. ALTERNATIVE REJECTED: adding SPEC.md to the hard-coded list (works for this repo, but other repos have other constitutions; policy vocabulary is the product answer).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 policy.protected_paths accepted by the schema (exact paths and directory prefixes), additive to the built-in set; a policy that tries to list fewer than the built-ins still protects them (test)
- [x] #2 isProtectedPath honours the policy list; hook classify and hook claude-code gate shell writes, redirects and Edit/Write tools on the listed paths as policy.edit
- [x] #3 SPEC 5.2 amended in the same commit as the schema (flagged); fixtures both ways; docs/claude-code-hook.md updated; CLAUDE.md Permissions line drafted in the notes for the human
- [x] #4 A proposed APPROVAL.md hunk (protected_paths: [SPEC.md]) is recorded in the notes for the human to apply with approval policy amend; npm test and lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, worktree from main, parallel with 106 (minimal hook.ts touch). 2. policy.protected_paths: exact paths and directory prefixes, no globs or negation, schema-validated, additive to the built-ins (fail closed, tested). 3. isProtectedPath pure matcher takes the policy list; classify and the hook FILE_TOOLS path thread it; hook classify reads the policy. 4. SPEC 5.2 sentence, flagged. 5. Fixtures both ways; docs. 6. Report carries the APPROVAL.md hunk and CLAUDE.md line for the human. 7. PR by branch, auto-merge; records here.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Opus subagent build, PR by branch aprv-107-protected-paths (#87). isProtectedPath(candidate, extra?) and classifyCommand(command, protectedPaths?) stay pure (no disk, no clock); parseProtectedEntry/matchesEntry helpers. Matching: built-ins first; a directory entry (trailing slash) matches its segments as a contiguous run anywhere; an exact entry matches the candidate trailing segments, so a bare SPEC.md matches docs/SPEC.md too, mirroring the built-in filenames (fail closed: a false positive costs one prompt, a false negative costs the property); multi-segment entries stay strict. Hook loads policy BEFORE classification (what counts as policy.edit is a policy question); ungated tools pass through before the load; hook classify gained --dir/--policy; a policy that fails to load leaves the built-ins in force while everything resolves manual. SPEC 5.2 bullet added (Amended APRV-107), flagged for the human. Fixtures: valid protected-paths, invalid glob, invalid escape. 15 new tests (matcher, classifier, hook incl. classify --dir scoping and no-policy fallback). 1836 tests, lint and typecheck clean. FOR THE HUMAN, not applied by agents: APPROVAL.md between approvers and classes: "protected_paths:            # widens policy.edit; the built-ins hold regardless" then "  - SPEC.md", applied via approval policy amend; CLAUDE.md Permissions, Require approval first, last bullet becomes: Edits to APPROVAL.md, .approval/, CLAUDE.md, SPEC.md, or CI/release config.

Merged at 18b1a40 (PR #87). The APPROVAL.md hunk and CLAUDE.md line remain for the human; until applied, SPEC.md is NOT yet gated in this repo.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
policy.protected_paths vocabulary (additive, fail closed, no globs), threaded through the classifier and the hook; SPEC 5.2 amended and flagged; the repo's own policy hunk (protected_paths: [SPEC.md]) recorded for the human to apply via policy amend. PR #87 merged at 18b1a40; 1836 tests, lint, typecheck.
<!-- SECTION:FINAL_SUMMARY:END -->
