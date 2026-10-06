---
id: APRV-501
title: >-
  Release 0.4.2 before the Oct 11 enforcement: policy tool-name mapping
  (APRV-499) and the reserved delegation block (APRV-500) reach the village
status: In Progress
assignee: []
created_date: '2026-10-06 02:30'
labels:
  - agent-village
dependencies:
  - APRV-499
  - APRV-500
priority: high
ordinal: 385000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
0.4.1 was cut from main at the release PR #622 (2026-10-05). Since then main has carried two policy-schema changes the Agent Village fleet should run before APPROVALD_ENFORCE=1 on Oct 11: APRV-499 (#623, policy-declared tool-name mapping tools: and defaults.unmapped_tool, so a marketplace app is a policy line rather than a core release and every harness tool call can be recorded) and APRV-500 (#624, the delegation block reserved, validated and inert, and the model: reviewer identity reserved). The policy schema is closed, so a policy carrying tools:, defaults.unmapped_tool or delegation: fails to load on 0.4.1 and earlier, and the control-plane template writes those keys only once every tenant is pinned to 0.4.2. Same ceremony as APRV-476: a release PR (changelog section, version strings, release notes), Carter attests the SPEC amendments proposed in the APRV-499 and APRV-500 task notes, Carter's gated tag and push, Trusted Publishing, read-backs, then DATA-228 rebakes the checkpoint at 0.4.2 and HOSTED-32's pin moves.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Release PR opened with the 0.4.2 section naming APRV-499 and APRV-500, the H1 known property and the upgrade order; CI green; draft until Carter's SPEC attests
- [ ] #2 Carter attests the APRV-499 and APRV-500 SPEC amendments; tags and pushes v0.4.2 through the gate; publish run green; read-backs recorded
- [ ] #3 DATA-228 and HOSTED-32 told the version; the checkpoint rebuilt at 0.4.2 before the Oct 11 roll; the template carries tools/unmapped_tool/delegation only after
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-06 (agentvillage-d4/REL-0.4.2). Release PR prepared on lane/rel-0.4.2, cut from origin/main 046176d0 (#623 APRV-499 and #624 APRV-500 on top of 0.4.1; nothing else merged since v0.4.1). Same shape as 0.4.1's #622: version strings in the eight files #622 touched, the release-notes test lists, `## Unreleased` dated `## 0.4.2 — 2026-10-06` (GitHub server Date header 2026-10-06 02:30Z) with a fresh empty `## Unreleased` above it, `docs/releases/0.4.2.md`. Every other `0.4.1` hit is historical and stays (docs/cli-reference.md "Older cores (0.4.1 and earlier)", the log).

Added to the 0.4.2 section: the H1 KNOWN PROPERTY (claude-edge ruling on A10 N4, CLAIMS 2026-10-06: under `defaults.unmapped_tool: record`, every unmapped harness tool call is exempt from global `daily_actions` and the loop floor; class-scoped limits and `daily_usd` still meter it; no class limit in the village template for now) and an "Upgrade order" subsection carrying #623's H2 note and the delegation equivalent. The APRV-499 and APRV-500 entries are main's, kept as merged, still saying "pending sign-off".

APRV-500 task notes: S4 moved from "stage-3 refutation" to a precondition of stage 2 (adviser) with claude-edge's deny list (`policy.edit` and sub-classes, `log.mutate`, `account.credential`, `policy.core`, `harness.tool.unmapped`, refused at parse time). Notes only.

SPEC.md not edited (sha256 3b1de87a, the 0.4.1 bytes). The attest list for Carter is in the PR body under "Before the cut: Carter attests".

Targeted checks only (no full suite): `npx tsc -p tsconfig.json` exit 0; `node scripts/run-tests.mjs --only release-notes site-version-guard docs-guard demo-wordmark daemon-git-evidence version harness-version` exit 0, 94 pass, 0 fail; `node --test dist/tests/docs-guard.test.js` exit 0, 17/17; `node conformance/run.mjs` exit 0, 553 passed, 0 failed, 225 controls; `node scripts/release-notes.mjs 0.4.2` exit 0 (111 lines, starts `### Policy`), `v0.4.2` exit 0, `--check` exit 0 listing `0.4.2 2026-10-06` first; `npm pack --dry-run` exit 0, `approval-md-0.4.2.tgz`, 936 entries = 0.4.1's published 900 + 27 new schema fixtures + 9 dist files (core/tool-map, delegation, identity .js/.d.ts/.js.map), nothing stray.

Draft PR #625 (Release 0.4.2) opened against main.

Remaining: AC #1 needs CI green on the PR head and the SPEC attests (the PR stays a draft until then); AC #2 and #3 are Carter's.
<!-- SECTION:NOTES:END -->
