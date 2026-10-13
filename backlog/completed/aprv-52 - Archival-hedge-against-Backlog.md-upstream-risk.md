---
id: APRV-52
title: Archival hedge against Backlog.md upstream risk
status: Done
assignee:
  - '@fable'
created_date: '2026-08-14 13:49'
updated_date: '2026-08-17 09:38'
labels: []
dependencies: []
references:
  - 'https://github.com/MrLesk/Backlog.md'
ordinal: 52000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
approval.md extends the Backlog.md convention (SPEC principle 6: extend, never fork or replace). Backlog.md is not a code dependency: no package.json entry, and the runtime parses task files with our own frontmatter code. The coupling is the plain-markdown file convention plus the dev-workflow CLI (Homebrew install). Upstream risk (breaking CLI changes, repo deletion) therefore warrants cheap archival insurance, explicitly NOT a development fork: a private disaster-recovery mirror we never build from unless upstream vanishes, a recorded pinned CLI version with deliberate upgrades, and confirmation that round-trip fixtures catch format drift.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A private archival mirror of https://github.com/MrLesk/Backlog.md exists (git clone --mirror pushed to a private repo, or a local bare mirror), documented as disaster-recovery only, not a development fork
- [x] #2 A docs note records the pinned Backlog.md CLI version the project is validated against, the install command for that version, and the rule that upgrades are deliberate (run the round-trip suite before adopting a new CLI version)
- [x] #3 Round-trip test fixtures are confirmed to capture representative Backlog.md task files so CLI format drift is caught by npm test; gaps, if any, are noted
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Confirm round-trip fixture coverage (AC #3): locate M6 round-trip tests and fixtures, run npm test, note gaps.
2. Write docs/backlog-md-pin.md (AC #2): pinned CLI version 1.49.3, install command, deliberate-upgrade rule.
3. Archival mirror (AC #1): git clone --mirror of upstream to a local bare mirror; pushing to a private GitHub repo is a network action requiring approval, route through the gate per CLAUDE.md dogfood rule or fall back to local bare mirror plus human follow-up.
4. Verify: git ls-remote against the mirror, backlog --version matches the docs note, npm test green.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
AC #2: docs/backlog-md-pin.md written — pins CLI 1.49.3 (verified against backlog --version), gives npm exact-version install and brew pin, and states the deliberate-upgrade rule. AC #3 verified with a gap: the M6 round-trip fixture suite does not exist yet (no milestone beyond m5 in backlog/milestones, no frontmatter round-trip tests in tests/); src/core/frontmatter.ts is read-only by design with unknown-key preservation explicitly deferred to M6 (header comment, line 8). Gap recorded in the docs note. AC #1 BLOCKED: cloning upstream is a network call requiring approval; the approval daemon is not running in the primary checkout, so per CLAUDE.md the gate is unreachable and the session stops and escalates. Full suite green after the docs change: npm test 1130 pass / 0 fail, oxlint clean.

AC #1 verified: human ran the mirror clone. ~/mirrors/Backlog.md.git is a bare repo (rev-parse --is-bare-repository true), origin = https://github.com/MrLesk/Backlog.md, ls-remote shows 968 refs. Local bare mirror only, no private GitHub push. Refresh with git remote update inside the mirror.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Decided against forking Backlog.md (not a code dependency; SPEC principle 6). Delivered archival insurance instead: docs/backlog-md-pin.md pins CLI 1.49.3 with install commands and the deliberate-upgrade rule; recorded that the M6 round-trip suite does not yet exist so drift is caught manually until then; local bare mirror at ~/mirrors/Backlog.md.git verified with 968 refs. Verified with npm test (1130 pass), oxlint clean, git ls-remote on the mirror.
<!-- SECTION:FINAL_SUMMARY:END -->
