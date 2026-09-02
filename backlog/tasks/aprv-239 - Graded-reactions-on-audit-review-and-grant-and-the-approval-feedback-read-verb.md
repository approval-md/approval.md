---
id: APRV-239
title: >-
  Graded reactions on audit review and grant, and the approval feedback read
  verb
status: To Do
assignee: []
created_date: '2026-09-02 20:46'
labels:
  - welfare
  - cli
  - audit
dependencies:
  - APRV-237
ordinal: 194000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Record what the human thought of an action, and give the agent a way to read it back. `approval audit review --reaction disliked|indifferent|liked|loved` records payload.reaction beside verdict; `verdict` stays the enforcement field. Rules live in core reviewSample, evaluated before the verified read and appending nothing: --deny with liked/loved refuses the new `reaction-conflicts-verdict`; loved/disliked without a non-blank note refuses the existing `note-required`. `approval grant --reaction` records the same field (reject and revoke refuse the flag as a usage error naming --note); a grant with loved/disliked and no note refuses the new gate code `reaction-note-required` (droppable to a follow-up if this task overruns). `approval feedback` is a new top-level read verb (beside `values`, symmetric with `journal`) listing human-authored reactions and notes, joined to class, task, action key, and the agent actor, read from verified records only, behind a HUMAN-AUTHORED GUIDANCE banner. Depends on APRV-237; independent of APRV-238.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `approval audit review --reaction <word>` records payload.reaction; omitted means absent, never indifferent; both --json and human output report it
- [ ] #2 reviewSample refuses reaction-conflicts-verdict for denied with liked/loved and note-required for loved/disliked with a blank note; both evaluated before the verified read and neither appends; AUDIT_REFUSAL_CODES and the frozen list in tests/audit.test.ts updated
- [ ] #3 `approval grant --reaction` records payload.reaction; reject and revoke refuse the flag as a usage error naming --note; loved/disliked without a note refuses reaction-note-required (gate union, tests/gate.test.ts, SPEC §11.2 row, docs gate-refusal-codes table, conformance vectors regenerated)
- [ ] #4 humanFeedback(records) in src/core/audit.ts returns entries joined to class, task, action key and agent actor, with agentActor sourced from task.registered/execution.started actor and never from a payload field; entries with neither reaction nor note are omitted
- [ ] #5 `approval feedback [--task] [--actor] [--reaction] [--source review|decision] [--since] [--limit] [--log] [--json]` ships, reads via readVerifiedRecords, prints FEEDBACK_BANNER on every output form, prints _no feedback_ when empty
- [ ] #6 Verb wired in all four places; MCP publishes tool `feedback`; not in GUEST_VERBS; tests/cli-help.test.ts and tests/cli-instructions.test.ts pass with no exemptions
- [ ] #7 tests/cli-feedback.test.ts added with every record built through the real append path; tests/audit.test.ts and tests/cli-gate.test.ts extended for the reaction rules
- [ ] #8 tests/values-inert.test.ts extended: two logs identical except reactions and notes give deep-equal pendingSamples, openSamples, sampledSubjects, openObligations, budget verdicts, and approval run outcomes
<!-- AC:END -->
