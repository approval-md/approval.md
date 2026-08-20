---
id: APRV-124
title: >-
  Hook prompts: the full command bytes on the phone, and a truthful class label
  for protected-path touches
status: Done
assignee: []
created_date: '2026-08-20 15:06'
updated_date: '2026-08-20 20:58'
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
- [x] #1 A hook-gated command renders its complete command bytes on the phone; nothing the human approves is ellipsized away
- [x] #2 Oversized commands degrade to a readable form (chunk or payload reference) rather than silent truncation
- [x] #3 A protected-path touch is labelled distinctly from an actual policy edit in the prompt, with the classifier still resolving at least as strict
- [x] #4 Tests cover a long command and a protected-path stash both rendering fully
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Merged as PR 113 (branch aprv-124-edit-payloads). Edit/Write/MultiEdit/NotebookEdit hook payloads now carry the change itself as the binding bytes: Edit is {tool, rule, file, before, after, replace_all?}, Write is {tool, rule, file, content}, multi-tools carry the tool input verbatim minus description; the agent's description field never enters the payload. Rendered on the phone as a full-replacement hunk (minus lines then plus lines, no diff algorithm so nothing can be wrong about what it claims), folding past 120 lines per side with an explicit counted marker, the canonical JSON and hash beneath. Bash prompts verified to carry the complete command in the FULL PAYLOAD block regardless of length (the summary headline may still ellipsize). Proposal-tier vs live-tier shipped: a protected-path edit resolving strictly inside <primary>/.claude/worktrees/<name>/ carries rule protected-path-proposal, hash-bound and leading the summary headline, with a rendered note that merging is a separate gated action; resolution uses the hook's own process cwd and realpath (APRV-108 discipline, harness cwd never read); every doubtful case is live-tier. Class semantics unchanged (APRV-127 hangs sampling off the distinction later). Carryover interaction verified: identical edits adopt and carry, a one-line difference is a new question, cross-tier replay impossible since the absolute file path differs. Two deliberate strengthenings beyond the filed spec: replace_all is in the binding bytes, and the tier rides inside the hashed payload rather than as unbound decoration. +10 tests.
<!-- SECTION:NOTES:END -->
