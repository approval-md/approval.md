---
id: APRV-430
title: 'A structural view for the run payload, and the renderer version bump it needs'
status: To Do
assignee: []
created_date: '2026-09-22 01:32'
labels:
  - payload
  - channels
dependencies: []
priority: medium
ordinal: 328000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The approval run payload renders under the opaque kind: its canonical JSON, whole. That is correct and complete, and since APRV-401 it carries a files array whose entries each hold an argv index, an absolute path and a 64-hex digest, which is exactly the shape a human reads worst as pretty-printed JSON. A structural view would render the command over its real lines, the cwd beneath it, then one line per bound file, in the closed-field-set style core/wysiwys.ts already uses for commands, file changes and emails. It was not built with APRV-401 for one reason: SPEC section 9 names the renderer version approval.md/wysiwys/2 normatively, a new kind changes the bytes that module emits, and by that module's own rule a change to those bytes is a new version. So this task is a SPEC amendment plus a view plus whatever display_hash re-derivation the bump implies for records written under wysiwys/2, and the amendment is the part a human has to sign. It is legibility and not security: the binding is the payload hash either way, and an approver who reads the JSON sees every byte. See the last section of docs/run-payload-binding.md.
<!-- SECTION:DESCRIPTION:END -->
