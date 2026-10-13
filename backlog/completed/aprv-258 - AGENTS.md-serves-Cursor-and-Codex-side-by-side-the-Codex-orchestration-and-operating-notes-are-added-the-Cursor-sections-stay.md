---
id: APRV-258
title: >-
  AGENTS.md serves Cursor and Codex side by side: the Codex orchestration and
  operating notes are added, the Cursor sections stay
status: Done
assignee:
  - '@claude'
created_date: '2026-09-05 00:06'
updated_date: '2026-09-05 02:03'
labels: []
dependencies: []
references:
  - AGENTS.md
priority: medium
ordinal: 197000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter drafted a Codex version of AGENTS.md (Astra/Sol/Spark orchestration, Codex operating notes, imported project memory at .codex/claude-memory.md, an import recovery boundary) as a full replacement of the Cursor-oriented file. Both interfaces are in use, so the file must serve both: keep every Cursor section as it stands on main (including the APRV-250 delivery rule), add the Codex sections beside them, and keep one shared set of invariants, Backlog workflow, dogfooding rules and permissions so the two interfaces cannot drift on policy. AGENTS.md classifies policy.edit; the edit goes through the gate and the tap is the sign-off.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 AGENTS.md keeps the Cursor model orchestration section and every rule main carries at the time of the edit, byte-for-byte where not restructured
- [x] #2 AGENTS.md gains a Codex model orchestration section (Astra, Sol, Spark), Codex-specific operating notes, the imported project memory pointer, and the import recovery boundary, worded as in the draft
- [x] #3 Shared sections (invariants, Backlog workflow, dogfooding, permissions, documentation style) appear once and apply to both interfaces; interface-specific hook notes name their interface
- [x] #4 tests/cli-instructions.test.ts and the docs guard pass; approval import agents-md still reads the permissions section
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Take main's AGENTS.md (APRV-250 delivery rules included) as the base. 2. Keep the Cursor model orchestration section; add a Codex model orchestration section (Astra, Sol, Spark) after it; move the delegation and delivery paragraphs into one shared section. 3. Add a Codex hook note beside the Cursor hook paragraph; name Codex configuration among the protected paths. 4. Append the Codex imported-memory pointer and the import recovery boundary. 5. Write through the policy.edit gate; verify cli-instructions and docs guard.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Composed from main's AGENTS.md (APRV-250 delivery rules kept verbatim) plus Carter's Codex draft: Cursor orchestration section kept, Codex orchestration section (Astra, Sol, Spark) added beside it, delegation and delivery rules merged into one shared section, Codex hook note beside the Cursor hook paragraph, Codex configuration named among the protected paths, imported-memory pointer and import recovery boundary appended. Written through the policy.edit gate (commit bb83a45). Verified: docs-guard and cli-instructions suites pass (23 tests) after the change, on top of the full suite on the merged tree.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
AGENTS.md now serves Cursor and Codex side by side: all of main's content kept, the Codex sections from Carter's draft added, one shared set of invariants and permissions. Verified with the docs guard and instructions suites.
<!-- SECTION:FINAL_SUMMARY:END -->
