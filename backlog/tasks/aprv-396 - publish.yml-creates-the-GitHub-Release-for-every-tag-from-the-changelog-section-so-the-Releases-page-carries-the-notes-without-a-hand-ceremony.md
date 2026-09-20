---
id: APRV-396
title: >-
  publish.yml creates the GitHub Release for every tag from the changelog
  section, so the Releases page carries the notes without a hand ceremony
status: To Do
assignee: []
created_date: '2026-09-20 03:49'
updated_date: '2026-09-20 04:40'
labels:
  - release
  - ci
  - docs
dependencies: []
priority: medium
ordinal: 305000
approval:
  origin:
    app: manual
    created_by: 'agent:claude-code'
  route:
    assignee: 'agent:claude-code'
    rationale: 'APRV-396 AC1, 2026-09-20: the 0.3.0 GitHub Release created by hand through the gate with the changelog section as its body, before publish.yml learns to do it; the human decides on the phone'
  state: proposed
  actions:
    - class: release.publish
      summary: 'gh release create v0.3.0 --verify-tag --title "approval-md 0.3.0" --notes-file <the 0.3.0 CHANGELOG section, 360 lines> from /Users/carter/dev/approval-md: creates the public GitHub Release object for the tag already pushed; publishes nothing to npm (payload is the argv and cwd; run recomputes the hash before it spawns)'
      reversible: true
      est_cost_usd: '0'
      idempotency_key: 'aprv-396:release-create:2026-09-20'
      payload_hash: '0da59006cbbc6ded797064261fad70720199fa645e3ceec170297fe707a10792'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter asked on 2026-09-20 where the 0.3.0 release notes are. They live in CHANGELOG.md (also inside the npm tarball), and the GitHub Releases page is empty for every version: neither 0.1.0, 0.2.0 nor 0.3.0 has a Release object, because publish.yml publishes to npm only. For 0.3.0 the Release is created by hand through the gate (this task first action, class release.publish, body = the 0.3.0 changelog section, --verify-tag). From the next tag on, publish.yml creates it: after the npm publish succeeds, extract the changelog section whose heading matches the tag version (refuse to create a Release when no section matches or the section is undated), create the Release with gh release create --verify-tag, title approval-md <version>, the section as the body, and attach the CI tarball and its sha256 as assets so the Releases page and the registry can be compared by hand. Idempotent: a Release that already exists is updated, never duplicated. Docs: docs/dogfood-cutover.md release section and the changelog convention note. Related: APRV-307 (Trusted Publishing), APRV-371, APRV-395 (site version guard), APRV-329.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The 0.3.0 Release exists on GitHub with the changelog section as its body, created through the gate, recorded in the notes with the grant and execution seqs
- [ ] #2 publish.yml creates or updates the Release for a tag after a successful publish, from the matching changelog section, with --verify-tag, the tarball and its sha256 attached; a tag with no matching dated section fails that step with a clear message and does not touch npm
- [ ] #3 A workflow-level test or a dry-run script under scripts/ exercises the section extraction against CHANGELOG.md for 0.2.0 and 0.3.0; docs updated
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
AC1 done 2026-09-20 ~04:0xZ through the gate: task.registered seq 59788, approval.requested 59789, approval.granted 59793 from the phone, executed under the token; gh release create v0.3.0 --verify-tag with the 360-line 0.3.0 CHANGELOG section as the body; https://github.com/approval-md/approval.md/releases/tag/v0.3.0. AC2 and AC3 are the workflow work and stay open.

Add to the workflow work: the publish job publishes a downloaded tarball with no .git, so the registry gitHead is null for 0.2.0 and 0.3.0; set it from RELEASE_SHA before npm publish (npm pkg set gitHead=<sha> on the extracted package, or the equivalent), so the registry metadata carries the commit the provenance already binds.
<!-- SECTION:NOTES:END -->
