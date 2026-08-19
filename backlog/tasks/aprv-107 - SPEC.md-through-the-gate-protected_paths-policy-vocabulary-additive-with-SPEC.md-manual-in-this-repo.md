---
id: APRV-107
title: >-
  SPEC.md through the gate: protected_paths policy vocabulary (additive) with
  SPEC.md manual in this repo
status: To Do
assignee: []
created_date: '2026-08-19 17:15'
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
- [ ] #1 policy.protected_paths accepted by the schema (exact paths and directory prefixes), additive to the built-in set; a policy that tries to list fewer than the built-ins still protects them (test)
- [ ] #2 isProtectedPath honours the policy list; hook classify and hook claude-code gate shell writes, redirects and Edit/Write tools on the listed paths as policy.edit
- [ ] #3 SPEC 5.2 amended in the same commit as the schema (flagged); fixtures both ways; docs/claude-code-hook.md updated; CLAUDE.md Permissions line drafted in the notes for the human
- [ ] #4 A proposed APPROVAL.md hunk (protected_paths: [SPEC.md]) is recorded in the notes for the human to apply with approval policy amend; npm test and lint clean
<!-- AC:END -->
