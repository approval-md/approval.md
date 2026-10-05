---
id: APRV-492
title: A doubled review tap does not lose the note prompt
status: In Progress
assignee: []
created_date: '2026-10-05 13:40'
labels:
  - telegram
  - review
dependencies: []
priority: high
ordinal: 376000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found by a control-plane refuter under core #614 (supervised-retro). In src/channels/telegram.ts, askForNote forgot the outstanding note prompt (dropped it from reviewNotePrompts) BEFORE sending the replacement. When a reviewer taps OK twice with a loved/disliked grade held, or doubles the second Deny tap, the second askForNote ran with the same verdict and grade. The relay (control plane) licenses exactly one prompt per grade tap and refuses the second send, so the toast told the reviewer to reply while the prompt on screen no longer resolved: the reply was ordinary chat and the note was lost. The verdict was not lost and the card was not stuck (grade again, then verdict, works).

Rule: (1) idempotent while a note is pending: a tap that would ask for the same note (same card, same verdict, same grade, same tapping account) sends nothing and leaves the prompt on screen live; (2) a prompt for a different verdict or grade forgets the old one only after the new send succeeds, so a failed send leaves the old prompt live. The recorded behaviour is unchanged: one audit.reviewed per review, explicit affirmative, the note collected before anything is appended.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A second OK tap with a loved/disliked grade held sends no second prompt, and a reply to the first prompt records ok + grade + note
- [x] #2 A doubled second Deny tap with disliked held sends no second prompt, and a reply to the first prompt records denied + disliked + note
- [x] #3 A failed send of a replacement prompt leaves the old prompt live, and a reply to it records what that prompt asked for
- [x] #4 Targeted tests in tests/channels-telegram.test.ts pass; CHANGELOG has an Unreleased (0.4.1) entry; no SPEC change
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Done (lane claude-edge/A9, branch lane/aprv-492-double-tap):
- src/channels/telegram.ts askForNote: returns without sending when the awaited note has the same verdict, grade and sender id and its prompt still resolves to this card; the old prompt is dropped from reviewNotePrompts only after sendMessage succeeds.
- Tests (tests/channels-telegram.test.ts, helper notePromptChannel refuses every ForceReply send after the first N, as the relay does):
  - AC #1: "APRV-492: a doubled OK asks for the note once, and the reply to that prompt records"
  - AC #2: "APRV-492: a doubled second Deny asks for the note once, and the reply records one denial"
  - AC #3: "APRV-492: a replacement prompt that fails to send leaves the old prompt live"
  - pins the success path: "APRV-492: a replacement prompt that is sent retires the old one"
- Red on main: the first three failed (commit a93d1773); green after the fix: node scripts/run-tests.mjs --only channels-telegram, exit 0, 181/181.
- AC #4: CHANGELOG Unreleased entry; no SPEC change (SPEC §10.3 "A reaction that requires the human's own words (§5.2) MUST collect them before anything is appended" still holds). No conformance vector or fixture touched.

Remaining: refuter pass and the suite of record (orchestrator); not armed; ships in 0.4.1.
<!-- SECTION:NOTES:END -->
