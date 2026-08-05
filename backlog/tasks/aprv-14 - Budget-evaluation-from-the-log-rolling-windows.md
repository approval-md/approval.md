---
id: APRV-14
title: Budget evaluation from the log (rolling windows)
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 00:59'
updated_date: '2026-08-05 01:12'
labels: []
milestone: m-3
dependencies: []
priority: high
type: feature
ordinal: 14000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC.md section 5.2: budgets are conjunctive (class limits AND global budgets) and consumption is computed from the log, never from a mutable counter. The human has pre-approved (2026-08-06) the rolling-window amendment recorded verbatim in this task's comments: daily limits are evaluated over the 24 hours preceding the evaluation moment, deterministically, from the log alone — rolling rather than calendar-day so a burst straddling midnight cannot reset its own tripwire. This task builds the pure evaluator the gate (APRV-16) calls before admitting any action: given (log path or parsed records, policy limits, action est_cost_usd, evaluation timestamp) return per-limit pass/fail with machine-readable detail. Deterministic core: the evaluation timestamp is a parameter, never read from the clock inside the evaluator. The section 5.2 amendment lands in the same commit as the evaluator.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 evaluateBudgets(records, policyLimits, action, evaluationTs) returns a per-limit verdict (limit name, window, consumed, requested, remaining, pass/fail) covering per_action_usd, daily_usd, daily_actions, and any named class limit plus global budgets, conjunctively
- [x] #2 Windows are rolling per the amendment: events inside the 24h window preceding evaluationTs count, events outside do not — proven with boundary tests straddling the window edge and a midnight-straddling burst that a calendar-day rule would miss
- [x] #3 Consumption is derived only from log events (execution.completed cost accounting as designed in this task; the chosen consumption events documented and flagged at review), never from any counter or index
- [x] #4 Deterministic: same records + timestamp always yield the same verdicts; evaluationTs is a required parameter, and the evaluator never reads the clock
- [x] #5 The SPEC section 5.2 rolling-window amendment lands verbatim in the same commit as the evaluator
- [x] #6 Test logs are built through the real append path only
- [x] #7 Consumption is commitment-based: authorization events count (grant on the manual path; the execution-authorizing event on supervised/autonomous paths, chosen and documented in this task), completion never does; rejected and expired requests consume nothing — each covered by tests
- [x] #8 Named test: N grants inside the window with zero completions trip daily_actions at N
- [x] #9 The second amendment sentence ("Budgets meter authorization, not completion; an authorized action consumes budget whether or not it ultimately executes.") lands verbatim in the same commit
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/core/budgets.ts: pure evaluateBudgets(records, policy limits+budgets, action {class, est_cost_usd}, evaluationTs) -> per-limit verdicts, conjunctive.
2. Consumption = authorization events: approval.granted (manual); supervised/autonomous authorization event chosen here (design: execution.started as the authorizing record on non-manual paths, documented + flagged at review); rejected/expired consume nothing.
3. Rolling 24h window: ts in (evaluationTs - 24h, evaluationTs]; boundary + midnight-burst tests; N-grants-zero-completions named test.
4. Both SPEC 5.2 amendment sentences verbatim, same commit.
5. Opus subagent (isolated worktree, parallel with APRV-15); fable reviews, merges, gates, finalizes.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented by Opus subagent in isolated worktree; fable review found nothing to override. Both amendment sentences landed verbatim in the section 5.2 budgets bullet, same commit. The consumption contract for APRV-16 is documented prominently in the module header: only approval.granted and execution.started consume; the gate MUST record payload.est_cost_usd and payload.class on both; started counts only when the window holds no grant with the same action_key; rejected/expired/revoked/completed/failed never consume. Accepted design decisions: half-open window (evaluationTs-24h, evaluationTs] so windows tile; class-limit consumption scoped by the matched RULE PATTERN via the real matcher (a financial.* daily_usd is one shared bucket, not per-class buckets that silently multiply the ceiling); all named budget scopes evaluated, not just global; fail-closed set incl. unknown limit names, non-finite ceilings, unparseable evaluationTs, class daily limits with no pattern, and events with unparseable ts kept IN the window (cannot be proven outside); 1e-6 USD rounding applied identically to comparison and reported figures; deterministic verdict ordering. Named test present: 5 grants zero completions — 5th passes remaining 0, 6th fails consumed 5. Verified on merged tree: 440/440, lint, typecheck green.
<!-- SECTION:NOTES:END -->

## Comments

<!-- COMMENTS:BEGIN -->
created: 2026-08-05 01:00
---
Human pre-approved SPEC section 5.2 amendment (2026-08-06), verbatim: "Budget windows are rolling: a `daily` limit is evaluated over the 24 hours preceding the evaluation moment, computed solely from the event log; evaluation is deterministic given the log and the evaluation timestamp."
---

created: 2026-08-05 01:05
---
Human-settled (2026-08-06): consumption is commitment-based. Second SPEC section 5.2 amendment sentence, verbatim: "Budgets meter authorization, not completion; an authorized action consumes budget whether or not it ultimately executes." Lands in the same commit as the rolling-window sentence and the evaluator.
---
<!-- COMMENTS:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
src/core/budgets.ts: pure commitment-based budget evaluator over rolling 24h windows with conjunctive class-pattern-scoped and global verdicts, fail-closed unknowns, and the documented consumption contract APRV-16 must honor; both human-approved section 5.2 sentences same-commit. 29 tests incl. the named N-grants case and midnight-straddling burst. Verified: 440/440, lint, typecheck.
<!-- SECTION:FINAL_SUMMARY:END -->
