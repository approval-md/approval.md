---
id: APRV-164
title: >-
  Gloss covers file changes and emails: the model sentence for every legible
  payload kind
status: To Do
assignee: []
created_date: '2026-08-30 21:50'
labels: []
dependencies:
  - APRV-162
ordinal: 141000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The haiku gloss (APRV-144) is the one human-meaningful sentence in the prompt, but withGloss bails for anything that is not a command payload, so the file-change prompts Carter actually receives never get one; the claimed summary is a bare "<tool> <path>" that means nothing. Extend the gloss to the other legible payload kinds: file-change and email payloads get their own describe-do-not-judge instruction through the same pipeline (2s timeout, 200-char cap, model:haiku author, every failure resolves to absence, nothing branches on what it says). Opaque payloads still get no gloss. Bound the material handed to the subprocess (a whole-file Write can be huge): cap at a few KB of the structural view, marked truncated in the model prompt, since the gloss is decoration and a partial input is fine.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A file-change payload prompt carries a gloss claimed line with the (model, unverified) suffix, produced from a file-edit-specific instruction
- [ ] #2 An email payload prompt carries a gloss from an email-specific instruction
- [ ] #3 Command payload glossing is unchanged; opaque payloads get no gloss
- [ ] #4 Material fed to the model subprocess is capped and the cap is marked in the prompt to the model; timeout and length bounds unchanged
- [ ] #5 Every gloss failure mode (timeout, empty, oversized, spawn error) resolves to absence for the new kinds, verified by test with an injected runner that never spawns
- [ ] #6 The withGloss comment retiring the commands-only rationale is updated
<!-- AC:END -->
