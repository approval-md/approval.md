---
id: APRV-330
title: Make approval up the default setup-to-operation handoff
status: In Progress
assignee:
  - '@codex'
created_date: '2026-09-12 18:24'
updated_date: '2026-09-12 18:29'
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
- [ ] #1 README startup and Telegram guidance recommend approval up after human setup/attestation and loading the instance environment.
- [ ] #2 CLI reference clearly distinguishes up from standalone Telegram listener and warns against competing listeners for one bot.
- [ ] #3 Guidance explains existing task directory selection, nonrecursive envelope scans, missing-folder warnings and live-draw startup without inventing approvals or weakening policy.
- [ ] #4 Documented commands and behavior are checked against source and relevant documentation checks pass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Verify up, env, Telegram and task-scan behavior against current source. 2. Clarify README and CLI reference startup and troubleshooting. 3. Review scope and run documentation-tier checks. 4. Record evidence, commit and deliver through a pull request.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented README and CLI reference guidance. Source reviewed: env ambient precedence and cwd paths; up task-directory validation and draw startup; daemon regular-file nonrecursive scan. Build and documentation guard 16/16 exit 0; records checks 27/27 exit 0; lint, typecheck and git diff --check exit 0. Full npm test is running; no runtime, policy, credentials, or running instances changed.
<!-- SECTION:NOTES:END -->
