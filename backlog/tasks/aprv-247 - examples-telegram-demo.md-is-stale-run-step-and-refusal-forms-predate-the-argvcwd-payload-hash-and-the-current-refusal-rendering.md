---
id: APRV-247
title: >-
  examples/telegram-demo.md is stale: run step and refusal forms predate the
  argv+cwd payload hash and the current refusal rendering
status: To Do
assignee: []
created_date: '2026-09-02 21:42'
labels:
  - docs
dependencies: []
priority: low
ordinal: 192000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found by the APRV-226 lane on 2026-09-02 while writing the Backlog.md example: examples/telegram-demo.md step 10 shows approval run succeeding with a --payload-hash of an email-shaped payload while the command is echo, but the current run verb recomputes the hash from argv plus physical cwd so that step cannot succeed as written; its refusal examples use the older 'approval: code:' form where the CLI now prints the glyph form (a cross, the code, the message). Outcome: the demo is re-run end to end against the current CLI and every shown command and output is what the CLI prints today; the docs-guard suite pins the refusal form used in examples so the two cannot drift again. Docs only.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Every command and output block in examples/telegram-demo.md matches a fresh end-to-end run of the current CLI; the run step's payload hash is derived the way approval run derives it
- [ ] #2 A docs-guard test asserts examples use the current refusal rendering
- [ ] #3 npm test passes; lint clean
<!-- AC:END -->
