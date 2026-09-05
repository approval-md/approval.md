---
id: APRV-268
title: >-
  Classifier: GitHub metadata operations on the repository's own remote classify
  with the repo-remote reads, not network.call
status: In Progress
assignee:
  - 'agent:opus-lane-b'
created_date: '2026-09-05 10:31'
updated_date: '2026-09-05 10:41'
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
- [ ] #1 Table-driven classifier tests for the listed gh forms against the origin repo (vcs.remote.meta) and for a graphql mutation, a foreign repo, and curl (network.call)
- [ ] #2 docs/claude-code-hook.md table, the repo policy pin and the dogfood reachability test updated
- [ ] #3 npm test passes; lint clean
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
