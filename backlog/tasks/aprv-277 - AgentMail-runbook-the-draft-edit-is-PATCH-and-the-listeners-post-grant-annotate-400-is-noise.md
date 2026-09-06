---
id: APRV-277
title: >-
  AgentMail runbook: the draft edit is PATCH, and the listener's post-grant
  annotate 400 is noise
status: To Do
assignee: []
created_date: '2026-09-06 01:39'
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
- [ ] #1 examples/agentmail-demo.md steps 9 and 10 use PATCH for the draft edit and note the draft id is a UUID; tests/docs-guard passes
- [ ] #2 The listener either recognises the unchanged-message 400 and prints nothing, or its line no longer reads as a failure; covered by a test against the injected fetch
<!-- AC:END -->
