---
id: APRV-9
title: 'CLI: approval log verify | tail | export and approval reindex'
status: To Do
assignee: []
created_date: '2026-08-04 21:46'
updated_date: '2026-08-04 23:36'
labels: []
milestone: m-1
dependencies:
  - APRV-7
  - APRV-8
priority: medium
type: feature
ordinal: 9000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC.md section 10.1 makes the CLI the primary interface for humans and agents, with schemas and instructions shipped in --help and `--json` on every command. M1's core functions (verify, reindex) need their CLI surface now so agents can actually use the log from M1 onward, and so the command/flag conventions (exit codes, --json output shape, help text style) are settled once before M2-M8 add more verbs. Scope is only the log-facing commands: `approval log verify`, `approval log tail`, `approval log export`, and `approval reindex`. The CLI is a thin wrapper over the APRV-6/7/8 core functions — no logic lives in the CLI layer itself. Other verbs (init, register, request, grant, ...) belong to later milestones.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `approval log verify` runs APRV-7 verification: exit 0 and a summary on an intact log, non-zero exit with the first bad seq on a tampered one
- [ ] #2 `approval log tail [-n N]` prints the last N events; `approval log export` streams the full log to stdout without modifying it
- [ ] #3 `approval reindex` rebuilds the SQLite index via APRV-8 and reports the number of events indexed
- [ ] #4 Every command supports `--json` with a stable machine-readable output shape, covered by tests asserting the JSON output
- [ ] #5 `--help` on each command documents usage, flags, and output shape (the section 10.1 CLI-first principle)
- [ ] #6 CLI tests run each command end-to-end against a temp directory with a log built through the real append path
- [ ] #7 `approval log verify` exit codes distinguish clean (0), corrupt, and torn-tail (distinct non-zero codes), mapping 1:1 onto the APRV-7 statuses
<!-- AC:END -->
