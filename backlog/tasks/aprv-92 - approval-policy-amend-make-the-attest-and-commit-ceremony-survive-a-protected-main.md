---
id: APRV-92
title: >-
  approval policy amend: make the attest-and-commit ceremony survive a protected
  main
status: To Do
assignee: []
created_date: '2026-08-18 17:45'
labels:
  - cli
  - dogfood
dependencies: []
priority: medium
type: feature
ordinal: 85000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-08-18 (APRV-83): amend attested cleanly, printed 'now land the edit and its attestation as ONE commit' with git add/commit lines, and the human's push to main was rejected by branch protection (required status check ci). The rule is right (policy and its attestation must not be separable) but the ceremony assumes direct pushes to main, as does docs/dogfood-cutover.md. Make it foolproof: (1) detect a protected default branch (gh api or a --branch flag) and offer to commit on a branch, push, and open a PR that contains exactly that commit, printing 'merge with a merge commit'; (2) when not on a branch and the push is likely to fail, say so before the human types git push; (3) rewrite the ONE-commit paragraph so a first-time user understands what to type and why (today it reads as a warning aimed at insiders); (4) update docs/dogfood-cutover.md's log-touching-commit guidance for protected main.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 amend --branch <name> (or an interactive offer) commits policy+log on a branch, pushes, and opens a PR containing that single commit
- [ ] #2 amend's post-attest text explains the one-commit rule in plain words and names the PR path when main is protected
- [ ] #3 docs/dogfood-cutover.md describes the protected-main flow
- [ ] #4 npm test and lint pass
<!-- AC:END -->
