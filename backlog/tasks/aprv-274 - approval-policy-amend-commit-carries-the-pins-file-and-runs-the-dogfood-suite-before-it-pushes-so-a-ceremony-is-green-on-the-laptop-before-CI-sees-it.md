---
id: APRV-274
title: >-
  approval policy amend --commit carries the pins file and runs the dogfood
  suite before it pushes, so a ceremony is green on the laptop before CI sees it
status: In Progress
assignee:
  - '@opus-274'
created_date: '2026-09-05 21:15'
updated_date: '2026-09-06 12:07'
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
- [x] #1 A ceremony whose pins file changed produces one amendment commit carrying policy, log and pins; the PR is green in CI without a second push
- [x] #2 A ceremony whose amended policy fails the dogfood suite refuses before attesting with a code naming the test, and nothing is attested, committed or pushed
- [x] #3 An undeclared class reported as unpinned prints the exact pin lines to add
- [ ] #4 docs/cli-reference.md policy amend section and docs/dogfood-cutover.md updated; npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. policy-expectations.ts: pinLine() for an unpinned class, a display-only pin-source reader, and the dogfood suite path constants.

2. amend.ts: planCommit learns the pins path, so exactly-two-files becomes exactly-these-files. After prepareBase the working pins are diffed against the base blob; when they moved the pins path joins the commit paths, the printed git add, the Changes section and the JSON report.

3. amend.ts: after the policy-suite check and before the attestation, run the built dogfood suite from the repo root under a TAP reporter. New code dogfood-suite-failed names the failing test; a source suite with no build output refuses the same way; a repo without tests/dogfood.test.ts skips it.

4. policy-suite-failed carries the exact pin lines to paste for every unpinned class: in the message, in the runbook steps and as an additive JSON field.

5. Rewrite the POLICY_AMEND_HELP line about EXACTLY two files in place; the constant is already at the 25-line cap, so no line may be added.

6. Tests: tests/policy-pins.test.ts for the pin line and the pin-source reader; cli-amend cases for a three-file amendment commit, a red dogfood suite refusing before the attestation, and an unpinned class printing its pin line.

7. Docs: the policy amend section of docs/cli-reference.md (file set, dogfood suite, pin lines, JSON keys) and the ceremony section of docs/dogfood-cutover.md.

8. Verify: npm run build, npm run typecheck, npm run lint, and the cli-amend, dogfood, policy-pins and cli-long-help suites.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
APRV-274 makes the amendment ceremony carry its whole contract and prove it green before it attests.

The file set. planCommit now returns a pinsArg, so exactly-two-files became exactly-these-files: policy, log, and src/core/policy-expectations.ts. After prepareBase the ceremony diffs the working pins against the commit it is BUILT ON and, when they differ, adds the pins to commitOnBase's paths, to the printed staging command, to the Changes section, to the commit subject and to the new --json pins key.

Decision, and a deliberate strengthening of AC1's wording. The task says 'differs from HEAD'; the implementation compares against the commit the amendment is parented on (origin/default, or HEAD where there is no remote and on the report-only and dry-run paths, which build nothing). Comparing against HEAD would overwrite a pins edit that reached origin after this checkout last looked, which is the hazard base-policy-diverged already exists for. A pins file the base already carries stays as the base carries it.

The suite is RUN, not reimplemented. runDogfoodSuite spawns the built tests/dogfood.test.ts from the repo root under a TAP reporter, before the attestation and after the pin check. The suite already reads the live APPROVAL.md off disk and imports the compiled pins, so it asks CI's question of the ceremony's own bytes; a second copy of those assertions inside the verb would be a second thing to keep in step.

The thing the diff will not show, and the reason the empty-run guard exists. node:test declines to run files recursively whenever NODE_TEST_CONTEXT is set: it warns, runs nothing, and EXITS 0. That variable is set for everything the test runner spawns, so the first version of the red-suite case came back green and published the whole amendment. runDogfoodSuite now strips the variable from the child environment, and separately refuses a run that exits 0 reporting no tests. The red-suite case is the regression test for both, since it runs under node --test itself.

Unpinned classes. checkPolicyExpectations resolves each unpinned class against the amended policy and attaches the exact source line to its ExpectationFailure. policy-suite-failed carries those lines in the message, in the runbook footer as copyable text, and as an additive pins.add array beside the --json error object. Nothing writes the pins file: the lines are printed, never applied.

Finishing pass: the refusal vocabulary, SPEC §11.2, and what a full `npm test` says in an agent worktree.

The union grew by exactly one member. `dogfood-suite-failed`, beside the `policy-suite-failed` it deliberately does not fold into: one is the pin check, the other is the whole of tests/dogfood.test.ts, and a ceremony told only "the pins moved" when a values-block test went red would be told the wrong thing about why it stopped.

SPEC §11.2 needs no row, and that is a finding rather than an omission. The registry covers the six gate-facing unions, and its own second paragraph (Amended APRV-215) puts a verb-local union outside them under invariant 6 alone. `AmendErrorCode` is verb-local: `commit-preconditions`, `fetch-failed`, `base-policy-diverged`, `base-log-diverged`, `policy-suite-failed`, `git-failed`, `push-rejected` and `pr-failed` have no rows there either. The amendment rows that ARE in the registry (`diff-too-large`, `proposal-not-found`, `proposal-stale`, `policy-already-attested`) belong to the gate-facing ceremony path this task does not touch. The new code is documented where its siblings are documented, in the policy amend refusal list of docs/cli-reference.md, and pinned by two cases in tests/cli-amend.test.ts (a red suite and an unbuilt one).

Carried forward, and not this task's to close: `AmendErrorCode` is a private type alias rather than an exported frozen array with a union test, which is the shape invariant 6 asks of a verb-local union. The gap predates this member and covers all nine; closing it is its own task rather than a rider on this one. Flagged here so it is written down somewhere.

Global invariants: none is touched. The new check reads and appends nothing on every arm, and it runs before the attestation, so check-then-append is exactly where it was. What it adds is deterministic (spawn a built file, parse TAP) and every state it cannot establish resolves to a refusal.

Verification in this worktree, exit codes read rather than summary blocks:
- `npm run build` exit 0, `npm run typecheck` exit 0, `npm run lint` exit 0.
- `node --test` over cli-amend, policy-pins, dogfood, cli-long-help, cli-help and docs-guard: 187 tests, 187 pass, 0 fail, exit 0. Alone: cli-amend 90/90 exit 0, policy-pins 10/10 exit 0.
- POLICY_AMEND_HELP is the same 24 lines it was. The paragraph was rewritten in place, no line added, and cli-long-help's cap holds.
- The compiled pins number 26, which is the count docs/cli-reference.md's sample transcript now prints (it said 21).

AC4's `npm test` clause is why AC4 stays unchecked. A full run here is 3647 tests, 3644 pass, exit 1, with two failures, both in files this diff never touches and both explained by the worktree rather than by the change:
- `every production dependency's engines.node admits the Node floor` (tests/ci-guard.test.ts) reads `<repo root>/node_modules/<dep>/package.json`. This agent worktree carries no node_modules of its own; Node resolves up to the primary checkout's, which is how build, lint and typecheck ran at all, but that test joins the path against its own repo root and finds nothing there.
- `control: outside the sandbox, the non-routable address times out rather than being refused` (tests/sandbox-probe.test.ts) asserts the behaviour of an unsandboxed network. This session's network is sandboxed, so the address is refused rather than timed out, which is the control failing for the reason it is a control.
Neither was re-run against a clean tree, so neither is proven pre-existing by measurement; what is measured is that both live outside the seven files this task changed. AC4's other two clauses (both documents updated, lint clean) hold on the evidence above. The box waits for a run with an install and an unsandboxed network, which is CI.
<!-- SECTION:NOTES:END -->
