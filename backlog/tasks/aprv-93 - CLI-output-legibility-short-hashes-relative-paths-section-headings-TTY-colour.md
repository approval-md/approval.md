---
id: APRV-93
title: >-
  CLI output legibility: short hashes, relative paths, section headings, TTY
  colour
status: To Do
assignee: []
created_date: '2026-08-18 17:46'
labels:
  - cli
  - ux
dependencies: []
priority: medium
type: feature
ordinal: 86000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Human feedback 2026-08-18 on 'approval policy amend --dry-run' output: dense and hard to scan. Two 64-hex hashes on one line, absolute paths repeated three times, every line the same visual weight, no colour. Applies to amend, status, wait, explain, hook classify and the gate verbs' human output. Proposal: (1) short hashes (12 chars) in human output, full value only in --json; (2) paths relative to cwd; (3) section labels and indentation (Policy / Changes / Load / Would run), with changed resolutions as the visual centre in a before -> after layout; (4) ANSI colour only when stdout is a TTY and NO_COLOR is unset (green ok, yellow changed, red refused, dim for hashes/paths), never in --json or when piped; (5) a shared src/cli/style.ts so every verb renders the same way; (6) tests that piped output stays byte-stable (docs-guard pins some of it) and that colour is off when not a TTY. No new dependency: hand-roll the few escape codes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 src/cli/style.ts provides heading/label/dim/ok/warn/err helpers that are no-ops when not a TTY or NO_COLOR is set
- [ ] #2 amend, status, wait, explain, hook classify use it; hashes short and paths relative in human output; --json unchanged
- [ ] #3 piped output has no escape codes; existing docs-guard and CLI tests pass unchanged
- [ ] #4 npm test and lint pass
<!-- AC:END -->
