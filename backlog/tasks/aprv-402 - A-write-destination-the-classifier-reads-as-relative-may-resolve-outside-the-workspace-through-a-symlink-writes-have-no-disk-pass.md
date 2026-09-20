---
id: APRV-402
title: >-
  A write destination the classifier reads as relative may resolve outside the
  workspace through a symlink; writes have no disk pass
status: To Do
assignee: []
created_date: '2026-09-20 11:25'
updated_date: '2026-09-20 11:27'
labels:
  - classifier
  - hook
  - security
dependencies: []
ordinal: 311000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found by the APRV-397 lane on 2026-09-20 while adding the packaging rules.

THE FACT. Deletes and reads each have a second, impure pass in src/cli/hook.ts that resolves the target, follows symlinks, and tightens the pure classifier's answer (targetStaysInScratch for files.delete.scratch, refineReadScope for read.file.out_of_scope). WRITES have none. So a relative destination is files.write.workspace on the text alone: cp x build/y, tee build/y, mkdir build/y, and since APRV-397 tar -x -C build and npm pack --pack-destination build all classify autonomous even when build is a symlink pointing outside the checkout.

NOT A REGRESSION, which is why this is its own task rather than a fix inside APRV-397. The hole is as old as the workspace-write row and is identical for cp, mv, tee, ln, truncate and mkdir; the packaging rows added by APRV-397 inherit exactly the same answer those rows already give, and before APRV-397 every one of those commands was denied as unclassified, so nothing that was refused became allowed by a symlink. The shape of the fix is the one the other two rules already have: resolve the nearest existing ancestor of each write destination against the hook's own directory, and tighten to the out-of-scope class when it leaves the roots. It can only ever tighten, exactly as the read pass can.

WORTH COSTING FIRST. Every workspace write in a session would gain a resolve, which is the cost APRV-188 and APRV-212 were about, and the read pass is already registered only when an operator opts in for that reason.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The cost of resolving a write destination on every files.write.workspace segment is measured before any code, against the hook startup budget APRV-209 and APRV-217 describe
- [ ] #2 A relative write destination that resolves outside every root through a symlink classifies out of scope, by the same nearest-existing-ancestor walk the read and delete passes use, for the workspace-write row and the APRV-397 packaging rows alike
- [ ] #3 The pure classifier is unchanged: the tightening lives in src/cli/hook.ts and can only narrow, with a test that the pass never loosens a class
- [ ] #4 A packaging write whose destination sits under a scratch root only through a symlink is tightened by the same disk pass the delete rule uses, rather than trusting the path segments
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
SECOND CASE, from the same lane and sharper than the first, because the delete rule explicitly closed it and the write path does not have it. A packaging destination strictly under a resolved scratch root answers files.write.workspace on the TEXT alone. For a delete, APRV-267 pairs that text branch with a disk pass in src/cli/hook.ts (targetStaysInScratch), which tightens back to the out-of-scope class when a symlink on the path leaves the root or a checkout is found inside it. A packaging write reaches no such pass: the hook only re-checks segments whose rule is rm-scratch, and a tar extraction into the scratchpad carries the rule tar-extract and the ordinary workspace class. So 'unpack into the temp directory' is autonomous even when the named directory under the temp root is a symlink pointing at the checkout or at a home directory. The fix is the same walk, keyed on the packaging rule ids rather than on rm-scratch alone, and it can only tighten.
<!-- SECTION:NOTES:END -->
