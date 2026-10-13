---
id: APRV-229
title: >-
  Integrations register: docs/integrations-considered.md seeded with the
  tool-gateway adapter (parked) and the UCA harness updater (declined)
status: Done
assignee:
  - '@claude'
created_date: '2026-09-02 17:01'
updated_date: '2026-09-02 17:13'
labels: []
dependencies:
  - APRV-227
  - APRV-228
references:
  - docs/proposals/tool-gateway-adapter.md
  - >-
    https://github.com/Dicklesworthstone/misc_coding_agent_tips_and_scripts/blob/main/UNIVERSAL_CODING_AGENT_HARNESS_UPDATER.md
priority: medium
ordinal: 185000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Every external adapter, harness, updater, gateway or protocol we evaluate for integration should leave one canonical record: what it is, what it exposes, how it fits the taxonomy and the §11 invariants, the conclusion, and next steps. Today the only prior assessment (the tool-gateway adapter, parked 2026-08-31) sits in docs/proposals with nothing pointing at it, and the UCA harness-updater question (asked 2026-09-02) has no home. This task creates the register and seeds it with both, so the next candidate gets an entry by habit rather than a fresh format. The UCA verdict is declined: it exposes no hooks, config, pinning or stable JSON, and its unattended three-hourly upgrade of the binary hosting the PreToolUse hook is the supply-chain decision SPEC §7 reserves for a human. Follow-ups filed as APRV-227 and APRV-228.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 docs/integrations-considered.md exists with a purpose paragraph, a summary table (candidate, link, date, kind, verdict, pointer), a fixed per-entry heading set (What it is, What it exposes, Fit, Conclusion, Next steps) and a "How to add an entry" section
- [x] #2 Entry for the tool-gateway adapter: parked 2026-08-31, links docs/proposals/tool-gateway-adapter.md as the detailed design
- [x] #3 Entry for the UCA harness updater: declined 2026-09-02, quotes the verified `approval hook classify` results, names APRV-227 and APRV-228 as next steps
- [x] #4 README.md links the register from "Where to look next"
- [x] #5 The light check tier (docs guard) passes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Write docs/integrations-considered.md: purpose, summary table, fixed per-entry headings, How to add an entry; seed with tool-gateway (parked, summarised from docs/proposals) and UCA (declined, with verified classifier output and APRV-227/228 as next steps).
2. Add one paragraph to README 'Where to look next' linking the register.
3. Run npm run check:changed; verify the docs guard passes.
4. Commit, push, open PR, arm merge.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
UCA declined: no hooks/config/pinning/stable JSON to integrate with; unattended three-hourly upgrade of the hook-hosting binary is the SPEC §7 supply-chain decision reserved for a human; SessionStart hook rejected because a later timer run invalidates it. Follow-ups filed as APRV-227 (harness version provenance + doctor row) and APRV-228 (classifier deps.upgrade for self-update verbs); both To Do, no plan, per task-creation guide. Verified npm run check:changed (full tier because backlog/** is in the diff): 2893 pass; one ci-guard failure was a missing node_modules package in the fresh worktree, cleared by npm ci and a rerun of dist/tests/ci-guard.test.js (28 pass).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added docs/integrations-considered.md (purpose, summary table, fixed five-heading entries, how-to-add) seeded with the tool-gateway adapter (parked 2026-08-31, pointer to docs/proposals) and UCA (declined 2026-09-02, verified classifier table, next steps APRV-227/228); linked from README 'Where to look next'. Verified by npm run check:changed plus a clean ci-guard rerun after npm ci.
<!-- SECTION:FINAL_SUMMARY:END -->
