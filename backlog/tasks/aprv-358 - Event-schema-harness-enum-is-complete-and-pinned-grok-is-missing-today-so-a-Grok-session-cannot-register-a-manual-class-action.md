---
id: APRV-358
title: >-
  Event schema harness enum is complete and pinned: grok is missing today, so a
  Grok session cannot register a manual-class action
status: In Progress
assignee:
  - '@claude'
created_date: '2026-09-17 22:06'
updated_date: '2026-09-19 08:00'
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

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. schema/event.schema.json: add "grok" to the payload.harness enum, in HARNESS_KINDS order, and note in the description that the list is pinned equal to the runtime set by test.
2. src/cli/hook.ts: replace the five-arm switch in commandHook with an exported HARNESS_ADAPTERS map typed Readonly<Record<HarnessKind, HarnessAdapter>>, so the compiler requires an adapter for every kind and a test can read the table.
3. src/cli/verb-registry.ts: add the missing hook grok entry (oversight from APRV-243; no comment claims it is deliberate).
4. src/mcp/server.ts: add hook grok to EXCLUDED_VERBS with the same stdin reason as its four siblings, and update the pinned list in tests/mcp-server.test.ts.
5. New tests/harness-enum.test.ts: one test asserting set-equality with HARNESS_KINDS for the schema enum, the adapter table and its kind/originApp fields, the verb-registry hook subcommands, the MCP exclusions, and the HOOK_HELP usage line; a sibling covering the command-class launch tables, whose vocabulary differs on purpose (claude, not claude-code) and is pinned through an explicit alias map.
6. AC3 regression in the same file: for each of the five kinds, drive the compiled CLI with that harness dialect on a manual class against a scratch repo attested through the real CLI, and assert task.registered carries harness=<kind> and that approval.requested follows, then approval log verify exits 0. The envelope carries a version field so provenance does not depend on a binary being on PATH.
7. Conformance: five valid event fixtures schema/fixtures/event/valid/harness-kind-<kind>.json, one per harness, then regenerate conformance vectors.
8. build, typecheck, lint, npm test, npm run conformance.
<!-- SECTION:PLAN:END -->
