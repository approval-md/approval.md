---
id: APRV-305
title: >-
  The classifier reads a tag push as vcs.push.branch, so pushing a release tag
  is autonomous
status: Done
assignee:
  - '@codex-sol'
created_date: '2026-09-08 04:37'
updated_date: '2026-09-09 01:32'
labels:
  - harness
dependencies: []
ordinal: 224000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
approval hook classify -- 'git push origin v0.1.0' answers vcs.push.branch (autonomous in the repo policy) while 'git tag -a v0.1.0 -m x' answers release.publish (manual). A pushed tag is what makes a release public on GitHub and what CI and consumers key on, so the push of a tag ref belongs with release.publish. Found preparing the APRV-199 ceremony on 2026-09-08; the ceremony declares the class in its envelope so it is gated regardless.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 git push of a ref that names a tag (refs/tags/*, a bare v-prefixed semver, or --tags) classifies release.publish; a branch push is unchanged
- [x] #2 tests/command-class.test.ts covers the tag forms and the branch control
- [x] #3 docs/cli-reference.md classifier section lists the rule
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Inspect git push parsing and preserve force/history and main/deletion precedence. 2. Route explicit refs/tags destinations, bare v-prefixed semantic-version refs, --tags and --follow-tags to release.publish conservatively while preserving explicit branch controls. 3. Test mixed branch/tag refspecs, tag deletion, force cases, options and lookalike branch names. 4. Update classifier docs, parent reviews security and focused/full evidence, then merge through policy.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented in 6ebc906 and merged via PR350, merge69c4e12a44a0b2360c40fb1339fb7e8c2827a94d. Parent reviewed tag/force precedence; focused classifier and CLI472/472 exit0; exact frozen full suite env -u APPROVAL_HUMAN npm test exit0,3973pass,1skip,0fail. Lint/typecheck/diff checks exit0; required PR checks passed. Tag refs, shorthand, semver and tags/follow-tags now require release.publish; force/history rewrites retain stricter precedence.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Tag pushes now classify release.publish while ordinary branch pushes remain unchanged. Source, tests and docs merged in PR350 after focused/full tests and required CI passed.
<!-- SECTION:FINAL_SUMMARY:END -->
