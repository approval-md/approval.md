---
id: APRV-268
title: >-
  Classifier: GitHub metadata operations on the repository's own remote classify
  with the repo-remote reads, not network.call
status: In Progress
assignee:
  - 'agent:opus-lane-b'
created_date: '2026-09-05 10:31'
updated_date: '2026-09-05 11:11'
labels:
  - classifier
dependencies: []
priority: medium
ordinal: 199000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From the log, 2026-09-05: 52 network.call questions since Aug 17, 48 approved; the bulk were gh api graphql queries, gh pr update-branch, gh run rerun and gh pr view against this repository's own origin, plus curl probes from test lanes. Sending anything (webhooks, emails, arbitrary curl POSTs) is the class's purpose and stays manual. Outcome: gh invocations whose target is the checkout's own origin repository and whose verb is a read or a metadata mutation with no payload leaving the repo (api GET, api graphql query without mutation, pr view/list/checks/update-branch, run view/rerun/list, issue view/list) classify vcs.remote.meta (new class, default supervised in the repo policy, beside read.vcs.remote and vcs.pr.open); gh api with a mutation or a non-origin repo, and any curl, keeps network.call. Why: a 9-minute hook wait and a phone question for gh pr view is the kind of friction that teaches people to bypass the gate.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Table-driven classifier tests for the listed gh forms against the origin repo (vcs.remote.meta) and for a graphql mutation, a foreign repo, and curl (network.call)
- [x] #2 docs/claude-code-hook.md table, the repo policy pin and the dogfood reachability test updated
- [x] #3 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. New class vcs.remote.meta, emitted purely by refineGh and refineGhApi. No filesystem: 'the checkout's own origin' is read off the ARGV as the task's own gloss defines it (default repo resolution, i.e. no -R/--repo and no --hostname). Any -R/--repo at all -> network.call, even one naming this repo: the classifier is pure and cannot resolve a remote, so it fails closed.
2. gh nouns and actions, exactly the listed set: pr view/list/checks/update-branch, run view/rerun/list, issue view/list. Anything else on those nouns keeps today's class (gh pr diff stays read.vcs.remote, gh pr merge stays vcs.push.main, gh pr create stays vcs.pr.open).
3. gh api: a GET-shaped call (no field flags, no method or -X GET, no substitution, no dollar) -> vcs.remote.meta. gh api graphql -> vcs.remote.meta only when every field value is readable and none matches the mutation keyword; a graphql call whose query the classifier cannot read, or that carries 'mutation', keeps network.call. gh release/gist/secret/auth/workflow and every curl are untouched.
4. Table-driven fixtures: the listed forms positive, and negatives for a graphql mutation, -R owner/other, --hostname, gh release create, curl.
5. docs/claude-code-hook.md and docs/cursor-hook.md tables (both doc tests assert every CLASSIFIER_CLASSES member is named); dogfood reachability is policy to classifier, so the new class must be in CLASSIFIER_CLASSES before Carter can declare it; policy-expectations pins vcs.remote.meta manual/default until the ceremony.
6. npm test, oxlint.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## Implementation notes (agent:opus-lane-b)

Commit 74f7733. Build green, oxlint clean, node --test on command-class (358), dogfood (35), cli-hook-cursor (8) and cli-amend (84) all exit 0.

### Entirely pure

Nothing here touches a disk or a remote. 'The checkout's own origin repository' is read off the argv as the task's own gloss defines it: gh's DEFAULT repository resolution, which reads the repository off the checkout's git remotes when no -R/--repo is given. That keeps the whole rule in the fixture table, where a classifier rule is reviewable.

### Fail-closed choices worth naming

- ANY -R, --repo or --hostname makes the invocation foreign, including a -R that names this very repository. The classifier cannot resolve a remote, so it cannot tell the two apart, and the safe reading is the one that does not let 'gh api -R victim/repo' ride a rule written for this repository's metadata. There is a fixture for -R approval-md/approval-md.
- Any dollar-expansion or command substitution in the argv is foreign too: a word the classifier cannot see could be a --repo.
- gh api graphql is vouched for only when every word is readable, none matches the mutation keyword as a WORD (so mutationCount does not trip it and mutation( cannot slip past), and the document is not read from a file (-f query=@doc, --input). A document the classifier will never see cannot be vouched for.
- The noun/action set is exactly the one the task lists. It does not grow by analogy: gh pr diff, gh pr status, gh repo view and gh run watch stay read.vcs.remote.

### FRICTION REGRESSION the orchestrator and Carter must sequence

The task's list puts gh pr view, gh pr list, gh pr checks, gh run view/list, gh issue view/list and a gh api GET on the new class. Those were already read.vcs.remote, which this repo's policy makes AUTONOMOUS through its read.* rule. On the new class, with APPROVAL.md not yet declaring it, they fall to the manual default. So on main-before-ceremony this commit makes gh pr view MORE expensive, not less, which is the opposite of the task's stated Why.

This was implemented as the acceptance criteria state rather than narrowed on my own judgement, and the pin note in policy-expectations says so in the file. Two ways out, Carter's choice: land the ceremony in the same breath (the APPROVAL.md line is in the final report, and supervised restores the intent for the mutations while still costing gh pr view its autonomous status), or narrow the rule to the three forms that were actually network.call (gh api graphql query, gh pr update-branch, gh run rerun) and leave the pure reads on read.vcs.remote. The second is a two-line change to GH_META_ACTIONS and the api branch.

### Invariants

No global invariant moves. The class is new and non-human-only, so no verb mints authority for a human-only class (SPEC 11.1 invariant 9); nothing self-reported is read (the classifier reads the command text only, never the harness's description field); every change is in the pure classifier, so no enforcement path reads an unverified record and no gate-typed event gains a caller timestamp.

### SPEC 7 draft (for Carter; agents may not edit that file)

Two sentences, to sit beside read.vcs.remote and vcs.pr.*:

  vcs.remote.meta covers a forge operation aimed at the repository the checkout
  itself tracks, where the effect is a read or a change to the forge's own
  bookkeeping about work already pushed, and no content of the operator's
  authorship leaves the machine. A runtime that cannot establish from the
  invocation alone that the target is the checkout's own repository must not
  emit this class, which is why naming any repository explicitly falls back to
  the class the operation had before.

### Suite fallout, found and fixed

The first full run was 3521 tests, 3519 pass, 1 fail, exit 1. The single failure was tests/cli-hook.test.ts 'hook classify reads gh api by its method and field flags', which pinned 'gh api repos/x/y/pulls' at read.vcs.remote through the real CLI. That is precisely the assertion this task moves, so it was updated rather than worked around: it now pins vcs.remote.meta for the default-resolution GET and read.vcs.remote for the same GET behind a -R, and a second case walks a graphql query and a graphql mutation through hook classify end to end. Commit 3ac2319; cli-hook is 90/90 exit 0 with it.

I missed it on the first pass because I ran cli-hook during the APRV-267-only phase of the branch, before restoring the gh changes. Worth noting for the next lane that splits one file across two commits.

Also checked and unaffected: every other test touching gh uses 'gh pr create' (still vcs.pr.open), and no test outside command-class asserts files.delete.out_of_scope. conformance/run.mjs is 279/279 exit 0, so no policy-resolution vector moved and the conformance ritual is not needed.
<!-- SECTION:NOTES:END -->
