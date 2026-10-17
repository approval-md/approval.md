---
id: APRV-60
title: >-
  Backlog.md round-trip: preserve the approval envelope through backlog task
  edit
status: Done
assignee: []
created_date: '2026-08-17 15:51'
updated_date: '2026-08-17 19:07'
labels: []
milestone: m-8
dependencies:
  - APRV-63
  - APRV-66
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
- [x] #1 Reproduction documented in docs/upstream-backlog-issue.md with exact commands
- [x] #2 A file whose task has registered actions but no envelope is detected and reported distinctly by the runtime
- [x] #3 Round-trip test: envelope survives a backlog task edit, or the failure is caught by the detection above
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
M6 decomposition (2026-08-17): split into APRV-63 (detection half) and APRV-66 (upstream filing half); this task closes when both do and serves as the incident record.

M6 close (2026-08-17): all three ACs met. Reproduction documented in docs/upstream-backlog-issue.md with exact commands and the committed fixture pair (APRV-65/66). Detection shipped in APRV-63 (register refuses envelope-missing; daemon drift-tags with reason envelope-missing; doctor envelope-integrity). Round-trip: our own writer (APRV-61) preserves the envelope through any rewrite it performs, and the loss through the third-party CLI is caught by the detection above; the daemon now also writes state back (APRV-62), so the file the CLI rewrites is the one the daemon keeps honest between edits. Remaining human step lives on APRV-66 (file upstream, record URLs).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The first envelope ever written into a task file was dropped by Backlog.md 1.49.3; M6 turned that into a fixture (65), an upstream issue draft (66), our own round-trip-safe writer (61), daemon write-back (62), and three-point detection so a silent drop is never silent (63).
<!-- SECTION:FINAL_SUMMARY:END -->
