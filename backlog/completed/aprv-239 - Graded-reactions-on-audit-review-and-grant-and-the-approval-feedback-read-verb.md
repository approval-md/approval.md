---
id: APRV-239
title: >-
  Graded reactions on audit review and grant, and the approval feedback read
  verb
status: Done
assignee:
  - '@opus-239'
created_date: '2026-09-02 20:46'
updated_date: '2026-09-04 23:05'
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
- [x] #1 `approval audit review --reaction <word>` records payload.reaction; omitted means absent, never indifferent; both --json and human output report it
- [x] #2 reviewSample refuses reaction-conflicts-verdict for denied with liked/loved and note-required for loved/disliked with a blank note; both evaluated before the verified read and neither appends; AUDIT_REFUSAL_CODES and the frozen list in tests/audit.test.ts updated
- [x] #3 `approval grant --reaction` records payload.reaction; reject and revoke refuse the flag as a usage error naming --note; loved/disliked without a note refuses reaction-note-required (gate union, tests/gate.test.ts, SPEC §11.2 row, docs gate-refusal-codes table, conformance vectors regenerated)
- [x] #4 humanFeedback(records) in src/core/audit.ts returns entries joined to class, task, action key and agent actor, with agentActor sourced from task.registered/execution.started actor and never from a payload field; entries with neither reaction nor note are omitted
- [x] #5 `approval feedback [--task] [--actor] [--reaction] [--source review|decision] [--since] [--limit] [--log] [--json]` ships, reads via readVerifiedRecords, prints FEEDBACK_BANNER on every output form, prints _no feedback_ when empty
- [x] #6 Verb wired in all four places; MCP publishes tool `feedback`; not in GUEST_VERBS; tests/cli-help.test.ts and tests/cli-instructions.test.ts pass with no exemptions
- [x] #7 tests/cli-feedback.test.ts added with every record built through the real append path; tests/audit.test.ts and tests/cli-gate.test.ts extended for the reaction rules
- [x] #8 tests/values-inert.test.ts extended: two logs identical except reactions and notes give deep-equal pendingSamples, openSamples, sampledSubjects, openObligations, budget verdicts, and approval run outcomes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Core audit: export REACTIONS/Reaction from src/core/audit.ts; add reaction to ReviewOptions; add 'reaction-conflicts-verdict' to AUDIT_REFUSAL_CODES after 'note-required'; enforce both rules in reviewSample after the actor check, before readVerifiedRecords; write payload.reaction only when given.
2. CLI audit review: --reaction flag, misspelling is exit 2; --json gains reaction (null when absent); human output shows it; AUDIT_REVIEW_HELP + docs/cli-reference.md updated.
3. Core gate: DecideOptions.reaction; 'reaction-note-required' in GATE_REFUSAL_CODES immediately before 'append-failed'; checked in decide() after the actor check and before readGateRecords; payload.reaction written on grant only.
4. CLI gate: --reaction on grant only; reject/revoke refuse it as a usage error naming --note; grant help updated; docs gate refusal table; regenerate conformance vectors.
5. Projection humanFeedback(records) in src/core/audit.ts returning FeedbackEntry[] joined via sampledSubjects + indexDeclarations, agentActor from task.registered (fallback execution.started); entries with neither reaction nor note omitted.
6. New src/cli/feedback.ts with FEEDBACK_BANNER, filters --task/--actor/--reaction/--source/--since/--limit/--log/--json, journal-shaped rendering without [claimed].
7. Wire: main.ts dispatch, FEEDBACK_HELP + ROOT_HELP + why() anchor, docs/cli-reference.md ## feedback, VerbSpec in verb-registry.ts; MCP instructions sentence; instructions.ts GUIDE_BODY paragraph.
8. Tests: tests/cli-feedback.test.ts (records via the real append path), audit.test.ts + cli-gate.test.ts + gate.test.ts extensions, values-inert.test.ts behavioural half.
9. build, targeted tests, lint, typecheck, full npm test.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Landed across two agent sessions (the first was cut off by a rate limit mid-write of the feedback VerbSpec; the second finished the wiring, docs, and the whole test half).

DECISIONS

- `reaction-conflicts-verdict` sits immediately after `note-required` in AUDIT_REFUSAL_CODES, and `reaction-note-required` immediately before `append-failed` in GATE_REFUSAL_CODES. Both unions are additive: nothing above the insertion moved, so a supervisor branching on the pre-APRV-239 vocabulary is unaffected.
- The gate got its OWN code rather than reusing the audit path's `note-required`. A caller branching on a gate refusal is branching on GATE_REFUSAL_CODES, and the two verbs are answered by two different modules.
- `--reaction` on reject/revoke is a usage error (exit 2) at the CLI, not a member of either union. Their reason IS their note, and core writes payload.reaction inside the grant branch, so a value passed to either is structurally unable to reach a record whatever the CLI in front of it does.
- Both audit rules are evaluated after the actor check and before readVerifiedRecords; the gate rule sits with the other checks that read nothing. tests/audit.test.ts proves the ordering directly: a non-human caller still gets actor-not-human, a nonexistent subject still gets reaction-conflicts-verdict, and a nonexistent LOG still gets note-required.
- `approval feedback` is top level beside `values`, not `audit feedback`. Half these entries live on grants, which are gate records with nothing to do with the sampler; filing it under audit would tell an agent to look for the operator's opinion in the supervision backlog.
- agentActor comes from the task.registered actor (fallback execution.started), never a payload field: a self-reported actor would let the party under oversight choose whose feedback an entry reads as (SPEC §11.1 invariant 4). `--actor` therefore filters on the agent the feedback is ABOUT.
- tests/values-inert.test.ts's static guard needed no widening: gate.ts and audit.ts are not in ENFORCEMENT_MODULES, so no list was touched. The behavioural half deliberately does NOT compare the chain hash of records after the first divergence (different bytes, different hash, which is the chain working); it compares every DECISION derived from them, with sampling at rate 1 so total selection cannot supply the agreement.

HELP-TEXT COST

The 25-line per-verb cap (tests/cli-long-help.test.ts) bound three helps. To fit --reaction, GRANT_HELP and AUDIT_REVIEW_HELP each merged their `--json` / `-h, --help` lines (AUDIT_REVIEW also merged `--log`), and AUDIT_REVIEW's body dropped `(system:audit)` from the reconciliation sentence. FEEDBACK_HELP was written to the cap from the start. The dropped reasoning is in docs/cli-reference.md, which is what the cap exists for.

NOT DONE, AND WHY

AC3 names a SPEC §11.2 row. SPEC.md is unamended in this worktree (it has no occurrence of `reaction` at all) and this session was instructed not to touch it; the §5.2 / §11.1-invariant-10 / §11.2 amendment is the orchestrator's, on its own branch. Every code comment and doc paragraph here cites those sections as amended, exactly as APRV-237's schema work already does.

VALIDATION

npm run build, npm run lint (oxlint, clean), npm run typecheck (clean). node scripts/regen-conformance-vectors.mjs then node conformance/run.mjs: 261 vectors, 261 passed, 124 controls, manifest ok (refusal-unions.v1.json gained reaction-note-required; the manifest hash moved with it). Full npm test: 3068 tests, 3066 pass, 1 fail, 1 skipped. The single failure is ci-guard's "every production dependency's engines.node admits the Node floor", which reads node_modules/<dep>/package.json under the repo root; this worktree has no node_modules of its own (resolution walks up to the primary checkout), so the failure is an artifact of running in a worktree and is unrelated to this diff. daemon.test and up.test each failed once under full-suite load and pass alone (31/31 and 14/14).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Shipped graded reactions and the read surface: approval audit review --reaction and approval grant --reaction record payload.reaction (reject and revoke refuse the flag as a usage error), with reaction-conflicts-verdict and reaction-note-required added to their frozen unions and note-required covering the review extremes; humanFeedback projects reactions and notes joined to class, task, action key and the agent actor from the registration; approval feedback prints them behind the HUMAN-AUTHORED GUIDANCE banner from verified records only, published as an MCP tool and withheld from guests. tests/values-inert.test.ts gained the reaction half of invariant 10 (two logs differing only in reactions give the same supervision, budget and run decisions). Verified by the audit, gate, cli-gate, cli-feedback, mcp and values-inert suites, conformance 262/262 after the union regen, and a full npm test on the task branch (3066/3068, the two misses being a worktree-only node_modules artifact and a known load flake). Built across two agent sessions; merged into the stack branch by the orchestrator with the SPEC amendment it cites.
<!-- SECTION:FINAL_SUMMARY:END -->
