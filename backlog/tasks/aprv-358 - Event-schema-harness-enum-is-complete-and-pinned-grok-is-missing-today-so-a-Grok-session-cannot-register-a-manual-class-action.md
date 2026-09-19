---
id: APRV-358
title: >-
  Event schema harness enum is complete and pinned: grok is missing today, so a
  Grok session cannot register a manual-class action
status: Done
assignee:
  - '@claude'
created_date: '2026-09-17 22:06'
updated_date: '2026-09-19 08:22'
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
- [x] #1 schema/event.schema.json accepts every harness kind the adapter table in src/cli/hook.ts declares, including grok; the schema change is called out in the PR and the conformance schema-validation vectors gain a record per harness
- [x] #2 A test fails when a harness kind exists in the adapter table and not in the schema enum or the reverse, and the same test or a sibling covers every other enumeration of harness names found in src/, schema/ and conformance/
- [x] #3 A Grok session registering a manual-class action through the hook appends a valid approval.requested in a scratch log built through the real append path (the failing case today, as a regression test), and the same is asserted for muse, codex, cursor and claude-code
- [x] #4 build, typecheck, lint, the hook suites and conformance pass
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
PR #447, commit 4dd4487, armed with gh pr merge 447 --merge (autoMergeRequest enabledAt 2026-09-19T08:21:52Z, method MERGE).

What was done. schema/event.schema.json payload.harness gains grok, so the enum is the five kinds HARNESS_KINDS names. The hook adapters became an exported Readonly<Record<HarnessKind, HarnessAdapter>> and the approval hook subcommand dispatch now reads that table through isHarnessKind instead of a five-arm switch, so the compiler refuses a kind with no adapter. hook grok gained the verb-registry entry APRV-243 never wrote, plus the MCP exclusion and the agent-facing row in tests/cli-instructions.test.ts that follow from having a registry entry at all. New tests/harness-enum.test.ts pins six enumerations set-equal to HARNESS_KINDS and drives a manual-class registration per harness. Five conformance fixtures, schema/fixtures/event/valid/harness-kind-<kind>.json, one accepted record per harness; schema-validation.v1.json regenerated, 181 to 186 vectors.

Reproduction, recorded before the fix. With grok removed from the enum the grok case fails with the verdict a live Grok session would have got: hook-gate-refused:append-failed, task.registered could not be appended: event failed schema validation at the write boundary; log left unchanged. The other four harnesses pass in the same run, which is why nothing caught this on main.

Decisions. (1) The verb-registry and MCP gaps were treated as oversight and filled, not as deliberate omissions: no comment anywhere claimed they were intended, and the one comment that mentioned the gap (tests/mcp-server.test.ts) merely described it. Filling the registry entry without the MCP exclusion would have PUBLISHED hook grok as an MCP tool that reads stdin, which on a stdio server is the JSON-RPC stream, so the two edits are one decision. (2) The APRV-354 launch classes keep their own vocabulary, harness.launch.claude rather than claude-code, because that class names a binary and the harness kind names a protocol. Rather than unify them the test pins an explicit alias map, so a sixth harness has to choose a name instead of inheriting one. (3) The regression envelopes state a version field, which harnessProvenance prefers over probing the binary, so the suite records a harness on a machine with no harness installed. (4) Codex exercises apply_patch, not Bash: its native Bash is refused before gate intake because the contract hides the per-call workdir (APRV-310).

Global invariants (SPEC section 11.1). This task touches invariant 3 and invariant 4 by widening a write-boundary enum, and widens neither: harness and harness_version stay optional, additive, self-reported and read by nothing that decides anything, and harness_version keeps its one-line printable-ASCII 64-character cap. The unknown-kind control fixture (harness-unknown-kind.json) still refuses, and the new test asserts the control is present, so the enum stays closed.

Validation. npm run build, npm run typecheck, npm run lint clean. npm run conformance 374/374, 157 controls. npm test 4646 tests, 4622 pass; the 23 failures are the SMTP and email adapter suites, which fail on this laptop under Node v26 (Setting the TLS ServerName to an IP address is not permitted, against the 127.0.0.1 mock) and are untouched by this diff. CI runs Node 22. One adapter-zzz case flaked under parallel load and passes alone (36/36). node scripts/protected-path-guard.mjs --base origin/main --head HEAD: no protected paths changed, so no records advance was needed.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added grok to the event schema harness enum and pinned every other enumeration of harness names set-equal to HARNESS_KINDS: the hook adapter table (now a Record<HarnessKind, HarnessAdapter> the dispatch reads), the verb registry, the MCP exclusions, the hook help, the APRV-354 launch classes and the conformance vectors. Verified by tests/harness-enum.test.ts, which registers a manual-class action through each of the five harness dialects against a real log and checks the chain; removing grok from the enum reproduces the live failure (hook-gate-refused:append-failed at the write boundary) and fails exactly that case plus the pin. PR #447, armed.
<!-- SECTION:FINAL_SUMMARY:END -->
