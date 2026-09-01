---
id: APRV-196
title: >-
  Telegram listener: callback acks and duplicate suppression, so a restart is
  not a bombardment
status: To Do
assignee: []
created_date: '2026-09-01 04:31'
labels:
  - channels
  - ux
dependencies: []
priority: high
ordinal: 163000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Incident 2026-09-01, during the APRV-182..185 wave: with 5-6 pending policy.edit requests, every listener restart re-sent the full pending queue (documented behavior, SPEC 10.3: channels hold no state that is truth), the human reported being bombarded, approve buttons generally getting stuck, and taps on pre-restart duplicate messages silently doing nothing. Three real grants DID land, so the pipeline works; the experience is the failure. The human's workaround was the CLI channel (approval grant / approval channel cli --interactive), which unblocked the wave.

Scope to design within the SPEC 10.3 constraint (no channel state that is truth): (a) ack every Telegram callback query immediately (answerCallbackQuery) so a tap never spins, including taps on dead pre-restart buttons, which should get an explanatory toast (request already decided, or this copy is stale, tap the newest); (b) on restart, edit or delete superseded prompt messages where the Bot API allows, or prefix re-sends with a one-line re-delivery banner naming how many are coming, so a flood reads as a re-delivery; (c) resolve a tap by ACTION KEY rather than by message identity where possible, so a tap on any copy of a still-pending request decides it (kills the duplicate-copy trap outright); (d) consider a single queue-summary message with per-request buttons as the re-delivery form. Derived state (message-id to action-key map) may live in the process or a cache file, provided the log stays the only truth.

Related: the flood-of-rejections rule (a swept backlog is not considered denial) becomes less load-bearing once duplicates cannot eat taps. The CLI channel fallback should also be named in docs/dogfood-cutover.md as the runbook for a misbehaving phone channel.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Every callback query is acked; taps on stale copies get an explanatory toast; no tap ever spins indefinitely
- [ ] #2 A tap on any copy of a still-pending request decides that request (action-key resolution), tested
- [ ] #3 Restart re-delivery is legible: superseded copies edited or deleted where the API allows, or a banner precedes the batch
- [ ] #4 No channel state becomes truth: SPEC 10.3 respected, any mapping is derived and rebuildable
- [ ] #5 docs/dogfood-cutover.md names the CLI channel as the fallback when the phone channel misbehaves
<!-- AC:END -->
