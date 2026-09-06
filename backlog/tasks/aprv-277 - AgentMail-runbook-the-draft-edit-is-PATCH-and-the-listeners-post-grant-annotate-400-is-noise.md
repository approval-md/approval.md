---
id: APRV-277
title: >-
  AgentMail runbook: the draft edit is PATCH, and the listener's post-grant
  annotate 400 is noise
status: In Progress
assignee:
  - '@opus-277'
created_date: '2026-09-06 01:39'
updated_date: '2026-09-06 07:28'
labels:
  - agentmail
  - docs
  - telegram
dependencies: []
type: docs
ordinal: 204000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Two findings from the APRV-224 manual e2e (2026-09-06). (1) examples/agentmail-demo.md steps 9 and 10 edit the draft with POST /v0/inboxes/{inbox}/drafts/{draft}; AgentMail returns not_found ("Route not found") for POST on that path and the edit silently does not happen, so a reader following the runbook gets a send where the text promises a drift refusal. PATCH on the same path works and returns the updated draft. (2) After a tap, approval channel telegram listen prints "telegram could not annotate the granted <key> (message N): editMessageText: HTTP 400 — the buttons are stale but the gate refuses a tap on them" even though the phone already shows the updated message; Telegram answers 400 when an edit would change nothing. Decide whether to detect the unchanged-message 400 and stay silent, or keep the line and soften its wording.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 examples/agentmail-demo.md steps 9 and 10 use PATCH for the draft edit and note the draft id is a UUID; tests/docs-guard passes
- [x] #2 The listener either recognises the unchanged-message 400 and prints nothing, or its line no longer reads as a failure; covered by a test against the injected fetch
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. examples/agentmail-demo.md steps 9-10: PATCH on the draft path (POST answers not_found, verified live 2026-09-06), UUID draft ids, show the restore curl. 2. src/channels/telegram.ts: TelegramApiError carries status and description (redacted); isMessageNotModified matches 400 + 'message is not modified'. 3. src/cli/channel-telegram.ts and the three annotate sites in telegram.ts skip that case silently; every other 400 still warns and quotes the description. 4. Tests against the injected fetch; docs-guard.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built across two agent sessions (the first could not compile or commit while the gate was dark). Commit a41bec1 on worktree-agent-aa554a09466c9d647: examples/agentmail-demo.md (+27/-8), src/channels/telegram.ts (+110), src/cli/channel-telegram.ts (+9), tests/channels-telegram.test.ts (+149). Validation: build clean; channels-telegram, docs-guard, channels-cli, channels-contract, checkpoint-tap 245/245; lint and typecheck clean. Two mislabelled output blocks in the runbook (they called the adapter's output the PATCH echo) were corrected in passing. The duplicate task APRV-279 the first session minted (it could not see this file) was deleted before commit.
<!-- SECTION:NOTES:END -->
