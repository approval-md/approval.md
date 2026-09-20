---
id: APRV-407
title: >-
  Site moves out of the repo root: site/ directory deployed to Pages by a
  workflow, so APPROVAL.md and SPEC.md sit beside the code and nothing else
status: To Do
assignee: []
created_date: '2026-09-20 18:53'
labels:
  - site
  - hygiene
  - ci
dependencies: []
references:
  - >-
    https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site
documentation:
  - private/README.md
priority: medium
ordinal: 315000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter directs people to the repository and the core files (APPROVAL.md, SPEC.md, README.md, AGENTS.md) sit among icons and share images. Pages serves main at path /, which is why they are there. Root inventory on 2026-09-20: served-site files index.html, CNAME, .nojekyll, site.webmanifest, favicon.ico, favicon.svg, apple-touch-icon.png, icon-192.png, icon-512.png, og-image.png, llms.txt, llms-full.txt, plus the served directories brand/, features/, rsi/, judgy/, hosted/policy-builder/; and a tracked .DS_Store that should never have been committed. Published URLs that must keep resolving: approval.md/ (index), /features/, /rsi/, /judgy/ and its live and research panes, /schema/*.schema.json (the six schema $id values in schema/ point at approval.md/schema/), /llms.txt, /llms-full.txt, /og-image.png (referenced by CHANGELOG.md and rsi/index.html), /site.webmanifest and the icons. Not a Pages dependency: the README agent-hours badges read raw.githubusercontent.com, and no tracked file links approval.md/docs/. Chosen shape: a site/ directory holding everything served, a scripts/build-site.mjs that assembles _site/ from site/ plus schema/ (schemas stay where the code and tests read them, copied at deploy), and a Pages deploy workflow (pages.yml in the GitHub workflows directory) using the upload-pages-artifact and deploy-pages actions with the Pages source switched to GitHub Actions. Sequence that keeps the site up throughout: (1) land the workflow and the build script while the script still reads from the current root paths, Carter switches the Pages source to GitHub Actions in repository settings and confirms approval.md renders unchanged; (2) git mv the files into site/, point the script at site/, land it; the URLs do not change. Two steps are Carter hands: the workflow file classifies policy.edit.ci (manual; the APRV-396 hunks timed out on the gate overnight, so a hand commit or a live tap), and the Pages source setting is a repository setting. Moving the source to a /docs folder was considered and rejected: it collides with the prose docs living there and needs every relative link rewritten. A moved file makes nothing private; the public-repo rule from private/README.md still applies to everything tracked. Classifier note: the first attempt to file this task was itself classified policy.edit.ci because the command text spelled the workflows directory path; the classifier matched argument text, not the write target.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Every served file listed in the description lives under site/ and the repo root holds only code, config and the governing documents (README, SPEC, APPROVAL, AGENTS, CLAUDE, CHANGELOG, CONTRIBUTING, GOVERNANCE, LICENSE, NOTICE, MILESTONES, package files, tsconfig, cli.js)
- [ ] #2 scripts/build-site.mjs assembles _site/ from site/ and schema/, is idempotent, and a test asserts every path in the published-URL list above exists in its output
- [ ] #3 The Pages workflow deploys _site/ on push to main with the minimal permissions (contents read, pages write, id-token write) and no other secret; the CI classifier still runs unchanged
- [ ] #4 After cutover, curl of approval.md/, /features/, /rsi/, /judgy/, /schema/event.schema.json, /llms.txt, /og-image.png and /site.webmanifest each return 200 with the same bytes as before the move, and the custom domain stays bound
- [ ] #5 .DS_Store is untracked and gitignored
- [ ] #6 README.md and docs say where the site lives and how it deploys, and the CLAUDE.md permissions summary notes that site/ edits are ordinary source edits
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Carter has switched the Pages source to GitHub Actions and confirmed the site renders before the move PR merges
<!-- DOD:END -->
