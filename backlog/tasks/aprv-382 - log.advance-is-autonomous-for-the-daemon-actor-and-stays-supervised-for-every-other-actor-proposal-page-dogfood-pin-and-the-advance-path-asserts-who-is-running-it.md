---
id: APRV-382
title: >-
  log.advance is autonomous for the daemon actor and stays supervised for every
  other actor: proposal page, dogfood pin, and the advance path asserts who is
  running it
status: Done
assignee:
  - '@claude-opus-5'
created_date: '2026-09-19 16:17'
updated_date: '2026-09-19 17:20'
labels:
  - policy
  - daemon
  - records
dependencies: []
priority: medium
ordinal: 296000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter asked on 2026-09-19 whether a records advance should be autonomous. The argument: the advance appends nothing and decides nothing, it publishes records already in the log to a records branch and opens a PR (files are the interface, the log is the truth, the committed copy is a cache); the CI guard reads grants that exist whether or not an advance ran, so no actor gains authority from timing one. The class was declared manual (seq 513) before the daemon existed, when any checkout could advance. Now the daemon is the single writer and already advances on a timer under --advance, so the remaining risk is mechanical (queue collision, duplicate branch), which the --pr path handles. Decision to propose: log.advance autonomous when the actor is the daemon, supervised for any other actor (a session in a worktree, a human terminal), so a lane still cannot publish the log. Agents do not edit APPROVAL.md: this task delivers a proposal page under docs/proposals/ in the byte-anchored form approval policy apply reads, the dogfood-suite pin change in the same PR (the pin-every-class rule, APRV-296), and a check in the advance path that the autonomous route is only taken when the running actor is the daemon (the cadence advance inside approval up or daemon run), refusing with a distinct code otherwise. Carter applies the page with approval policy apply <page> and restarts the daemon. Related: APRV-125 (log sync verb), APRV-284 (advance arms itself), APRV-215, APRV-296, APRV-360.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 docs/proposals/log-advance-daemon-2026-09.md exists in the form policy apply reads, with the rule for log.advance by actor and the cost seen that prompted it (three advances on 2026-09-19 each at a one-in-a-hundred live draw while the human was away)
- [x] #2 The dogfood suite pin for log.advance moves in the same PR and the amend dry-run against the proposed policy passes on the laptop
- [x] #3 The advance path distinguishes the daemon actor from any other and a non-daemon actor under an autonomous rule is refused with a machine-readable code, with tests through the real append path
- [x] #4 docs/dogfood-cutover.md and docs/cli-reference.md say which actor may advance autonomously; build, typecheck, lint and the advance, daemon and policy suites pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read the live rule, the two applied proposal pages, src/cli/policy-apply.ts anchoring, the pins (src/core/policy-expectations.ts, tests/dogfood.test.ts) and the gated advance path (src/daemon/advance.ts authorizeAdvance, src/core/advance-cycle.ts).
2. Policy shape: the class grammar carries no actor condition, so the rule is TWO lines. log.advance stays supervised-live 0.01 for every actor; a new log.advance.daemon is autonomous and is the class ONLY the daemon cadence requests under. A lane running approval log advance still classifies log.advance through the hook, so the autonomous line is unreachable from a shell command by construction.
3. Page: docs/proposals/log-advance-daemon-2026-09.md, one byte-anchored pair quoting the live log.advance line and replacing it with itself plus the daemon line, with the cost seen (three advances on 2026-09-19 each at a one-in-a-hundred live draw while the human was away) and the mantra argument.
4. Code: ADVANCE_DAEMON_CLASS plus RUNTIME_CLASSES in src/core/command-class.ts (emittableClass learns the class the RUNTIME emits and no command spells, which is what would otherwise refuse the amend unreachable); a process mark set by the Daemon constructor in src/daemon/daemon.ts and read through src/core/daemon-actor.ts, never a caller argument (SPEC 11.1 invariant 4); advanceRoute() in src/core/advance-cycle.ts picks the class: daemon plus a RULE on the daemon class takes the autonomous route, a daemon with no such rule falls back to log.advance (so the cadence is unchanged until Carter applies the page), and a non-daemon actor whose class resolves autonomous is refused advance-actor-not-daemon.
5. Pin move: tests/dogfood.test.ts gains the state-tolerant pin for the pair (log.advance never autonomous; log.advance.daemon autonomous once declared) and a test that parses the proposal page, applies it to the live APPROVAL.md bytes in memory through the real parseProposal/planApply, and runs checkPolicyExpectations over the result: the amends own laptop check, without writing APPROVAL.md.
6. Tests through the real append path in tests/daemon-advance-actor.test.ts: daemon under the proposed policy advances unasked under the daemon class; non-daemon under an autonomous rule is refused advance-actor-not-daemon; daemon under a policy with no daemon line still gates as log.advance.
7. Docs: docs/dogfood-cutover.md and docs/cli-reference.md say which actor may advance autonomously; note the RUNTIME_CLASSES line in the pin section.
8. build, typecheck, lint, npm test; PR; merge origin/main and rebuild; arm.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Shape of the rule. The class grammar carries no actor condition (schema/policy.schema.json classRule has autonomy, rates, approvers, and nothing about who is asking), so the decision is written as TWO classes: log.advance stays supervised-live 0.01 for every actor and a new log.advance.daemon is autonomous. Nothing an agent can type reaches the looser line, and that is structural rather than a check: approval log advance classifies log.advance whoever runs it (verified with approval hook classify), and the daemon class is asked for only from inside the daemon process. Starting a daemon is gate.self, which this policy leaves at the fail-closed manual default.

Why not one class turned autonomous with a code-side actor check. That would have refused the orchestrators own approval log advance --pr, which is the documented repair for a protected-path guard (CLAUDE.md, handover section 6), and it would have refused Carter at his own terminal. The title of this task says every other actor stays SUPERVISED, and only a second class can say that.

Who is running it. src/core/daemon-actor.ts holds one process fact. markDaemonProcess() takes no arguments and records process.pid; isDaemonProcess() answers true only while that pid is this process. The Daemon constructor sets it, so approval up, approval daemon run, the shutdown flush and a --once tick are one actor. It is deliberately NOT a field on AdvanceInput: a field a caller sets is a self-reported field, and SPEC 11.1 invariant 4 says a self-reported field never reduces scrutiny. The module header states plainly what it is not, namely a boundary against code already running inside the daemon process.

The route, and the fallback. core/advance-cycle.ts advanceRoute(daemon, load) is pure over a loaded policy. Daemon plus a RULE on log.advance.daemon takes that class; daemon with no such rule falls back to log.advance, so the cadence in the primary checkout is unchanged between the day this merges and the day Carter applies the page (the alternative, resolving to the manual default, would have been a phone tap per advance for a policy that had decided nothing). A non-daemon actor whose class resolves autonomous is refused advance-actor-not-daemon before anything is appended.

The pin that moved. log.advance was never in REPO_POLICY_EXPECTATIONS (APRV-296 removed it deliberately), so the pin this amendment would have failed is the REACHABILITY check: emittableClass answers from the command classifiers table, and a class no command spells would be refused unreachable, which is a true statement about the classifier and a false one about the runtime. So command-class.ts gains RUNTIME_CLASSES (classes a runtime cycle asks the gate for directly) and emittableClass reads it. CLASSIFIER_CLASSES is untouched on purpose: tests/cli-hook.test.ts requires every member of it to appear in docs/claude-code-hook.md, and the daemon class is not a hook row. tests/dogfood.test.ts gains two pins: one state-tolerant pin that log.advance is never autonomous and any autonomy sits on the daemons class, and one that parses docs/proposals/log-advance-daemon-2026-09.md, applies it to the live APPROVAL.md bytes through the real parseProposal/planApply, loads the result and runs checkPolicyExpectations over it.

The dry run. approval policy apply --dry-run could not be run here: the verb classifies policy.core and the hook denied it with hook-class-human-only, as designed (transcript in the PR). The dogfood test above is the same three steps the verb performs before it writes anything, over an in-memory copy, and APPROVAL.md is untouched (the suites own after hook compares its bytes).

No schema change was needed: envelope.schema.json constrains an action class by pattern, not by enum, so log.advance.daemon validates. No SPEC.md edit. No APPROVAL.md edit.

Touching a global invariant: SPEC 11.1 invariant 4 (self-reported fields never reduce scrutiny) is the reason the actor is a process fact rather than an argument, and invariant 6 (machine-readable refusals) is why the new refusal has its own code.

Validation: npm run build, npm run typecheck, npm run lint all clean. npm test after npm ci: 4735 pass, 45 fail, exit 1; every failure is in tests/adapter-email.test.ts, tests/smtp-probe.test.ts and the four setup adapter email cases of tests/cli-setup.test.ts, the pre-existing local SMTP failures on Node v26 (CI on Node 22 is the truth). The five new cases in tests/daemon-advance-actor.test.ts and the two new dogfood cases pass.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
log.advance.daemon is the daemons own advance class and is autonomous; log.advance is untouched for every other actor. Delivered: the byte-anchored proposal page (docs/proposals/log-advance-daemon-2026-09.md), the reachability pin the amendment needs (RUNTIME_CLASSES in src/core/command-class.ts) plus two dogfood pins including one that applies the page to the live policy and runs the ceremonys own expectation check, the actor route in src/core/advance-cycle.ts read from src/core/daemon-actor.ts (a process fact, never a caller argument) with advance-actor-not-daemon for a non-daemon actor under an autonomous rule, and the docs. Verified by five new cases in tests/daemon-advance-actor.test.ts through the real append path over a real git topology, two new cases in tests/dogfood.test.ts, and build/typecheck/lint clean with npm test at 4735 pass and 45 pre-existing local SMTP failures.
<!-- SECTION:FINAL_SUMMARY:END -->
