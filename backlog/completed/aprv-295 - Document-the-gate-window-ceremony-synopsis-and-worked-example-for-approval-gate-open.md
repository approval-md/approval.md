---
id: APRV-295
title: >-
  Document the gate window ceremony: synopsis and worked example for approval
  gate open
status: Done
assignee:
  - 'agent:fable'
created_date: '2026-09-07 02:45'
updated_date: '2026-09-07 02:47'
labels:
  - docs
dependencies: []
ordinal: 217000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
docs/cli-reference.md's gate section explains the window's semantics but carries no usage synopsis and never says --reason is required (the flag appears only as the refusal code gate-reason-required and inside the status JSON). README.md does not mention the verb at all. A person reaching for the escape hatch under pressure gets the required flag from --help alone. Add the synopsis and one worked example to the gate section and a README pointer, so the ceremony is discoverable from the docs.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 docs/cli-reference.md gate section carries the usage synopsis for open, close and status, matching src/cli/help.ts
- [x] #2 docs/cli-reference.md gate section states that --reason is required and recorded, with one worked example invocation of approval gate open including --for and --reason
- [x] #3 README.md names approval gate open as the human-only escape hatch and points at docs/cli-reference.md#gate
- [x] #4 No behavior change; npm run build and the docs-related tests pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add a usage synopsis (open/close/status, copied from GATE_WINDOW_HELP in src/cli/help.ts) and a worked example to the gate section of docs/cli-reference.md, stating that --reason is required and recorded. 2. Add one README.md sentence under 'How the gate holds' naming approval gate open as the human-only escape hatch, pointing at docs/cli-reference.md#gate (README carries no verb inventory, so a pointer only). 3. Run npm run build and the help/gate tests.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Docs-only change. The gate section of docs/cli-reference.md gained a Usage block (copied verbatim from GATE_WINDOW_HELP so the two cannot drift), a paragraph stating --reason is required and recorded (absent: usage error; empty: gate-reason-required; no minimum length), and a worked open/status/close example with the understood line marked as typed at the prompt. README.md gained one bullet under How the gate holds naming the verb as the recorded escape hatch and pointing at the reference anchor; the README carries no verb inventory by design, so a pointer only. Prompted by a live question on 2026-09-06: the required flag was discoverable from --help alone. Verified: npm run build, node --test on cli-help, cli-gate-window and cli-instructions (36 pass), oxlint clean.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added the gate verb's usage synopsis, the --reason requirement, and a worked example to docs/cli-reference.md#gate, plus a README pointer to it. Verified with npm run build and the help, gate-window and instructions test files (36 pass) and oxlint.
<!-- SECTION:FINAL_SUMMARY:END -->
