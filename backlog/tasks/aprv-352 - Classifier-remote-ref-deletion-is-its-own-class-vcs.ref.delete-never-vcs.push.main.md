---
id: APRV-352
title: >-
  Classifier: remote ref deletion is its own class, vcs.ref.delete, never
  vcs.push.main
status: To Do
assignee: []
created_date: '2026-09-17 02:22'
labels:
  - classifier
  - vcs
  - policy
dependencies: []
priority: medium
ordinal: 269000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found by Lane 5 on 2026-09-17 while building the APRV-318 branch-deletion driver: a git push that deletes remote refs (git push origin --delete <branch>, git push origin :refs/heads/<branch>, and the bulk refspec forms) classifies vcs.push.main, which this repository sets to supervised-retro, so 233 irreversible deletions would proceed unasked and be sampled afterwards. The driver works around it by demanding a grant record before --execute; the real fix is a class. Add vcs.ref.delete (single or bulk, branch or tag, any remote) in src/core/command-class.ts with the ref names bound, distinct from vcs.push.main and from vcs.history.rewrite (human-only, a force-push that moves shared history); a deletion of a tag under a protected pattern stays release.publish or human-only as today. Unknown class falls to defaults.autonomy (manual) by the fail-closed rule, so shipping the class without a policy line is already safe; the policy line for this repository (vcs.ref.delete: { autonomy: manual }) goes to docs/proposals/ for Carter to apply with approval policy apply. Carter approved the class as the fix on 2026-09-17. Related: APRV-318, APRV-185, APRV-283.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval hook classify returns vcs.ref.delete with the ref names bound for git push --delete, the colon-refspec form, and a bulk deletion of several refs; an ordinary push and a force-push keep their current classes; tests cover each spelling
- [ ] #2 SPEC 7 class table gains the row and the amendment is called out; docs/claude-code-hook.md lists the class
- [ ] #3 docs/proposals/ carries the Current and Replace-with pair adding vcs.ref.delete: { autonomy: manual } to this repository APPROVAL.md; the APRV-318 driver drops its grant-record workaround in favour of the class once the line is applied, or documents why it keeps both
- [ ] #4 Conformance vectors cover the three spellings; build, typecheck, lint and the classifier suites pass
<!-- AC:END -->
