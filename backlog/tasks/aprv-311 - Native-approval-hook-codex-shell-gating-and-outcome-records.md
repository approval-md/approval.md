---
id: APRV-311
title: Native approval hook codex shell gating and outcome records
status: In Progress
assignee:
  - '@codex-sol'
created_date: '2026-09-08 07:24'
updated_date: '2026-09-08 07:58'
labels: []
dependencies:
  - APRV-310
references:
  - 'https://learn.chatgpt.com/docs/hooks'
priority: high
type: feature
ordinal: 229000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
User-authorized overnight Codex integration. Binding SPEC 6.3,7,9,10,11.1. Isolated branch; no live installation, credential access or deployment. Morning activation remains a separate pending task.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Bash reuses verified gate policy, budgets, waits and grant carryover with Codex actor/harness provenance.
- [ ] #2 Malformed/unexpected input denies; stable ids correlate success/failure reports, duplicates refuse and unknown outcomes append nothing.
- [ ] #3 Runtime/schema/registry/MCP exclusion support codex; Claude and Cursor regression tests pass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Reuse the harness adapter and verified gate path for Codex Bash; accept only documented event/tool/input shapes and stable session/tool ids. 2. Add codex runtime/schema provenance, CLI verb/help, and explicit MCP exclusion. 3. Keep Codex outcome parsing isolated from Claude/Cursor: implement only readings confirmed by APRV-310 native evidence; until available unknown outcomes remain open with diagnostic. 4. Add focused adversarial and regression tests using existing isolated real append fixtures; no live activation or config changes. Native probe is pending gate authorization, so implement independent adapter infrastructure first and finalize outcome acceptance after observed contracts.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Infrastructure reviewed: strict Bash validation and explicit denies; Codex tool/command/cwd payload plus domain-separated session/call digests preserve loop scope and avoid delimiter/cross-tool collisions; codex provenance/schema/registry/MCP exclusion. Sol focused regression 227/227 exit0 outside socket/sandbox restrictions; latest build and Codex/schema34/34 exit0; lint/typecheck exit0. Native hook outcomes remain unverified; current PostToolUse emits diagnostic and appends nothing. Task and outcome acceptance remain open while APRV-312 proceeds.
<!-- SECTION:NOTES:END -->
