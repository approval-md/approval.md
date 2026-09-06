---
id: APRV-284
title: The daemon's records PR arms its own merge
status: In Progress
assignee:
  - '@opus-284'
created_date: '2026-09-06 07:19'
updated_date: '2026-09-06 12:10'
labels:
  - daemon
  - records
dependencies: []
type: enhancement
ordinal: 210000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
approval log advance --pr and the daemon's advance cadence open or update a records-log-<date> PR and stop there; it sits at CLEAN until a person clicks or a session runs gh pr merge --auto. Records commits carry only the log, queue and payloads, are exempt from the protected-path guard, and are the one PR shape that never needs review, so arm auto-merge when the PR is created (gh pr merge <n> --auto --merge, or the API equivalent), classified vcs.push.main exactly as a session's arm is. The advance verb's output names whether the merge was armed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 approval log advance --pr arms auto-merge on the PR it opens or updates, and says so; a flag disables it
- [x] #2 The daemon advance path does the same; tests cover the armed and the disabled cases against a mocked gh
- [x] #3 docs/cli-reference.md log advance section and CLAUDE.md workflow item 7 mention it
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. cli/log-advance.ts: LogAdvanceOptions gains `autoMerge?: boolean` (default true, only consulted when `pr` is true). `ghPullRequest` gains the arm: after list/create it runs `gh pr merge <recordsBranch> --merge --auto` in cli/amend.ts's `armAutoMerge` shape (same argv order, same tolerance: an arm gh says no to is reported, never a refusal of the verb — the advance is committed, pushed and the PR is open either way).
2. Guard before the arm. The task's whole rationale is that a records commit carries only the log, QUEUE.md and .approval/payloads/, so before arming, diff the pushed commit against the fetched base tip and withhold the arm when anything outside ADVANCE_PATHS rides the branch. Fail closed: an undeterminable base or a failed diff withholds too.
3. LogAdvanceReport gains `autoMerge: 'armed'|'withheld'|'refused'|'off'|null` (null = no PR step ran) and `autoMergeNote: string|null` carrying gh's or the guard's reason.
4. cli/log-verbs.ts: `--no-auto-merge` in ADVANCE_FLAGS, passed as `autoMerge:false`; an `auto-merge` row in the table naming the state and the reason; `autoMerge`/`autoMergeNote` in --json. cli/help.ts LOG_ADVANCE_HELP names the flag.
5. daemon/advance.ts: AdvanceCadence gains `autoMerge: boolean` (defaultCadence true), threaded through runVerbHere, the child request and advance-child.ts; advanceArgv adds `--no-auto-merge` only when it is off, so the default payload argv is byte-identical and no idempotency key moves. AdvanceAttempt gains `autoMerge`, DaemonEvent's advance line gains `auto_merge`, and the attempt message says the merge was armed. The arm rides the SAME log.advance authorization APRV-204 opened: one authorization, one act, no second gate call from a child that has no authority.
6. cli/daemon.ts + cli/up.ts: `--no-advance-auto-merge`, beside `--no-advance-pr`.
7. Rewrite the advance.ts module comment's '`gh pr merge` appears nowhere in this file' section and the daemon-advance.test.ts test that pins it: the daemon still never spells a merge itself, the arm is logAdvance's and it is `--auto`, which lands only what CI and the branch rules already allow.
8. Tests: tests/log-advance-automerge.test.ts (armed, disabled, gh-refused, guard-withheld, --json shape) against a stubbed gh; daemon-advance.test.ts gains armed and disabled cases and its stub's `pr merge` stops failing.
9. docs/cli-reference.md log advance + daemon cadence sections, CLAUDE.md workflow item 7.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What was built

approval log advance --pr and the daemon's cadence advance now ARM the merge on the records pull request they open or update, rather than leaving it at CLEAN for a click. The arm lives in ONE place: src/cli/log-advance.ts's armAutoMerge, run right after ghPullRequest. It is 'gh pr merge <records branch> --merge --auto' — the same argv, in the same order, as cli/amend.ts's ceremony arm, which is the same command a session types by hand.

LogAdvanceOptions.autoMerge (default true, read only when pr is set) turns it off; the session flag is --no-auto-merge and the daemon's is --no-advance-auto-merge. The outcome is a closed set on the report: armed | withheld | refused | off | null (no PR step ran), with autoMergeNote carrying the reason for the three that have one. It surfaces as an auto-merge table row, as autoMerge/autoMergeNote in --json, and as auto_merge/auto_merge_note plus a phrase in the message on the daemon's advance line.

## Decisions

Decision: the arm rides the advance's own authorization and opens no second question. APRV-204 routed the daemon's advance through register + request + startExecution under log.advance as agent:daemon, with the whole remote-side effect inside that one grant. The arm is one more step of that same effect, inside the same grant.

A second gate call would have had to happen in the advance child, which by construction cannot reach the gate (core/child-env.ts strips the APPROVAL_ prefix from a child's environment, so the supervised-live draw would fail closed on every tick). The arm keeps its own class in the taxonomy: it is vcs.push.main (core/command-class.ts, rule gh-pr-merge), unchanged, and nothing here mints a class or claims an exemption.

Decision: the verb was NOT reclassified. refineApprovalVerb still answers log.advance for approval log advance whatever flags follow. Escalating it to vcs.push.main when --pr is present was considered and left alone: it is outside this task's criteria and it wants a policy conversation rather than a lane's judgement. Flagged because it is the one thing here a reviewer might want the other way: the verb already folded a vcs.pr.open into a log.advance grant, and this widens that fold by one class.

Decision: a guard the criteria did not ask for. The task's rationale is a claim about the diff, that a records branch carries only the log, QUEUE.md and .approval/payloads/ (the paths CI's protected-path guard exempts), so nobody needs to read it. But that claim is about what THIS verb builds, and what gets armed is a branch on a shared remote, which can carry work this verb did not make.

So armAutoMerge diffs the pushed commit against the base sha the advance measured itself from and withholds the arm when any path outside ADVANCE_PATHS rides the branch, naming what it saw. It fails closed: an unreadable diff or an unresolvable base withholds too, and 'withheld' is its own state rather than an error, because the pull request is open and correct either way. A withheld arm costs a person one click; an unconditional arm would land whatever else was sitting on a shared branch.

Decision: an arm gh refuses is reported and never fatal, the rule cli/amend.ts's ceremony arm has followed since APRV-130. Auto-merge disabled on the repository, a merge queue, an already-mergeable pull request: gh says no to all three, and the records are committed, pushed and open regardless, so refusing the verb over the arm would lose a good advance to a repository setting.

Decision: the default cadence argv is byte-identical to what it was. advanceArgv adds --no-auto-merge only when the arm is OFF, so a running daemon's payload hash and idempotency key do not move under an upgrade. advance-child.ts reads autoMerge as 'absent means arm it', so an older parent's request still means what it meant.

## Verification

npm run build: exit 0. npm run lint (oxlint src tests): exit 0. npm run typecheck: exit 0.

node scripts/run-tests.mjs --only log-advance-automerge log-advance-rebuild cli-log-verbs daemon-advance up cli-help cli-long-help docs-guard: 123 tests, 123 pass, 0 fail, exit 0. daemon-advance alone: 10 tests, 10 pass, exit 0. Full npm test: green (see the final summary for the count).

AC1 evidence: tests/log-advance-automerge.test.ts, eight cases against a gh stub that logs every call. '--pr arms the merge with the argv a session's own arm uses' asserts the recorded argv is exactly pr merge <branch> --merge --auto; 'the arm follows the pull request on a later advance' covers the update path as well as the open; '--no-auto-merge: nothing is armed and no gh pr merge is run at all' asserts the ABSENCE of the call, not only the report; 'a gh that refuses the arm is reported, and the advance still succeeds' pins exit 0 with autoMerge 'refused'; 'a records branch carrying more than an advance may carry withholds the arm' builds a foreign path onto the branch and asserts the withhold and its note; the two CLI cases pin the auto-merge table row and the --json shape.

AC2 evidence: tests/daemon-advance.test.ts gains 'a cadence advance arms auto-merge on the day's pull request' and '--no-advance-auto-merge: the advance publishes and no merge is armed', both through the real cadence path against the same stub, plus 'the argv the payload binds to names the arm only when it is off'. The pre-existing test that pinned 'gh pr merge appears nowhere' is rewritten as 'the module spells no merge of its own: the argv is logAdvance's, shared with the session path', which is still true and is the property worth pinning.

AC3 evidence: docs/cli-reference.md log advance section (the arm, the withhold, the gh refusal, the --json shape) and daemon cadence section (auto_merge on the advance line, --no-advance-auto-merge); CLAUDE.md workflow item 7; docs/dogfood-cutover.md's merge step, which told the operator to click. docs-guard passes.

## Invariants touched

SPEC.md §11.1: invariant 6 (machine-readable, distinct refusals) is why the outcome is a closed set of five states with a separate note, rather than a boolean plus prose. No invariant is weakened: no class is minted, no self-reported field reduces scrutiny, no second authorization is claimed, and the log is untouched by this change.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
approval log advance --pr and the daemon's cadence advance now arm the merge on the records pull request they open or update (gh pr merge <branch> --merge --auto), so a records PR no longer sits at CLEAN waiting for a click that was never a review. The arm lives once, in src/cli/log-advance.ts's armAutoMerge; it withholds when the pushed branch carries a path outside ADVANCE_PATHS (or when the diff cannot be read), reports a gh refusal without failing the verb, and is turned off by --no-auto-merge (--no-advance-auto-merge for the daemon). It rides the advance's own log.advance authorization and opens no second gate question, and the default cadence argv is unchanged so no payload hash moves. Verified: npm run build, npm run lint, npm run typecheck all exit 0; node scripts/run-tests.mjs --only log-advance-automerge log-advance-rebuild cli-log-verbs daemon-advance up cli-help cli-long-help docs-guard = 123 pass / 0 fail, exit 0 (8 new cases in tests/log-advance-automerge.test.ts, 3 new in tests/daemon-advance.test.ts).
<!-- SECTION:FINAL_SUMMARY:END -->
