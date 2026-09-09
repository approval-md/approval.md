---
id: APRV-314
title: Codex hook integrated verification review and GitHub delivery
status: Done
assignee:
  - '@codex-astra'
created_date: '2026-09-08 07:25'
updated_date: '2026-09-08 21:47'
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
- [x] #1 Astra reviews security-sensitive diffs; focused/full tests lint typecheck conformance and CI parity have recorded results.
- [x] #2 Per-task reviewed commits are pushed in feature PR, merge armed under policy and actual GitHub state verified.
- [x] #3 Handoff has worktree branch commits PR checks gaps and morning instructions; no log artifacts in feature commits.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Review each task diff and commit only in-scope files, keeping task acceptance pending wherever native/runtime evidence is absent. 2. After patch/doctor interfaces stabilize, run focused suites then npm test, lint, typecheck, conformance and ci:local; inspect actual exits and distinguish platform restrictions from failures. 3. Conduct critical security review of full patch path union, gate organs, payload/correlation/session scope and unknown outcomes; resolve defects and rerun only affected checks. 4. Refresh origin/main without touching primary; integrate remote changes in isolated branch and retest affected code. 5. Push feature branch, open one PR listing310-315 with exact implemented coverage and blockers, arm merge under policy when review/acceptance permits, and verify GitHub checks/state. Keep primary approval records on their own delivery path. 6. Leave315 pending and hand off exact branch/worktree/commits/PR/test exits, live-evidence gaps and human activation steps.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Integration baseline refreshed: origin/main remains2391b02; primary checkout untouched. First npm test exit1:3921tests,3913pass,7fail,1skip. Fixed new corrupt-log expectation, short-hook help cap and doctor reference roster. Existing macOS scratch test now uses an outside cwd so isolated /private/tmp checkout is supported. Inherited APPROVAL_HUMAN invalidated two no-identity fixtures; clean rerun removes it. Color-positive runbook fixture now supplies env:{} instead of inheriting NO_COLOR/TERM=dumb; dedicated veto tests unchanged. Second full run progressing with only that pre-fix color assertion red; fresh final checks will follow. Source lint/typecheck exit0. Native probe/trust and SPEC evidence path remain unresolved; prepare draft PR, do not arm merge until acceptance can be established.

Final local verification at df570ea32546b7606947126ea695788acace4454: npm test exit0 (3920pass,1skip,3921total); lint/typecheck exit0; conformance exit0 (293vectors,142controls); ci:local --parallel exit0 (build,protected-path guard,3full shards,lint all0). Logs /private/tmp/aprv-314-{npm-test,conformance,ci-local}-verified.log; results /private/tmp/aprv-314-check-results.json. Node24.2.0/macOS; Linux/Node20 remain GitHub evidence. Worktree /private/tmp/approval-codex-hook branch codex/codex-hook, primary and existing worktrees preserved; no .approval artifacts in feature commits. Source commits629d52c/65e16e9/43eed40/c41537f/3b13c9a and integrationdf570ea reviewed. Next push reviewed branch and open draft PR, verify remote checks; do not arm merge while native hook/trust/outcome and protected SPEC evidence remain incomplete. APRV315 stays To Do; no activation/deployment.

Reopened final review for native-discovered execution-context gap and corrective pre-event denials. Previous green checks apply to prior head only; new code needs focused/full validation and updated GitHub checks before delivery claims.

Resumed reviewed frozen code passed full npm test exit0:3929 total,3928 pass,1skip,0fail in441s; lint0,typecheck0,conformance0(293/293,142controls). Logs /private/tmp/aprv-314-resumed-*.log and result manifest /private/tmp/aprv-314-resumed-check-results.json. Astra final source/tests/docs/fixture review has no findings. Pre-push CI parity and final GitHub state remain to be recorded.

Current reviewed implementation at f6a1f85 passed npm test exit0 (3945pass,1skip,0fail), lint0, typecheck0 and conformance0. User requested Codex attribution: the five unpublished commits above published8ad3eb1 were recreated with unchanged trees and original authors/dates, adding Co-authored-by: Codex <noreply@openai.com>; published history is intact. New IDs:6158b72,ba1239b,7afc9e0,df2ccd0,0ff895a. APRV316 commitf6a1f85 also carries the trailer. Exact SPEC material is retained and delivered separately in records PR345, commit20e2f743, auto-merge armed. PR344 metadata now documents experimental direct-patch scope, unconditional Bash refusal, native fail-open behavior and unavailable outcomes. Pre-push CI parity running; guard reported no protected changes despite SPEC diff, so Sol is investigating before that result can count as evidence. Everyday activation remains pending.

Delivery checkpoint: wrapper bypass confirmed and covered by expected-red focused script tests (build0;9pass/2fail). The two reviewed wrapper edits remain unapplied pending primary policy.edit.ci requests29937/29938. Full pre-push run exited0 but its wrapper evidence is invalid until repaired. Publish reviewed attribution/implementation commits to the existing draft PR; do not mark ready or arm feature merge while this defect remains. Uncommitted focused regressions stay in the isolated worktree awaiting the gated implementation. Next action: receive actual grants, execute the two hash-bound edits from primary, run focused wrapper/core checks, commit with Codex coauthor, deliver fresh records, rerun required CI parity and verify GitHub before readiness/merge. Everyday activation remains APRV315 pending.

Final local delivery checkpoint: full npm test passed 3,951 tests with 1 skip and 0 failures; lint, typecheck and conformance exited 0. Committed CI parity passed build, real SPEC evidence, shards 1 and 2, and lint; shard 3 had one 500 ms daemon timeout, then passed all 1,629 tests in an isolated retry. Live-draw also passed 22/22. No timeout, permission or test weakening was used. Reviewed commits 8be51ad (exact replay) and f1daf38 (accurate evidence wording) carry Codex co-author credit. Actual SPEC proof reconstructs the file from seven original authorization records in merged records PRs 345 and 347. Probe, patch protection and operator-support criteria are complete. Native Bash/outcome limitations remain APRV-311, everyday activation remains APRV-315. Publish final branch, make PR 344 ready and arm its merge under policy; verify actual GitHub results before final handoff.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Delivered experimental Codex direct-patch gating, configuration protection, operator documentation and policy-aligned CI in PR #344, merged 2026-09-08T21:45:42Z as b17d138cb279f37d6b44c5971dbb6d6787e57540 from ff455012fde28b2545fe1ede576da19333b64f0a. All PR checks and all six Node 20/22 merge-queue shards passed (runs 34280831799 and 34281532341); protected-path verification passed. Local npm test: 3951 passed, 1 skipped, exit 0; lint/typecheck/conformance exit 0. Initial CI-parity shard 3 timeout and successful isolated 1629-test retry remain documented above. Codex co-author trailers verified on GitHub. Feature worktree /private/tmp/approval-codex-hook, branch codex/codex-hook, clean at ff45501. Approval evidence delivered separately through merged PRs #345 and #347; no approval-home artifacts in feature commits. APRV-311 remains pending for trustworthy native working-directory and outcome contracts; APRV-315 remains To Do for desktop trust and real Telegram rejection/once-approval verification after those contracts exist. Bash is refused, direct patch coverage is experimental, native hook failures can fail open, and PostToolUse records no outcomes. No everyday activation or deployment occurred. Runbook: docs/codex-hook.md. Closeout records are delivered from /private/tmp/approval-codex-closeout on codex/codex-hook-closeout.
<!-- SECTION:FINAL_SUMMARY:END -->
