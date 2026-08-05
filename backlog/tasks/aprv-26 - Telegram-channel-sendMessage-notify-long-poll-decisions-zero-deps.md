---
id: APRV-26
title: 'Telegram channel: sendMessage notify, long-poll decisions, zero deps'
status: To Do
assignee: []
created_date: '2026-08-05 10:51'
labels: []
milestone: m-5
dependencies:
  - APRV-22
priority: high
type: feature
ordinal: 26000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The reference push channel (SPEC 10.3): message with declared effects plus inline Approve/Reject buttons, callback verified against approver identity. Human-settled (2026-08-08): zero new runtime dependencies — the Bot API is plain HTTPS JSON via node fetch/https; notify via sendMessage with inline keyboard; decisions via long-polling getUpdates (webhooks out of scope for local-first v0.1); bot token and chat id from environment only (APPROVAL_TG_TOKEN / APPROVAL_TG_CHAT env-var names per section 5.1), never logged and never in policy beyond the env-var names; callbacks verified against the configured approver chat id and recorded with the config-declared human actor, section 11 caveat stated in the channel docs. Long-polling runs under a foreground verb approval channel telegram listen; the M5 daemon adopts it later. B7 batching MAY defer to a follow-up if inline-keyboard ergonomics fight it — flagged, not forced. Tests run against a local mock Bot API server (never the real network); the real-network path is exercised by the APRV-27 documented manual script. SEQUENCING FLAG: when this task passes its tests on main, notify the human — they will then edit APPROVAL.md channel: cli -> telegram and re-attest (seq 2); the policy must never name a channel that does not exist.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 notify sends a Telegram message with tagged effects rendering (computed vs claimed, full payload for manual) and inline Approve/Reject buttons, via plain HTTPS with zero new dependencies
- [ ] #2 approval channel telegram listen long-polls getUpdates in the foreground; a callback from the configured approver chat id records the decision through the gate verbs with the config-declared human actor; callbacks from any other chat id are ignored and logged as anomalies nowhere near the decision path
- [ ] #3 Bot token and chat id come from environment only; a test scans all appended events and all rendered output for the token (never present); policy carries only env-var names
- [ ] #4 The APRV-22 conformance suite passes against the telegram channel unmodified; all tests run against a local mock Bot API server, never the real network
- [ ] #5 The section 11 config-declared-identity caveat is stated in the channel docs and help; if B7 batching is deferred, the deferral is flagged in the implementation notes with the ergonomic reason, never silently dropped
- [ ] #6 On green tests on main, the human is flagged to perform the APPROVAL.md channel edit and re-attestation (seq 2); the task is not complete until that flag is raised
<!-- AC:END -->
