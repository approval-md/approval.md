---
id: APRV-352
title: >-
  Classifier: remote ref deletion is its own class, vcs.ref.delete, never
  vcs.push.main
status: Done
assignee:
  - '@opus-lane-classifier'
created_date: '2026-09-17 02:22'
updated_date: '2026-09-17 08:05'
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
- [x] #1 approval hook classify returns vcs.ref.delete with the ref names bound for git push --delete, the colon-refspec form, and a bulk deletion of several refs; an ordinary push and a force-push keep their current classes; tests cover each spelling
- [x] #2 SPEC 7 class table gains the row and the amendment is called out; docs/claude-code-hook.md lists the class
- [x] #3 docs/proposals/ carries the Current and Replace-with pair adding vcs.ref.delete: { autonomy: manual } to this repository APPROVAL.md; the APRV-318 driver drops its grant-record workaround in favour of the class once the line is applied, or documents why it keeps both
- [x] #4 Conformance vectors cover the three spellings; build, typecheck, lint and the classifier suites pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read refineGitPush and the order its branches fire in, so the new class lands without moving the force branch or the tag branch above it.
2. Give a refinement the ability to bind a value: Refinement gains an optional path, classifySegment carries it to the segment, same field and same meaning the protected-path binding already has.
3. In refineGitPush, return vcs.ref.delete with rule git-ref-delete and the ref names bound, for the flag forms (--delete, -d), the colon-refspec forms (:refs/heads/x, :x, src:) and bulk forms mixing several. Keep the force check above it so a force push that also deletes stays vcs.history.rewrite, and keep the tag check above it so a tag deletion stays release.publish.
4. Add the class to the git-push row emits, which is what CLASSIFIER_CLASSES and emittableClass derive from.
5. Move the two fixtures in tests/command-class.test.ts that asserted the old class, and add tests/command-class-ref-delete.test.ts for every spelling, for the refs bound, and for the six things that must not move.
6. SPEC section 7: the vcs row gains .ref.delete and an amendment paragraph stating what an implementation must and must not do with it.
7. docs/claude-code-hook.md gains the rule-table entry and a section with the spelling table; docs/cursor-hook.md gains the entry and a pointer; docs/cli-reference.md classify paragraph names the class.
8. docs/proposals/vcs-ref-delete-2026-09.md in the contract docs/proposals/README.md defines, anchored to the vcs.history.rewrite line quoted byte for byte from the live policy.
9. scripts/reconcile-delete-merged-branches.mjs keeps its grant-record check and says so in the assertGranted comment and in the --plan output.
10. Conformance vectors for the three spellings plus the bulk, mixed, tag and force controls; regenerate and run.
11. build, typecheck, lint, the affected suites, conformance.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented. The new class is vcs.ref.delete, rule git-ref-delete, and the refs it matched are bound to the segment path. Binding needed a small plumbing change: Refinement gained an optional path and classifySegment carries it through, which is the same field and the same meaning the protected-path binding has had since APRV-143, so a channel prompt can name what is about to disappear without re-reading the command.

Three orderings decide the whole rule and each is deliberate. The force check stays FIRST, so a force push that also deletes is still vcs.history.rewrite (human-only here): moving shared history is the stricter fact about that command. The tag check stays SECOND, above the deletion check, so every tag deletion spelling keeps release.publish, and so does a bulk deletion that mixes a tag in; the name a release was published under is a release surface however it is removed, and APRV-352 asked for a class for branch deletions rather than a loosening of the tag surface. The deletion check is THIRD, and one deleting refspec makes the whole command a deletion, because a command effect is the union of its refspecs and the destructive half is the half a person is being asked about.

Two fail-closed choices worth naming. A --delete that names no ref at all stays in the class with nothing bound rather than falling through to a push class: an invocation whose targets cannot be read is the one that least deserves the looser answer. A ref name the classifier cannot expand, such as a bare parameter, is still a deletion.

Shipping ahead of the policy line is safe, and safe in the strict direction specifically. A class no rule matches resolves to defaults.autonomy, which in this policy is manual, so between the merge and the paste every remote ref deletion is stricter than it was yesterday rather than looser. It used to resolve vcs.push.main at supervised-retro, which is how 233 irreversible deletions would have proceeded unasked.

The driver keeps its workaround, and says so in two places. scripts/reconcile-delete-merged-branches.mjs keeps the assertGranted grant-record check; its comment now records why the class alone is not the trigger to remove it (an autonomy that holds only by default is one a later vcs.* wildcard could absorb without anyone editing the driver), and its --plan output prints a line saying the check stays until the policy line is applied and that dropping it is APRV-318 decision.

Global invariants touched, named per CLAUDE.md. Fail closed: the two cases above, plus the fact that every ordering choice resolves ambiguity to the stricter class. No verb minting authority: nothing here relabels anything downward, and the human-only classes (vcs.history.rewrite, policy.core, log.mutate, account.credential) are untouched. SPEC section 7 is amended and the amendment is called out for Carter in the PR body.

Verification, with the evidence per criterion. node scripts/run-tests.mjs --only over sixteen affected suites exited 0 with 824 tests, 824 pass, 0 fail (command-class, command-class-quoting, command-class-ref-delete, command-class-routing, conformance, conformance-regen, docs-guard, cli-hook, cli-hook-scope, cli-hook-rewrite, hook-module-graph, dogfood, coverage, agents-md, policy-explain, cli-policy). node conformance/run.mjs exited 0 over 345 vectors. npm run build, npm run typecheck and npm run lint each exited 0.

AC1 is proved by tests/command-class-ref-delete.test.ts. Ten named ref-deletion cases, each asserting the class, the rule AND the bound refs: the flag form long and short, with the flag before and after the remote, a fully qualified refs/heads name, the colon refspec in both spellings, two bulk forms (one flag with three refs, three colon refspecs), a mixed push-and-delete, and the empty-destination spelling. Two more pin the fail-closed cases: a --delete naming no ref at all, and a ref the classifier cannot expand. Sixteen unchanged cases cover the other half of the criterion: ordinary branch and trunk pushes, the implicit push, four force spellings, six tag spellings including two tag deletions, and a bulk deletion mixing a tag in. One more, a force push that also deletes is still a rewrite. Two more pin enumerability: the git-push row declares the class in emits, and CLASSIFIER_CLASSES carries it.

AC2: SPEC section 7 vcs row gains .ref.delete with the gravity, and a new amendment paragraph states what an implementation MUST do (bind the refs, keep force in vcs.history.rewrite, never use the class to loosen a deletion that already takes a stricter one) closing with Amended APRV-352. docs/claude-code-hook.md gains the rule-table entry and a section with the six-row spelling table; docs/cursor-hook.md gains the entry and a pointer; docs/cli-reference.md classify paragraph names the class. The docs-guard test that asserts the hook doc lists every rule and every deny code passes.

AC3: docs/proposals/vcs-ref-delete-2026-09.md follows the docs/proposals/README.md contract, with a declared-language fence per block and a Current anchor quoted byte for byte from the live APPROVAL.md. I verified uniqueness mechanically rather than by eye: the anchor matches exactly one line in APPROVAL.md, so the applier will not refuse it as stale or ambiguous. The page also documents that the driver keeps both the class and the grant-record check, which is the second half of the criterion.

AC4: conformance/vectors/command-class.v1.json gains eight vectors at version 1.1.0, covering the flag form, the short flag, the colon refspec, a bulk deletion, a mixed push-and-delete, a tag deletion that stays release.publish, a force-and-delete that stays a rewrite, and an ordinary push as the control that nothing moved. The manifest pins the new digest.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
A git push that removes a remote ref is now vcs.ref.delete, rule git-ref-delete, with the ref names bound to the segment so an approver is told what disappears. Every spelling lands there: the --delete and -d flags, the colon refspec fully qualified and short, the empty-destination form, and bulk forms mixing several or mixing a deletion into an ordinary push. It used to be vcs.push.main, which this repository samples retrospectively, so 233 irreversible removals would have proceeded unasked. Three boundaries hold: a force push stays vcs.history.rewrite even when it also deletes, a tag deletion stays release.publish including in a bulk form, and a deletion whose refs cannot be read stays in the class with nothing bound. SPEC section 7 carries the row and an amendment paragraph, both hook docs and the CLI reference carry the class, docs/proposals/vcs-ref-delete-2026-09.md carries the policy line for Carter with its anchor verified byte for byte and unique against the live file, and scripts/reconcile-delete-merged-branches.mjs keeps its grant-record check and says why in its comment and its --plan output. Shipping ahead of the policy line is safe in the strict direction: an unmatched class falls to defaults.autonomy, which is manual here. Verified: sixteen affected suites at 824 tests, 824 pass, 0 fail, exit 0; conformance exit 0 over 345 vectors with eight new ref-deletion vectors; build, typecheck and lint exit 0.
<!-- SECTION:FINAL_SUMMARY:END -->
