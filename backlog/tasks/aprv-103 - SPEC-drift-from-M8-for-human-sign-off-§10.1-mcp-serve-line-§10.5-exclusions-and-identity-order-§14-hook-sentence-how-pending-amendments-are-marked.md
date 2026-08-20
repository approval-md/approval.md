---
id: APRV-103
title: >-
  SPEC drift from M8, for human sign-off: §10.1 mcp serve line, §10.5 exclusions
  and identity order, §14 hook sentence, how pending amendments are marked
status: To Do
assignee: []
created_date: '2026-08-19 12:32'
updated_date: '2026-08-20 12:55'
labels:
  - spec
  - docs
milestone: m-12
dependencies: []
priority: medium
ordinal: 95000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found by the 2026-08-19 M8 review (code on main at 3637632 audited against SPEC.md). The M8 surfaces honour SPEC §11 and §11.1 (no .approval/env read, --as stripped and refused on the MCP server, identity appended last, refusals as isError tool results with the CLI code, hook fail-closed and never "ask"), but the spec text lags the code in four places, and agents do not edit SPEC.md silently (CLAUDE.md), so this task is the call-out. (1) §10.1 command block has no "approval mcp serve" line; the handover said it had been added. (2) §10.5 says the tool surface is "the agent-facing half of the verb registry, one tool per verb" and never names the two further exclusions the code applies (consume: internal plumbing that run wraps; hook claude-code: reads the stdin the transport owns, src/mcp/server.ts EXCLUDED_VERBS) nor that the server identity is appended last to every argv so it wins; a conformance reader building from SPEC alone gets a different tool list. (3) §14 M8 says the hook "returns allow only on a decision the log records", but src/cli/hook.ts allows autonomous classes, non-gated tools, non-protected file edits and the gate verb itself with nothing appended, and allows a supervised class after registration with no approval event; the sentence should say allow is recorded only where the class is gated (manual waits on a logged decision; supervised appends task.registered; autonomous appends nothing), or the hook should change. (4) The amendments the builders drafted (§10.1 setup/instructions lines, §10.3 setup nouns, §10.4 vault writer, §10.5 rewrite, §5.2 environment map and telegram names, §11 no-implicit-config paragraph, §11.1 invariant 7) all read as ratified text; nothing in SPEC.md marks them pending sign-off, only docs/HANDOVER.md and task notes do. Decide the convention (a "(Amended APRV-n, pending)" suffix, or a sign-off line in the task) and apply it once. Also pending on the human: the CLAUDE.md Engineering-invariants bullet for invariant 7 (drafted in APRV-73 notes). Small related cleanups that can ride the same PR: src/cli/verb-registry.ts attaches human_only_note to consume and hook claude-code although their human_only is false (the MCP exclusion map restates the same reasoning), and docs/claude-code-hook.md lines 56-57 describe --dir scoping the log, which is APRV-101 and not yet true.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 SPEC §10.1 lists approval mcp serve with a one-line gloss matching the other verbs
- [ ] #2 SPEC §10.5 names the consume and hook claude-code exclusions and states that the server identity is appended last to every argv
- [ ] #3 SPEC §14 M8 sentence matches what src/cli/hook.ts does (or a task is filed to change the hook), decided by the human
- [ ] #4 A convention for marking amendments pending sign-off exists and the seven listed amendments are marked or signed
- [ ] #5 verb-registry.ts carries human_only_note only where human_only is true; the MCP exclusion reasoning lives in one place
- [ ] #6 npm test passes (docs-guard, cli-help and layering tests included)
<!-- AC:END -->
