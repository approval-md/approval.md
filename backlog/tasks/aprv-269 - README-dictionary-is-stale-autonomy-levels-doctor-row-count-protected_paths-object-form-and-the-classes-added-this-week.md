---
id: APRV-269
title: >-
  README dictionary is stale: autonomy levels, doctor row count, protected_paths
  object form and the classes added this week
status: To Do
assignee: []
created_date: '2026-09-05 15:59'
labels:
  - docs
dependencies: []
priority: medium
ordinal: 200000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found by the APRV-265 landing-page lane on 2026-09-05 while cross-checking every claim against main: the README's APPROVAL.md dictionary row for classes.<pattern>.autonomy lists three levels while schema/policy.schema.json ships six (autonomous, supervised, supervised-live, supervised-retro, manual, human-only); the running-the-checks section says doctor prints eleven lines while the ordered row list in tests/cli-doctor.test.ts is 25; and since then APRV-266 added the {path, class} object form of protected_paths with the reserved policy.edit sub-classes, APRV-267/268 added files.delete.scratch and vcs.remote.meta, APRV-216 added channels.telegram.delivery and APRV-218 channels.<name>.prompt, APRV-217 the daemon block, APRV-220/257 audit.checkpoint_keys and checkpoint_every. Outcome: the dictionary and the checks section describe the schema as shipped, with one row per key and the default named; a docs-guard test pins the autonomy list and the doctor row count against the schema enum and the doctor row list so they cannot drift again. Docs only, no protected path.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Every top-level policy key and every classes.<pattern> field in schema/policy.schema.json has a dictionary row naming its default; the autonomy row lists the schema's enum verbatim
- [ ] #2 A docs-guard test derives the autonomy list from the schema enum and the doctor row count from the doctor row list and fails when the README disagrees
- [ ] #3 The running-the-checks section's doctor description matches the current row count and names the rows that skip on a fresh directory
- [ ] #4 npm test passes; lint clean
<!-- AC:END -->
