---
id: APRV-51
title: 'M5 dogfood proof: one real deps.add flows session to phone to execution'
status: To Do
assignee: []
created_date: '2026-08-05 19:34'
labels: []
milestone: m-7
dependencies:
  - APRV-49
priority: high
type: chore
ordinal: 51000
approval:
  origin:
    app: manual
    created_by: 'agent:fable'
  route:
    assignee: 'agent:fable'
    rationale: 'M5 dogfood proof ordered by the human at the 2026-08-05 review stop'
  state: proposed
  actions:
    - class: deps.add
      summary: 'npm update @types/node in /Users/carter/dev/approval-md (refresh within the ^26 range; package-lock.json is the diff)'
      reversible: true
      est_cost_usd: 0
      idempotency_key: 'aprv-51:deps-refresh:2026-08-05'
      payload_hash: '6f9b042133d9b1f0a66e4566c901acc255bdbe3a6b45162893fca4ed430ce85e'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The APRV-49 end-to-end proof, as its own task file because this file IS the artifact: it carries the approval envelope the proof registers, requests, and executes against. The action is real: refresh @types/node within the ^26 range (npm update @types/node), a genuine registry interaction of class deps.add, manual under APPROVAL.md. The full runbook lives in docs/dogfood-cutover.md. The envelope payload binds argv+cwd per SPEC 6.2; grant approves exactly that command in exactly that directory.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval register, request, wait executed by the session against the primary checkout log
- [ ] #2 Grant delivered via Telegram on the human phone; token spent by approval run executing the command
- [ ] #3 execution.completed on the committed log on main; approval log verify clean
<!-- AC:END -->
