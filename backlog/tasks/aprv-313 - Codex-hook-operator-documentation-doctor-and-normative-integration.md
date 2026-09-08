---
id: APRV-313
title: Codex hook operator documentation doctor and normative integration
status: In Progress
assignee:
  - '@codex-sol'
created_date: '2026-09-08 07:25'
updated_date: '2026-09-08 08:23'
labels: []
dependencies:
  - APRV-312
priority: high
type: feature
ordinal: 231000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
User-authorized overnight Codex integration. SPEC 6.3,7,9,10,11.1 bind. Isolated code/tests/delivery now; everyday activation and human decisions only in morning. No deployment, credentials, dependencies or production policy/log mutation.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Help/examples/runbook specify opt-in shell/patch coverage, failure gaps, ten-minute outer timeout and nine-minute gate wait.
- [ ] #2 Doctor distinguishes configured wiring from trusted/observed operation and checks Codex provenance.
- [ ] #3 Narrow SPEC edits follow the gate; no live installation, daemon restart, dependencies or release.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. After adapter interfaces settle, add opt-in example outside live .codex paths and an activation/rollback runbook; document exact tested CLI and desktop pending separately. 2. Add doctor diagnostics for Codex Pre/Post configuration and harness provenance, explicitly not claiming trust or execution from file presence. 3. Parent prepares narrow SPEC changes for Codex verb, gate organs, MCP exclusion, patch/outcome contract and bounded coverage; route exact edits through primary gate before applying. 4. Focused doctor/help/docs checks, then final integration verification; leave APRV-315 pending.

The public verb, Pre/Post registration and 9m/600s timing are now settled in APRV-311. Begin disjoint doctor/examples/runbook work while APRV-312 patch internals proceed; keep native outcomes and desktop proof explicitly pending until observed.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
SPEC remains unchanged. Proposed amendment (requires a valid protected-edit execution/delivery path):

### 10.6 Native Codex hook adapter (Amended APRV-313, pending sign-off)

The opt-in `approval hook codex` adapter reads synchronous native `PreToolUse` and `PostToolUse` events for `Bash` and `apply_patch`. It MUST reuse the verified gate, policy, budgets, approval waiting and grant-consumption paths. It MUST return a supported explicit allow or deny on pre-execution input, require stable session and tool-call identifiers, and refuse malformed input or unsupported tools delivered to it. Codex sandbox permissions remain independent; a native approval is never a substitute for an approval.md decision. The default gate wait is nine minutes and the example native hook timeout is ten minutes.

A patch approval MUST bind the complete raw patch, tool identity and execution directory. Every addition, update, deletion, and move source and destination MUST be inspected with the existing scope and protected-path rules; an unreadable or ambiguous patch is refused. Codex hook configuration (`.codex/hooks.json`, `.codex/hooks/` and `.codex/config.toml`) is a gate organ under §5.2. Examples MUST be delivered outside those live paths; installation and trust are operator actions.

Codex has its own `codex` harness provenance. A post-execution report MUST correlate with a verified delegated start for that Codex call and reuse `reported_by: post-tool-use`. Only an outcome shape verified against a named Codex version may close a start. `PostToolUse` alone is not evidence of success; unknown, interrupted, or unfinished results remain unclosed with a diagnostic, and tool-output text never enters the approval log.

Coverage is bounded to the native paths that deliver these hooks. Operator documentation MUST distinguish tested explicit denial from observed crash and timeout behavior, and identify unverified desktop behavior. Hook failure or timeout may leave no enforceable decision at the native boundary; this integration makes no universal enforcement or strict Claude parity claim. Doctor MUST distinguish configuration on disk from trusted and demonstrated operation, and MUST NOT infer either from configuration presence. (Amended APRV-313, pending sign-off.)

Other proposed narrow edits: add Codex hook/config gate organs to section5.2; add hook codex CLI row; extend MCP withheld count to four and list Codex; list Codex in M8. Exact seven before/after edits prepared at /private/tmp/aprv-313-spec-edits.json. Existing approval run binds argv/cwd, while file-hunk evidence uses file/before/after. Do not fake Claude provenance or deploy the new daemon/schema merely to self-authorize. Parent is retaining this boundary while independent implementation proceeds.

Operator slice reviewed: separate Codex wiring row; strict quoted absolute direct command profile, malformed async and echo/compound negative controls; TOML presence remains undetermined, no trust/execution inference. Inert example and human install/rollback runbook plus local POST witness prepared; README/count pins updated. Sol tsc/lint/focused doctor6 and docs guard22 exit0; parent full cli-doctor outside socket restriction passed70/70 exit0 (46.4s), resolving earlier inconclusive manually cancelled restricted runs. Loopback witness readiness/POST204/one marker/server exit0 verified. SPEC remains unchanged and proposed exact amendment is recorded above; native trust/outcome and morning activation remain pending.
<!-- SECTION:NOTES:END -->
