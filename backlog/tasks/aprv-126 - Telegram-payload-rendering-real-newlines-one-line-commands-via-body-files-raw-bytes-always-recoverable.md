---
id: APRV-126
title: >-
  Telegram payload rendering: real newlines, one-line commands via body files,
  raw bytes always recoverable
status: Done
assignee: []
created_date: '2026-08-20 17:00'
updated_date: '2026-08-25 13:48'
labels:
  - channel
  - telegram
  - ux
milestone: m-12
dependencies: []
priority: medium
ordinal: 118000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
2026-08-20, from the human reading a FULL PAYLOAD block on the phone: the exact-bytes guarantee is right, the reading experience is not. A gated shell command arrived as one paragraph of escaped JSON with literal \n sequences and a PR body inlined twice over.

Changes, all display-side; the sha256 keeps binding the raw payload bytes:
- Render the command field of a command payload as a code block with real line breaks (escape sequences interpreted for display), cwd on its own line beneath it. Label the block 'rendered; the hash binds the raw bytes' so nobody mistakes the pretty view for the bound bytes.
- The renderer must never let two distinct byte strings display identically: a literal backslash-n two-byte sequence renders visibly distinct from a real newline (e.g. shown escaped inside a marked span). Property test this.
- Long quoted strings and heredocs fold with an explicit '... N more lines (hash covers all bytes)' marker, never a silent ellipsis (APRV-124's rule).
- Related orchestrator practice, already adopted, no code: PR bodies pass via --body-file so command payloads stop embedding whole documents.
Builds on payload-view.ts (APRV-100 did the same for email payloads). Related: APRV-124 (full bytes on the phone), APRV-115 (digests).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Command payloads render with real line breaks and separated cwd, labelled as rendered
- [x] #2 Two distinct byte strings can never render identically; literal escape sequences are visibly distinct from real newlines, property-tested
- [x] #3 Folding is explicit and counted, never silent
- [x] #4 Raw bytes remain recoverable: the payload store holds them and the prompt says how
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built 2026-08-25 by an Opus subagent, reviewed by fable, merged in PR #117 (commit c18a563). commandPayloadView joins the email and diff structural views in payload-view.ts: exact-shape {command, cwd} detection, real line breaks, cwd beneath, store path stated, heading says the hash binds the raw bytes. markEscapes marks literal \n \r \t \\ as guillemet-wrapped spans and is injective by construction (left-inverse proof in its doc comment); AC 2 verified by a 4000-case property test over the collision-prone alphabet plus the named a\\nb vs a-newline-b pair. Folding routes through the shared foldMarker on the diff view's 120-line budget (AC 3). Deliberate scope choices: real control characters are NOT marked (a second marker form would itself need escaping; shell commands do not carry them); the recoverability line is command-view only. The 'expires HH:MM' glitch could not be reproduced (path traced, pinned by an existing test) and was left alone. Out of scope, noticed: SPEC §6.2's {argv, cwd} command payload correctly falls through to JSON; an argv-shaped view is a natural follow-up. Verified: docs updated (both hook docs), 2044 tests at build, 2053 after APRV-115 stacked, lint clean, merged through the queue.

2026-08-25 post-merge: Carter saw \n blobs in a prompt after PR #117 merged — that prompt was rendered by the still-running pre-merge listener, not a regression; the fix appears on listener restart. Successor legibility work: APRV-136 (metadata), APRV-137 (summary).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Command payloads render as commands on the phone: real line breaks, cwd separated, provably injective escape marking, counted folds, raw bytes recoverable. Verified by property test (4000 collision-prone pairs), 5 new channel tests, full suite green, merged in PR #117.
<!-- SECTION:FINAL_SUMMARY:END -->
