---
id: APRV-330
title: Make approval up the default setup-to-operation handoff
status: Done
assignee:
  - '@codex'
created_date: '2026-09-12 18:24'
updated_date: '2026-09-12 18:38'
labels: []
dependencies: []
type: docs
ordinal: 248000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
ZZZ onboarding repeatedly recommended channel telegram listen instead of approval up, then hit missing default task-directory and live-draw warnings. Make the normal startup path explicit for operators and agents, while preserving standalone component commands for focused use. Clarify setup versus running services, one listener per bot, correct working directory and actual task-folder selection. Documentation only; no daemon, policy, credentials, release or running instance changes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 README startup and Telegram guidance recommend approval up after human setup/attestation and loading the instance environment.
- [x] #2 CLI reference clearly distinguishes up from standalone Telegram listener and warns against competing listeners for one bot.
- [x] #3 Guidance explains existing task directory selection, nonrecursive envelope scans, missing-folder warnings and live-draw startup without inventing approvals or weakening policy.
- [x] #4 Documented commands and behavior are checked against source and relevant documentation checks pass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Verify up, env, Telegram and task-scan behavior against current source. 2. Clarify README and CLI reference startup and troubleshooting. 3. Review scope and run documentation-tier checks. 4. Record evidence, commit and deliver through a pull request.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented README and CLI reference guidance. Source reviewed: env ambient precedence and cwd paths; up task-directory validation and draw startup; daemon regular-file nonrecursive scan. Build and documentation guard 16/16 exit 0; records checks 27/27 exit 0; lint, typecheck and git diff --check exit 0. Full npm test is running; no runtime, policy, credentials, or running instances changed.

Full suite first run: 4108 tests, 4106 passed, 1 failed, 1 skipped, exit 1. Failure was a missing APPEND_ERROR_CODES export during a concurrent rebuild; focused cli-env test passed 1/1 exit 0. Re-running full suite without concurrent builds. Documentation acceptance is verified; completion awaits final verification and delivery.

Clean full npm test rerun exit 0: 4108 tests, 4107 passed, 1 skipped, 0 failed. Lint/typecheck/docs guard passed. PR 385 source commit f664b31 passed every required GitHub check in run 34711346300; merge armed. Worktree /private/tmp/approval-up-startup-docs; branch codex/up-startup-docs. No runtime or running-process changes.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
README and CLI reference now guide operators and agents from setup and attestation through explicit instance environment loading to approval up. Standalone Telegram listener, one-poller requirement, actual flat task-directory coverage, draw prerequisites and optional web diagnostics are distinguished. Verified against source/help, docs guard 16/16, records guards 27/27, clean full suite 4107 passed and 1 skipped, lint and typecheck; all checks exited 0. Delivery via PR 385.
<!-- SECTION:FINAL_SUMMARY:END -->
