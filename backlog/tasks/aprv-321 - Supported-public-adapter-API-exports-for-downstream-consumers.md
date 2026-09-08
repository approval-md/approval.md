---
id: APRV-321
title: Supported public adapter API exports for downstream consumers
status: To Do
assignee: []
created_date: '2026-09-08 22:51'
labels: []
dependencies: []
references:
  - 'https://github.com/approval-md/approval.md/issues/140'
priority: medium
type: feature
ordinal: 238000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
GitHub issue #140 still requests a supported adapter API beyond the now-published npm0.1.0 package. Provide a small versioned export surface for the adapter contract, conformance runner, credential provider and types, preserving gate ownership of execution and avoiding accidental broad internal API commitments. Active package release work APRV199/306/307 remains separately owned.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The intended public exports and semver boundary are documented and a consumer can import them from the packed package without deep internal paths.
- [ ] #2 Packed-package tests exercise execution binding and conformance through the public API; unsupported internals are not accidentally exported.
- [ ] #3 Any package metadata or release changes follow the actual primary policy gate and no active release work is overwritten.
<!-- AC:END -->
