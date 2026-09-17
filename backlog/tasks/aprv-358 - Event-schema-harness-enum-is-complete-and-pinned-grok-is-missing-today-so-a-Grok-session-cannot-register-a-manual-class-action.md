---
id: APRV-358
title: >-
  Event schema harness enum is complete and pinned: grok is missing today, so a
  Grok session cannot register a manual-class action
status: To Do
assignee: []
created_date: '2026-09-17 22:06'
labels:
  - schema
  - hook
  - harness
  - bug
dependencies: []
priority: high
ordinal: 275000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found by the Muse adapter lane on 2026-09-18 (PR #437). schema/event.schema.json carries a closed enum of harness names on the records a hook writes. When the Grok Build adapter landed (APRV-243, PR #414) `grok` was never added to it, and no test noticed: the adapter classifies and denies correctly, but a Grok session that registers a manual-class action fails validation at the write boundary, so the request never reaches a human. The Muse lane added `muse` for its own adapter and deliberately left `grok` alone because schema changes are their own tasks. Carter asked on 2026-09-18 that the list be made complete. Fix the enum and, more importantly, make the omission impossible to repeat: the set of harness kinds in the adapter table in src/cli/hook.ts (claude-code, cursor, codex, grok, muse) and the schema enum must be one list or be pinned equal by a test, and the same check should cover any other place a harness name is enumerated (verb registry, conformance fixtures, docs tables, origin_app values). Related: APRV-243, APRV-350, APRV-311, APRV-82.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 schema/event.schema.json accepts every harness kind the adapter table in src/cli/hook.ts declares, including grok; the schema change is called out in the PR and the conformance schema-validation vectors gain a record per harness
- [ ] #2 A test fails when a harness kind exists in the adapter table and not in the schema enum or the reverse, and the same test or a sibling covers every other enumeration of harness names found in src/, schema/ and conformance/
- [ ] #3 A Grok session registering a manual-class action through the hook appends a valid approval.requested in a scratch log built through the real append path (the failing case today, as a regression test), and the same is asserted for muse, codex, cursor and claude-code
- [ ] #4 build, typecheck, lint, the hook suites and conformance pass
<!-- AC:END -->
