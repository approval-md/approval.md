---
id: APRV-534
title: 'APB-12: dispatch Telegram requests while a long poll is pending'
status: Done
assignee:
  - '@codex-contextsling'
created_date: '2026-11-13 04:41'
updated_date: '2026-11-13 05:29'
labels: []
dependencies: []
references:
  - CLAIMS L44867; L20090; L20094
type: enhancement
ordinal: 406000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A newly requested approval currently waits for the next Telegram poll cycle. Wake the existing verified-log dispatch path when the log changes, with stat fallback and serialized dispatch, so a held getUpdates call does not delay the card. Deliver one draft PR for review; no version bump, publish, tag, pin PR, or merge.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A real newly appended approval request is sent before a held getUpdates call completes.
- [x] #2 File notifications, stat fallback, and beforePoll share serialized dispatch; duplicate and burst wakeups do not send duplicate pending cards.
- [x] #3 Watcher attachment errors or missed notifications retain stat fallback and poll dispatch; unchanged logs do not create a fast send retry loop.
- [x] #4 Stop, once mode, startup failures, and unexpected listener termination release all watcher and timer resources and settle outstanding dispatch safely.
- [x] #5 Existing verified-log, payload, callback, delivery pacing, and retry behavior remains covered by tests, with real append APIs for fixtures.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Keep startup dispatch and fatal outcomes; add a startListener-owned fs.watch plus one-second stat observer using existence/dev/ino/size/mtime/ctime hints only. Recover stale or failed watcher handles on bounded ticks; do not create log paths. 2. Route changed-log wakes and unconditional beforePoll through one serialized coalescing dispatchPending scheduler, with a fresh clock per pass and one trailing wake for changes during a send. Close attachment races without turning stable stats into retries. 3. Stop observation synchronously and clean up in finally; drain active dispatch while suppressing queued work. Preserve callback and paced selection behavior. 4. Add real-append/mock-transport tests for held polls, fallback and watcher failures, burst/overlap, mid-send appends, corruption/refusal, retries, callback interleaving and all shutdown paths. 5. Run focused regressions, full local CI tier, lint, conformance and protected-path guard; complete independent conformance/refutation and deliver one draft PR with accurate #655/#664 release facts. No publish/tag/pin/merge.

Review-required refinement: share a finite-operation queue between dispatch and the processing of a received Telegram update batch. Add an optional listen/poll processUpdates wrapper around intake only, leaving getUpdates outside the queue. This prevents early taps arriving before sendMessage response has registered its nonce, including review/checkpoint/digest sends. Preserve direct poll/webhook defaults. Move JSON stopped output after draining active dispatch and test its ordering.

Independent refutation refinement: beforePoll and initial observer attachment must await a finite scheduling barrier, not the entire coalescing runner. Sustained real log changes must not starve the next getUpdates call. Keep trailing passes asynchronous and coalesced, with each pass and received-update batch retaining FIFO exclusion; add a deterministic continuous-append regression.

Preserve transport recovery: the generic FIFO tail recovers for subsequent operations but returns an intake rejection to TelegramChannel.listen for its existing retry/backoff. Only a dispatch wrapper records a fatal unexpected dispatch failure and stops. Add malformed successful-HTTP result:null then valid-result recovery regression.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
First frozen candidate: 14 watch tests and 298 focused regressions pass; Astra conformance found two P2 defects before delivery: stopped JSON precedes active-dispatch drain, and a real early callback can arrive while sendMessage response is pending before delivery nonce registration. Both must be fixed and affected checks/review repeated. No PR or publication yet.

Second candidate: 19/19 watcher tests and conformance accepted. Fresh independent refutation reproduced P2 polling starvation: eight successive real-append dispatch passes kept getUpdates at one call until appends ceased. Delivery remains held for a bounded scheduling fix and affected rechecks.

Final candidate: 22/22 watcher tests and 306/306 focused Telegram regressions pass (actual exit 0); build, typecheck, lint and conformance each exit 0, with 910/910 conformance vectors. AC1 held-poll real-append test; AC2 bursts/mid-send/FIFO tests; AC3 stable-stat/failure/recovery tests; AC4 stop/once/startup/error/JSON-drain tests; AC5 existing channel/minimal/webhook regressions plus real-append corruption, pacing, callback, early-tap and retry tests. Conformance and fresh independent refutation accepted the final finite-pass/error-neutral queue. Independent original fairness/retry reproductions and strict stop/repeated-error probes pass. Full local CI and committed protected-path guard remain delivery gates; task stays In Progress until completed.

Accepted full local CI completed exit 0 on Darwin Node 26.8.2: build, all three test shards, and lint passed; 6946 total tests, 6934 passed, 0 failed, 11 skipped, 1 todo. Shards: 2063, 2400, 2483 tests. Runtime/test hashes still match final conformance and refutation acceptances. Linux GitHub PR CI and committed protected-path guard remain separately reported delivery checks. No live Telegram, provider, version, publish, tag, pin, or merge act.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added watch/stat-driven Telegram dispatch during long polls, using finite FIFO passes shared with update intake so early taps remain bound and sustained appends keep polling. Observer shutdown drains active work before final statistics. Verified 22 watcher regressions, 306 focused regressions, 910 conformance vectors and all full local CI shards (6934 passed, 0 failed; exit 0). Independent conformance/refutation accepted; delivery is one draft PR for external review.
<!-- SECTION:FINAL_SUMMARY:END -->
