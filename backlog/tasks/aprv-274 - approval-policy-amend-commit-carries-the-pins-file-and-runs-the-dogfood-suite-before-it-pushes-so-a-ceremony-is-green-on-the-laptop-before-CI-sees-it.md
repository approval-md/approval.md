---
id: APRV-274
title: >-
  approval policy amend --commit carries the pins file and runs the dogfood
  suite before it pushes, so a ceremony is green on the laptop before CI sees it
status: To Do
assignee: []
created_date: '2026-09-05 21:15'
labels:
  - cli
  - dogfood
dependencies: []
priority: high
ordinal: 202000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The seq 23351 ceremony on 2026-09-06 took four hand steps and two red CI runs for one policy edit: the pins in src/core/policy-expectations.ts had to be fetched from a branch, built, unstaged (the verb refuses a commit carrying anything but the policy and the log), then cherry-picked onto policy-amend-<seq> by an agent after the push; and a dogfood test that assumed the values block was not yet live went red on CI. Outcome: (1) when src/core/policy-expectations.ts differs from HEAD at ceremony time, --commit includes it in the amendment commit (the pins are part of the amendment's contract, and CI's dogfood suite reads them from the same commit), with the semantic diff listing the pin changes beside the class changes; the exactly-two-files rule becomes exactly-these-files: policy, log, and the pins file when changed, nothing else. (2) Before attesting, --commit runs the dogfood suite (tests/dogfood.test.ts and the policy-suite check) against the amended file and the built pins, and refuses with a distinct code naming the failing test when red, so a red ceremony never reaches CI. (3) The verb prints the exact pin lines a new class needs when the suite reports unpinned, so the human edits one file, not a branch. Why: a policy change is the human's most common act in this repo and it should be one edit, one command, one tap.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A ceremony whose pins file changed produces one amendment commit carrying policy, log and pins; the PR is green in CI without a second push
- [ ] #2 A ceremony whose amended policy fails the dogfood suite refuses before attesting with a code naming the test, and nothing is attested, committed or pushed
- [ ] #3 An undeclared class reported as unpinned prints the exact pin lines to add
- [ ] #4 docs/cli-reference.md policy amend section and docs/dogfood-cutover.md updated; npm test passes; lint clean
<!-- AC:END -->
