---
id: APRV-141
title: >-
  Harness supervised/autonomous executions are unbudgeted and unsampled
  (red-team F6, medium)
status: To Do
assignee: []
created_date: '2026-08-25 13:41'
labels:
  - security
  - observability
  - cleanroom-review
dependencies: []
references:
  - ../approval-md-redteam (findings-report.md
  - F6 and F7)
  - src/cli/hook.ts
  - src/core/budgets.ts
  - src/core/audit.ts
priority: medium
type: bug
ordinal: 128000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
CONFIRMED and verified; distinct from APRV-137 GAP-4. The Claude Code hook appends no execution.started for supervised or autonomous classes (src/cli/hook.ts ~1075-1090 and ~1343-1350: nothing is appended). Budget consumption reads only approval.granted and execution.started (src/core/budgets.ts ~24-45,87), and audit sampling draws candidates only from execution.started and only for supervised autonomy (src/core/audit.ts ~162-183). So harness-executed non-manual actions consume zero budget (including daily_actions) and are never sampled by the retrospective overseer. Under Claude Code that is the majority of real activity. APRV-137 GAP-4 asks which log moment consumes budget and presumes such a record exists; this task is that on the harness path no such record is written.

Decide-and-document: either (a) append a lightweight record on harness supervised/autonomous allow so consumption and sampling count them, weighed against the comment rationale that writing one per agent action fills the log; or (b) a SPEC statement that harness-executed non-manual actions are outside budget and audit scope, with the blind-spot tradeoff written down. Also worth stating (F7, informational): the verifier treats byte-format changes, duplicate-key lines, and unanchored tail truncation per the documented hash-covers-canonical-content boundary; add one clarifying sentence.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A written decision records option a or b with the log-volume vs blind-spot tradeoff
- [ ] #2 If a: harness supervised/autonomous allow appends a record that budget consumption and audit sampling both count; tests assert a harness autonomous action is charged and is sampleable
- [ ] #3 If b: SPEC states harness-executed non-manual actions are out of budget/audit scope, marked for human sign-off, and cross-references APRV-137 GAP-4
- [ ] #4 One sentence added (here or in APRV-137) stating the verifier byte-format/duplicate-key/tail-truncation boundary (F7)
- [ ] #5 npm test passes; lint clean
<!-- AC:END -->
