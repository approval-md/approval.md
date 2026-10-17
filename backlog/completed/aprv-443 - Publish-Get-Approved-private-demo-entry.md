---
id: APRV-443
title: Publish Get Approved private demo entry
status: Done
assignee:
  - '@codex'
created_date: '2026-09-30 09:33'
updated_date: '2026-09-30 10:40'
labels: []
dependencies: []
ordinal: 337000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Publish the reviewed Approved hackathon entry at /approved with one-click access to its private browser demo. Runtime and gateway implementation are tracked by HOSTED-22 in approval-md-hosted and live in bountify-ai/approved.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Get Approved appears before the deck and policy builder and opens the verified dedicated demo origin in a frame.
- [x] #2 Existing deck, policy builder, screenshots, and live proof remain available; desktop and mobile entry layouts are verified.
- [x] #3 Required local CI and GitHub checks pass, the PR is merged, and the published URL is verified.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Copy only the reviewed site entry from the Approved application checkout after confirming its existing proof section is preserved. 2. Run the full local CI tier selected for approved/index.html. 3. Publish after runtime adversarial review and live deployment verification, then verify the actual entry URL and existing links.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Prepublication evidence (2026-09-30): PR #559 head 74c7a40 changes approved/index.html only under approved/. The existing It ran live proof section is byte-identical to origin/main; approved/slides.html and both live-gate/live-judge PNG Git object IDs are unchanged. Parent browser checks at desktop 1280 and mobile 390x844 verified the entry layout; live slides navigation advanced 1/17 to 2/17; the policy builder approver edit generated an updated policy. Criterion #2 is satisfied before publication. Criterion #1 awaits the published entry and dedicated iframe verification; #3 awaits queued checks, merge, and published URL verification. Site PR #559 PR CI passed, while queued full Node 20/22 run 36700287805 was still running at handoff. App PR #20 merged as b008a086; the public gateway and private demo have separate live evidence in HOSTED-22. Do not mark the site published yet.

Local records-tier check on the current task-only working tree: node scripts/ci-local.mjs --working-tree, exit 0; npm run build exit 0 and records guards 28/28 pass. This macOS Node 26 run does not replace GitHub Node 20 or protected-path checks. Rerun the same command after final task notes or criteria updates, then record the final exit and queue/published evidence.

Publication verification (2026-09-30; supersedes the prepublication pending statements above): Site PR #559 was merged at a2a057dde2b5d33cf63c0985ec6cb570e7008a3d after site PR CI, the required queue, and Pages checks passed. The live https://approval.md/approved/ HTML SHA-256 is 67734cf297a19a221ebfd045ad59081e81b09efed30ce64f2174cc5a09c39908, identical to merged approved/index.html. The entry places Get Approved before deck and policy-builder links and opens the dedicated https://approved-demo-gateway.vercel.app/ origin in an iframe. Parent verified the public entry at desktop width 1280 and mobile 390 with no overflow; the published deck, policy builder, screenshots, and It ran live proof remain available. In the public iframe, one click automatically started private run t628e112d59. It completed with read allowed, main rejected, branch approved, force rejected, three live advisories, follow verified, and 12 clean log records; no console errors. Embedded mobile outer 390/content 390 and inner 312/content 312. Runtime/gateway delivery is tracked separately by HOSTED-22: gateway 5e369a9 deployed as dpl_3PV2CoJN7gkfjY7QMSrdWQxiB1Dr; runtime follow-up PR #21 passed all five checks and merged as 3c8afc3d3271514d3bc3ffb46e5f8be417c9644a. This task records the completed site publication only.

Final records-tier verification on branch codex/get-approved-entry-records after publication notes and criteria were recorded: node scripts/ci-local.mjs --working-tree selected records tier, build exit 0, records guards 28/28 pass, overall exit 0 (macOS Node 26.8.2). GitHub CI and queue were verified separately for the merged site PR.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Published the Get Approved entry at /approved with a verified one-click private demo frame. Site PR #559 merged; required checks and Pages passed; live HTML matches merged source by SHA-256. Desktop/mobile entry and existing deck, policy builder, screenshots, and live proof were verified.
<!-- SECTION:FINAL_SUMMARY:END -->
