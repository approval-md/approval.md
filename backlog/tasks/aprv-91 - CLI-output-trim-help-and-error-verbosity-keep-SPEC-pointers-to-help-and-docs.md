---
id: APRV-91
title: 'CLI output: trim help and error verbosity, keep SPEC pointers to help and docs'
status: To Do
assignee: []
created_date: '2026-08-18 12:04'
updated_date: '2026-08-18 12:05'
labels:
  - cli
  - ux
dependencies:
  - APRV-90
ordinal: 82000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed running examples/email-demo.md (2026-08-18). Interactive output cites SPEC.md sections inline (`This is config-declared identity (SPEC.md §11)`) and every usage error appends the full per-verb help, which itself restates its rationale (the trust-boundary paragraph appears twice on one screen for setup identity) and repeats the frozen exit-code table. To a first-time operator without SPEC.md open the section pointers read as internal jargon, and the one line they needed is buried. Direction: keep the "why" prose and SPEC pointers in --help and docs/, not in prompt and error lines; per-verb help is usage plus one or two lines of intent, with the exit-code table only in `approval --help`; usage errors print the error and a one-line `see approval <verb> --help` unless the error is genuinely about argument shape. Do a pass over src/cli/*HELP* constants and the usageError paths, not only setup. Coordinate with the sibling task on setup prompt reprompting so the two do not fight over the same lines.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Interactive prompt lines and error lines carry no SPEC.md section citations; --help and docs keep them
- [ ] #2 Per-verb help is usage plus at most a short paragraph of intent; the exit-code table lives only in top-level help
- [ ] #3 Usage errors print the message plus a one-line pointer to --help instead of the full help text, except for argument-shape errors where the usage line is shown
- [ ] #4 Every existing test asserting on help/error text updated; examples/*.md transcripts updated to match
- [ ] #5 npm test and lint clean
<!-- AC:END -->
