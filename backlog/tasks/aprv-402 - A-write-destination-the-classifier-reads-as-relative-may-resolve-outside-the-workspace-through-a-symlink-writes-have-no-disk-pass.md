---
id: APRV-402
title: >-
  A write destination the classifier reads as relative may resolve outside the
  workspace through a symlink; writes have no disk pass
status: Done
assignee:
  - '@claude-lane-d'
created_date: '2026-09-20 11:25'
updated_date: '2026-09-22 01:43'
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
- [x] #1 The cost of resolving a write destination on every files.write.workspace segment is measured before any code, against the hook startup budget APRV-209 and APRV-217 describe
- [x] #2 A relative write destination that resolves outside every root through a symlink classifies out of scope, by the same nearest-existing-ancestor walk the read and delete passes use, for the workspace-write row and the APRV-397 packaging rows alike
- [x] #3 The pure classifier is unchanged: the tightening lives in src/cli/hook.ts and can only narrow, with a test that the pass never loosens a class
- [x] #4 A packaging write whose destination sits under a scratch root only through a symlink is tightened by the same disk pass the delete rule uses, rather than trusting the path segments
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. AC1 FIRST, before any code: measure the nearest-existing-ancestor walk (existsSync up to the first hit, realpathSync, re-append the tail) over realistic destination shapes on this machine, and compare with the hook latency APRV-209 recorded (about 371 ms for a cold gated invocation, 116 ms of module graph, 51 ms for hook.js alone).
2. Read the two passes that already exist in src/cli/hook.ts: refineScratchDelete with targetStaysInScratch (delete) and refineReadScope with resolvedReadTarget (read). Mirror their shape exactly: an exported refine* that takes the classification, only ever narrows, and is registered in classifyForHook.
3. Roots: the resolved cwd plus resolveScratchRoots(cwd). The classifier's own rule is that a relative destination is the workspace, and the workspace is where the command runs, so the resolved cwd is the root that rule already implies. Scratch roots come from the function the delete pass already uses, so the two rules cannot disagree about where the agent's scratch is.
4. Candidates per segment: every argument that does not start with a dash, plus the value half of an --opt=value argument. That is the delete pass's own filter, it reaches a flag-named destination (-C dir, -o file, --pack-destination dir) without this file holding a second copy of the classifier's flag table, and it can only over-include, which can only tighten.
5. Rules covered, exactly the ones AC2 names: workspace-write, and the packaging rows tar-extract, tar-create, gunzip-write, base64-write, openssl-digest-out, npm-pack. Only segments whose class is still files.write.workspace.
6. Tighten to files.delete.out_of_scope, the class the classifier already uses for an out-of-scope packaging destination, with a new rule id write-out-of-scope-resolved. No new class is minted, because a class no policy names resolves by defaults.autonomy.
7. Tests in tests/cli-hook-scope.test.ts or a sibling: a symlinked destination leaving every root tightens, a real destination inside does not, a destination under a scratch root only through a symlink tightens (AC4), the pure classifier answers the same before and after (AC3), and a property case that the pass never loosens any segment.
8. Run the hook suites, command-class, and the conformance vectors.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
SECOND CASE, from the same lane and sharper than the first, because the delete rule explicitly closed it and the write path does not have it. A packaging destination strictly under a resolved scratch root answers files.write.workspace on the TEXT alone. For a delete, APRV-267 pairs that text branch with a disk pass in src/cli/hook.ts (targetStaysInScratch), which tightens back to the out-of-scope class when a symlink on the path leaves the root or a checkout is found inside it. A packaging write reaches no such pass: the hook only re-checks segments whose rule is rm-scratch, and a tar extraction into the scratchpad carries the rule tar-extract and the ordinary workspace class. So 'unpack into the temp directory' is autonomous even when the named directory under the temp root is a symlink pointing at the checkout or at a home directory. The fix is the same walk, keyed on the packaging rule ids rather than on rm-scratch alone, and it can only tighten.

AC1, MEASURED BEFORE ANY CODE WAS WRITTEN. A scratchpad script reproduced the nearest-existing-ancestor walk the two existing passes do (existsSync up to the first hit, realpathSync, re-append the tail) and timed it over 20k iterations per shape, five rounds, warm cache, on this machine:

  existing directory        0.108 ms per destination
  existing file             0.103 ms
  one missing segment       0.106 ms
  deep miss, six segments   0.126 ms
  absolute, existing        0.069 ms

A write segment names one or two destinations, so a write command pays roughly 0.1 to 0.25 ms. APRV-209 measured a cold gated hook invocation at about 371 ms, of which 116 ms is the CLI module graph and 51 ms is hook.js alone; APRV-217 owns what is left, which is log-size dependent and this is not. The pass is therefore under half a percent of the smallest term in that budget, it is paid only by segments the classifier has already called a workspace write, and it is the same per-target price the delete pass has paid since APRV-267 and the read pass since APRV-347. No opt-in was added: a cost this size does not earn a switch, and a switch would be a second way for the hole to be open.

WHAT THE PASS DOES. src/cli/hook.ts gains refineWriteScope, registered last in classifyForHook, mirroring refineScratchDelete and refineReadScope in shape, purity contract and failure behaviour. For a segment still classed files.write.workspace whose rule is one of the seven AC2 names (workspace-write, tar-extract, tar-create, gunzip-write, base64-write, openssl-digest-out, npm-pack), each candidate destination is resolved through the nearest existing ancestor and the segment tightens to files.delete.out_of_scope, rule write-out-of-scope-resolved, when the result is outside every root.

ROOTS: the resolved working directory plus resolveScratchRoots(cwd). Not readRoots. A read scope is a read notion and must not become a write authorization, which is the classifier's own words in the scopedWrite header, so this pass asks its own narrower question. The working directory is the root the text rule already implies: 'a relative destination is the workspace' means the workspace is wherever the command runs. Sharing resolveScratchRoots means the write rule and the delete rule cannot disagree about where the agent's scratch is.

CANDIDATES: every argument not spelled as a flag, plus the value half of --opt=value. This is the delete pass's own filter and it is deliberately coarser than the classifier's flag table: it reaches -C dir, -o file, -out file and --pack-destination dir without this file carrying a second copy of that table to drift against. It over-includes (a tar archive being read is a candidate, so is chmod's mode), and over-including can only tighten a segment that would otherwise have been waved through. The equals spelling is covered because the classifier's namedDestination covers it; both spellings have a test.

CLASSES TOUCHED, IN THE WORDS OF SPEC §11.1. Fail closed: a segment this pass cannot re-parse tightens rather than passing, on the delete pass's reasoning that two reads of the same bytes disagreeing is not a thing to resolve in favour of the agent. Invariant 4, self-reported fields never reduce scrutiny: cwd is harness-supplied and is read here as a root, which is sound ONLY because this pass exclusively narrows. The baseline it narrows from is no check at all, so a poisoned cwd buys back exactly today's answer and never a looser one; that argument is written into the function's header so the next reader does not have to reconstruct it. The read-scope invariant is honoured by NOT reusing the read roots, for the reason above. No new class is minted: files.delete.out_of_scope is what the classifier already answers for an out-of-scope packaging destination, and a brand-new files.write.out_of_scope would resolve by defaults.autonomy in every deployment with permissive defaults, which is the one way a tightening pass could loosen something.

TWO SIBLINGS DELIBERATELY LEFT, and they are the same hole: rm-workspace (a relative rm inside the workspace, refineRm's last branch) and redirect-write (a shell redirect into a relative path). Both reach files.write.workspace by the same text-only reasoning and neither is in AC2's enumeration. They are one line each in WRITE_SCOPE_RULES if the orchestrator wants them, and rm-workspace is the sharper of the two because it destroys.

ONE LIMIT WORTH NAMING. The pass resolves the literal argument text and performs no shell expansion, so cp x ~/Desktop/y, cp x $HOME/y and a glob destination are resolved as the strings they are and stay workspace writes. That is unchanged from today (the workspace-write row has no refinement at all and never read isUnknownValue), and tightening on those spellings would deny ordinary globs, so it was left out rather than done halfway.

OVERLAP WITH APRV-409/410. Another lane is editing src/cli/hook.ts and src/core/command-class.ts for quoted prose arguments and late grants. This diff touches src/core/command-class.ts not at all, and in src/cli/hook.ts it is one new section between refineReadScope and classifyForHook plus three lines inside classifyForHook's body. No existing function was reshaped and no signature changed, so the two diffs should merge without a conflict outside classifyForHook's last statement.

STALE DOC CORRECTED IN THE SAME DIFF. docs/claude-code-hook.md carried a paragraph headed 'There is no disk pass for a write destination, and that is a limit rather than a claim', naming this very task as the one that would close it. It is now the write pass's own section, with the same three-row table the delete rule has, the roots it uses, why the read scope is not among them, and the shell-expansion limit stated plainly.

VALIDATION. cli-hook-write-scope 10 tests, 10 pass, 0 fail (the new suite). cli-hook 142 tests, 142 pass, 0 fail. cli-hook-scope, cli-hook-scratch, cli-hook-read-scope, cli-hook-rewrite, command-class, command-class-routing and command-class-quoting together: 621 tests, 621 pass, 0 fail. conformance, conformance-regen, policy-vocabulary, layering and hook-module-graph: 55 tests, 55 pass, 0 fail. node conformance/run.mjs: 458 vectors, 458 passed, 0 failed, 176 controls, 0 controls passed wrongly, exit 0. build, typecheck and lint each exit 0.

CI CAUGHT ONE THING AND IT WAS THE TEST, NOT THE PASS. Shard 3/3 of the first full-gate run failed one assertion, 'resolveWriteRoots carries the working directory and the scratch roots', with roots ["/tmp/approval-md-write-scope-awneGo/workspace","/var/tmp"]. The pass behaved correctly; the assertion was macOS-shaped. The suite builds its world under os.tmpdir(), which IS /tmp on a Linux runner, so resolveScratchRoots discards /tmp for containing the working directory (its own guard, and the right one) and the surviving temp root is /var/tmp, which the assertion's list of acceptable names did not include. On macOS the base sits under /var/folders and /tmp survives, so it passed locally.

The assertion now states the property as agreement rather than as a list of directory names: resolveWriteRoots(cwd) deepEquals [cwd, ...resolveScratchRoots(cwd)]. That is the thing that has to hold on every platform, and it is the thing worth pinning, that the write rule and the delete rule cannot disagree about where scratch is. Verified both ways locally: 10 of 10 under the ordinary layout and 10 of 10 with TMPDIR=/tmp, which reproduces the runner's shape exactly.

Worth knowing rather than buried: on a machine where the session's cwd sits under the temp root, /tmp is not a write root, so a write into it is a question. The delete rule has had that property since APRV-267 and this pass inherits it by sharing the function.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
src/cli/hook.ts gains refineWriteScope, the disk pass the write path never had, registered last in classifyForHook beside the delete and read passes it mirrors. A destination of the workspace-write row or any of the six packaging answers is resolved through its nearest existing ancestor and tightened to files.delete.out_of_scope (rule write-out-of-scope-resolved) when it lands outside the resolved working directory and every scratch root, which closes both the relative-through-symlink case and the packaging destination that is under a scratch root only through a symlink. The pure classifier is untouched: src/core/command-class.ts has no change in this diff. Cost was measured first, 0.07 to 0.13 ms per destination against APRV-209's 51 ms hook.js term, so no opt-in was added. Verified by tests/cli-hook-write-scope.test.ts (10/10), which builds real symlinks and includes a property case that the pass never loosens a segment under any root set, plus cli-hook 142/142, the hook and classifier suites 621/621, conformance 458/458 vectors with 0 controls passed wrongly, and build, typecheck and lint at exit 0. docs/claude-code-hook.md's paragraph saying no such pass exists is replaced by the pass's own section. rm-workspace and redirect-write are the same hole in two rules AC2 does not name and are left, called out in the notes.
<!-- SECTION:FINAL_SUMMARY:END -->
