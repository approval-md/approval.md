---
id: APRV-14
title: Budget evaluation from the log (rolling windows)
status: To Do
assignee: []
created_date: '2026-08-05 00:59'
updated_date: '2026-08-05 01:00'
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
- [ ] #1 evaluateBudgets(records, policyLimits, action, evaluationTs) returns a per-limit verdict (limit name, window, consumed, requested, remaining, pass/fail) covering per_action_usd, daily_usd, daily_actions, and any named class limit plus global budgets, conjunctively
- [ ] #2 Windows are rolling per the amendment: events inside the 24h window preceding evaluationTs count, events outside do not — proven with boundary tests straddling the window edge and a midnight-straddling burst that a calendar-day rule would miss
- [ ] #3 Consumption is derived only from log events (execution.completed cost accounting as designed in this task; the chosen consumption events documented and flagged at review), never from any counter or index
- [ ] #4 Deterministic: same records + timestamp always yield the same verdicts; evaluationTs is a required parameter, and the evaluator never reads the clock
- [ ] #5 The SPEC section 5.2 rolling-window amendment lands verbatim in the same commit as the evaluator
- [ ] #6 Test logs are built through the real append path only
<!-- AC:END -->

## Comments

<!-- COMMENTS:BEGIN -->
created: 2026-08-05 01:00
---
Human pre-approved SPEC section 5.2 amendment (2026-08-06), verbatim: "Budget windows are rolling: a `daily` limit is evaluated over the 24 hours preceding the evaluation moment, computed solely from the event log; evaluation is deterministic given the log and the evaluation timestamp."
---
<!-- COMMENTS:END -->
