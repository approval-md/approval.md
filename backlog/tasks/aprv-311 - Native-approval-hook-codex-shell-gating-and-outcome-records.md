---
id: APRV-311
title: Native approval hook codex shell gating and outcome records
status: In Progress
assignee:
  - '@codex-sol'
created_date: '2026-09-08 07:24'
updated_date: '2026-09-08 19:21'
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
- [x] #3 Runtime/schema/registry/MCP exclusion support codex; Claude and Cursor regression tests pass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Reuse the harness adapter and verified gate path for Codex Bash; accept only documented event/tool/input shapes and stable session/tool ids. 2. Add codex runtime/schema provenance, CLI verb/help, and explicit MCP exclusion. 3. Keep Codex outcome parsing isolated from Claude/Cursor: implement only readings confirmed by APRV-310 native evidence; until available unknown outcomes remain open with diagnostic. 4. Add focused adversarial and regression tests using existing isolated real append fixtures; no live activation or config changes. Native probe is pending gate authorization, so implement independent adapter infrastructure first and finalize outcome acceptance after observed contracts.

Native v5 established Bash success and nonzero both deliver empty-string tool_response, so keep PostToolUse diagnostic with no invented outcome. Correct Codex allow output to the documented identity updatedInput command form, always echoing exact bound bytes after gate admission. Add focused response and regression tests; validate native handler Completed rather than treating a scratch effect alone as successful allow handling. Sol owns Codex response/probe/tests/docs; parent owns SPEC, task records, security review and delivery.

Astra review classifies hidden native workdir as P1: a relative target can name a protected gate organ in the actual directory while classification sees an ordinary session-root file. Reject all current native Bash PreToolUse events before gate-open, gate-self, approval reuse, budgets or execution start; emit explicit unsupported-execution-context denial. No override, absolute-cd exception, or wrapper. Preserve diagnostic-only post handling. Regression tests must establish zero gate mutation and explicit denial across policy modes/window states; existing Claude/Cursor behavior stays unchanged. Task remains incomplete until a native contract exposes effective execution directory.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Infrastructure reviewed: strict Bash validation and explicit denies; Codex tool/command/cwd payload plus domain-separated session/call digests preserve loop scope and avoid delimiter/cross-tool collisions; codex provenance/schema/registry/MCP exclusion. Sol focused regression 227/227 exit0 outside socket/sandbox restrictions; latest build and Codex/schema34/34 exit0; lint/typecheck exit0. Native hook outcomes remain unverified; current PostToolUse emits diagnostic and appends nothing. Task and outcome acceptance remain open while APRV-312 proceeds.

Final code df570ea passed npm test3920/3921 with1skip, lint/typecheck,293 conformance vectors, and all3 CI-parity shards plus protected-path guard (all exit0). Codex provenance/schema/MCP exclusion and shared Claude/Cursor regressions verified. AC2 remains pending: success/failure outcome parsing has no native-verified contract; PostToolUse remains diagnostic and append-free.

Native v6 invalidates the previously checked Bash support acceptance: actual per-call workdir is omitted, so current native Bash must be refused. Historical unit results remain recorded, but do not establish safe native operation.

Implemented mandatory early Bash refusal because native execution cwd is omitted. Refusal precedes policy/window/self/carry/start and preserves an already granted token without log change. Direct patch gate retains exact-byte identity updatedInput, budgets, manual/carry/duplicate protections. Post remains diagnostic. Astra final review has no remaining findings; focused adapter/probe26/26 and full npm3928 pass/1skip exit0; lint/typecheck/conformance exit0. Bash support and reliable outcome closure remain acceptance blockers.
<!-- SECTION:NOTES:END -->
