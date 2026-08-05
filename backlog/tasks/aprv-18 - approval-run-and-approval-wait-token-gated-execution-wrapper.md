---
id: APRV-18
title: 'approval run and approval wait: token-gated execution wrapper'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 01:00'
updated_date: '2026-08-05 02:11'
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
- [x] #1 `approval run` without a valid token refuses at a distinct documented exit code, appending nothing; with a valid token it appends execution.started before spawn and completed/failed with the child's actual exit code after, consuming the token — all covered by subprocess tests
- [x] #2 A simulated crash between started and completed leaves a dangling execution that the status/queue surface reports distinctly (not as completed, failed, or clean); nothing auto-repairs it, and the documented recovery is explicit human invocation
- [x] #3 `approval wait <task> --timeout <duration>` blocks until decided or timeout; exit code encodes granted/rejected/expired/timeout distinctly, documented and pinned by tests
- [x] #4 Three consecutive execution.failed events for one task yield an escalate-to-manual projection consumed by the gate for subsequent requests, covered by tests
- [x] #5 All new CLI surface follows the frozen exit-code and --json conventions with --help documenting shapes and codes
- [x] #6 New verb `approval status`, distinct from queue: reports attestation state, dangling executions, budget headroom per limit, latest verification summary, and loop-escalation flags; --json shape and exit codes frozen by subprocess tests per the APRV-9 conventions
- [x] #7 `approval queue` remains solely the pending-decision inbox and gains no status content
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented by Opus subagent; fable review found nothing to override. Exit-code additions 5 (run: no valid execution token — distinct because the repair is distinct) and 6 (wait: timeout) added in the declared single home src/cli/exit-codes.ts, 0-4 untouched, each new code emitted by exactly one verb; wait overloads 1/3 as exit-code-equals-decision per SPEC 10.1, flagged in help for review. loop-escalated added to the gate refusal union at the documented seam — escalation forces the manual path and never blocks it (refusing manual too would leave no way back). Accepted decisions: budget headroom via zero-cost probe (class limits omitted — they need a matched rule status does not have); manual-path start does not re-check attestation (grant+mint were the guarded operations per the settled design; the token proves an attested grant); signal deaths recorded 128+signum, unspawnable 127; a refused finish after a successful child exits with the refusal code (failure to record success must not read as success); run --json summary goes to stderr since stdout belongs to the inherited-stdio child (the one documented departure from one-object-on-stdout). Deliberately unbuilt and flagged for human decision: no CLI verb closes a dangling execution — finishExecution is the core-level human recovery, but making that write casual would undercut the log; the verb shape awaits human sign-off. Real-crash test: child SIGKILLs its run parent; status reports dangling, queue does not, second run refuses token-consumed, nothing auto-repairs. Verified from wiped node_modules/dist: 629/629, lint, typecheck.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
approval run/wait/status/queue: token-gated transparent execution wrapper (started before spawn, child exit code recorded and propagated), exit 5 for missing tokens and 6 for wait timeout as documented table additions, dangling executions surfaced by status and never auto-repaired, section 10.2 loop escalation enforced at the gate seam, status as system health distinct from the queue inbox. 53 tests incl. a real SIGKILL crash. Verified: 629/629, lint, typecheck from clean install.
<!-- SECTION:FINAL_SUMMARY:END -->
