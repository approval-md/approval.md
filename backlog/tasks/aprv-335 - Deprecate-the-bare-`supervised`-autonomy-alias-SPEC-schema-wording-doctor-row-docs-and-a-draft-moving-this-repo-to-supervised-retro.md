---
id: APRV-335
title: >-
  Deprecate the bare `supervised` autonomy alias: SPEC, schema wording, doctor
  row, docs, and a draft moving this repo to supervised-retro
status: To Do
assignee: []
created_date: '2026-09-14 04:04'
labels: []
dependencies:
  - APRV-334
references:
  - docs/proposals/repo-values-block.md
ordinal: 253000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Since APRV-127 the bare `supervised` level is only an alias of `supervised-retro`, kept so pre-split policies keep their meaning, with a load-time note. Reading a policy that mixes `supervised`, `supervised-live` and `supervised-retro` suggests three bargains where there are two, and the SPEC glossary row (line 64) still lists three levels with no split at all. This task marks the alias deprecated without removing it (removal would break published policies), surfaces it in `approval doctor`, fixes the glossary, updates every doc that enumerates levels, and drafts the five class lines in this repo policy that still use the bare word (vcs.push.main, vcs.pr.*, policy.edit.design, vcs.remote.meta, and any other) as supervised-retro, appended to docs/proposals/approval-md-2026-09.md for Carter to paste. SPEC edits classify policy.edit.spec and carry an (Amended APRV-NNN, pending sign-off.) marker. No §11 invariant is touched; implementation notes must say so.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 SPEC §5.2 autonomy-split bullet states the bare spelling is deprecated: still parsed as supervised-retro, still noted at load time, surfaced in the health report, removed in a future schema version
- [ ] #2 SPEC glossary row for Autonomy level lists human-only, manual, supervised-live, supervised-retro, autonomous in strictness order and names supervised as the deprecated alias
- [ ] #3 schema/policy.schema.json keeps supervised in both autonomy enums and its descriptions say deprecated; the load-time note text says deprecated and tests/autonomy-split.test.ts asserts it
- [ ] #4 approval doctor gains an autonomy-alias row: pass with a detail naming each class pattern that uses the bare word and a fix hint, or pass with none listed; a covered test proves both shapes
- [ ] #5 README.md (dictionary row and levels prose) and docs/cli-reference.md say deprecated alias wherever they say alias today
- [ ] #6 docs/proposals/approval-md-2026-09.md carries a section with every bare-supervised class line rewritten to supervised-retro, comments intact
- [ ] #7 tests/dogfood.test.ts still pins the live APPROVAL.md unchanged; npm test and lint pass
<!-- AC:END -->
