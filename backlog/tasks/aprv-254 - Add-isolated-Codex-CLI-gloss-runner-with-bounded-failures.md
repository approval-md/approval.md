---
id: APRV-254
title: Add isolated Codex CLI gloss runner with bounded failures
status: In Progress
assignee:
  - '@codex'
created_date: '2026-09-04 22:00'
updated_date: '2026-09-04 23:21'
labels: []
dependencies:
  - APRV-253
type: feature
ordinal: 195000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Task B of the approved summarizer stack, binding SPEC 3,9,10.3,11 and APRV-207. Own a new Codex runner and dedicated fake-executable tests; no shared channel, policy, credential or other session edits. Reuse provider result contract from APRV-253. Same feature PR, separately reviewed commit. Verify real CLI isolation support before implementation; unsupported isolation omits gloss visibly.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Codex runner uses saved CLI auth without reading or copying credentials, passes synthetic or bounded untrusted payload via stdin, and extracts only a successful final assistant response.
- [ ] #2 Environment scrub, 20-second total bound and output bounds have fake-process tests; attribution states provider and requested model honestly.
- [ ] #3 Gated synthetic smoke test verifies model availability, auth reuse, response extraction and latency; npm test, lint and typecheck pass.
- [ ] #4 Use verified available Codex controls: minimal read-only filesystem in an empty cwd, command network disabled, project docs suppressed, integrations and known tools disabled; document inherited global/managed instructions and lack of deny-all tool guarantee. Unsupported controls and model/process/output failures yield absence with no fallback.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Use verified installed Codex 0.152.1 configuration with strict parsing and explicit model. 2. Implement bounded sync-facing process supervision with process-group timeout cleanup and temporary empty cwd; reuse credential scrub and leave saved authentication to Codex. 3. Parse only successful JSONL lifecycle and completed agent text; reject tool/unknown/error events. 4. Add fake-process tests for invocation, bounded input/output, failures, cleanup and provenance. 5. Parent reviews capability limits and runs a gated synthetic smoke test and integrated checks.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Read-only feasibility on installed codex-cli 0.152.1: exec help exposes no built-in tool deny-all; strict-config rejects tools.enabled_tools; project_doc_max_bytes=0 suppresses repo documents but global/managed instructions remain. App Server dynamicTools is not a built-in tool restriction. No inference or credential access performed. Parent has asked user to choose practical minimal read-only isolation with documented limits versus strict unavailable behavior. Dependent implementation awaits answer.

User explicitly chose available Codex isolation with documented limits on 2026-09-04 in this task. This replaces the earlier literal no-tools/no-global-instructions requirement; never claim that stronger guarantee. Sol research verified config parsing without inference. Other sessions remain untouched.

Implemented the Codex runner, POSIX process-group supervisor and fake-executable tests. Parent reviewed subprocess argv/stdin separation, bounded output, requested-only provenance, strict JSONL rejection and cleanup. Installed CLI 0.152.1 help confirms piped stdin is appended as a stdin block when a positional prompt exists; launcher waits for its native child. Focused tests 5/5, typecheck and repository lint all exit 0. No live inference call has run: gated synthetic smoke and final integrated checks remain pending. Windows reports unsupported-platform. Shared model identifier validation is exported for this runner; optional Claude model selection remains APRV-255 ownership.

Integration evidence: the installed Codex CLI rejected the initial one-token skill-context cap with an explicit error event, and the strict parser correctly omitted the gloss. Gated synthetic diagnostics identified that error without exposing credentials. The reviewed correction removes that cap and enables the verified skip_host_skill_discovery feature; this remains a version-specific practical control, not a universal tool or inherited-instruction isolation guarantee. The corrected frozen synthetic smoke is registered as aprv254:codex-smoke-v2:20260904 and is awaiting its human decision. No successful live extraction is claimed. After merging current main a27c812, the suite-wide fake harness safeguard now also stubs codex. Integrated A-C npm test finished with exit 0: 3187 passed, 1 skipped, 0 failed or cancelled. Focused 25/25, build, lint and typecheck passed; independent Astra critical review found no code blocker. Live smoke and APRV-255 operator documentation remain outstanding. This reviewed B implementation is assembled into a separate clean delivery branch without rewriting the original worker branch.
<!-- SECTION:NOTES:END -->
