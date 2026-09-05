---
id: APRV-269
title: >-
  README dictionary is stale: autonomy levels, doctor row count, protected_paths
  object form and the classes added this week
status: In Progress
assignee: []
created_date: '2026-09-05 15:59'
updated_date: '2026-09-05 16:14'
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
- [x] #1 Every top-level policy key and every classes.<pattern> field in schema/policy.schema.json has a dictionary row naming its default; the autonomy row lists the schema's enum verbatim
- [x] #2 A docs-guard test derives the autonomy list from the schema enum and the doctor row count from the doctor row list and fails when the README disagrees
- [x] #3 The running-the-checks section's doctor description matches the current row count and names the rows that skip on a fresh directory
- [ ] #4 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read schema/policy.schema.json for every top-level key and every classes.<pattern> field, and tests/cli-doctor.test.ts for the ordered doctor row list.
2. Run approval init + policy attest + doctor in a scratch directory to get the real row count, tally and skip set rather than deriving them from prose.
3. Rewrite the README dictionary: one row per key, each naming its default or what an absent key means; add defaults.token_delivery, classes.<pattern>.live_rate, classes.<pattern>.retro_rate, protected_paths[].path and protected_paths[].class.
4. Carry the six autonomy levels into the 'Pick an autonomy' step and the classes.<pattern>.autonomy row, verbatim from the schema enum, with live_rate named beside supervised-live.
5. Describe files.delete.scratch and vcs.remote.meta where the README shows the classifier, and the policy.edit sub-classes where it discusses protected paths.
6. Give 'Running the checks' doctor's 25 rows and the 15 that skip on a fresh directory, and fix the install section's count and tally.
7. Move the doctor roster to tests/doctor-rows.ts so one list feeds cli-doctor and docs-guard; add docs-guard tests deriving the autonomy list from the schema enum, the row count and skip names from that roster, and the dictionary's key coverage from the schema's properties.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Done on branch readme-dictionary-refresh, commit ce3d7d5 (cut from origin/main 51178b9, then merged origin/main again so PR #293's two classes are covered as they landed).

WHAT WAS STALE, AND WHAT IT IS NOW
- classes.<pattern>.autonomy listed three levels (manual, supervised, autonomous). The schema's $defs.autonomy.enum admits six. The row and the 'Pick an autonomy for each' step now carry all six, strictest first, with supervised named as the pre-split alias of supervised-retro and live_rate named beside supervised-live.
- doctor was described as eleven lines with a '6 ok / 4 not applicable / 1 failed' tally. It emits 25 rows. The numbers were not guessed: approval init + policy attest + doctor were run in a scratch directory (the scaffolded policy's attested sha256 cff55216... still matches the one the README prints, so the three sample lines stayed valid) and the tally it printed, 9 ok / 15 not applicable / 1 failed, replaces the old one.

ROWS ADDED: defaults.token_delivery (manual/sealed, default manual, APRV-105); classes.<pattern>.live_rate (required on supervised-live, refused elsewhere, APRV-127); classes.<pattern>.retro_rate (optional on the supervised levels, absent means the global rate, APRV-183); protected_paths[].path and protected_paths[].class (the APRV-266 object form, the four reserved policy.edit sub-classes, the protected-route-floor refusal).

ROWS CORRECTED: every row now names its default or says what an absent key means, which several did not. audit.supervised_sample_rate is now stated as the FALLBACK rate for classes declaring no retro_rate. classes.<pattern>.approvers said nothing about absence; it now says absence restricts nobody and names actor-not-approver, which is what core/gate.ts does rather than what the schema implies. channels.telegram.delivery gained APRV-216, the prompt rows gained APRV-218 and prompt-row-required, checkpoint_keys and checkpoint_every gained their skip/off semantics.

CLASSES ADDED THIS WEEK: files.delete.scratch and vcs.remote.meta are described where the README shows approval hook classify, including the two limits that matter to a reader (everything not provably scratch keeps files.delete.out_of_scope; any gh flag naming another repo or host falls back to today's class). The policy.edit sub-classes appear in the protected-paths step, the dictionary and the 'Can't the agent just go around it?' answer.

THE GUARD (AC #2). The doctor roster moved from an inline literal in tests/cli-doctor.test.ts to tests/doctor-rows.ts, comments and append-only discipline intact, exported as DOCTOR_ROW_ORDER plus DOCTOR_FRESH_SKIPS. cli-doctor.test.ts asserts a healthy run against it; docs-guard.test.ts derives from it. Three new docs-guard tests: (1) every level in $defs.autonomy.enum is named in the README and the spelled-out count matches; (2) the README states the row count, the skip count and every skip row name, and its sample tally sums to the roster length with a 'not applicable' figure equal to the skip set; (3) every top-level schema property and every classRule field has a dictionary row, so the next key added to the schema fails this test rather than shipping undocumented.

NOT DONE, FOR THE REVIEWER: AC #4's 'npm test passes' was not run in full. This lane ran docs-guard (16 pass, exit 0), cli-doctor (55 pass, exit 0) and ci-guard (31 pass, exit 0), plus npx oxlint on the three touched .ts files (exit 0) and npm run build (exit 0, which is the typecheck). The change touches tests/cli-doctor.test.ts, so it takes the full CI tier; the full matrix has not been observed locally.

ALSO NOTICED, NOT FIXED: src/cli/help.ts's DOCTOR_HELP still says 'Twelve checks' and lists twelve of the 25. That is a source string with its own cli-help test, outside a docs lane's scope.
<!-- SECTION:NOTES:END -->
