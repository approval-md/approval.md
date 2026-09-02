---
id: DRAFT-2
title: 'Classifier: backlog status transitions emit record.write.stage'
status: Draft
assignee: []
created_date: '2026-09-02 17:01'
labels:
  - gate
  - classifier
  - design
milestone: m-12
dependencies:
  - APRV-80
references:
  - SPEC.md
  - src/core/command-class.ts
priority: low
type: enhancement
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Every backlog CLI invocation classifies files.write.workspace (the workspace-tool bucket in src/core/command-class.ts, autonomous in APPROVAL.md), so an agent marking its own task Done, or creating tasks, is ungated. SPEC section 7 defines the record.* classes (record.write.stage, record.create, record.categorize, record.archive) where grant means adoption and the gate exists for cognitive ownership rather than consequence. The right shape is a classifier refinement plus one policy line, and explicitly NOT an adapter: a Backlog.md task file holds no credential, so a section 10.4 adapter could not be a hard boundary (assessment of 2026-09-02, answering whether a pre-launch Backlog.md adapter should ship: no). Parked as a v0.2 draft because the five record.* spec tensions recorded in APRV-80 notes (no non-file envelope shape, batching vs full-payload display, identity off the local machine, re-request key reuse) are unresolved, and because it must not delay APRV-199. Policy change is the human amend ceremony, never an agent edit.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A refine function on the workspace-tool row (or a dedicated backlog row) emits record.write.stage for backlog task edit with --status naming a terminal status, and record.create for backlog task create; every other backlog subcommand keeps files.write.workspace; an unparseable argv falls to the existing class (fail closed to the stricter path)
- [ ] #2 Representative commands of each shape are pinned by classifier tests, including a status edit to a non-terminal status staying files.write.workspace
- [ ] #3 docs/claude-code-hook.md class tables list the new emits; SPEC section 7 needs no edit unless the taxonomy text is contradicted, and any divergence is called out to the human
- [ ] #4 A draft policy line for the human amend ceremony is written in the notes: record.write.stage at supervised-retro with batching per SPEC section 10.3, so the sample costs taps and the rest is retrospective
<!-- AC:END -->
