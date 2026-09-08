---
id: APRV-314
title: Codex hook integrated verification review and GitHub delivery
status: In Progress
assignee:
  - '@codex-astra'
created_date: '2026-09-08 07:25'
updated_date: '2026-09-08 08:42'
labels: []
dependencies:
  - APRV-311
  - APRV-312
  - APRV-313
priority: high
type: task
ordinal: 232000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
User-authorized overnight Codex integration. SPEC 6.3,7,9,10,11.1 bind. Isolated code/tests/delivery now; everyday activation and human decisions only in morning. No deployment, credentials, dependencies or production policy/log mutation.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Astra reviews security-sensitive diffs; focused/full tests lint typecheck conformance and CI parity have recorded results.
- [ ] #2 Per-task reviewed commits are pushed in feature PR, merge armed under policy and actual GitHub state verified.
- [ ] #3 Handoff has worktree branch commits PR checks gaps and morning instructions; no log artifacts in feature commits.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Review each task diff and commit only in-scope files, keeping task acceptance pending wherever native/runtime evidence is absent. 2. After patch/doctor interfaces stabilize, run focused suites then npm test, lint, typecheck, conformance and ci:local; inspect actual exits and distinguish platform restrictions from failures. 3. Conduct critical security review of full patch path union, gate organs, payload/correlation/session scope and unknown outcomes; resolve defects and rerun only affected checks. 4. Refresh origin/main without touching primary; integrate remote changes in isolated branch and retest affected code. 5. Push feature branch, open one PR listing310-315 with exact implemented coverage and blockers, arm merge under policy when review/acceptance permits, and verify GitHub checks/state. Keep primary approval records on their own delivery path. 6. Leave315 pending and hand off exact branch/worktree/commits/PR/test exits, live-evidence gaps and human activation steps.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Integration baseline refreshed: origin/main remains2391b02; primary checkout untouched. First npm test exit1:3921tests,3913pass,7fail,1skip. Fixed new corrupt-log expectation, short-hook help cap and doctor reference roster. Existing macOS scratch test now uses an outside cwd so isolated /private/tmp checkout is supported. Inherited APPROVAL_HUMAN invalidated two no-identity fixtures; clean rerun removes it. Color-positive runbook fixture now supplies env:{} instead of inheriting NO_COLOR/TERM=dumb; dedicated veto tests unchanged. Second full run progressing with only that pre-fix color assertion red; fresh final checks will follow. Source lint/typecheck exit0. Native probe/trust and SPEC evidence path remain unresolved; prepare draft PR, do not arm merge until acceptance can be established.
<!-- SECTION:NOTES:END -->
