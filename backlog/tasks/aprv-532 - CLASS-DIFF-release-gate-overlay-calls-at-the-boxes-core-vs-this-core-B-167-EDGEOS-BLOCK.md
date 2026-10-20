---
id: APRV-532
title: >-
  CLASS-DIFF release gate: overlay calls at the boxes' core vs this core (B-167,
  EDGEOS-BLOCK)
status: In Progress
assignee: []
created_date: '2026-10-20 11:10'
updated_date: '2026-10-20 13:33'
labels:
  - release
  - ci
  - edgeos-block
dependencies: []
references:
  - approval-md#663
priority: high
ordinal: 405000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Lead ruling CLAIMS L15681 (1), Carter P0: a core version reaches boxes only after a conformance check classifies the whole shipped overlay corpus at the candidate core and the GATE line carries the class-diff (every call whose class changes); an existing recipe flipping auto -> human-only (or to a deny) is blocking. Builds on APRV-530 D (approval.md#663): extends scripts/overlay-recipes-check.mjs with --diff and the overlay-recipes CI job; the overlay runs the same script at its pin (Edge-City/agentvillage companion PR).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 --diff <baseline core> classifies the same corpus (recipes + template tools lines) at both cores and reports every call whose class, decision or card style moves
- [ ] #2 An existing call moving from auto/sampled/card to human-only/refused fails, unless the allowlist names it with a reason (optional flip narrows it)
- [ ] #3 New calls (with --baseline-corpus) are reported, not gated
- [ ] #4 The overlay-recipes job re-extracts the corpus at its pinned overlay sha and fails on drift, installs the boxes' core from npm at pinned integrity, and publishes markdown + JSON report
- [ ] #5 Fixture tests: a flip fails, a stay passes, a new recipe is reported; 0.4.5 -> 0.4.6 on overlay 99d33417 shows the eleven EdgeOS flips
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Fold 1 (review-b refute 3M/4S/4N): the diff and a new absolute box check run every call through each core's real approval hook hermes in a box layout (scripts/overlay-recipes-box.mjs): recipes at HERMES_HOME, HOME, workspace, unset; harness calls as Hermes envelopes (core tools + every tools line); shadowed tools lines block. S-4: any loss of autonomy on an existing call blocks. M-3: allowlist entries need accepted_by/accepted_at (Carter), trivial reasons refused, ci.yml pins the gate files by sha256 and the corpus count, base-branch extractor. Proposed for Carter (not done: agents may not edit APPROVAL.md): protected_paths entries for scripts/overlay-recipes*. A hook run exiting 0 without an allow line is an error (found: a symlinked tmpdir made the CLI skip main). Allowlist entries ship unaccepted, so the job is red until Carter accepts them.
<!-- SECTION:NOTES:END -->
