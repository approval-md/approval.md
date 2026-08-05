---
id: APRV-37
title: 'GitHub Actions CI: gates outside any agent hands'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 14:01'
updated_date: '2026-08-05 15:32'
labels: []
milestone: m-6
dependencies:
  - APRV-36
priority: high
type: chore
ordinal: 37000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Human addendum (2026-08-05), landing before M5 implementation. Rationale verbatim: today the gates run only in the sessions of the agents whose work they check, so verification is executed by the examined party; an executor outside any agent's hands closes that. Scope: a workflow running install, build, full test suite, lint, and typecheck on every push and pull request to any branch, from a clean checkout, Node 20 and 22 matrix; the APRV-36 tiering applies as a separate fast doc-guard job, with the full job always running on main and on any non-light diff; no secrets in any workflow file (the suite needs no credentials by design; a check asserts workflow files reference none); README badge once green. The human flips branch protection on main to require the full job once confirmed green (repository settings are theirs).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A workflow runs install, build, full tests, lint, typecheck from a clean checkout on every push and PR to any branch, Node 20 and 22 matrix
- [x] #2 The tier classifier gates a separate fast doc-guard job; the full job runs unconditionally on main and on any non-light diff, with classification computed in CI, never asserted by the author
- [x] #3 No workflow file references any secret; a repo test asserts workflow files contain no secrets references
- [x] #4 README carries the CI badge once the workflow is green on main; the human is flagged to flip branch protection
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented by Opus subagent; fable review found nothing to override. Hardening beyond the brief, accepted: github context reaches the shell only as env vars (a branch name is attacker-shaped input and must never become shell syntax); permissions contents:read (the read-only complement to no-secrets); the classifier output re-validated in-shell with unrecognized values failing closed to full; cancel-in-progress disabled on main; a second --json step makes the verdict auditable without being able to influence it. The guard test parses the workflow with parseHardenedYaml (third surface dogfooding the hardened parser; YAML 1.2 core is what keeps on: a string key rather than 1.1's boolean true), asserts no secrets. reference in tree or raw text, the tier sourced solely from the classifier step, the unconditional push-to-main rule ordered before any classifier invocation, no github.event.* interpolation, and that the workflow file itself classifies full via .github/**. Node 20 caveat checked: nothing 22-only; matrix stays [20,22]. FOR THE HUMAN: badge reads no-runs-yet until this push; confirm green then flip branch protection — note doc-guard and full are mutually exclusive by tier, so require classify as the always-present check (main pushes are always full by rule 1). Verified locally: 949/949, lint, typecheck.

Date corrected in place per the 2026-08-05 human ruling (log-is-authoritative, applied to all APRV-46 findings): prose previously claimed 2026-08-10; this task's own created_date (2026-08-05) is the cited source. The wrong date was orchestrator confabulation, part of the systematic drift reported in APRV-46.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
.github/workflows/ci.yml: classify -> doc-guard|full with push-to-main unconditionally full, Node 20/22 matrix from clean checkouts, zero secrets enforced by a 10-test guard that parses the workflow with the repo's own hardened YAML parser. README badge added. Verified locally: 949/949.
<!-- SECTION:FINAL_SUMMARY:END -->
