---
id: APRV-27
title: 'End-to-end demo: request to Telegram approval to executed run'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 10:51'
updated_date: '2026-08-05 12:12'
labels: []
milestone: m-5
dependencies:
  - APRV-25
  - APRV-26
priority: high
type: feature
ordinal: 27000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The m-4 exit criterion (human-settled 2026-08-08): something end-to-end must close the milestone. A scripted demo test walks the full path — register, request (manual class), Telegram notify, approve via callback, token minted at grant, approval run executes the command — asserted against the log at every hop, running against the local mock Bot API. Alongside it, a documented manual script (docs or examples/ per SPEC section 14) walks the same path against real Telegram for a human to run once, since the mock cannot prove the real network. The demo is the SPEC abstract made executable: agent drafts, phone approves, log verifies.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A scripted e2e test walks register -> request -> notify -> callback approve -> grant mints token -> approval run executes -> execution.completed, asserting the log record sequence, payload bindings, and chain cleanliness at each hop, against the mock Bot API
- [x] #2 The demo asserts the negative space too: before approval, run refuses at exit 5; after consumption, a second run refuses; the raw token never appears in any log byte
- [x] #3 A documented manual script for the real-Telegram walkthrough exists under examples/ with setup (env vars, bot creation) and expected output at each step
- [x] #4 QUEUE.md and approval status reflect the demo state correctly at the intermediate hops (queue shows the pending request; status healthy at completion)
- [x] #5 The scripted test's final step runs full chain verification on the demo log and asserts clean, so the demo's closing claim is the chain's own
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented by Opus subagent; fable review found nothing to override. Eight ordered hops driven entirely through the CLI as subprocesses; core imported only for the fixture payload hash. Both negative-space requirements covered (exit 5 before approval with byte-identical log; token replay refused with no second started event); token and bot-token scans cover log bytes, mock request bodies, and stderr; final statement of the file is log verify --json asserting clean per the human rider. examples/telegram-demo.md carries the real-Telegram walkthrough with verbatim captured transcripts and the section 11 caveat, no em dashes. CLI friction reported for follow-up triage (not fixed, per scope): (1) approval render has no --payloads bridge so live manual requests land in could-not-summarize and QUEUE.md pending reads 0 while queue reads 1 — the missing payload store made concrete; (2) grant-via-telegram records no note while reject does, asymmetry undocumented outside channel source; (3) no approval payload hash verb — the manual script resorts to a node -e one-liner against an internal module; (4) --payload-hash is load-bearing for adapter-shaped payloads but run --help presents it as exotic; (5) examples transcripts are a second unexecuted source of truth — cheap guard test proposed. Verified from wiped node_modules/dist: 809/809, lint, typecheck.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
tests/e2e-demo.test.ts: the SPEC abstract executable — attest, register, request, refused-before-approval, Telegram notify via mock, phone-tap approve, token on stdout and nowhere else, bound run to execution.completed, replay refused, surfaces consistent, closing with chain verification clean as the last assertion. Plus examples/telegram-demo.md for the real-network walkthrough. 9 tests. Verified: 809/809 from wiped install.
<!-- SECTION:FINAL_SUMMARY:END -->
