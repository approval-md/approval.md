---
id: APRV-27
title: 'End-to-end demo: request to Telegram approval to executed run'
status: To Do
assignee: []
created_date: '2026-08-05 10:51'
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
- [ ] #1 A scripted e2e test walks register -> request -> notify -> callback approve -> grant mints token -> approval run executes -> execution.completed, asserting the log record sequence, payload bindings, and chain cleanliness at each hop, against the mock Bot API
- [ ] #2 The demo asserts the negative space too: before approval, run refuses at exit 5; after consumption, a second run refuses; the raw token never appears in any log byte
- [ ] #3 A documented manual script for the real-Telegram walkthrough exists under examples/ with setup (env vars, bot creation) and expected output at each step
- [ ] #4 QUEUE.md and approval status reflect the demo state correctly at the intermediate hops (queue shows the pending request; status healthy at completion)
<!-- AC:END -->
