---
id: APRV-309
title: >-
  approval quickstart: three questions to an operative gate with the reader's
  own name in the policy
status: To Do
assignee: []
created_date: '2026-09-08 06:47'
labels:
  - dogfood
dependencies: []
priority: high
ordinal: 227000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The README's quick path (PR #342) is init, a sed that renames the scaffold's approver from alice to the reader, and attest. The sed is a text substitution on a file the reader has not read, and it exists because the scaffold names an approver who is not them; without it a grant on communicate.email.external refuses actor-not-approver. docs/proposals/solo-dev-quickstart.md designs the replacement: one interactive verb that asks who you are, where the button goes, and what must always ask, then writes the policy with those answers in it, stores the channel token, and attests in the same session. Reuses setup identity, setup channel telegram and policy attest; new are the prompt flow and the template.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval quickstart is interactive by refusal (a pipe or --json exits 2 and prints the non-interactive equivalents), asks three questions (name; Telegram token or this terminal; a checklist of the classes that must always ask, defaulting to all on: send a message or email, spend money, delete files, post publicly, push to main), and writes APPROVAL.md from a solo template with the reader's name as the sole approver, the checklist classes manual, defaults.autonomy autonomous, no audit block, and a comment on how to add sampling and how to tighten
- [ ] #2 It runs setup identity, stores the token via the same keystore path setup channel telegram uses, writes .approval/env, and attests the policy as the last prompt with the typed understood; it prints one line: ready: N classes ask human:<name> on <channel>; everything else runs, and a try: line naming approval hook classify
- [ ] #3 Doctor output appears only when a step failed; a fresh directory after quickstart has 0 failed rows (the solo template names no audit block, so audit-sampling reports not applicable, which needs the doctor solo tier from the proposal or an equivalent)
- [ ] #4 tests/cli-quickstart.test.ts drives the prompts through a pty or the non-interactive form, asserts the written policy loads, resolves the five classes manual and read.* autonomous, and that a grant by the named human on communicate.email.external is not refused actor-not-approver; docs/cli-reference.md gains the verb; the README's quick path replaces init + sed + attest with approval quickstart
- [ ] #5 SPEC.md 10.1 CLI list gains the verb (amendment text in the notes for hand application; no SPEC edit from the lane)
<!-- AC:END -->
