---
id: APRV-397
title: >-
  Classifier rules for the read-only packaging and archive tools a release
  verification uses: npm pack, npm init, npm --version, tar (list and extract
  into a scratch dir), gunzip, base64, openssl dgst, shasum; and git tag -l is a
  read, never release.publish
status: To Do
assignee: []
created_date: '2026-09-20 04:41'
labels:
  - classifier
  - hook
  - release
dependencies: []
priority: medium
ordinal: 306000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found on 2026-09-20 during the APRV-371 AC3 verification pass and the tag ceremony. (1) A Sonnet verifier could not run npm pack, npm init, bare npm --version, tar (list or extract), gunzip, base64 or openssl dgst: all came back hook-unclassified and were refused, so it fetched the tarball with curl and parsed it with node scripts. These are the tools any release verification or packaging check uses; each is read-only or writes only into a directory it names, so they belong in src/core/command-class.ts with the same scoping the read.* and files.write.workspace rules apply (tar extraction is a write into its destination path; refuse when the destination is outside the workspace or scratch). (2) The orchestrator ran git tag -l in a state check and the git-tag rule (APRV-305) sent it to release.publish, a manual class, which put a nine-minute question on Carter phone for a listing; git tag with -l, --list, -n or no arguments is a read and must classify read.repo (or whatever the read class for git metadata is), while -a, -d, -f, -s and a bare tag name stay release.publish. Add conformance vectors for both groups in command-class.v1.json with the version bump the suite requires. Related: APRV-305, APRV-380 (the login-shell unwrap set the pattern for pinning classifier changes in vectors), APRV-371.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 npm pack, npm init, npm --version, tar list and tar extract into a named scratch path, gunzip, base64, openssl dgst and shasum classify as reads or workspace writes with the scoping stated, pinned by conformance vectors; tar extract to a path outside the workspace or scratch is refused
- [ ] #2 git tag -l, --list, -n and bare git tag classify as a read; git tag -a, -d, -f, -s and git tag <name> stay release.publish; pinned by vectors and a hook test
- [ ] #3 docs/claude-code-hook.md and docs/cli-reference.md classifier section list the new rules; build, typecheck, lint, hook and conformance suites pass
<!-- AC:END -->
