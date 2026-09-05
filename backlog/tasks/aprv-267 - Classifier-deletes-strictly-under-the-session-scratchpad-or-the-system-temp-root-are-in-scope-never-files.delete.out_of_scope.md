---
id: APRV-267
title: >-
  Classifier: deletes strictly under the session scratchpad or the system temp
  root are in scope, never files.delete.out_of_scope
status: In Progress
assignee:
  - 'agent:opus-lane-b'
created_date: '2026-09-05 10:31'
updated_date: '2026-09-05 14:58'
labels:
  - classifier
dependencies: []
priority: medium
ordinal: 198000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From the log, 2026-09-05: all 13 files.delete.out_of_scope questions since Aug 17 were lanes removing their own scratch directories (/private/tmp/claude-501/... session scratchpads, /tmp/<name> clones and probe files); 11 approved, 2 expired. Outcome: an rm whose every target path is strictly under the process's scratchpad root (the CLAUDE_SCRATCHPAD or session scratch dir the harness exports, when present) or under the system temp root (os.tmpdir() and /private/tmp on macOS), with no .., no symlink escape (realpath the parent), and no path inside any checkout, classifies files.delete.scratch (a new class under files.delete.*, default autonomy from files.delete's line or autonomous in the repo policy); anything else keeps today's classification. Why: a delete of the agent's own temp files is not a decision.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Table-driven classifier tests: scratchpad and temp-root targets classify files.delete.scratch; a target outside those roots, a .. segment, a symlink escaping the root, or a checkout path keeps files.delete.out_of_scope
- [x] #2 docs/claude-code-hook.md table and the repo policy pin updated; every literal class reachable
- [x] #3 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Thread an optional ClassifierContext (scratchRoots: absolute, already-resolved roots) through classifyCommand -> classifySegment -> RuleContext, exactly as protectedPaths is threaded: omitting it under-reports the new class rather than inventing an authorization.
2. refineRm gains a scratch branch ABOVE the absolute check: every positional must be absolute, carry no .. segment, no unknown value ($ * ? ~), and be a strict descendant of one scratchRoot. All targets pass -> files.delete.scratch, rule rm-scratch. Any target failing keeps today's class. Declare files.delete.scratch in the rm row's emits so CLASSIFIER_CLASSES carries it.
3. The impure half lives in src/cli/hook.ts beside refineRewrite (APRV-108 precedent): resolveScratchRoots() reads os.tmpdir() plus the fixed platform temp roots and the harness scratchpad vars when present, realpaths them, and rejects any root shallower than two segments or containing the cwd (a poisoned TMPDIR must not make / a scratch root). refineScratchDelete() then TIGHTENS: for every rm-scratch target it realpaths the nearest existing ancestor, requires it still under a root, and requires no .git at or above the target up to that root. Any failure downgrades back to files.delete.out_of_scope.
4. Table-driven fixtures in tests/command-class.test.ts against synthetic roots (positives and each negative: outside, .., glob, the root itself, a checkout path is proven in the hook test); hook tests for the impure tightening.
5. docs/claude-code-hook.md and docs/cursor-hook.md rule tables gain the class (both doc tests assert every CLASSIFIER_CLASSES member is named); policy-expectations pins files.delete.scratch manual/default, since the repo policy declares neither new class.
6. npm test, oxlint.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## Implementation notes (agent:opus-lane-b)

Commit 4bfadf7. Build green, oxlint clean, node --test on command-class (358), dogfood (35), cli-hook (89), cli-hook-cursor (8) and the new cli-hook-scratch (12) all exit 0.

### The split, and why it is a split

The classifier's file header promises purity: no filesystem, no clock, no environment. This rule needs all three. Rather than break that promise it follows APRV-108's precedent exactly, and the promise is what makes the fixture table a specification instead of a sample of observed behaviour.

- PURE half, src/core/command-class.ts: a new exported ClassifierContext threaded through classifyCommand -> classifySegment -> RuleContext as an optional third argument, shaped precisely like protectedPaths. refineRm gains allTargetsAreScratch above the absolute-path check: every target absolute, no .. segment, nothing unreadable (dollar, star, question mark, tilde), and a STRICT descendant of a supplied root. All targets or none. files.delete.scratch is declared in the rm row's emits, so CLASSIFIER_CLASSES carries it and the dogfood reachability check will pass the moment the policy declares it.
- IMPURE half, src/cli/hook.ts, beside refineRewrite: resolveScratchRoots + refineScratchDelete + classifyForHook (the one order both hook callers now use, so hook classify prints what hook claude-code decides).

### What the classifier learns of the environment today: nothing

The classifier has never read an environment and still does not. The HOOK reads one, and the honest answer to 'how does it learn of the scratchpad' is that no harness tells it. Probed on this machine: CLAUDE_SCRATCHPAD_DIR, CLAUDE_SCRATCHPAD, CLAUDE_PROJECT_DIR and TMPDIR are all unset in a hook child; Claude Code names the scratchpad in the system prompt and nowhere else. So the roots are os.tmpdir() plus the fixed roots /tmp, /private/tmp and /var/tmp, which cover every path in the log evidence (the observed scratchpad is /private/tmp/claude-501/<project>/<session>/scratchpad, and /tmp is a symlink to /private/tmp on macOS). CLAUDE_SCRATCHPAD_DIR and CLAUDE_CODE_SCRATCHPAD_DIR are read anyway so the rule narrows by itself the day a harness starts exporting one. All of this is documented in the hook docs' new 'Deleting scratch' section and in the module comment.

### Touches SPEC 11.1 invariant 8 (self-reported fields never reduce scrutiny)

os.tmpdir() reads TMPDIR, so a value reaching the hook process could in principle nominate / and turn every absolute delete into a scratch delete. Three guards, none of which trusts the value: a root must realpath to a real directory, must be at least two path segments deep, and must not contain the directory the hook runs in (a checkout is never inside its own scratch root). There is a test for each. No other invariant moves: the refinement only ever TIGHTENS, the protected-path and credential overrides still run after it (a CLAUDE.md inside the scratchpad is still policy.edit), no new human-only class is minted, and no caller timestamp is read.

### The checkout rule is literal, and it costs something

'No path inside any git checkout' is implemented as written: a .git at or above the target, walking up to the containing root. That means a lane removing a throwaway clone at /tmp/probe-clone still gates, even though that was one of the observed cases. Fail closed was the instruction and removing a checkout destroys work; if the cost shows up in the log, narrowing it is a follow-up task, not a silent widening here.

### Repo policy

APPROVAL.md declares neither this class nor APRV-268's, so files.delete.scratch is pinned manual/default in REPO_POLICY_EXPECTATIONS. Until Carter's ceremony this rule costs nothing and changes nothing: files.delete.out_of_scope was already manual, so a scratch delete gates exactly as it always did, with a better name on the phone. The line to add is in the final report.

### SPEC 7 draft (for Carter; agents may not edit that file)

Two sentences, to sit under the files.delete.* group:

  files.delete.scratch covers a delete whose every target lies strictly inside
  the session scratchpad the harness allots or the system temp root, with no
  parent-directory segment, no symlink leaving that root, and no path inside a
  git checkout. It is a sibling of files.delete.out_of_scope and never a
  substitute for it: a delete that fails any one of those tests keeps the
  out-of-scope class, and a runtime that cannot resolve the roots emits the
  class for nothing at all.

## Platform finding: the depth floor refused the Linux temp root (CI fix)

CI (ubuntu) failed two of the APRV-267 hook tests that pass on macOS: "the
system temp root is a scratch root, resolved through its symlinks" and
"approval hook classify reports files.delete.scratch for a temp-root delete".
Cause: the anti-poisoning depth floor. On macOS os.tmpdir() is
/var/folders/... and /tmp resolves through its symlink to /private/tmp, both
two segments or more, so the floor was never felt. On Linux os.tmpdir() IS
/tmp, one segment, so resolveScratchRoots dropped it, no scratch root existed
at all, and files.delete.scratch could never fire on the platform CI runs.
The rule was accidentally macOS-only.

Fix, in resolveScratchRoots via a new exported predicate
scratchRootDepthAccepted(resolved): the three compiled-in temp roots (/tmp,
/private/tmp, /var/tmp) are accepted at depth one; every other resolved
candidate keeps the two-segment rule. The exemption is keyed on the RESOLVED
value being one of those three literals, so SPEC 11.1 invariant 8 is unmoved:
a poisoned TMPDIR still has to realpath to a directory that is already a
compiled-in root to get in, / is not among them and is still refused, one
segment directories like /etc and /home are still refused, and the cwd
containment guard is untouched. The other two guards (must realpath to a real
directory, must not contain the hook cwd) are unchanged.

Tests are now platform-independent: the temp-root case builds its expectation
from realpath(os.tmpdir()) on the running machine instead of assuming the
symlinked layout; the poisoned-root case asserts every root is either two
segments deep or one of the well-known three; a new darwin-guarded case keeps
proving the /tmp to /private/tmp symlink resolution; a new predicate case
covers the Linux shape (/tmp accepted at depth one, / and /etc refused) on
either platform, since no depth-one path can exist on macOS to exercise it
directly; and a new end-to-end case classifies a delete under the machine's
own resolved temp root using the roots resolveScratchRoots returns rather than
a hand-written list. cli-hook-scratch 15/15, command-class 360/360, cli-hook
91/91, all exit 0; oxlint clean.
<!-- SECTION:NOTES:END -->
