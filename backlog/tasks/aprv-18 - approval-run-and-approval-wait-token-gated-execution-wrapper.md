---
id: APRV-18
title: 'approval run and approval wait: token-gated execution wrapper'
status: To Do
assignee: []
created_date: '2026-08-05 01:00'
labels: []
milestone: m-3
dependencies:
  - APRV-17
priority: medium
type: feature
ordinal: 18000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The gate's execution surface (SPEC section 10.1, human-settled point 5, 2026-08-06). `approval run -- <cmd...>` refuses without a valid token at a distinct exit code; on success it appends execution.started BEFORE spawning the child and execution.completed/execution.failed carrying the child's exit code after. A crash between started and completed leaves a dangling execution: the queue/status surface and verification tooling must report that state distinctly, and recovery is human-invoked, never automatic — no auto-reconciliation on the next run. `approval wait <task> --timeout` blocks until a request is decided, exit code encoding the decision (SPEC 10.1). Three consecutive execution.failed events for one task escalate to manual regardless of policy (SPEC 10.2 loop safety) — the projection for that lives here so the daemon (M5) can reuse it.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `approval run` without a valid token refuses at a distinct documented exit code, appending nothing; with a valid token it appends execution.started before spawn and completed/failed with the child's actual exit code after, consuming the token — all covered by subprocess tests
- [ ] #2 A simulated crash between started and completed leaves a dangling execution that the status/queue surface reports distinctly (not as completed, failed, or clean); nothing auto-repairs it, and the documented recovery is explicit human invocation
- [ ] #3 `approval wait <task> --timeout <duration>` blocks until decided or timeout; exit code encodes granted/rejected/expired/timeout distinctly, documented and pinned by tests
- [ ] #4 Three consecutive execution.failed events for one task yield an escalate-to-manual projection consumed by the gate for subsequent requests, covered by tests
- [ ] #5 All new CLI surface follows the frozen exit-code and --json conventions with --help documenting shapes and codes
<!-- AC:END -->
