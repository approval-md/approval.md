---
id: APRV-124
title: >-
  Hook prompts: the full command bytes on the phone, and a truthful class label
  for protected-path touches
status: To Do
assignee: []
created_date: '2026-08-20 15:06'
labels:
  - hook
  - channel
  - ux
milestone: m-12
dependencies: []
priority: high
ordinal: 116000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
2026-08-20, spotted by the human: a gated stash-and-pull command (git stash push .approval/log/events.jsonl ... git pull --ff-only ... git stash pop) reached the phone classified policy.edit with its CLAIMED summary ellipsized mid-command (git sta...). Two defects. (1) The prompt must carry the full command bytes: SPEC's own framing is that the approval moment is the argv in front of a person, and an ellipsized summary asks the human to approve bytes they cannot see. Hook requests should attach the full command as the payload rendered in a FULL PAYLOAD block (as MCP/register requests already do), chunked or file-linked when it exceeds Telegram limits; the truncated summary may remain as the headline. (2) The class label was untrue in a small way: a command touching .approval/ paths classified policy.edit though it edited no policy. Conservative is right; the label should be a distinct protected-path class (or a qualifier the prompt renders) so the human reads what actually happened. Invariant note: self-reported fields never reduce scrutiny is untouched; this is about the COMPUTED/CLAIMED rendering being complete.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A hook-gated command renders its complete command bytes on the phone; nothing the human approves is ellipsized away
- [ ] #2 Oversized commands degrade to a readable form (chunk or payload reference) rather than silent truncation
- [ ] #3 A protected-path touch is labelled distinctly from an actual policy edit in the prompt, with the classifier still resolving at least as strict
- [ ] #4 Tests cover a long command and a protected-path stash both rendering fully
<!-- AC:END -->
