---
id: APRV-492
title: A doubled review tap does not lose the note prompt
status: To Do
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
- [ ] #1 A second OK tap with a loved/disliked grade held sends no second prompt, and a reply to the first prompt records ok + grade + note
- [ ] #2 A doubled second Deny tap with disliked held sends no second prompt, and a reply to the first prompt records denied + disliked + note
- [ ] #3 A failed send of a replacement prompt leaves the old prompt live, and a reply to it records what that prompt asked for
- [ ] #4 Targeted tests in tests/channels-telegram.test.ts pass; CHANGELOG has an Unreleased (0.4.1) entry; no SPEC change
<!-- AC:END -->
