---
id: APRV-412
title: 'README split: short README plus docs/README-extended.md'
status: Done
assignee:
  - '@fable'
created_date: '2026-09-20 19:45'
updated_date: '2026-09-20 21:07'
labels: []
dependencies: []
references:
  - draft-README.md
  - draft-README-extended.md
ordinal: 318000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The root README grew to 980 lines and doubles as the product tour, dictionary, threat-model FAQ, CI guide and exit-code reference. Split it: README.md becomes a short entry (pitch, quickstart, autonomy table, integration signposts, boundary statement), and a new docs/README-extended.md carries the tour and operating detail. Two drafts were reviewed against main at 9ca089e: every link target, verb, flag and schema key they name exists. Landing them needs six fixes so nothing is lost and the docs guard keeps its coverage.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 README.md is the short draft; docs/README-extended.md exists with no em dash in its title
- [x] #2 The three sections neither draft carried (How this compares, the per-key APPROVAL.md dictionary, the seq 2 amend story) live in docs/README-extended.md
- [x] #3 tests/docs-guard.test.ts asserts the moved claims against docs/README-extended.md; the autonomy count phrase and doctor row-count literals are dropped, every enum level and every DOCTOR_FRESH_SKIPS row is still asserted
- [x] #4 features/index.html, llms-full.txt and llms.txt no longer link to README anchors that land on the Read on signpost; they point at the extended guide sections
- [ ] #5 package.json files includes docs/README-extended.md and npm pack --dry-run lists it
- [x] #6 The version-scope paragraph names no commit SHA and no unreleased feature by name
- [x] #7 The short README example policy loads through approval policy check with no channel cross-check refusal
- [ ] #8 npm run ci:local is green
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Copy draft-README.md over README.md; create docs/README-extended.md from draft-README-extended.md with a colon title.
2. Move from the old README into the extended guide: the per-key dictionary (both tables) under Policy reference, the seq 2 story under Change and attest the policy, How this compares as a section after Security and evidence limits. Add a fresh-directory doctor paragraph naming the DOCTOR_FRESH_SKIPS rows under Operating and troubleshooting.
3. Retarget tests/docs-guard.test.ts README assertions to docs/README-extended.md; drop the count phrase and doctor row-count and tally literals; keep every enum level and every fresh-skip row asserted.
4. Retarget features/index.html, llms-full.txt and llms.txt links that pointed at dictionary, evasion FAQ, comparison and checks anchors to the extended guide sections.
5. Add docs/README-extended.md to package.json files; drop the SHA and Hermes clause from the version-scope paragraph.
6. Verify: build, docs-guard alone, full test, lint, typecheck, policy check of the README example, anchor sweep, npm pack dry run, ci:local.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Landed from the two ChatGPT drafts plus six fixes. Moved sections: How this compares (new H2 after Security and evidence limits), the per-key dictionary (#### Every key under Policy reference), the seq 2 story (end of Change and attest the policy). Added a fresh-directory doctor paragraph naming every DOCTOR_FRESH_SKIPS row without a count. Rewrote the guide staleness paragraph to describe the landed split rather than instruct it.

docs-guard: the autonomy count phrase and the doctor row-count and tally literals are dropped by design; the guide argues five levels plus one alias, and the row count is volatile and lives in tests/doctor-rows.ts. Every enum level and every fresh-skip row is still asserted by name. New test: README.md links docs/README-extended.md.

Verification: build ok; docs-guard 17/17; lint and typecheck clean; anchor sweep of 53 references resolved with none missing; policy check of the README example resolves vcs.push.main and read.file.out_of_scope to manual with loadFailure null (no defaults.channel cross-check exists in the loader). AC5 unchecked: npm pack --dry-run was denied hook-unclassified by the primary build (this worktree classifies it npm-pack, so the enforcing build is stale relative to main); files list verified by reading package.json. AC8 unchecked: npm test has 41 pre-existing failures on this host (better-sqlite3 NODE_MODULE_VERSION 137 vs 147 under Node 26, and SMTP mock TLS handshake), none in touched files; CI is the verdict.

Follow-up (same day): the README told readers to attest a changed policy with the bare attest verb, and the guide never said what to do when a policy edit sits in a checkout behind main. Both now name approval policy amend (--pr) as the way to land a policy edit, and the guide says explicitly not to stash, reset or check the file out to get past a refused sync. Prompted by Carter hitting log-sync-git-failed on a wanted APPROVAL.md diff.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Split README.md into a short entry and docs/README-extended.md, restoring the three sections the drafts dropped, retargeting the docs guard and the site links, and shipping the guide in the npm package. Verified with build, docs-guard 17/17, lint, typecheck, a 53-reference anchor sweep, and approval policy check on the README example. PR #524 opened and merge armed; AC5 and AC8 wait on CI because npm pack is denied by the primary hook build and npm test has 41 pre-existing host failures.
<!-- SECTION:FINAL_SUMMARY:END -->
