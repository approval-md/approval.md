---
id: APRV-492
title: A doubled review tap does not lose the note prompt
status: Done
assignee: []
created_date: '2026-10-05 13:40'
updated_date: '2026-10-08 01:15'
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

Rule: (1) idempotent while a note is pending: a tap that would ask for the same note (same card, same verdict, same grade, same tapping account) sends nothing and leaves the prompt on screen live; (2) a prompt for a DIFFERENT VERDICT retires the old one BEFORE the send (base behaviour): a verdict change is not a grade tap, the relay refuses that send, and an old prompt left live would record the verdict the human changed, so a note may be lost but a wrong verdict is never recorded (PR #619 refutation B1, ruled by claude-edge); (3) a prompt for the same verdict and a different grade (licensed, it follows a grade tap) forgets the old one only after the new send succeeds, so a network failure leaves the old prompt live (accepted residual S2: the reply records the grade the old prompt names); (4) a send that fails says so on the card (note not asked, nothing recorded, grade again to be asked) and still throws. The fields a recorded review carries are unchanged: one audit.reviewed per review, explicit affirmative, the note collected before anything is appended.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A second OK tap with a loved/disliked grade held sends no second prompt, and a reply to the first prompt records ok + grade + note
- [x] #2 A doubled second Deny tap with disliked held sends no second prompt, and a reply to the first prompt records denied + disliked + note
- [x] #3 A failed send of a same-verdict replacement prompt leaves the old prompt live, and a reply to it records what that prompt asked for (residual S2, named)
- [x] #4 Targeted tests in tests/channels-telegram.test.ts pass; CHANGELOG has an Unreleased (0.4.1) entry; no SPEC change
- [x] #5 A verdict change on the same held grade (OK then a confirmed Deny; a Deny corrected to OK) retires the old prompt before the send, so a reply to it records nothing; the refused send says so on the card; grading again asks and records the new verdict
- [x] #6 The test fake models the relay's rule: one ForceReply licence per grade tap
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

Fix round 1 (lane claude-edge/A9-fix, after refutation A9 at 21a8f62c, NOT CLEAN on B1):
- B1 fixed: askForNote retires a waiting prompt whose verdict differs BEFORE the send; retire-after-success stays only for a same-verdict, different-grade replacement. A failed send sets a card notice (TELEGRAM_NOT_RECORDED + telegramReviewNoteUnasked(verdict)), redraws, and rethrows; a later sent prompt clears that notice.
- S1: notePromptChannel now grants one ForceReply licence per grade tap seen in getUpdates and refuses 403 with none left; network failures are a separate list of attempt numbers.
- New tests: "APRV-492 (PR #619 refutation B1, T1): OK then a confirmed Deny on one held grade never records the OK" and "APRV-492 (PR #619 refutation B1, T2): a Deny corrected to OK on one held grade never records the denial". Both fail with the retire-before-send branch disabled (exit 1, 181/183) and pass with it.
- Test 3 renamed: "APRV-492: a same-verdict replacement prompt that fails on the network (an ordinary send failure) leaves the old prompt live, residual S2". It pins residual S2: loved, ok (P1), disliked, ok (network failure) -> a reply to P1 records ok+loved while the card holds disliked; P1's own text says LOVED. Only a network failure reaches it (the relay licenses that send).
- S3 (pre-existing: arming Deny does not retire a waiting ok prompt) not fixed here: filed as APRV-493.
- Runs: npx tsc -p tsconfig.json exit 0; node scripts/run-tests.mjs --only channels-telegram exit 0, 183/183; npx oxlint on both files exit 0.

Remaining: recheck of the changed seams and the suite of record (orchestrator); not armed; ships in 0.4.1.

Closed by the 2026-10-08 backlog sweep (claude-b3/SWEEP-APRV-1): all ACs ticked; PR #619 merged 5d5318ed (2026-10-05) after refuter recheck CLEAN (CLAIMS 2026-10-05 14:02Z); released in 0.4.1. Follow-up APRV-493 stays open.
<!-- SECTION:NOTES:END -->
