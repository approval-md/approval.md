---
id: APRV-199
title: >-
  Release 0.1.0 through the gate: npm publish as the first release.publish
  ceremony
status: In Progress
assignee:
  - '@fable'
created_date: '2026-09-01 18:46'
updated_date: '2026-09-06 02:07'
labels:
  - release
  - dogfood
dependencies:
  - APRV-198
  - APRV-194
  - APRV-224
priority: high
ordinal: 165000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Every SPEC section 14 milestone (M0 to M8) has shipped, package.json already reads 0.1.0, and the log verifies clean. The launch itself is one action in the release.publish class (manual in the repo policy): npm publish, run from the primary checkout through the envelope flow (approval register, request, wait, run) with the granted sealed token, so the first public release of approval.md is approved via approval.md. The same grant is a real manual-class action and doubles as the end-to-end sealed-delivery proof APRV-166 AC3 still needs. This task carries the preconditions a stranger installing the package would notice; the decision to run it is the human operator's.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Preflight recorded: npm pack --dry-run contents reviewed (files and bin fields; no .approval, backlog, or private material shipped), README front page current, LAUNCH.md or CHANGELOG carries the 0.1.0 line
- [ ] #2 Envelope on this task: register, request, wait, run for npm publish from the primary checkout; grant seq and execution seq recorded in the notes; no human relayed a token (APRV-166 AC3 evidence)
- [ ] #3 v0.1.0 tag pushed through its own gated action and the package installs on a clean machine under the published name; verified and recorded
- [ ] #4 The human decides go or no-go; the agent prepares and never triggers the publish
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Preflight (AC1, agent work): package.json files whitelist reviewed (cli.js, dist, schema, docs/cli-reference.md, SPEC.md, README.md; no .approval, backlog, .claude, journal or proposals ship; no .npmignore needed); npm pack --dry-run is unclassified by the hook, so the whitelist is the evidence and Carter runs the dry-run once by hand before the tap. Write CHANGELOG.md with the 0.1.0 line. README front page gains the values/feedback verbs (APRV-237..240) so the shipped surface is current.
2. Ride the aprv-276-278 stack: APRV-276 (drift check before token spend), APRV-277 (runbook PATCH, listener 400), APRV-278 (ambient-bleed false positive) land in the same PR so there is one merge before the publish.
3. AC2-AC4 are Carter's: envelope on this task, register/request/wait/run npm publish from the primary through the gate, tag v0.1.0 through its own gated action, install on a clean machine, go/no-go.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Preflight (fable, 2026-09-06, branch aprv-276-278-agentmail-release-stack): package.json ships by whitelist only (cli.js, dist, schema, docs/cli-reference.md, SPEC.md, README.md), no .npmignore needed; .approval, backlog, .claude, .approval-journal and docs/proposals cannot ship. npm pack --dry-run is unclassified by the hook for an agent, so Carter runs it once by hand before the tap and pastes the file list. CHANGELOG.md created with the 0.1.0 line (unreleased until the tag). README front page gains a section on approval values / approval feedback; tests/docs-guard passes. Riding the same PR as APRV-276/277/278 so one merge precedes the publish.
<!-- SECTION:NOTES:END -->
