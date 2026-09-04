---
id: APRV-256
title: Telegram /queue wording must not imply a visible approval card
status: To Do
assignee: []
created_date: '2026-09-04 22:30'
labels:
  - telegram
  - channels
  - ux
dependencies: []
references:
  - APRV-216
  - APRV-218
  - src/cli/channel-telegram.ts
  - src/channels/telegram.ts
documentation:
  - docs/cli-reference.md
priority: medium
type: bug
ordinal: 194000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed on 2026-09-04: /queue reported three pending requests, marked one shown now, and said Tap the buttons on the message above, but the user could see no approval buttons. /queue is a summary-only reply; the listener marker records an earlier successful delivery and cannot establish that its card remains visible. /skip recovered navigation without deciding requests. Follow up APRV-216 with accurate wording and discoverable recovery instructions. Scope is user-facing wording and matching documentation/tests, not new commands, decision controls, policy changes or live service reconfiguration. Before implementation, inspect concurrent APRV-218 prompt-layout work and coordinate shared channel/documentation ownership.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The /queue reply explicitly identifies itself as a pending-request list without decision buttons and directs decisions to a separate approval card without assuming its position or visibility.
- [ ] #2 Replace shown now and message above wording with language describing listener selection or prior delivery; missing or deleted cards are never asserted to be currently visible.
- [ ] #3 When an approval card cannot be found, the reply explains /skip recovery, that requests remain pending and no decision is made, and that a fresh card arrives on a later listener cycle with possible gloss delay. /next is not described as a resend command.
- [ ] #4 Focused rendering and command tests cover selected-item, no-selected-item and empty-queue wording; existing navigation remains non-decisional and log-free. Update corresponding CLI/Telegram documentation and pass applicable repository checks.
<!-- AC:END -->
