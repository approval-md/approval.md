---
id: APRV-126
title: >-
  Telegram payload rendering: real newlines, one-line commands via body files,
  raw bytes always recoverable
status: To Do
assignee: []
created_date: '2026-08-20 17:00'
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
- [ ] #1 Command payloads render with real line breaks and separated cwd, labelled as rendered
- [ ] #2 Two distinct byte strings can never render identically; literal escape sequences are visibly distinct from real newlines, property-tested
- [ ] #3 Folding is explicit and counted, never silent
- [ ] #4 Raw bytes remain recoverable: the payload store holds them and the prompt says how
<!-- AC:END -->
