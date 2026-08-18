---
id: APRV-75
title: 'Doctor: uniform fix commands and the value-free environment check'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-18 01:39'
updated_date: '2026-08-18 02:39'
labels: []
milestone: m-10
dependencies:
  - APRV-73
priority: medium
type: feature
ordinal: 74000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
doctor catches misconfiguration and does not help configure; some fixes are literal commands, some are prose. Every fail fix begins with a runnable command (shape test over all failing verdicts); identity, audit-sampling secret-unset, vault passphrase-unset, and telegram unconfigured point at the corresponding approval setup verb, keeping the export line as the manual alternative. New environment check APPENDED (pinned order): each policy-named variable set/unset BY NAME ONLY; .approval/env presence, mode, gitignore coverage, plaintext literals; skip when nothing unset and no file; fail only for wrong mode, plaintext secret, or ungitignored file. Doctor still appends nothing, sends nothing, getMe only. Generalize VAULT_IGNORE_PATTERNS to cover .approval/env.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Every fail fix begins with a runnable command; the four env-shaped fixes point at approval setup <thing> with the export line kept as alternative
- [x] #2 environment check appended (10 -> 11), value-free, with the stated skip/fail semantics; pinned lists extended additively
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, worktree from aprv-73 branch, parallel with 74; file boundary: doctor.ts + its tests + help DOCTOR_HELP only. 2. Uniform fix commands; four env-shaped fixes point at approval setup; new environment check appended (value-free); VAULT_IGNORE_PATTERNS generalised. PR.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Opus subagent build, PR #41. Fix-prefix allowlist pinned in runtime and test (approval/chmod/echo/export/mv/node/npm; no rm, sudo, git commit: doctor repairs nothing). Four env-shaped fixes point at approval setup <thing> with export alternatives kept; telegram skip detail names setup telegram. Check 11 environment appended: pass when all policy-named variables set/resolved/declared-against-keystore; fail in order for file refusal (mode/io/syntax), ungitignored env file, plaintext secret literal, helper-missing declaration; skip naming unset variables otherwise. DOCTOR DOES NOT RESOLVE KEYSTORE SOURCES: injects a non-resolving runner into the same resolveEnvironment call approval env --check uses (so they cannot disagree) and reports keychain:<svc> as declared-not-resolved; rationale: security find-generic-password and secret-tool raise GUI prompts for locked stores and BLOCK on a human, unacceptable from ssh/CI and trains click-through; a diagnostic may cost time and packets, never a human. Value-free on every path (secret sweep). Reviewer-weigh: gitignore checked against --dir (parity with vault check); bare basename env pattern counts as covering (correct git semantics; possible false pass beside a virtualenv named env). +10 tests, 1440.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Doctor fixes are command-first from a pinned allowlist and point at approval setup; the appended value-free environment check reports names/status/mode/gitignore/plaintext without ever resolving a keystore or blocking on a human. PR #41.
<!-- SECTION:FINAL_SUMMARY:END -->
