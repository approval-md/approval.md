---
id: APRV-437
title: Muse approval.md connector prototype
status: In Progress
assignee:
  - '@codex-sol'
created_date: '2026-09-22 06:46'
updated_date: '2026-09-22 06:46'
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
- [ ] #1 Tenant-isolated facade supports propose, status, pending inbox and canonical request detail through existing verified runtime paths.
- [ ] #2 Read and proposal credentials cannot grant or impersonate humans, run arbitrary shell, export logs or access another tenant.
- [ ] #3 Decision flow uses trusted Telegram with exact request binding; retries, replay, expiry, drift and scope checks have meaningful tests.
- [ ] #4 Submission packet states prototype status and unknown native platform capabilities accurately.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Reuse verified existing register/request/state/payload rendering paths behind a narrow single-tenant facade with separate read/propose credentials from the launch environment. 2. Expose propose, status, pending and canonical detail only; human decisions occur in existing Telegram and no grant/execute/export route exists. 3. Pin idempotency and identity, bound responses and payloads, refuse native decision requests explicitly. 4. Add synthetic local probe, negative controls and scope/replay/expiry/drift tests; document native evidence unavailable unless probe proves it. 5. Draft truthful packet and run required checks for independent parent review.
<!-- SECTION:PLAN:END -->
