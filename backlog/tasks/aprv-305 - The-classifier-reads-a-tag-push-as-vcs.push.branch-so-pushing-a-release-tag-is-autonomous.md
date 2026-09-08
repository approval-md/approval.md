---
id: APRV-305
title: >-
  The classifier reads a tag push as vcs.push.branch, so pushing a release tag
  is autonomous
status: To Do
assignee: []
created_date: '2026-09-08 04:37'
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
- [ ] #1 git push of a ref that names a tag (refs/tags/*, a bare v-prefixed semver, or --tags) classifies release.publish; a branch push is unchanged
- [ ] #2 tests/command-class.test.ts covers the tag forms and the branch control
- [ ] #3 docs/cli-reference.md classifier section lists the rule
<!-- AC:END -->
