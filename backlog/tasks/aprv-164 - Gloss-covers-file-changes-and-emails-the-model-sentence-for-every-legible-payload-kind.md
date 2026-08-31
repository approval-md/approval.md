---
id: APRV-164
title: >-
  Gloss covers file changes and emails: the model sentence for every legible
  payload kind
status: Done
assignee: []
created_date: '2026-08-30 21:50'
updated_date: '2026-08-31 17:40'
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
- [x] #1 A file-change payload prompt carries a gloss claimed line with the (model, unverified) suffix, produced from a file-edit-specific instruction
- [x] #2 An email payload prompt carries a gloss from an email-specific instruction
- [x] #3 Command payload glossing is unchanged; opaque payloads get no gloss
- [x] #4 Material fed to the model subprocess is capped and the cap is marked in the prompt to the model; timeout and length bounds unchanged
- [x] #5 Every gloss failure mode (timeout, empty, oversized, spawn error) resolves to absence for the new kinds, verified by test with an injected runner that never spawns
- [x] #6 The withGloss comment retiring the commands-only rationale is updated
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read src/cli/gloss.ts and withGloss in src/cli/channel-telegram.ts:850-878 plus gloss tests.
2. Per-kind instructions (file edit, email) beside the command one; shared pipeline and bounds unchanged.
3. withGloss derives kind via exported wysiwys view functions; opaque still bails; comment updated.
4. Cap material handed to the subprocess (~4-8KB of the structural view), marked truncated in the model prompt.
5. Tests with injected runner: per-kind instruction routing, claimed line renders for file-change/email, opaque absent, failures resolve to absence. npm test + lint.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built 2026-08-30 by an Opus subagent in an isolated worktree (parallel with APRV-163), diff ported by fable via git apply -3 (clean), reviewed by fable. glossFor(command) became glossFor(instruction, material); glossPrompt caps material at GLOSS_MAX_INPUT_CHARS=8192 with GLOSS_TRUNCATION_NOTE preceding the material so the model meets the caveat first. GLOSS_EDIT_INSTRUCTION and GLOSS_EMAIL_INSTRUCTION mirror the command instruction's describe-don't-judge discipline. withGloss routes through glossMaterial, deriving kind structurally via commandPayloadView -> changePayloadView -> emailPayloadFields (never a self-declared kind); the command path is byte-identical to APRV-144; file changes send labels + before/after (or new content); emails send the field view lines; opaque gets nothing. Deviation from the task brief, accepted at review: an oversized model ANSWER does not resolve to absence — tidyGloss caps it at 200 chars with a marker, shared shipped behavior with the command path; the failure-matrix test asserts and explains this. Timeout/empty/whitespace/spawn-error all resolve to absence. Fable fixed two comment references to the FULL PAYLOAD heading retired by APRV-162. Same full-suite verification caveat as APRV-163 (machine at load 168; five unrelated flakes, each passing elsewhere). Lint clean.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The haiku gloss now covers file-change and email payloads through the same bounded pipeline (2s, 200-char output, 8KB capped input marked when truncated, model:haiku author, failures resolve to absence); kind derived structurally so the sentence describes the material the approver sees. Verified by injected-runner tests per kind incl. cap and failure matrix; lint clean.
<!-- SECTION:FINAL_SUMMARY:END -->
