---
id: APRV-74
title: approval setup identity | vault | sampling | telegram
status: To Do
assignee: []
created_date: '2026-08-18 01:39'
labels: []
milestone: m-10
dependencies:
  - APRV-73
priority: high
type: feature
ordinal: 73000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
doctor names what is wrong and cannot fix it; the Keychain commands are best practice you have to already know; discovering a Telegram chat id means curl against getUpdates and reading JSON by hand. Interactive setup verbs that store secrets in the keystore and write the .approval/env source map, refusing when stdin is not a TTY (printing the exact non-interactive commands). New cli/prompt.ts: readLine hoisted from amend.ts, readSecret (raw-mode byte loop, no echo, backspace, Ctrl-C aborts storing nothing, raw mode restored in finally), confirm. setup telegram: on macOS delegate token entry to security add-generic-password -w with inherited stdio (Apple no-echo prompt; the token never enters our argv; never -w <value>), else readSecret; getMe verification (reuse doctor probe + redact), print @username; ask the human to message the bot; getUpdates with NO OFFSET EVER (read without acknowledging so a running listener keeps its callbacks; comment why); dedupe candidates newest-first; confirm; store token via source map, chat id inline. setup identity exempt from the human-only gate (it declares the identity; say so); vault and sampling gated like vault set; generate randomBytes(32) base64, never print. Nothing under setup appends, attests, or edits APPROVAL.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 cli/prompt.ts with readLine/readSecret/confirm; amend.ts uses it; every setup subcommand refuses non-TTY or --json at exit 2 printing the non-interactive commands
- [ ] #2 setup identity, vault, sampling write the source map and store secrets in the keystore without printing them; re-run asks before replacing
- [ ] #3 setup telegram: token acquisition, getMe, human-sends-message, getUpdates with no offset, candidate confirmation, storage; token never in any argv/output/error (redaction wraps every message); assert no getUpdates body carried an offset
- [ ] #4 Log byte-compared across a full run; interactive paths tested via injected prompt and keystore (real Keychain never touched); telegram-mock gains messageUpdate
<!-- AC:END -->
