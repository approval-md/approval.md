---
id: APRV-527
title: >-
  Study withdraw: a hosted study operator denies one pending request (approval
  study withdraw), dark behind APPROVAL_STUDY_MODE=1
status: In Progress
assignee: []
created_date: '2026-10-20 04:27'
updated_date: '2026-10-20 04:32'
labels: []
dependencies: []
priority: high
ordinal: 404000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Why: a study run on a hosted box needs its team to be able to withdraw one specific card an agent raised before it can run, so a study conversation that leads an agent to ask for a real action never reaches execution. Built on the study record (payload.study on approval.rejected, amended SPEC.md §8), stacked on the Looks wrong PR (#660, its first commit). Deny-only and pending-only; never grant, alter or reopen a decision. Off unless the process environment holds APPROVAL_STUDY_MODE exactly 1. The caller is a control plane's root exec on the box as the store's own uid; no transport publishes the verb.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval study withdraw <key>|--action-ref <12 hex> --operator <8 hex> --ref <ref> appends exactly one approval.rejected by human:study-team on channel study with payload.study {reason: study_withdrawn, operator, ref}; approval log verify passes after
- [ ] #2 A request that is not pending (granted, rejected, revoked, expired, withdrawn, never requested) is refused not-pending and the log is byte-identical: no audit.decision_refused, no lazy approval.expired
- [ ] #3 The same ref again answers idempotent:true with the earlier seq and appends nothing
- [ ] #4 A resident decision landing between the read and the append wins: not-pending with gate_code already-decided, one decision record
- [ ] #5 APPROVAL_STUDY_MODE anything but exactly 1 refuses study-mode-off before the log is read; --help answers either way
- [ ] #6 The registry marks the verb human_only; serve and MCP publish nothing for it and a serve call is refused
- [ ] #7 The Telegram listener edits a withdrawn card to WITHDRAWN BY THE STUDY TEAM / withdrawn by the study team at HH:MM UTC · nothing ran, buttons removed, no operator id; a plain reject is byte-identical to the base
- [ ] #8 study_withdraw_refusal_codes is registered (SPEC §11.2) and pinned in refusal-unions 31.0.0 with no existing expectation moved
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
core/study-withdraw.ts (switch, verified read, replay, pending check, decide reject); cli/study.ts + main.ts + help.ts + verb-registry.ts; channel-telegram.ts terminalDeliveries headline; telegram.ts TELEGRAM_STUDY_WITHDRAWN_HEADLINE; conformance harness + regen (31.0.0); SPEC §11.2 rows; docs/cli-reference.md; tests/study-withdraw.test.ts with a base-captured golden.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built as a stacked draft on #660 (S0 a19231b2 + Looks wrong 658fbe45). Decisions the diff alone does not show:
- The logic is core/study-withdraw.ts and the CLI is a thin cli/study.ts (the spec named only cli/study.ts; the CLI holds no logic here).
- --action-ref <12 hex> was added beside the spec's <action-key> positional (exactly one of the two), so a control plane never carries an action key off the box. The ref is the same 12 hex the Looks wrong stderr line prints (studyLogRefOf). action-ref-ambiguous is the refusal for more than one pending match; tested with a real 48-bit collision found once by a birthday search and pinned as a fixture.
- A decide refusal that says the LOG could not be read or written (log-unreadable, log-torn-tail, log-corrupt, append-failed) passes through under its own code instead of becoming not-pending: a control plane must be able to tell "retry" from "too late". Every other decide refusal is not-pending with gate_code.
- No audit.decision_refused on any refusal (spec §4.1 step 4). The one record a refusal can still leave is decide's own lazy approval.expired when the TTL lapses inside the read-to-append window.
- study_withdraw_refusal_codes is a registered union (SPEC §11.2), refusal-unions 31.0.0 stacked on #660's 30.0.0: the control plane branches on these strings (the relay precedent).
- Global invariants touched: human-only classes stay inert (the verb goes through decide, so class-human-only still refuses); every check-then-append goes through compare-and-append (decide's head-moved retry, tested with a racing resident tap); refusals machine-readable and distinct (new union pinned); the actor is a constant human: identity recorded with an operator digest, never an email.
- SPEC.md changes (the §11.2 preamble sentence and the new union's table) need Carter's attest together with #660's at the release.
<!-- SECTION:NOTES:END -->
