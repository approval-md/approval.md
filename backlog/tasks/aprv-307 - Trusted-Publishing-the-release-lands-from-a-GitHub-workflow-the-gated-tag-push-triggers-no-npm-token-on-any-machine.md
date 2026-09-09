---
id: APRV-307
title: >-
  Trusted Publishing: the release lands from a GitHub workflow the gated tag
  push triggers, no npm token on any machine
status: In Progress
assignee:
  - '@codex-sol'
created_date: '2026-09-08 06:18'
updated_date: '2026-09-09 23:39'
labels:
  - release
dependencies:
  - APRV-305
ordinal: 226000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The 0.1.0 publish (2026-09-08) needed a granular npm token with 'Bypass 2FA' because npm now demands a second factor on every direct publish from a 2FA account and a gated child process cannot answer a passkey. npm's own guidance is Trusted Publishing: the registry trusts an OIDC identity from a GitHub Actions workflow, so no token exists anywhere. That fits this repo better than the bypass token: the human's gated act becomes the tag push (release.publish, APRV-305 makes the classifier see it), the workflow publishes with provenance, and the gate still stands in front of the only human-triggered step.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A release workflow (.github/workflows/publish.yml) runs on a pushed v* tag, builds, runs the full test tier, and publishes with npm provenance via OIDC; no NPM_TOKEN secret is configured
- [ ] #2 The package is configured for Trusted Publishing on npmjs.com for this repository and workflow (recorded in the notes; the setting itself is the human's)
- [ ] #3 docs/dogfood-cutover.md and the APRV-199 notes describe the release ceremony as: gated git tag, gated tag push, workflow publishes; the bypass-2FA token path is retired and the token deleted
- [ ] #4 APRV-305 lands first so a tag push classifies release.publish without an envelope declaring it
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Replace the unsafe direct-tag publisher design with an inert release-candidate workflow triggered by stable v* tag pushes; it has empty permissions, no checkout, no artifacts and no external action. 2. Add a protected-main publish workflow triggered only by successful first-attempt completion of that exact relay; reject wrong repository, workflow name/path, event, conclusion, attempt, tag spelling or SHA before checkout. 3. In a no-OIDC verify job, bind the peeled tag target, upstream SHA, downstream workflow SHA, checkout and freshly fetched current main; validate package and tool identities, run the full checks, pack once, inspect the packed manifest, and bind the tarball SHA-256 through a job output. 4. Transfer only the fixed tarball within the same downstream run. Give only the environment-bound publish job id-token: write; it performs no checkout or repository scripts, compares the tarball hash with the verify output, and publishes the tarball with scripts disabled. Pin every official action to its verified full commit SHA and serialize runs without cancellation. 5. Add hardened YAML capability tests plus safe fixture execution tests for metadata refusal, ref equality, packed identity and artifact hash mismatch; add an operator runbook that orders main-only zero-tag/zero-secret environment and immutable-tag controls before npm trust, and states audit limits. 6. Parent registers and applies the exact protected workflow payloads through the primary gate, then runs focused and full validation and delivers the reviewed change. Human owners separately configure GitHub/npm and perform any live release.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Architecture correction before implementation: AC1 says publish.yml runs on a pushed v* tag. The accepted safe design is indirect: the tag starts inert release-candidate.yml, then protected-main publish.yml runs on that relay completion. A direct tag trigger would load privileged workflow bytes from the tag and is unsafe. Preserve AC1s release intent, but parent should revise its trigger wording before finalization so the checked criterion states the actual protected-main workflow_run boundary.

Ordinary implementation checkpoint (2026-09-09): added docs/trusted-publishing-runbook.md and tests/publish-workflow.test.ts. The tests use hardened YAML parsing and safe local fixtures to enforce the inert relay, protected workflow_run metadata checks before checkout, exact tag/upstream/downstream/checkout/current-main equality, official action pins, no OIDC in verify, publish-job permission isolation, packed manifest identity, independent tarball SHA-256 binding, and refusal before a stub npm command on hash mismatch. No test contacts npm, requests OIDC, or publishes. Build, typecheck, and lint each exited 0; docs-guard passed 16/16 exit 0. Since the two protected workflow targets remain absent pending the primary gate, the compiled publish-workflow suite was run in an isolated shadow tree populated with the exact frozen workflow bytes and passed 6/6 exit 0. Protected delivery bundle /private/tmp/aprv307-delivery-bundle is prepared but no phase was executed: manifest SHA-256 ac65d09e71114e9c4672ad05903b3479f1b8d7e1ee435ec37fbc70a59454d58b; release-candidate payload hash 513553fdde4c6a1526d8208c512ef639d702d89c535179be6ab7ef3e869b7d65; publish payload hash e1314515d428c7b19f57e245838828ea92d93ee9ff3ecd0445ec587ec2ac0846. The parent owns registration, approval, execution and the exact in-worktree focused rerun. AC1 wording still needs the previously noted protected-main workflow_run correction; AC2 and AC3 remain human configuration and delivery evidence, and no acceptance criterion is checked yet.

Protected workflow application and actual-file validation (2026-09-09): the parent executed the reviewed release-candidate action after grant 30354 (execution.started 30355, execution.completed 30356) and the reviewed publish action after grant 30357 (execution.started 30362, execution.completed 30363). Installed bytes match the frozen approvals exactly: release-candidate.yml SHA-256 75ceef2c1560f36874ea7cae8048e0ded2c31e9e06d966dd3da13887029bf7a9; publish.yml SHA-256 0e48b98bf9e6e12eee16730f424792b1c3072caac1251f0b0e0ac1da02d47c74. Against those actual tracked paths, publish-workflow passed 6/6 exit 0 and docs-guard passed 16/16 exit 0 with APPROVAL_HUMAN removed. No full suite ran in this checkpoint because another worker owns the broad-suite slot. Human GitHub environment, immutable-tag controls, npm Trusted Publisher setup, delivery, and a live release remain outstanding; AC1 wording still needs the recorded workflow_run correction before finalization, so no AC is checked and status remains In Progress.

Full validation against the installed protected workflows (2026-09-09): the sole npm test run with APPROVAL_HUMAN removed completed with actual process exit 0: 4,090 tests, 4,089 passed, 1 skipped, 0 failed, log /private/tmp/aprv307-full.log (341,247 bytes). After the run, release-candidate.yml still hashed to 75ceef2c1560f36874ea7cae8048e0ded2c31e9e06d966dd3da13887029bf7a9 and publish.yml still hashed to 0e48b98bf9e6e12eee16730f424792b1c3072caac1251f0b0e0ac1da02d47c74. This is local implementation evidence only; it does not establish GitHub environment controls, tag rules, npm Trusted Publisher configuration, a live release, or delivery.
<!-- SECTION:NOTES:END -->
