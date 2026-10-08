---
id: APRV-437
title: Muse approval.md connector prototype
status: Done
assignee:
  - '@codex-sol'
created_date: '2026-09-22 06:46'
updated_date: '2026-09-22 23:46'
labels: []
dependencies:
  - APRV-436
priority: high
type: feature
ordinal: 333000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Build the approved narrow consumer Muse facade for proposals, approval inbox and trusted Telegram decision handoff. Reuse runtime paths. Native decision capability stays disabled absent verified per-action human confirmation. No hosting, provider registration or submission.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Tenant-isolated facade supports propose, status, pending inbox and canonical request detail through existing verified runtime paths.
- [x] #2 Read and proposal credentials cannot grant or impersonate humans, run arbitrary shell, export logs or access another tenant.
- [x] #3 Decision flow uses trusted Telegram with exact request binding; retries, replay, expiry, drift and scope checks have meaningful tests.
- [x] #4 Submission packet states prototype status and unknown native platform capabilities accurately.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Reuse verified existing register/request/state/payload rendering paths behind a narrow single-tenant facade with separate read/propose credentials from the launch environment. 2. Expose propose, status, pending and canonical detail only; human decisions occur in existing Telegram and no grant/execute/export route exists. 3. Pin idempotency and identity, bound responses and payloads, refuse native decision requests explicitly. 4. Add synthetic local probe, negative controls and scope/replay/expiry/drift tests; document native evidence unavailable unless probe proves it. 5. Draft truthful packet and run required checks for independent parent review.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
User-requested pause 2026-09-22. Local implementation uncommitted in /private/tmp/approval-muse-connector on codex/muse-connector-prototype. Final build plus targeted muse/cli-instructions/cli-long-help/layering suite exit 0 (57/57), lint exit 0, diff --check exit 0. Independent Astra found credential detection JSON-escaping leak and missing frozen refusal vocabulary; worker fixed both with regressions, but fresh affected-seam review remains required. Earlier full npm test exited 1 before fixes: observed missing Muse help anchor fixed; sandbox-read-jail nested build exit 255 unresolved. Full output was truncated, so full failure inventory unknown. No fresh full suite/conformance or live/native connector probe at pause. Native compatibility and real trusted-handoff completion remain unverified; no implementation commit/push/PR.

Resumed validation: Node24 worktree-local lockfile npm ci fixed the previous Node26 native-module ABI mismatch. Full npm test exit0:5357 tests,5356 pass,0 fail,1 opt-in external-network skip; lint/typecheck exit0; conformance481/481 vectors and182 controls exit0. Applicable full local-CI build/all-tests/lint steps covered without duplicate broad rerun. Actual scratch CLI HTTP listener probe7/7 exit0. Independent Astra affected-seam recheck passed43 credential-smuggling/body-error attacks with unchanged logs on refusals plus valid controls. Final added policy-drift regression confirms409 policy-not-attested and no append; focused Muse8/8,build,lint,diff-check all exit0. Synthetic existing Telegram callback covers grant,replay,altered/expired requests. Native Muse E2E and live operator handoff are not claimed. Tenant isolation requires distinct operator-configured stores and credentials.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented local single-tenant Muse proposal/status/inbox/canonical-detail facade with separate read/propose scopes and no decision/execution authority. Reuses verified core and trusted Telegram callback paths; native decisions disabled. Independent security refutation passed after two fixes; full and focused validation passed. Public hosting, native compatibility and listing remain separate APRV-405 work.
<!-- SECTION:FINAL_SUMMARY:END -->
