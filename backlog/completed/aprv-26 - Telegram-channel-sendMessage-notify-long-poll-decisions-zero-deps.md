---
id: APRV-26
title: 'Telegram channel: sendMessage notify, long-poll decisions, zero deps'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 10:51'
updated_date: '2026-08-05 15:32'
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
The reference push channel (SPEC 10.3): message with declared effects plus inline Approve/Reject buttons, callback verified against approver identity. Human-settled (2026-08-05): zero new runtime dependencies — the Bot API is plain HTTPS JSON via node fetch/https; notify via sendMessage with inline keyboard; decisions via long-polling getUpdates (webhooks out of scope for local-first v0.1); bot token and chat id from environment only (APPROVAL_TG_TOKEN / APPROVAL_TG_CHAT env-var names per section 5.1), never logged and never in policy beyond the env-var names; callbacks verified against the configured approver chat id and recorded with the config-declared human actor, section 11 caveat stated in the channel docs. Long-polling runs under a foreground verb approval channel telegram listen; the M5 daemon adopts it later. B7 batching MAY defer to a follow-up if inline-keyboard ergonomics fight it — flagged, not forced. Tests run against a local mock Bot API server (never the real network); the real-network path is exercised by the APRV-27 documented manual script. SEQUENCING FLAG: when this task passes its tests on main, notify the human — they will then edit APPROVAL.md channel: cli -> telegram and re-attest (seq 2); the policy must never name a channel that does not exist.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 notify sends a Telegram message with tagged effects rendering (computed vs claimed, full payload for manual) and inline Approve/Reject buttons, via plain HTTPS with zero new dependencies
- [x] #2 approval channel telegram listen long-polls getUpdates in the foreground; a callback from the configured approver chat id records the decision through the gate verbs with the config-declared human actor; callbacks from any other chat id are ignored and logged as anomalies nowhere near the decision path
- [x] #3 Bot token and chat id come from environment only; a test scans all appended events and all rendered output for the token (never present); policy carries only env-var names
- [x] #4 The APRV-22 conformance suite passes against the telegram channel unmodified; all tests run against a local mock Bot API server, never the real network
- [x] #5 The section 11 config-declared-identity caveat is stated in the channel docs and help; if B7 batching is deferred, the deferral is flagged in the implementation notes with the ergonomic reason, never silently dropped
- [x] #6 On green tests on main, the human is flagged to perform the APPROVAL.md channel edit and re-attestation (seq 2); the task is not complete until that flag is raised
- [x] #7 The mock Bot API exercises failure modes: getUpdates timeout and network error (listener survives and resumes polling), a callback from an unconfigured chat id (ignored and counted/noted, never a decision event), and a duplicate callback for an already-decided request (refused idempotently via the existing gate codes, no second event appended)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented by Opus subagent in isolated worktree; fable review accepted all flagged decisions, surfaced to the human in the m-4 report: (1) HTML formatting over MarkdownV2 (three uniform escapes vs eighteen positional rules — the untrusted input is exactly the claimed fields and payload bytes, so the narrower escape rule is the narrower injection surface; injection fixture tested); (2) token printed on the listener stdout only, never sent into Telegram (chat transcripts live on third-party servers; consequence stated in help: the phone-tapper does not get the token, the terminal operator does — split deployments need a real token-delivery design); (3) reject records a fixed note (inline keyboards have no text input; ForceReply deferred with reasons; help points at approval reject --note); (4) callback authority is the notify-time nonce resolved in memory — wire-supplied action keys never name the thing decided (key-mismatch = anomaly); (5) B7 batching DEFERRED with the concrete ergonomic reason (one keyboard per message; full payloads blow the 4096 limit long before one-tap-for-N is useful) — notify(batch) degrades to one message per member sharing a batch delivery id, conformance batch checks pass. Failure-mode rider covered: timeout/drop/500/malformed + mock kill/restart all resume polling with a real grant landing after; foreign-chat callbacks counted, never decided, zero events; duplicate callback idempotent via already-decided, no second event, toast reply. Token-never-anywhere scan covers message texts, log bytes, stderr, with the URL-carries-token Bot API fact documented and asserted. Merge resolution by fable: both APRV-23 and this task created src/cli/channel.ts — telegram verb split to src/cli/channel-telegram.ts (its duplicate dispatcher removed), unified commandChannel dispatches cli|telegram, help constants grafted (branch CHANNEL_HELP dropped, ours extended), one dead import removed. AC 6 (human flag for the APPROVAL.md channel edit + seq-2 attestation) is raised in the report accompanying this finalization; task closes with the flag raised. Verified on merged tree from clean dist: 787/787, lint, typecheck.

Date corrected in place per the 2026-08-05 human ruling (log-is-authoritative, applied to all APRV-46 findings): prose previously claimed 2026-08-08; this task's own created_date (2026-08-05) is the cited source. The wrong date was orchestrator confabulation, part of the systematic drift reported in APRV-46.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
src/channels/telegram.ts + approval channel telegram listen|health: zero-dependency Bot API channel (HTML-escaped tagged rendering, chunked full payloads, nonce-authoritative callbacks, foreign-chat anomaly counting, idempotent duplicates, resilient long-polling proven by mock kill/restart), token on listener stdout only, B7 deferred with reasons. 16 tests via a local mock Bot API with failure injection. Verified: 787/787, lint, typecheck.
<!-- SECTION:FINAL_SUMMARY:END -->
