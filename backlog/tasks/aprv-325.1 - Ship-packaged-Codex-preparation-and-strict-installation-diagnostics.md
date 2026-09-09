---
id: APRV-325.1
title: Ship packaged Codex preparation and strict installation diagnostics
status: In Progress
assignee:
  - '@codex-sol'
created_date: '2026-09-09 07:39'
updated_date: '2026-09-09 08:37'
labels: []
dependencies: []
references:
  - docs/codex-boundary-probe.md
parent_task_id: APRV-325
priority: high
type: feature
ordinal: 243000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Deliver the npm-distributed preparation, explicit setup-check and strict doctor surfaces needed for a constrained Codex environment. This is the first implementation slice of APRV-325; it must not claim that installing npm alone creates enforcement or that an absent executor is ready.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A fresh tarball installation contains all required runtime/schema/template/docs assets and runs preparation and diagnostics from the installed path without a repository checkout.
- [ ] #2 Preparation emits inert reviewable artifacts; no install script changes trusted hooks, system requirements, accounts, services, credentials or live policy.
- [ ] #3 Strict diagnostics reject unknown or unsafe ownership, writable ancestors, symlinks, root overlap, invocation drift, unsupported versions/platforms and missing enforcement components.
- [ ] #4 Existing broad MCP does not publish the new activation/execution surface; incomplete broker or runner always yields an explicit not-ready result.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Implement a closed versioned manifest, packaged inert templates, prepare/setup-check/doctor CLI and conservative trust checks in isolated enforcement worktree. Parent settles SPEC and architecture; worker owns nonprotected code/tests/package assets. Validate hostile manifest/path/ownership cases and installed-tarball execution, then parent reviews and delivers.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Parent security review requires literal shell quoting, a pinned absolute Node interpreter, no manifest-selected binary execution before custody validation, distinct non-root principals, and explicit incomplete subtree/ACL confinement findings. Exact SPEC proposal: /private/tmp/aprv325-preparation-spec-bundle/SPEC.diff; manifest SHA256 13438ecf6a01c25b829354f470edc1ddc7f4ed2f6d0df384c004f52eb8e16d6f. Primary gate declaration codex-aprv325-preparation-spec registered seq30138; live approval requested, wait exit6. No SPEC edit occurred. Implementation continues independently; amendment remains pending a real grant.

Correction to prior pending note: the real primary-gate grant arrived at seq30140. The exact reviewed SPEC amendment was applied through the adapter and recorded at outcome30151. The request used draw-daemon-stale/source unavailable, so it was a real human grant, not an unselected live sample. Parent full npm test exited1 with five integration omissions: registry exit-code invariant, human-only registry allowlist, schema conformance coverage, missing valid and invalid codex-instance fixtures. Sol is fixing these before a fresh full run. Readiness remains false; no installation or activation occurred.
<!-- SECTION:NOTES:END -->
