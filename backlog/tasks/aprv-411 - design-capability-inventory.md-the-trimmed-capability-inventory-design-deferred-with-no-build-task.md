---
id: APRV-411
title: >-
  design/capability-inventory.md: the trimmed capability-inventory design,
  deferred with no build task
status: Done
assignee:
  - '@fable'
created_date: '2026-09-20 19:34'
updated_date: '2026-09-20 19:35'
labels:
  - design
dependencies: []
references:
  - private/approval-capability-inventory-spec.md
  - docs/claude-code-hook.md
priority: low
ordinal: 318000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter asked (2026-09-20, after APRV-408) to keep the ChatGPT capability-inventory proposal (private/approval-capability-inventory-spec.md, 57 KB) as a trimmed design note under design/. APRV-408 already took the one buildable finding (doctor roster drift, handler binding). This task records the rest as a future direction: the six-way distinction (available, classifiable, policy-configured, interception configured, interception observed, bounded enforcement evidence), the invariants that would bind a build, what a first release would and would not deliver, and why it is deferred. No code, no schema, no task for the build. Editing design/ classifies policy.edit through the hook.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 design/capability-inventory.md exists, under 250 lines, headed by a status line saying it is deferred design with no build task and nothing wired into the gate
- [x] #2 It records the six-way distinction, the ten invariants condensed, the routes and classes views, the evidence dimensions, the CLI sketch, and the deferred live-discovery, session-evidence and enforcement milestones, each in a few sentences
- [x] #3 It states what APRV-408 already shipped and that the held read-scope matcher line is a documented decision, so a future reader does not re-file the drift as a discovery
- [x] #4 It names the reasons for deferral: no user for MCP snapshot import or log projection today, the existing verbs (doctor, coverage, policy check, hook classify) already answer the operator questions the MVP targets, and a new verb needs a registry publication decision
- [x] #5 Prose follows the CLAUDE.md style rule (few em dashes, no not-X-but-Y); the docs-guard suite passes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Write design/capability-inventory.md from the private spec: keep the distinction, invariants, views, evidence dimensions, CLI sketch, deferred milestones; drop the acceptance matrix, the JSON contract, the source register and the milestone 1-3 build detail. 2. State what APRV-408 shipped and the held read-scope decision. 3. Run docs-guard, commit (policy.edit through the hook), PR, arm merge.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Written from the private proposal; 159 lines, zero em dashes, docs-guard 16 pass. Dropped: the acceptance matrix (pointed at, not copied), the TypeScript report contract, the source register, milestone 1-3 build detail, the illustrative terminal output. Added section 2 (what already exists) so APRV-408 and the held read-scope line are not re-filed as discoveries. design/ is policy.edit; the commit went through the hook.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
design/capability-inventory.md records the six-way distinction, eight condensed invariants, the route/class model, the CLI sketch with the registry decision, the three deferred milestones and the reasons for deferral. Verified: docs-guard passes, no em dashes, under 250 lines.
<!-- SECTION:FINAL_SUMMARY:END -->
