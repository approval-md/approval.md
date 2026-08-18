---
id: APRV-89
title: 'README holistic pass: from changelog to front door'
status: To Do
assignee: []
created_date: '2026-08-18 11:17'
labels: []
milestone: m-11
dependencies:
  - APRV-88
priority: medium
type: docs
ordinal: 84000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The README grew ceremony by ceremony across eight milestones and is accurate (docs-guard pins its exit-code table and refusal strings) but has never had a top-to-bottom read as a newcomer would give it. This is that pass, timed for the moment the surface stops moving (after M8), and it pairs with the launch post thread in private/LAUNCH.md. Questions to answer with the rewrite: is the opening still the right pitch (the AGENTS.md-says-ask-first hook); does a quickstart belong before the ceremonies (approval init -> setup -> eval env -> doctor in ten lines); are the four ceremonies the right spine or should the MCP path be a fifth; where do the incident-lineage paragraphs live (they are the best part; keep them, place them); does Running the checks belong at the end; is the verb inventory needed or is ROOT_HELP enough. Constraints: docs-guard stays green; every command shown is copied from the built --help; the incident-grounded voice and the prose rules hold; the four SPEC pointers and the CLAUDE.md pointer survive; nothing claims more than the code does (the M7/M8 demo runs are the evidence for their ceremonies).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 README rewritten top to bottom with a quickstart, the ceremonies as spine (MCP as its own path), incident lineage kept, checks section placed; docs-guard green; every command matches --help
- [ ] #2 A newcomer read-through by the human confirms the pitch and ordering; the launch-post thread in private/LAUNCH.md points at the sections it will quote
<!-- AC:END -->
