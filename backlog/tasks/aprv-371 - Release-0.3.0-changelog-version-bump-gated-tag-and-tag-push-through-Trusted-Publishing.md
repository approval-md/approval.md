---
id: APRV-371
title: >-
  Release 0.3.0: changelog, version bump, gated tag and tag push through Trusted
  Publishing
status: To Do
assignee: []
created_date: '2026-09-18 06:34'
labels:
  - release
dependencies:
  - APRV-307
priority: medium
ordinal: 288000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Since v0.2.0 (published 2026-09-12, APRV-329) main carries 183 commits and 35 feat or fix entries: approval policy apply (APRV-343) and amend --pr (341), attested-policy-on-main doctor row (342), human sign-off records (338), read.file.out_of_scope with read-tool gating and the Seatbelt read profile (347), vcs.ref.delete (352), harness.launch.NAME (354), the Grok Build adapter (243) and the Muse Code adapter (350), the Codex workspace broker and confined session (325.2, 325.3), Codex native hook hardening (311), sender identity on the Telegram channel (324), approval up reconciling an extended working log (346), the values block 0.2 format (336) and the deprecation of the bare supervised alias (335). All additive; the deprecation still loads with a warning, so this is a minor bump. Ceremony as for 0.2.0: one PR carrying the CHANGELOG 0.3.0 section (written from the diffs, not from commit titles) and the package.json bump, merged; then the gated annotated tag v0.3.0 and the gated tag push (release.publish), which triggers the protected-main Trusted Publishing workflow; then registry bytes, installed behaviour and provenance verified as APRV-329 did. Before the tag push the operator confirms no NPM_TOKEN secret exists (APRV-307 AC1, runbook 2026-09-16 step 4). The tag and the push are the operator decisions; an agent prepares the PR and the verification.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 CHANGELOG.md has a 0.3.0 section that names every user-visible change since v0.2.0 with its task id, and package.json reads 0.3.0, merged to main in one PR
- [ ] #2 Annotated tag v0.3.0 created and pushed through the gate; publish.yml publishes approval-md@0.3.0 with npm provenance and no NPM_TOKEN
- [ ] #3 Registry tarball matches the CI artifact, a clean install runs approval --version and approval doctor, provenance verified; results recorded in the notes and the changelog dated
<!-- AC:END -->
