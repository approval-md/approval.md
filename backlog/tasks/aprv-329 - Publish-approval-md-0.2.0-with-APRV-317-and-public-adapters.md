---
id: APRV-329
title: Publish approval-md 0.2.0 with APRV-317 and public adapters
status: In Progress
assignee:
  - '@codex-astra'
created_date: '2026-09-12 18:04'
updated_date: '2026-09-12 18:17'
labels: []
dependencies:
  - APRV-307
ordinal: 248000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The npm registry remains at 0.1.0 and lacks merged APRV-317 irreversible policy controls, ZZZ adapter and the public adapters API. Deliver a reviewed minor pre-1.0 release, document the newly explicit export boundary and verify the actual installed registry artifact. Mandatory Codex confinement remains unfinished and must not be claimed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Version and lockfile agree on 0.2.0 with unchanged dependencies; release notes identify APRV-317, ZZZ/public adapters, deep-import migration and Codex limitations.
- [ ] #2 Packed and clean-installed artifact exposes the public adapters API and CLI; tests prove explicit irreversible policy authorization and retained manual/human-only controls.
- [ ] #3 Required repository checks and protected delivery checks pass for the release commit; GitHub PR is merged.
- [ ] #4 Authorized trusted publication completes and registry version, integrity, provenance and clean-install behavior are verified.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Recover from refreshed remote main in isolated durable worktree. Prepare exact version-file proposal for release gate before edits, write factual release notes, validate package contents and installed API/CLI with lockfile-pinned dependencies. Depend on APRV-307 workflow delivery, immutable tags and human npm trust setup. Land version PR, bind separately approved annotated tag to current main, observe OIDC publication, verify public registry artifact. Keep live activation and Codex confinement claims excluded.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Prepared unpublished 0.2.0 CHANGELOG section after comparing source baseline 78baf522 with refreshed origin/main: APRV317 class-scoped irreversible opt-in and retained manual/human-only floors; public adapters API/deep-import breaking boundary; ZZZ thread/reply adapter and separate service migration; inert Codex preparation, direct-patch native limits and unfinished broker/custody; quickstart/follow/explicit co-author tools. Exact version proposals stored only in ignored private/aprv329-version-proposal at source HEAD e02296fa22a1b80765d0cfbc822c861f014cee65; live manifests unchanged. Proposal JSON equality verifies only package top-level version plus lock top-level/root package versions move to 0.2.0 and dependencies are unchanged. git diff --check exit 0. Existing package-adapters tests exercise tarball exports/types/manual binding/conformance but link runtime dependencies from checkout, so they are not a clean npm install. Registry acceptance must install the actual published version with pinned registry integrity/provenance, then import approval-md/adapters, refuse private deep paths, invoke CLI version/policy check in an explicit synthetic project, and prove truthful irreversible policy permission alongside manual/human-only paths through actual public execution API. No broad tests run in this worker slice; no live version edit, commit, push, publish or gate write.

Installed-artifact acceptance script added at scripts/installed-artifact-acceptance.mjs. It packs current compiled candidate with scripts disabled, performs a real offline npm install into a fresh consumer (no checkout dependency symlinks), creates a consumer lock and installs the exact root-lock Node type package, explicitly rebuilds installed better-sqlite3 offline and validates an in-memory SELECT, then checks installed CLI version, exact five ESM exports, private-path denial, strict NodeNext TypeScript compilation, genuine scratch CLI policy attestation/registration, public executeThroughAdapter autonomous and supervised truthful irreversible act, omitted override/manual token-required refusal, human-only zero-act refusal, single-use replay and real log verification. All records are labeled synthetic and explicit scratch paths; no primary/worktree gate records or service credentials. Root npm ci --offline exit 0; build exit 0; final focused script exit 0 at current candidate version 0.1.0 (version grant remains pending), no failures. Initial script errors were realpath /var vs /private/var normalization and unsupported register --dir; both corrected without changing runtime. node --check and git diff --check exit 0. This demonstrates offline installed tarball behavior plus explicit native rebuild, not standard online registry installation or publication; final 0.2.0 and published artifact checks remain parent-owned.

Required repository validation completed 2026-09-12 on current unchanged 0.1.0 manifest/release source plus unpublished changelog/script/task: npm test actual exit 0 (suite duration 261972.695541 ms; 4099 total, 4098 passed, 1 skipped, 0 failed); npm run lint exit 0; npm run typecheck exit 0; built node conformance/run.mjs exit 0 with all 298 vectors and 143 controls. Durable ignored logs: private/aprv329-validation/{npm-test,lint,typecheck,conformance}.log. git diff --check exit 0. No installed-probe rerun after the earlier focused pass; version0.2 manual gate approval remains pending, so final version/registry artifact acceptance and protected delivery remain outstanding. Sole broad-suite slot released after actual npm test completion; no further tests or commits by worker.

Correction to the immediately preceding summary: actual npm test banner is 4108 total, 4107 passed, 1 skipped, 0 failed (not 4099/4098). Actual exit 0 and duration 261972.695541 ms unchanged. Log SHA-256 91fe06866ecd409f11db1f3212a9141ac3af752c14fc01481a852abd4f7df09c is authoritative.
<!-- SECTION:NOTES:END -->
