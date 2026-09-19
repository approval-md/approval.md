---
id: APRV-378
title: >-
  Audit event for a question the gate exists to ask being answered by something
  else, starting with the Codex auto-reviewer
status: Done
assignee:
  - '@claude'
created_date: '2026-09-19 14:06'
updated_date: '2026-09-19 16:05'
labels:
  - audit
  - schema
  - codex
  - bridge
dependencies:
  - APRV-364
priority: medium
ordinal: 293000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Split out of APRV-364 on the orchestrator ruling (2026-09-19, option a). APRV-364 AC2 asked for an audit record when an autoApprovalReview notification arrives mid-session, and no event type fits: audit.dark_session is the sweep, audit.decision_refused is a human gesture the gate would not take, and audit.gesture_refused (APRV-355) is a gesture that is not a decision. The fact with no record is a DIFFERENT one, and it is the one this project most wants written down: something other than the gate answered a question the gate exists to ask.

The Codex app-server auto-reviewer is the first instance (docs/codex-app-server-bridge.md, question 3): a server-side reviewer can resolve an approval with a model call before approval codex bridge sees the request, and tells the client afterwards through an item/autoApprovalReview notification. Zero were observed on 2026-09-18 under the operator configuration, which says nothing about other configurations. Under APRV-364 the bridge STOPS on such a notification and reports it; this task is what makes the stop leave a trace in the log.

Name it so it can carry the next instance as well as this one (for example audit.question_preempted, with a closed source enum whose first member is the Codex auto-reviewer). It authorizes nothing, no enforcement path reads it, and the actor is system: for the reason audit.dark_session and audit.decision_refused both give: a record of an event authored by either party to it is a record neither party can be held to.

SHAPE, from APRV-355 which did exactly this on 2026-09-19: one event type, the schema enum, an if/then block, the union and header count in src/core/log.ts, conformance vectors for the valid record and the invalid shapes, one SPEC section 8 bullet in ONE commit that no later commit touches, and a records advance before the protected-path guard can pass.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A new audit-tier event type for a question answered by something other than the gate is defined in schema/event.schema.json and in one SPEC section 8 bullet, validated at the write boundary, carrying a closed source enum (first member: the Codex app-server auto-reviewer), the question it answered as the server identified it, and the verdict that other party reached, with a system: actor required
- [x] #2 approval codex bridge appends exactly one such record when an autoApprovalReview notification arrives, through the real append path, and appends none in a session where no such notification arrives; tests drive the real CLI against the stub server
- [x] #3 No enforcement path reads the record (a test or a module-graph assertion pins that), it is visible in approval log tail and approval log export, and docs/cli-reference.md describes it where the other audit records are described
- [x] #4 Conformance vectors cover the valid record and at least two invalid shapes; build, typecheck, lint, the schema, bridge and log suites pass, and the SPEC amendment is called out in the PR
- [x] #5 approval doctor gains a codex-auto-reviewer row that reads this record and reports pass, fail or skip with a fix (moved here from APRV-364 AC3 on the orchestrator ruling of 2026-09-19: the row's only durable input is the record this task creates, so a row built in 364 would always skip and would be rewritten the moment this landed)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
IMPLEMENTED by lane 6, 2026-09-19, in the APRV-355 shape the description asks for: one event type, one commit.

WHAT IS IN THE DIFF. schema/event.schema.json (the enum, the count in its description, one if/then block); src/core/log.ts (the union and the header note); src/core/question-preempted.ts (the writer, modelled on core/gesture-refusal.ts); src/cli/codex-bridge.ts (one append before the bridge-auto-reviewer-active stop, plus autoReviewVerdict); src/cli/doctor.ts (the codex-auto-reviewer row); five fixtures; conformance vectors regenerated with a MINOR bump to 2.4.0; SPEC.md section 8, one bullet; docs/cli-reference.md (the record beside the other audit records, and the row in the doctor list); README.md (33 rows, the tally, the row name); tests/question-preempted.test.ts, plus cases in tests/codex-bridge.test.ts and the roster in tests/doctor-rows.ts.

NAME. audit.question_preempted, general on purpose: the Codex auto-reviewer is the first instance and source is a closed enum, so the next system that pre-empts one of these questions gains a member rather than a type.

DECISIONS THE DIFF DOES NOT SHOW.
1. VERDICT IS OPTIONAL. The criterion says the record carries the verdict the other party reached, and the honest reading is: verbatim when the disclosure stated one, ABSENT when it did not. A required field forced to a placeholder would be this runtime inventing another party decision, which is the one thing a record about another party decision may not do. A fixture and a test pin the absence.
2. QUESTION IS AN OBJECT of the other party own identifiers (id required; method, thread, turn optional), not a string. A record about somebody else decision has to name it in their terms or a reader cannot find it on their side.
3. DOCTOR IS A READER, and deliberately not on the enforcement list the module-graph test walks. A health row diagnoses; it authorizes nothing and refuses nothing. That is stated in the schema comment, in the module header and in the SPEC bullet, so a later reader does not read the row as an exception to the no-enforcement rule.
4. THE ROW WINDOWS ITS FAIL to 24 hours (the dark-sessions window) and reports older records in the detail of a passing row. A row that stayed red forever over a fact already dealt with is a row nobody reads.
5. THE ROW PASS IS NARROW: the log holds no such record. It is not a claim that a harness auto-reviewer is off. That is why APRV-364 probes rather than reading a configuration key whose name this repository has no record of.
6. CONFORMANCE 2.4.0 is a MINOR bump in the shape 2.1.0 and 2.3.0 were. Noted while doing it: APRV-355 five gesture_refused fixtures reached the suite under 2.3.0 with no bump of their own, so 2.4.0 is the first version that names them. Recorded in the script comment and in the PR body rather than fixed silently.

SPEC section 11 INVARIANTS TOUCHED. Invariant 5 (compare-and-append): the writer reads a fresh head and appends against it through withHeadRetry, the same cycle gesture-refusal uses. Invariant 4 (self-reported fields): every field is the other party own frame, and nothing the agent under oversight said about itself. Invariant 3 (no raw secrets): the payload carries identifiers and one verdict word, never the notification wholesale. None weakened. The new event is audit tier and no enforcement path reads it, pinned by a module-graph test over eleven modules.

VALIDATION. build, typecheck, lint all exit 0. npm run conformance: 395 vectors passed, 0 failed, exit 0. tests/question-preempted.test.ts 7/7; tests/codex-bridge.test.ts 41/41; tests/cli-doctor.test.ts 76/76; docs-guard and cli-long-help 39/39; all exit 0. Full npm test: 4769 tests, 4746 pass, 22 fail, exit 1, and the failing set is byte-identical to the APRV-364 run earlier today (the pre-existing Node 26 SMTP and email adapter set). The pre-change baseline on this checkout was 4749 / 4725 / 23.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
audit.question_preempted is the eighteenth event type: something other than this gate answered a question this gate exists to ask. It carries a system: actor, a closed source enum whose first member is the Codex auto-reviewer, the question in the other party own identifiers, and their verdict verbatim where the disclosure stated one (absent, never defaulted, where it did not). approval codex bridge appends exactly one before it stops on an item/autoApprovalReview notification, and none in a session that sees no such notification. It is audit tier on the strict terms audit.decision_refused set, pinned by a module-graph test over eleven enforcement modules; approval doctor codex-auto-reviewer row reads it, which is a diagnosis rather than an enforcement, and its pass says the log holds no such record rather than that any harness reviewer is off. Verified by 7 new unit cases, 2 new bridge cases driving the real CLI against the stub, 5 conformance fixtures under a MINOR bump to 2.4.0 (395 vectors, 0 failed), the doctor and docs-guard suites, and a full npm test whose failing set is identical to the run before this change.
<!-- SECTION:FINAL_SUMMARY:END -->
