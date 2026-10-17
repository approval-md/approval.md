---
id: APRV-254
title: Add isolated Codex CLI gloss runner with bounded failures
status: Done
assignee:
  - '@codex'
created_date: '2026-09-04 22:00'
updated_date: '2026-09-05 09:47'
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
- [x] #1 Codex runner uses saved CLI auth without reading or copying credentials, passes synthetic or bounded untrusted payload via stdin, and extracts only a successful final assistant response.
- [x] #2 Environment scrub, 20-second total bound and output bounds have fake-process tests; attribution states provider and requested model honestly.
- [x] #3 Gated synthetic smoke test verifies model availability, auth reuse, response extraction and latency; npm test, lint and typecheck pass.
- [x] #4 Use verified available Codex controls: minimal read-only filesystem in an empty cwd, command network disabled, project docs suppressed, integrations and known tools disabled; document inherited global/managed instructions and lack of deny-all tool guarantee. Unsupported controls and model/process/output failures yield absence with no fallback.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Use verified installed Codex 0.152.1 configuration with strict parsing and explicit model. 2. Implement bounded sync-facing process supervision with process-group timeout cleanup and temporary empty cwd; reuse credential scrub and leave saved authentication to Codex. 3. Parse only successful JSONL lifecycle and completed agent text; reject tool/unknown/error events. 4. Add fake-process tests for invocation, bounded input/output, failures, cleanup and provenance. 5. Parent reviews capability limits and runs a gated synthetic smoke test and integrated checks.

After the corrected granted smoke still yielded unsafe-output, run one gated synthetic diagnostic against the same frozen build. Capture only event types, key names, parser-state booleans and closed error categories; omit all assistant/error text. Keep strict rejection unchanged. Use the observed rejection branch to settle the next implementation step.

The granted shape diagnostic identified one pre-turn error event, with a nonempty final assistant response and valid terminal ordering. Local installed CLI 0.152.1 binary confirms an under-development feature startup warning and the supported suppress_unstable_features_warning option. Add that explicit option and a fake invocation assertion; retain rejection of every error event. Build and run focused tests, lint and typecheck, then a gated synthetic smoke verifies whether the known notice caused the failure. This is a tested hypothesis until live success.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Read-only feasibility on installed codex-cli 0.152.1: exec help exposes no built-in tool deny-all; strict-config rejects tools.enabled_tools; project_doc_max_bytes=0 suppresses repo documents but global/managed instructions remain. App Server dynamicTools is not a built-in tool restriction. No inference or credential access performed. Parent has asked user to choose practical minimal read-only isolation with documented limits versus strict unavailable behavior. Dependent implementation awaits answer.

User explicitly chose available Codex isolation with documented limits on 2026-09-04 in this task. This replaces the earlier literal no-tools/no-global-instructions requirement; never claim that stronger guarantee. Sol research verified config parsing without inference. Other sessions remain untouched.

Implemented the Codex runner, POSIX process-group supervisor and fake-executable tests. Parent reviewed subprocess argv/stdin separation, bounded output, requested-only provenance, strict JSONL rejection and cleanup. Installed CLI 0.152.1 help confirms piped stdin is appended as a stdin block when a positional prompt exists; launcher waits for its native child. Focused tests 5/5, typecheck and repository lint all exit 0. No live inference call has run: gated synthetic smoke and final integrated checks remain pending. Windows reports unsupported-platform. Shared model identifier validation is exported for this runner; optional Claude model selection remains APRV-255 ownership.

Integration evidence: the installed Codex CLI rejected the initial one-token skill-context cap with an explicit error event, and the strict parser correctly omitted the gloss. Gated synthetic diagnostics identified that error without exposing credentials. The reviewed correction removes that cap and enables the verified skip_host_skill_discovery feature; this remains a version-specific practical control, not a universal tool or inherited-instruction isolation guarantee. The corrected frozen synthetic smoke is registered as aprv254:codex-smoke-v2:20260904 and is awaiting its human decision. No successful live extraction is claimed. After merging current main a27c812, the suite-wide fake harness safeguard now also stubs codex. Integrated A-C npm test finished with exit 0: 3187 passed, 1 skipped, 0 failed or cancelled. Focused 25/25, build, lint and typecheck passed; independent Astra critical review found no code blocker. Live smoke and APRV-255 operator documentation remain outstanding. This reviewed B implementation is assembled into a separate clean delivery branch without rewriting the original worker branch.

Corrected smoke v2 was granted and executed through approval run: exit 1, latency 4104 ms, result absent, reason unsafe-output. It did not verify successful extraction. All feature draft PR 262 CI checks passed. Sol read-only investigation proposes one content-free event-shape diagnostic to distinguish skill-context errors, retry/config errors and JSONL ordering/schema mismatches; no further inference has run.

Content-free diagnostic exit 1, latency 3893 ms: thread.started, pre-turn item.completed error (closed category other), turn.started, nonempty completed assistant message, turn.completed. No unknown events, malformed JSON or terminal-order issue. The parser correctly rejected the error event. Sol verified the installed CLI startup-warning text and config key locally without inference or credential access.

Verified live success on 2026-09-05: exact granted frozen v3 smoke exited 0 in 4296 ms, returned the correct summary of printf hello-world and provenance provider codex/requestedModel gpt-5.4-mini, with no diagnostic reasons. No credentials were read or copied by approval.md; Codex reused its saved authentication. Suppressing the known under-development-feature startup notice resolved the observed pre-turn error while the strict parser remained unchanged. The returned requested model is not a claim that the response independently confirms a model ID or billing method. Build, focused B 5/5, full lint, typecheck and diff check exit 0 after the correction. AC3 remains pending final updated CI; AC4 remains pending APRV-255 operator documentation. Commit this separately reviewed correction without rewriting the already-pushed implementation history.

Final completion evidence: operator docs now integrated after Claude shared changes landed. They document saved CLI authentication, conditional subscription/API billing, practical isolation limitations, CLI0.152.1 compatibility, Windows unavailability, bounds and strict failure behavior. Gated frozen v3 smoke passed in4296ms for requested gpt-5.4-mini. Final assembled npm test exit0 (3426 passed,1 skipped,no failures/cancellations), focused25/25, docs/help43/43, build/lint/typecheck/diff checks pass. Independent critical review approves the unchanged error rejection and claimed-only provenance. PR262 merge remains a separately verified delivery step; no credentials copied, policy schema/dependencies added, or live services reconfigured.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added a bounded codex exec runner using saved CLI authentication, explicit requested-model provenance, practical isolation controls and strict final-response extraction. Fake-process failure/cleanup tests and the full suite pass; gated synthetic live smoke returned the correct summary in4.296seconds. Documented remaining global/managed instruction and tool-inventory limits; no provider fallback.
<!-- SECTION:FINAL_SUMMARY:END -->
