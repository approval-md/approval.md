---
id: APRV-103
title: >-
  SPEC drift from M8, for human sign-off: §10.1 mcp serve line, §10.5 exclusions
  and identity order, §14 hook sentence, how pending amendments are marked
status: Done
assignee: []
created_date: '2026-08-19 12:32'
updated_date: '2026-08-20 19:05'
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
- [x] #1 SPEC §10.1 lists approval mcp serve with a one-line gloss matching the other verbs
- [x] #2 SPEC §10.5 names the consume and hook claude-code exclusions and states that the server identity is appended last to every argv
- [x] #3 SPEC §14 M8 sentence matches what src/cli/hook.ts does (or a task is filed to change the hook), decided by the human
- [x] #4 A convention for marking amendments pending sign-off exists and the seven listed amendments are marked or signed
- [ ] #5 verb-registry.ts carries human_only_note only where human_only is true; the MCP exclusion reasoning lives in one place
- [x] #6 npm test passes (docs-guard, cli-help and layering tests included)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
SPEC amendments applied and SIGNED OFF: the human merged PR 107 (2026-08-20), which is the sign-off for the applied wording, and ratified the pending-amendment convention (the (Amended APRV-n, pending sign-off.) suffix, stated once in the front matter). Follow-up PR 108 (also merged) applied the suffix to the APRV-58/82/106/107 sites flagged in task notes but outside this task's seven. Builder process note for the record: the first application run stopped mid-work on a hook-timeout per CLAUDE.md's stop-and-escalate rule (the human was away from the phone); the remaining four suffix edits were finished by the orchestrator under per-edit gating. Remaining OPEN on this task: the code-side ACs (verb-registry human_only_note cleanup on consume / hook claude-code; the stale --dir claims in docs/claude-code-hook.md lines 56-57) need a code branch.

AC 5 left UNCHECKED because it is WRONG, discovered by attempting it: human_only_note records why the human_only judgment went the way it did in EITHER direction, and tests/cli-instructions.test.ts pins that agent-facing-by-argument verbs (consume, hook claude-code, adapter email) MUST carry the note. The AC's premise (notes only where human_only is true) came from the degraded-context review misreading the field. The MCP exclusion reasoning already lives in one place per side of the boundary: src/mcp/server.ts names its exclusions with reasons, SPEC 10.5 states them normatively (signed off in PR 107). The docs --dir lines the review flagged were already corrected by APRV-101. Nothing remains; task closed with AC 5 recorded as invalid rather than satisfied.
<!-- SECTION:NOTES:END -->
