---
id: APRV-393
title: Move judgy/ out of the public repository into approval-md-hosted
status: To Do
assignee: []
created_date: '2026-09-20 01:32'
labels:
  - site
  - hosting
  - judgy
dependencies: []
priority: medium
ordinal: 303000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter ruled on 2026-09-20 that the judgy reviewer pages belong to the private hosted offering and do not ship in 0.3.0, so they come out of this repository and land in a new private repository named approval-md-hosted in the bountify-ai organisation. The 0.3.0 changelog entry for them has already been dropped (APRV-371).

What is here today: judgy/ holds README.md, index.html, data/ (episode.json, improvement.json and a live/ subdirectory), live/index.html and research/ (index.html plus a figures/ directory), 348K in total. Its own README already states that this repository holds a copy and that the source of truth is elsewhere, which is the premise this task acts on.

Two facts checked before filing, both of which narrow the work. First, no release impact: judgy is absent from the files list in package.json, so no published tarball has ever carried it and removing it changes no artifact. Second, nothing in the public site points at it: index.html, features/index.html, README.md, llms.txt and llms-full.txt each contain zero occurrences of the name. The only references outside the directory are a comment in scripts/site-serve.mjs naming /judgy among the paths the dev static server serves, and historical acceptance-criteria text on APRV-387, which is a completed task and stays as written.

What the removal costs: the site is served from the repository root behind the CNAME, so deleting the directory makes approval.md/judgy return 404 for anyone holding the link from CoreWeave Hacks 2026. Whether that is acceptable, or whether the public site keeps a one-line pointer page at that path, is the decision the first criterion records.

Division of labour. Creating the private repository and pushing the content into it is a human step and Carter owns it. The agent half is the inventory, the pointer decision written down, and the deletion pull request once the content demonstrably lives in the other repository; the deletion must not land before that is confirmed, because this repository would otherwise be the only copy that existed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A decision is recorded here on what approval.md/judgy serves after the move: nothing (404), or a pointer page, with its content if a pointer
- [ ] #2 A written inventory of every in-repository reference to the directory, the paths it serves, and what each one does after removal, including the scripts/site-serve.mjs comment
- [ ] #3 Carter confirms the content lives in approval-md-hosted under bountify-ai before any deletion is proposed, and that confirmation is recorded here
- [ ] #4 A pull request removes judgy/ from this repository and applies the recorded pointer decision, with the site verified to build and every remaining page reachable
- [ ] #5 No release artifact changes: the files list in package.json is unaffected and a packed tarball is identical in contents to the one before the change
<!-- AC:END -->
