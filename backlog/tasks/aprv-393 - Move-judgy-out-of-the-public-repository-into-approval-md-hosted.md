---
id: APRV-393
title: >-
  Remove judgy/ from the public repository; the archive is git history at
  49574e4d and /judgy returns 404
status: In Progress
assignee:
  - '@claude-nonav'
created_date: '2026-09-20 01:32'
updated_date: '2026-10-17 02:26'
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
- [x] #1 The destination is decided and recorded here by Carter; until it is, this task stays blocked and no deletion is proposed
- [x] #2 Carter confirms a copy of the directory lives at that destination and is at least as current as this one; no agent reads a private repository to establish it
- [x] #3 A decision is recorded here on what approval.md/judgy serves after the deletion: nothing (404), or a pointer page, with its content if a pointer
- [x] #4 A written inventory of every in-repository reference to the directory and what each one does after removal, including the scripts/site-serve.mjs comment
- [x] #5 A pull request removes judgy/ and applies the recorded pointer decision, with the site verified to build and every remaining page reachable
- [ ] #6 No release artifact changes: the files list in package.json is unaffected and a packed tarball is identical in contents to the one before the change
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Decision (Carter, 17 Oct 2026, relayed by the claude-nonav lead as D-8): the archive is this repository's own git history at 49574e4d (the last commit that touches judgy/; its judgy tree f031c2b5 is byte-identical to origin/main's), judgy/ is deleted, and approval.md/judgy returns 404 with no pointer page.

1. git rm -r judgy/ (13 tracked files, judgy/.nojekyll included).
2. Remove the in-repository references that would dangle: the judgy research card in approved/index.html (an absolute https://approval.md/judgy/research/ link), the judgy/README.md link in docs/README-extended.md, and /judgy in the scripts/site-serve.mjs header comment. The wandb.ai/bountify/judgy links in approved/index.html point at an external W&B project, not at this path, and stay.
3. Leave historical text alone: completed tasks (APRV-371, APRV-387), .approval/ log and payloads (never edited by agents).
4. CHANGELOG Unreleased entry naming the archive sha.
5. Verify: npm pack --dry-run file list identical before and after; every remaining page served by scripts/site-serve.mjs answers 200 and /judgy/ answers 404 locally; the tier gate.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Decisions recorded (AC1, AC3): Carter, 2026-10-17, relayed by the claude-nonav lead as D-8 of APRV-decisions-batch.md. Destination: this repository's own git history. Archive commit: 49574e4da169f6b3f2e44fa4f67dbd1a7048ca20 (49574e4d, APRV-387), the last commit on main that touches judgy/. What approval.md/judgy serves afterwards: nothing (404), no pointer page. No private repository was read.

AC2 evidence: `git diff --quiet 49574e4d origin/main -- judgy/` exits 0, and `git rev-parse 49574e4d:judgy` equals `origin/main:judgy` (tree f031c2b5bc45b9442262fc1bc64c27713ef10dda), so the archive is byte-identical to the deleted copy. 49574e4d is an ancestor of origin/main 801684f9. Recover with `git checkout 49574e4d -- judgy/` or `git archive 49574e4d judgy`.

AC4 inventory, every in-repository reference outside judgy/ and what each does after removal:
- approved/index.html, card linking https://approval.md/judgy/research/: removed (it would 404).
- approved/index.html, five links to wandb.ai/bountify/judgy (nav, a card, two Weave calls): kept; they point at an external W&B project, not at this path.
- docs/README-extended.md:743-745, table row linking ../judgy/README.md and a sentence on judgy's pages: row narrowed to hosted/, sentence replaced with a pointer to the archive commit. This file ships in the npm package (see AC6).
- scripts/site-serve.mjs header comment naming /judgy: removed from the list.
- backlog/tasks/aprv-407 AC4 lists /judgy/ among paths that must return 200 after the site move: NOT edited here (another task's criteria); it is stale after this lands and needs a human or that task's owner to drop /judgy/.
- backlog/completed/aprv-371 and aprv-387: historical, left as written.
- .approval/log/events.jsonl and .approval/payloads/: the daemon's records, never edited by agents.

What makes approval.md/judgy 404: GitHub Pages for approval-md/approval.md is build_type legacy, source branch main path / (gh api repos/approval-md/approval.md/pages, read 2026-10-17). GitHub's own pages-build-deployment runs on every push to main, so the merge of this PR is the deploy; nobody deploys by hand. There is no 404.html at the root, so GitHub serves its default 404 page. No redirect config exists (no _redirects, vercel.json, netlify.toml or Pages workflow). Live before the merge, 2026-10-17T01:05Z: approval.md/judgy/ and /judgy/research/ answered 200.

AC5 evidence (local): scripts/site-serve.mjs on the branch answers 200 for /, index.html, features/, rsi/, approved/, approved/slides.html, hosted/policy-builder/, llms.txt, llms-full.txt, site.webmanifest, og-image.png and schema/event.schema.json, and 404 for judgy/, judgy/research/, judgy/live/. A scan of every href/src in the remaining site HTML found 0 same-site links that no longer resolve. The site has no build step (static files served from the root).

AC6, OPEN for a ruling: `npm pack --dry-run --json --ignore-scripts` before and after lists the same 942 paths and judgy contributes none (it was never in package.json files). The one content difference is docs/README-extended.md (75718 to 75661 bytes), the dangling-link removal above, which the build brief asked for. AC6's literal wording ("identical in contents") is therefore not met. Either accept that the deletion itself changes no artifact and check AC6, or drop the README-extended.md hunk from this PR (its link to ../judgy/README.md was already dead inside the tarball, which never carried judgy/).

Fix round 1 (refute M1, N4): the CHANGELOG Site entry no longer says the package contents are unchanged. It now says the packed file list is unchanged (942 paths, re-checked with npm pack --dry-run --json --ignore-scripts) and that docs/README-extended.md, which ships in the package, drops judgy from its directory table. The README-extended.md hunk stays. AC6 is deliberately left UNCHECKED for Carter: its literal wording (a packed tarball identical in contents) is not met by that one file, and whether that hunk satisfies AC6 as intended is his ruling, not the build's. Title updated to the decided outcome (D-8).
<!-- SECTION:NOTES:END -->
