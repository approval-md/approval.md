---
id: APRV-51
title: 'M5 dogfood proof: one real deps.add flows session to phone to execution'
status: Done
assignee: []
created_date: '2026-08-05 19:34'
updated_date: '2026-08-17 15:30'
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
  state: executed
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
- [x] #1 approval register, request, wait executed by the session against the primary checkout log
- [x] #2 Grant delivered via Telegram on the human phone; token spent by approval run executing the command
- [x] #3 execution.completed on the committed log on main; approval log verify clean
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
PROOF EXECUTED 2026-08-17 (dates verified against the log ts, per the APRV-46 rule), committed to main as 7d632e5 by the human. Log seq 5 task.registered (agent:fable), 6 approval.requested deps.add -> manual with payload filed by hash 6f9b0421..., 7 envelope.drift (system:daemon: file said proposed, log said requested), 8 approval.granted by human:carter via telegram carrying payload_hash and token_sha256 only, 9 envelope.drift (granted), 10 execution.started, 11 execution.completed exit 0 (npm update @types/node: 26.1.2 -> 26.2.0 in package-lock.json), 12 envelope.drift (executed). approval log verify: clean, 12 records, head 76608f31.... approval token afterwards: token-consumed, single-use proven by the log. Operational finding: the request sat pending ~20 minutes because the daemon and listener had not yet been started when register/request ran; once started, the listener startup send delivered it immediately, so no defect. The three envelope.drift records are the signed-off 6.3 write-back deferral doing exactly what it documents: the file was never updated by the daemon, so each state change the log made was recorded as drift; M6 round-trip machinery closes that loop.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
One real deps.add flowed session -> gate -> phone -> grant -> execution -> committed public log (seq 5-12, main 7d632e5). Log verifies clean, token consumed, package-lock diff is the side effect.
<!-- SECTION:FINAL_SUMMARY:END -->
