---
id: APRV-9
title: 'CLI: approval log verify | tail | export and approval reindex'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-04 21:46'
updated_date: '2026-08-05 00:05'
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
- [x] #1 `approval log verify` runs APRV-7 verification: exit 0 and a summary on an intact log, non-zero exit with the first bad seq on a tampered one
- [x] #2 `approval log tail [-n N]` prints the last N events; `approval log export` streams the full log to stdout without modifying it
- [x] #3 `approval reindex` rebuilds the SQLite index via APRV-8 and reports the number of events indexed
- [x] #4 Every command supports `--json` with a stable machine-readable output shape, covered by tests asserting the JSON output
- [x] #5 `--help` on each command documents usage, flags, and output shape (the section 10.1 CLI-first principle)
- [x] #6 CLI tests run each command end-to-end against a temp directory with a log built through the real append path
- [x] #7 `approval log verify` exit codes distinguish clean (0), corrupt, and torn-tail (distinct non-zero codes), mapping 1:1 onto the APRV-7 statuses
- [x] #8 Exit codes and --json output shapes are frozen public API: documented in --help and pinned by tests asserting both the exact exit code and the exact JSON shape per command and outcome
- [x] #9 I/O errors (permissions, unreadable paths) are distinguishable from integrity failures at the CLI boundary: distinct exit code and a message that does not use the word corrupt
- [x] #10 `approval log tail` on a torn-tail log prints the intact records to stdout and warns on stderr, exiting successfully rather than failing
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/cli/main.ts + command modules wrapping the core functions only (verify, tail, export from the log; reindex) — zero new dependencies, hand-rolled arg parsing.
2. cli.js becomes a thin ESM loader importing dist/src/cli/main.js with a clear not-built error message; placeholder banner preserved for bare `approval` with no args? No — bare invocation prints usage. (cli.js edit is in-scope for this task: it is the bin entry.)
3. Exit codes (frozen): 0 success/clean; 1 corrupt (integrity); 2 usage error; 3 torn-tail; 4 io. verify maps VerifyResult 1:1; io reason wording avoids "corrupt".
4. --json on every command with stable shapes; --help documents flags, exit codes, and JSON shape per command (SPEC section 10.1 CLI-first).
5. tail: default last 10, -n N; torn tail -> intact records to stdout + stderr warning, exit 0. export: full stream to stdout, log untouched.
6. reindex CLI: wraps APRV-8, --force for torn-tail, reports records indexed; refusals map to the same exit-code scheme.
7. Tests run the built CLI end-to-end as a subprocess against temp dirs with logs built through the real append path; assert exit codes, stdout/stderr split, and JSON shapes verbatim.
8. Opus subagent implements; fable reviews, gates from clean, finalizes, merges, pushes; M1 report to human.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented by Opus subagent; fable review found nothing to override and independently smoke-tested every exit path (clean=0, torn=3, tail-on-torn=0 with stderr warning, usage=2). Frozen exit codes: 0 success, 1 integrity, 2 usage, 3 torn-tail, 4 io — named constants in src/cli/exit-codes.ts, documented in every --help, pinned by 49 subprocess tests. The APRV-7 io nit is resolved at the CLI boundary as required: preflightLog() stats/access-checks the log before core verify() ever runs, so permission failures exit 4 with a message that never says corrupt (asserted by regex in tests); core verify.ts unmodified. Accepted CLI shape decisions: verify torn-tail JSON adds intactThroughSeq (head null, as core reports); corrupt JSON keeps records/head as explicit nulls so the key set is stable; --json usage/io failures go to stderr with empty stdout so piped stdout is always the result; verify/reindex outcomes are results on stdout even when non-zero. tail prints intact records + stderr warning on torn logs (exit 0), refuses corrupt logs (exit 1, nothing printed); export is byte-verbatim (asserted against raw file bytes). cli.js is now a thin loader for dist/src/cli/main.js using process.exitCode to keep stdout flushed. Zero new dependencies (hand-rolled arg parsing). Verified from wiped node_modules/dist: 267/267 tests, lint, typecheck green.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
approval log verify|tail|export and approval reindex as thin wrappers over the M1 core, with frozen exit codes (0/1/2/3/4 incl. distinct io) and frozen --json shapes documented in --help and pinned by 49 end-to-end subprocess tests; torn-tail tail prints intact records and warns on stderr; io messages never say corrupt. Verified: 267/267 tests, lint, typecheck from clean install, plus an independent reviewer smoke test of every exit path.
<!-- SECTION:FINAL_SUMMARY:END -->
