---
id: APRV-231
title: >-
  Conformance vectors drift from schema fixtures without a test failing:
  regenerate for the APRV-214 gate-window fixtures and pin the check
status: In Progress
assignee:
  - 'agent:opus-lane-h'
created_date: '2026-09-02 19:18'
updated_date: '2026-09-05 08:31'
labels:
  - conformance
  - test
dependencies: []
priority: medium
ordinal: 186000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found by the APRV-211 lane on 2026-09-02: APRV-214 (PR #223) added six schema/fixtures/event/* gate-window fixtures without regenerating conformance/vectors/schema-validation.v1.json (the regen script adds about 201 lines), and nothing in npm test fails when fixtures and vectors disagree, so the frozen conformance surface can silently lag the fixtures it is meant to pin. Outcome: the schema-validation vector is regenerated for the 214 fixtures under the documented ritual (manifest version bump), and a test asserts that regenerating the vectors from the current fixtures is a no-op, so any future fixture added without the ritual fails CI with a message naming the regen command. Why: the conformance vectors are the contract other implementations test against; a vector that lags the fixtures is a contract nobody is checking.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 conformance/vectors/schema-validation.v1.json covers every fixture under schema/fixtures/event including the six APRV-214 gate-window fixtures, with the manifest version bumped per the documented ritual
- [x] #2 A test regenerates the vectors in memory from the current fixtures and fails with the regen command in its message when the committed file differs
- [x] #3 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Refactor scripts/regen-conformance-vectors.mjs: the authored inputs stay module-level; the schema suite's vectors become a function of a fixtures root; export generateConformance({ fixturesRoot }) returning the bytes of every vector file and of the manifest, writing nothing and printing nothing; the CLI entry (guarded on import.meta.url === argv[1]) keeps the writing and the log lines. conformance/run.mjs is untouched.
2. Add tests/conformance-regen.test.ts: regenerate in memory from the current fixtures and compare with the committed files and manifest digests. vectors_version is excluded from the comparison (a fixture change needs a human-chosen bump, per the ritual in conformance/README.md), except that content drift under an UNCHANGED version is reported distinctly. Every failure message names 'node scripts/regen-conformance-vectors.mjs'.
3. Cover both drift directions: a fixture added without a regen (generate from a scratch copy of schema/fixtures carrying one extra fixture, assert the drift is reported and names the new vector), and a vector edited by hand (compare the real generation with a mutated snapshot of the committed bytes).
4. AC1 is already delivered: APRV-235's merge (PR #266) regenerated schema-validation to 1.6.0 with the six APRV-214 gate fixtures. Check it on that evidence with a note.
5. npm test green, npx oxlint clean, node conformance/run.mjs still exits 0.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
AC1 was already delivered elsewhere, and is checked on that evidence rather than on work in this branch. APRV-235/237 (PR #266, merge b7ed476) regenerated conformance/vectors/schema-validation.v1.json and swept in APRV-214 six gate-window fixtures: the file is at vectors_version 1.6.0 and carries event-valid-gate-opened, event-valid-gate-closed, event-valid-gate-bypassed, event-invalid-gate-opened-agent-actor, event-invalid-gate-closed-non-integer-opened-seq and event-invalid-gate-bypassed-missing-opened-seq. Coverage of EVERY fixture (not only those six) is now proved rather than eyeballed: the new test regenerates and compares, and a fixture missing from the vectors fails it. The 1.5.0 collision and the merge rule are already written up in conformance/README.md by an earlier lane; nothing here re-versions anything.

AC2 and AC3 are this branch. Three commits on aprv-231-conformance-pin, cut from origin/main at 5053344.

fe6b264 splits scripts/regen-conformance-vectors.mjs into a generator and a writer. generateConformance({ fixturesRoot }) returns the bytes of every vector file and of the manifest and has no effects; the CLI entry (guarded on import.meta.url === argv[1]) writes them and keeps the log lines. The schema suite entry becomes a FUNCTION of a fixtures root instead of an array, so the fixtures are read when a suite is generated rather than when the module is imported, and a test can generate from a scratch copy. Manifest keys are now built with a literal "/" instead of slicing a joined path, which is the same string on posix and a portable one on Windows. Verified byte-identical: running the script after the refactor left conformance/ untouched (git status clean).

5659d86 adds tests/conformance-regen.test.ts. It regenerates in memory and reports every difference from what is committed, each message naming node scripts/regen-conformance-vectors.mjs. Both directions are covered, and the fixture direction is REAL rather than simulated: schema/fixtures is copied to a temp dir, one fixture is added there, generation runs against that root, and the drift must name event-valid-aprv-231-added-without-regen. The hand-edit direction feeds the comparison a mutated snapshot of the committed bytes (an expectation rewritten, and separately a vector dropped under a bumped version) without touching the working tree.

Design decision, per the task brief and conformance/README.md: vectors_version is NOT compared. The number is the judgement the ritual reserves for a person (a new vector is a minor bump, a moved expectation a major one, claimed at merge and not at branch), and a test that guessed would either force a bump nobody reviewed or block one somebody made. Content that moved under an UNCHANGED version is reported as its own kind (content-version-unchanged) with a sentence about the bump, since that is the shape a regeneration without the ritual takes. A version that moved on its own is not drift, and there is a test that says so; the bytes are still pinned, because tests/conformance.test.ts compares the manifest with what is on disk.

752f9b1 closes the sibling gap: the regeneration names its five schemas by hand, so a NEW schema could ship with fixtures, be covered by tests/fixtures.test.ts, and never reach the conformance suite. The generated inputs are compared with listSchemaNames(), the same source fixtures.test.ts iterates.

conformance/README.md gains a paragraph under Changing the suite: skipping the regeneration is a test failure now, and the one field the test does not compare is named with the reason.

No global invariant in SPEC 11 is touched: nothing here reads or writes the log, no gate path changes, and conformance/run.mjs is byte-for-byte unchanged (still exit 0, 279 vectors, 134 controls).

Validation, all in the worktree at /Users/carter/dev/approval-md/.claude/worktrees/lane-231:
- npm test (final, at 752f9b1): 140 files, 3396 tests, 3395 pass, 1 skipped (the pre-existing opt-in SANDBOX_PROBE_EXTERNAL leg), 0 fail, exit 0.
- node --test dist/tests/conformance-regen.test.js: 7 tests, 7 pass, exit 0.
- node --test dist/tests/conformance.test.js: 25 tests, 25 pass, exit 0.
- node conformance/run.mjs: exit 0, ok true, 279 vectors passed.
- npx oxlint src tests scripts: exit 0, no findings.
- Negative check outside the suite: dropping one vector from the committed schema-validation.v1.json on disk made the new test fail with the message naming the vector and the regen command; the file was restored with git checkout and the tree is clean.
<!-- SECTION:NOTES:END -->

## Comments

<!-- COMMENTS:BEGIN -->
author: @fable
created: 2026-09-02 22:04
---
APRV-237's conformance regen (branch claude/approval-signals-human-values-f0cf71) swept in the six APRV-214 gate fixtures this task names, so the drift half is fixed there. The 'pin the check' half (a test that fails when schema fixtures and schema-validation.v1.json disagree) is still open and stays with this task.
---
<!-- COMMENTS:END -->
