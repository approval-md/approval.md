---
id: APRV-60
title: >-
  Backlog.md round-trip: preserve the approval envelope through backlog task
  edit
status: To Do
assignee: []
created_date: '2026-08-17 15:51'
labels: []
dependencies: []
priority: high
type: bug
ordinal: 59000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed live at M5 close: backlog task edit rewrote the APRV-51 task file and silently dropped the entire approval: frontmatter key (the envelope the proof registered and executed against). Restored by hand. SPEC 6 says implementations MUST preserve unknown frontmatter keys when rewriting task files, and CLAUDE.md names round-trip fidelity a hard requirement with M6 tests. This is the concrete reproduction: create a task, add an approval envelope, run any backlog task edit, observe the key vanish. Two halves: (a) the upstream Backlog.md issue (docs/upstream-backlog-issue.md draft, now with this reproduction) filed by the human; (b) our own defense: approval register or the daemon detects an envelope missing from a file whose task has log history and reports it distinctly (an envelope.drift variant or a doctor check), so a silent drop is never silent. Belongs to M6 decomposition.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Reproduction documented in docs/upstream-backlog-issue.md with exact commands
- [ ] #2 A file whose task has registered actions but no envelope is detected and reported distinctly by the runtime
- [ ] #3 Round-trip test: envelope survives a backlog task edit, or the failure is caught by the detection above
<!-- AC:END -->
