---
id: APRV-307
title: >-
  Trusted Publishing: the release lands from a GitHub workflow the gated tag
  push triggers, no npm token on any machine
status: To Do
assignee: []
created_date: '2026-09-08 06:18'
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
