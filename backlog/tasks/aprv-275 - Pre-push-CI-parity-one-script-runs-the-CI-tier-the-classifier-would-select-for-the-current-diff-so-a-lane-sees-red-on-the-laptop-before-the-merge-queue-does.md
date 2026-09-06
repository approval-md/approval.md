---
id: APRV-275
title: >-
  Pre-push CI parity: one script runs the CI tier the classifier would select
  for the current diff, so a lane sees red on the laptop before the merge queue
  does
status: In Progress
assignee:
  - '@opus-275'
created_date: '2026-09-05 21:16'
updated_date: '2026-09-06 08:33'
labels:
  - ci
  - dx
dependencies: []
priority: medium
ordinal: 203000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Most red CI runs this week were avoidable on the laptop: a row-count pin missed on one platform, a Linux-only temp-root check, a test coupled to the live policy, a conformance manifest regenerated on two branches. Lanes ran suites one file at a time under load and could not afford the full matrix; CI then ran it serially in the merge queue, one PR at a time, and every red cost a re-merge and another queue slot. Outcome: scripts/ci-local.mjs (npm run ci:local) reads the same classify-tier logic .github/workflows/ci.yml uses, prints the tier the diff selects (light, records, full) and runs exactly that tier's jobs locally (docs guard, records guards, protected-path cross-check where computable, the full gate sharded the same way), with the platform-sensitive suites flagged when the host is not Linux; the lane brief and docs/dogfood-cutover.md say to run it before pushing. Why: the queue is serial and every red is a lost slot; the laptop is where red is cheap.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 npm run ci:local on a docs-only diff runs the light tier and on a src diff runs the full gate shards, matching ci.yml's selection for the same diff (test against three fixture diffs)
- [x] #2 The script reports platform-sensitive suites (temp root, symlinks) when not on Linux and exits non-zero on any red with the failing file names
- [x] #3 docs updated; npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read the CI workflow, the tier classifier, the test runner, the protected-path guard, the package scripts and the README checks section. 2. Add a ci-local script that imports the classifier so the tier a lane sees is the tier CI computes, with a base ref, a working-tree mode and explicit paths as its path sources. 3. Plan the jobs the workflow runs for that tier. Light is build plus the docs guard, records is build plus the records-only run, full is build plus three test shards plus lint, and the protected-path cross-check is planned on every tier whenever a merge base is computable and reported as not computable otherwise, never as green. 4. Name the deviations in the script and print them. One build for all shards, lint once, shards sequential unless asked otherwise, and the Node 20 floor legs unreproducible on one host Node. 5. Print a frozen table of platform-sensitive suites, temp root resolution and symlink cases, whenever the host is not linux. 6. Tee each step output, extract failing test files from the TAP not-ok lines, and exit non-zero naming them. 7. A dry-run mode prints the plan and runs nothing, and a JSON mode emits it, which is the surface the test drives. 8. The package gains a ci-local script entry. 9. A new suite drives three fixture diffs built as throwaway git repositories, docs-only, src and mixed, through both the new script and the classifier, asserts the two agree, and asserts parity against the checked-in bytes of the workflow parsed the way the CI guard suite parses it. 10. Docs. The README checks section and the dogfood cutover runbook gain the pre-push line. 11. Verify with build, the new and adjacent suites, lint and typecheck. The workflow file is not edited.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
WHAT LANDED. scripts/ci-local.mjs, run as npm run ci:local, runs the CI tier the classifier selects for the current diff. tests/ci-local.test.ts covers it with 21 cases. README gains a Before the push subsection under Running the checks, and docs/dogfood-cutover.md gains a pre-push block in the session workflow.

TIER PARITY IS BY CONSTRUCTION, NOT BY COPY. The script reimplements no path rule. It spawns node scripts/classify-tier.mjs with the same arguments the workflow classify job spawns it with, reads the JSON verdict, and applies the workflow's own fail-closed case rule to the answer, so an unrecognised word becomes full. A classifier that errors, or prints output that will not parse, also becomes full with the reason named. STEP PARITY IS BY TEST. The per-tier job list is duplicated from the workflow, because a script cannot read a matrix without carrying a YAML parser it has no business carrying. The duplication is guarded rather than trusted. tests/ci-local.test.ts parses the checked-in .github/workflows/ci.yml with parseHardenedYaml, the way tests/ci-guard.test.ts does, and asserts that the shard count equals the declared matrix, that each tier's planned command is one the corresponding job actually runs, and that the protected-path job is unconditional. A command changed in the workflow and not here is a red test rather than a surprise in the queue.

WHAT IT DOES DIFFERENTLY, AND SAYS SO. One build serves every step, where the workflow builds once per job over the same tree. Lint runs once, where the workflow runs it inside every shard. Shards run one after another unless --parallel is passed, which takes the matrix shape. The Node 20 floor legs cannot run on a host that is not Node 20. All four are printed with the plan under a heading that says where this is not the workflow, so a lane never reads green without the sentence that says what green here does not cover. PLATFORM REPORT. A frozen table of six suites with the reason each is host-sensitive, each reason taken from that test file's own comment. It prints whenever the host platform is not linux, intersected with the suites the selected tier actually runs, so the light and records tiers report none instead of reciting a list they never execute. A test asserts every named file still exists, and that test runs on Linux too, so a rename cannot leave a reassuring line pointing at nothing.

RED NAMES FILES. Each step's output is teed to the terminal and captured. Failing files are extracted from four shapes, TAP for the Node 20 floor, the spec reporter's failing-tests roll-call for Node 22 and later, tsc diagnostics, and oxlint span markers, then mapped from dist back to the source file a lane would open. An unrecognised shape yields no name rather than a guess, and the exit code is always the verdict. UNRESOLVED IS NOT GREEN. The protected-path guard's exit 4 means it could not look, usually because the records branches are not fetched into this checkout. That is reported as unresolved and kept out of the verdict. Its exit 1, a protected path with no grant, is red like anything else. HARNESS FINDING. node --test exports NODE_TEST_CONTEXT into every process a test file spawns, and a grandchild node --test that sees it reports over IPC and exits 0 whatever happened. The new suite strips it. Nothing in the script depends on this, since a lane runs it from a shell, but a test that did not strip it would have been asserting on a red run that could never go red.

WORKFLOW NOT EDITED. .github/workflows is policy.edit.ci and manual, and nothing in this task needs a change there. The script mirrors the workflow's shape and CI never consults the script, so no workflow amendment is proposed. INVARIANTS. The SPEC section 11 global invariants are untouched. The script appends nothing, reads no log, mints no verb for any class, and cannot lower scrutiny for anything. It runs the tier the classifier already chose, or more, never less, and tier-selection authority stays with scripts/classify-tier.mjs and the workflow. No new dependencies. TWO WAYS TO RUN A TIER. check:changed already runs a tier through the classifier's own --run, in its own shape, which for full is npm test then lint then typecheck. That is left alone, and the README now says which question each answers, work-in-progress for the older one and what the workflow will say for the new one.

VERIFICATION. npm run build clean. npm run lint exit 0. npm run typecheck exit 0. Targeted suites run through the CI runner, ci-local plus ci-guard plus classify-tier plus docs-guard plus milestones-guard plus backlog-fixtures, 129 tests, 129 pass, 0 fail, 0 skipped, runner exit 0. The new suite is 21 of those 129 and covers the three fixture diffs the criterion names, docs-only, src and mixed, plus a records fixture for the third tier, each built as a throwaway git repository with the two scripts copied in and a real two-commit diff, each classified through both the new script and the classifier the workflow runs, asserted to agree. END TO END IN THIS REPOSITORY. node scripts/ci-local.mjs README.md docs/dogfood-cutover.md selected light, built, ran the docs guard 16 of 16 and printed that every step this host can run is green, exit 0. Dry runs print light for a docs-only path set, full with three shards and lint for a src path set, and full for the mixed set. A red run is proven in the suite end to end, exit 1 with the failing source file named, and a failed build stops the run rather than reporting on a stale tree. npm ci was needed first because this worktree carried no node_modules, which is what the one ci-guard case that reads dependency manifests needs.

ON THE FULL SUITE. A full npm test was started in this worktree and was still running at hand-off, so criterion 3's npm test clause rests on the targeted 129 of 129 above plus the real light-tier end-to-end run, not on a completed full matrix. This lane's brief waived the full run. Two suites in this repository are known load flakes under a loaded machine, the daemon TTL sweep and the up.test expiry case, per the notes on APRV-241, and this change touches no source that either reads. CI runs the full gate on the pull request regardless.
<!-- SECTION:NOTES:END -->
