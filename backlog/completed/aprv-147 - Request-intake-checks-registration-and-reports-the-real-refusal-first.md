---
id: APRV-147
title: Request intake checks registration and reports the real refusal first
status: Done
assignee:
  - '@fable'
created_date: '2026-08-26 19:25'
updated_date: '2026-08-29 06:32'
labels:
  - security
  - gate
dependencies: []
priority: high
ordinal: 132000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Born 2026-08-26 from the APRV-122 builder's gate-verdict vectors, which pinned the current behavior honestly as intake-does-not-check-registration. (1) request() does not check that the task was registered or the action key declared: a caller supplying its own payload_hash gets an approval.requested recorded for a task the log never registered. SPEC §7's declaration requirement is enforced at execution and at harness consumption, so no side effect escapes, but a human can be shown a request (and tap Approve) for an undeclared class — attention spent on a question the gate would refuse to act on, and a social-engineering surface (the prompt looks exactly like a real one). Fix: intake refuses an unregistered task / undeclared action key with a distinct machine-readable code, and the pinned conformance vector flips from documenting the gap to asserting the refusal. (2) Check order at intake buries not-registered under payload-hash-required; the real reason should surface first. Touches §11.1 invariants 1, 5, 6; implementation notes must say so. Backward compat: audit the committed log for requests without registration before choosing the enforcement (historical records must keep verifying; the refusal binds new intakes only).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 request() refuses an unregistered task or undeclared action key with a distinct pinned code; the conformance vector flips to assert it
- [x] #2 Refusal order at intake reports not-registered before payload-hash-required, pinned
- [x] #3 The committed log still verifies; historical requests without registration are unaffected by the new refusal
- [x] #4 npm test and the conformance runner pass; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Branch aprv-147-intake-registration from main 2961f7c (post-#133). 2. gate.ts request(): where autonomy resolves manual OR supervision is live, consult registeredAction(read.records, task, actionKey) before anything else that could bind, draw, or record: not-registered / action-not-registered (the pinned codes it already carries) propagate as the refusal. Placement closes two holes at once: the human-prompt forgery the task names, and a re-roll the audit surfaced (an unregistered supervised-live action draws over its caller-supplied hash, so varying the hash re-rolls the draw; the check must precede liveVerdict). The caller-supplied payload_hash fallback survives only for the case the registration declared an action without a hash. Plain supervised-retro/autonomous proceed answers stay unchanged: they mint nothing and record nothing, and SPEC 7 is enforced for them at execution, per the existing boundary vectors. 3. Conformance: gate-verdicts.v1.json vector intake-does-not-check-registration flips to assert the not-registered refusal (description rewritten from boundary-statement to enforcement-statement); add an order vector (unregistered task AND missing hash refuses not-registered, not payload-hash-required) and an undeclared-action-key intake vector; respect the suite's versioning/manifest rules in conformance/README. 4. gate.test.ts: unregistered manual request refused with nothing appended; registered task + undeclared key refuses action-not-registered; order pin; supervised-live unregistered refuses at every rate (no draw, no re-roll); registered flows byte-identical. 5. AC3 evidence: log audit (2026-08-28, committed log at seq 887) found zero approval.requested lacking a matching task.registered declaration, at task and (task, action_key) level, hook ctc_/fc_ tasks included; verify never replays intake, so historical records are untouched by construction. 6. npm test, npm run conformance, lint. Invariants touched: 11.1 #1 (the check reads task.registered from the log, never the file), #5 (it joins the pre-append checks under the same head compare-and-append), #6 (refusals reuse pinned distinct codes). SPEC 7 line 261 already states the MUST this enforces; no SPEC edit.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built by an Opus subagent from the recorded plan; fable reviewed the diff and independently re-ran verification (npm test 2304/2304 incl. 6 new gate tests, conformance 221/221 with 101 negative controls, lint clean). Commit 9737e3d on aprv-147-intake-registration, PR #134, auto-merge armed for the queue. Review-approved divergences from the plan, each sound: the flipped vector was also RENAMED intake-does-not-check-registration to intake-checks-registration (an id asserting the opposite of its expectation is a trap for readers); vectors_version bumped to 2.0.0 while the .v1.json filename stays (filename is format generation, the field is the contract version, recorded in conformance/README.md); the conformance harness gained a records field on refused request steps so nothing-was-appended is asserted from the verified log rather than described (budget-exceeded shows it discriminating at 3 vs the intake refusals' 1). Three pre-existing tests that requested undeclared keys were updated to declare them (they pin the budget ratchet, the irreversibility floor, and payload retention, and were not exercising the gap). Out of scope, flagged separately: conformance/vectors/schema-validation.v1.json is stale on main (the two APRV-127 reconciliation event fixtures have no vectors; regeneration adds 2, count 110 to 112) — excluded from this commit, proposed as its own task.

Merged: PR #134 as main 13b86e2 through the merge queue. AC evidence: AC1 six gate tests plus the flipped conformance vector intake-checks-registration (refusal not-registered, nothing appended, asserted via the harness records field); AC2 the order vector intake-not-registered-outranks-payload-hash-required plus the matching test; AC3 the pre-change audit of the committed log found zero approval.requested lacking a registration at task and (task,action_key) level, verify never replays intake, and approval status reads clean (1057 records at finalization); AC4 verified twice independently, builder and reviewer: npm test 2304/2304, npm run conformance 221/221 vectors with 101 negative controls, lint clean.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
request() now enforces SPEC 7 declaration at intake for manual and supervised-live resolutions, before the live draw and before anything is appended: not-registered / action-not-registered surface ahead of payload-hash-required, closing the forged-prompt surface and the supervised-live re-roll. Shipped as PR #134 (main 13b86e2); verified with 6 new gate tests, the flipped and added conformance vectors at vectors_version 2.0.0, suite 2304/2304, conformance 221/221, lint clean.
<!-- SECTION:FINAL_SUMMARY:END -->
