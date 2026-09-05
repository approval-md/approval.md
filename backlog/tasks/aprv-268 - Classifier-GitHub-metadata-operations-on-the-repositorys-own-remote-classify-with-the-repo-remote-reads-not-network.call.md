---
id: APRV-268
title: >-
  Classifier: GitHub metadata operations on the repository's own remote classify
  with the repo-remote reads, not network.call
status: To Do
assignee: []
created_date: '2026-09-05 10:31'
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
