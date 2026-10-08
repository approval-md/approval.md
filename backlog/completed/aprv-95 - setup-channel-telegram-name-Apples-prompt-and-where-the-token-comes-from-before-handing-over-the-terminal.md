---
id: APRV-95
title: >-
  setup channel telegram: name Apple's prompt and where the token comes from
  before handing over the terminal
status: Done
assignee:
  - Claude
created_date: '2026-08-18 18:39'
updated_date: '2026-08-18 18:39'
labels:
  - cli
  - ux
dependencies: []
ordinal: 87000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed running examples/email-demo.md (2026-08-18): the operator reached macOS security's 'password data for new item:' prompt and did not know it wanted the BotFather token, and thought the approval-tg-token item had to be looked up in the keychain first (it is created by this prompt). The wording is Apple's and cannot change; the line printed before the handoff now says what to paste (BotFather /mytoken), what the prompt will look like (both lines), that nothing echoes, and that nothing needs looking up first. examples/telegram-demo.md and email-demo.md say the same. Sibling of APRV-90/APRV-91.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Pre-handoff text names the BotFather token, quotes both of security's prompt lines, and says the item is created here
- [x] #2 Both example docs quote Apple's prompt wording
- [x] #3 setup tests pass, lint clean
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Text change in src/cli/setup-channel.ts collectToken() plus one sentence in each example doc. No test pins the wording; setup tests 51/51, lint clean. Verified by the operator on the next setup channel telegram run in the email demo.
<!-- SECTION:NOTES:END -->
