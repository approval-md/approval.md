---
id: APRV-321
title: Supported public adapter API exports for downstream consumers
status: In Progress
assignee: []
created_date: '2026-09-08 22:51'
updated_date: '2026-09-09 02:01'
labels: []
dependencies: []
references:
  - 'https://github.com/approval-md/approval.md/issues/140'
documentation:
  - docs/adapter-api.md
modified_files:
  - src/adapters/public.ts
  - package.json
  - tsconfig.json
  - tests/package-adapters.test.ts
  - docs/adapter-api.md
  - README.md
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

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add a curated ESM-only public barrel at src/adapters/public.ts and expose it solely as approval-md/adapters. Export the approved adapter contract, refusal unions, conformance harness, vault provider and credential manifest types; keep registry, built-in adapters, core modules and deep dist paths private.
2. Emit TypeScript declarations and map the public subpath import and types conditions to the built files. Ship docs/adapter-api.md in the package and link it from README.md. Document migration from incidental dist/src deep imports and state that compiled-in CLI adapter discovery remains separate.
3. Add a packed-package test that builds a real tarball into isolated scratch, resolves approval-md/adapters through Node package resolution, asserts the exact runtime export list and private-path refusals, compiles a strict NodeNext TypeScript consumer, and verifies the public execution contract refuses mismatched bytes without acting then executes the approved bytes once.
4. Run the public runAdapterConformance export against a consumer-defined adapter and real grant harness, assert declarations and docs are present in the tarball, then run focused tests, build, typecheck and lint. Coordinate before the single full suite.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented the curated ESM-only approval-md/adapters barrel and package export map. The runtime surface is exactly ADAPTER_REFUSAL_CODES, CREDENTIAL_REFUSAL_CODES, executeThroughAdapter, runAdapterConformance and vaultCredentialProvider; the approved contract, harness, vault and CredentialSpec types are emitted as declarations. Registry, built-in adapters, core modules and dist/src deep paths remain unexported.

Added a packed-package test that creates a local tarball with a scratch npm cache, extracts it as a downstream package, bounds every child process, verifies exact exports and private-path rejection, compiles a strict NodeNext consumer, checks mismatch zero-act and valid one-act behavior through a real grant, and runs public conformance. Runtime dependencies are linked from the checkout only for this isolated local tarball test; this is not a registry install. TypeScript consumers require Node 20 or newer and @types/node because the public contract carries Node platform types.

The exports map intentionally breaks the incidental 0.1.0 dist/src imports. docs/adapter-api.md gives the migration and recommends a breaking minor release while major version is zero. No version, tag, publish, dependency, CI, SPEC, registry or built-in adapter change occurred.

Validation on the frozen bytes: build exit 0; typecheck exit0; lint exit 0 clean; packed-package plus docs guard 21 tests passed, 0 failed; environment-clean npm test exit 0 with 4,001 tests, 4,000 passed, 0 failed and 1 skipped. Complete full-suite output: /private/tmp/aprv321-full-suite.log.
<!-- SECTION:NOTES:END -->
