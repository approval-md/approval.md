---
id: APRV-393
title: Remove judgy/ from the public repository; its destination is undecided
status: To Do
assignee: []
created_date: '2026-09-20 01:32'
updated_date: '2026-09-20 01:38'
labels:
  - site
  - hosting
  - judgy
dependencies: []
priority: low
ordinal: 303000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter ruled on 2026-09-20 that the judgy reviewer pages do not ship in 0.3.0 and leave the public repository. The 0.3.0 changelog entry for them has already been dropped (APRV-371).

WHERE THEY GO IS NOT DECIDED, and this task must not assume it. Two candidates were named and neither is settled: a private approval-md-hosted repository, and bountify-ai/judgy, which Carter says is a different project. The destination is his call and it has not been made. Nothing in this task authorises an agent to read, infer or name a private repository.

What the files here say about themselves, quoted rather than interpreted: judgy/README.md opens "Source of truth is this folder; the approval.md repo only receives a copy (see Publish)", and its Publish section describes a script that "Copies this folder into ~/dev/approval-md/judgy/ and prints that repo status. It never commits or pushes". The same README refers throughout to demo/site paths and to three scripts (publish_site.sh, build_report_figures.py, feed_simulator.py), none of which exist here. So this copy is downstream of something. WHICH something is exactly the open question, and the README does not answer it: the folder it calls the source is a folder in whatever repository the README was written in.

What is here today: judgy/ holds README.md, index.html, data/ (episode.json, improvement.json and a live/ subdirectory), live/index.html and research/ (index.html plus five files under figures/), 348K in total. After deletion this repository keeps no copy, which is why the first criterion is a confirmation rather than a check an agent can run.

Two facts checked before filing, both of which narrow the work and neither of which depends on the destination. First, no release impact: judgy is absent from the files list in package.json, so no published tarball has ever carried it and removing it changes no artifact. Second, nothing in the public site points at it: index.html, features/index.html, README.md, llms.txt and llms-full.txt each contain zero occurrences of the name. The only references outside the directory are a comment in scripts/site-serve.mjs naming /judgy among the paths the dev static server serves, and historical acceptance-criteria text on APRV-387, which is a completed task and stays as written.

What the deletion costs: the site is served from the repository root behind the CNAME, so removing the directory makes approval.md/judgy return 404 for anyone holding the link from CoreWeave Hacks 2026. Whether that is acceptable, or whether the public site keeps a one-line pointer page at that path, is the decision the third criterion records, and a pointer cannot be written before the destination exists.

Division of labour. Carter decides the destination and confirms a copy lives there. The agent half is the link inventory (done, recorded above), the pointer decision written down once there is somewhere to point at, and the deletion pull request after his confirmation. All of it waits on the first two criteria.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The destination is decided and recorded here by Carter; until it is, this task stays blocked and no deletion is proposed
- [ ] #2 Carter confirms a copy of the directory lives at that destination and is at least as current as this one; no agent reads a private repository to establish it
- [ ] #3 A decision is recorded here on what approval.md/judgy serves after the deletion: nothing (404), or a pointer page, with its content if a pointer
- [ ] #4 A written inventory of every in-repository reference to the directory and what each one does after removal, including the scripts/site-serve.mjs comment
- [ ] #5 A pull request removes judgy/ and applies the recorded pointer decision, with the site verified to build and every remaining page reachable
- [ ] #6 No release artifact changes: the files list in package.json is unaffected and a packed tarball is identical in contents to the one before the change
<!-- AC:END -->
