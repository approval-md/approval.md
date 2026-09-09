---
id: APRV-325
title: Prove a mandatory approval boundary for a constrained Codex session
status: In Progress
assignee:
  - '@codex-astra'
created_date: '2026-09-09 06:53'
updated_date: '2026-09-09 07:35'
labels: []
dependencies: []
references:
  - 'https://learn.chatgpt.com/docs/app-server'
  - 'https://learn.chatgpt.com/docs/hooks'
priority: high
type: spike
ordinal: 242000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter explicitly requested verifiable Codex gate enforcement after learning ordinary desktop tools bypass the voluntary adapter path. Establish a bounded executable proof and an honest architecture decision before any everyday activation. Existing APRV311/315 native hooks are blocked by hidden execution cwd and observed fail-open failures; APRV193 covers broader fleet isolation. Preserve all existing work and production gate state.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The report identifies the exact Codex version, tool and execution boundary, trusted components, residual direct capabilities, and what the current desktop session cannot enforce.
- [ ] #2 Harmless isolated probes establish denial, no-grant, crash/disconnect, timeout, changed-payload and replay behavior with observed file effects and actual exit codes; failures are reported as failures, not enforcement.
- [ ] #3 Any proposed mandatory executor reuses attested APPROVAL.md and verified runtime authorization rather than model judgment or native approval impersonation; protected configuration remains outside agent control.
- [ ] #4 A concrete activation and rollback path names human-only steps and separates Telegram transport proof from enforcement proof; reviewed artifacts and task evidence are delivered to GitHub.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Inspect current native contracts and installed CLI/app-server surfaces, reusing existing probe evidence without repeating unsafe live activation. 2. Diagnose Telegram service separately under APRV315, without credentials or duplicate polling. 3. Compare constrained read-only Codex plus an external executor against an app-server approval bridge and isolated host boundary; test only the smallest scope the interfaces can actually constrain. 4. Record bounded scratch proof scripts and results, including fail-open counterexamples and unsupported paths; implementation of a dedicated workflow follows the user preference and reviewed architecture. 5. Astra reviews the boundary and evidence, Sol owns substantive proof code, and delivery follows the normal policy gate with no configuration weakening.

6. Carter explicitly authorized implementation of the dedicated npm-distributed enforcement workflow overnight. Build in /private/tmp/approval-codex-enforced-session on codex/codex-enforced-session from reviewed main7a7a3e3. Preserve policy-defined autonomy; package explicit setup/start/doctor and a narrow server-enforced executor, with no silent install-time trust or privileged host changes. Validate the packed npm artifact from a fresh directory. Unsupported confinement must refuse; native hooks and generic MCP are not enforcement fallbacks. 7. Settle and test command/patch custody and operation classification, then perform adversarial whole-session proof before activation claims. Prepare actual release only after implementation and checks; registry publication remains subject to its real gate.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-09-09 architecture review: a dedicated managed read-only Codex session with one gate-controlled executor is a candidate, not verified enforcement. Managed requirements can constrain native permissions and MCP executable/args, but do not pin MCP cwd/env. Existing generic MCP run is not automatically a strict broker: its command payload is bound but declared action classes, broad filesystem effects and sandbox opt-out need separate adversarial review. The executor and its policy/log/runtime must remain outside all agent-writable paths. User preference for a dedicated session remains pending; no everyday configuration or daemon restart occurred. Native CLI 0.152.1 uses codex sandbox -P :read-only, not the documented macos subcommand. A first exact scratch write under native Seatbelt returned EPERM with no effect; nested Seatbelt under desktop sandbox was unavailable, which is not denial evidence.

Critical review of existing MCP/run source found additional enforcement gaps to verify before activation: the full MCP catalog includes the ungated sandbox verb and other mutating verbs; run accepts --no-sandbox; nonmanual command sandbox restricts egress rather than filesystem writes; verified registration preserves caller-declared classes without proving argv semantics; argv/cwd binding does not bind mutable script contents; unresolved relative executables may fall back to raw spawn when process and target cwd differ; unsupported sandbox mechanisms are not always fatal. These are source findings, not completed exploit proofs. A strict broker needs server-side tool allowlisting, no caller opt-out, independent operation classification, immutable runtime/canonical target custody, protected write denials and no ambient credentials. APPROVAL.md must continue to decide autonomy; a scratch proof may use manual defaults without hard-coding a replacement production policy. No existing MCP profile should be advertised as mandatory enforcement.

Reviewed checkpoint: Sol implemented scripts/probes/codex-boundary.mjs and docs/codex-boundary-probe.md. Astra independently ran the final scratch probe at /private/tmp/aprv-325-codex-boundary-parent-001: overall exit 0, Codex 0.152.1, preflight exit 0, all three controls exit 0 with exact effects, and all three sandboxed attempts exit 23 with started markers, operation-denied and absent artifacts. Parent review tightened output-path canonicalization before creation; worker verified a parent-symlink escape refuses with exit 2 and no outside artifact. Lint, typecheck and conformance (142 controls, zero failures) exited 0. Full regression remains pending: first run stopped with exit 130 after local socket EPERM; second stopped with exit 130 after discovering the reused dependency tree lacked SQLite bindings. Corrected only this worktree node_modules symlink to verified primary dependencies and restarted the suite. No production enforcement claim or acceptance criterion is marked complete.

PR362 merged as7a7a3e3d7055ac959969beb9af77903e093c970d, source commits e628d9d and e94f8fb. All required GitHub Node22 PR checks and merge queue completed. Final local full suite exit1:4018 tests,4015 passes,2 cli-setup failures expecting absent human identity,1 skip. Re-running cli-setup with APPROVAL_HUMAN removed from the test child passed91/91, exit0. Do not claim unqualified local full-suite success. Native probe, lint, typecheck and142-control conformance passed. User has now explicitly requested overnight implementation plus all outstanding tasks including317; the earlier dedicated-session preference is resolved by that instruction. npm registry still serves0.1.0, so merged source alone does not update npm users.
<!-- SECTION:NOTES:END -->
