---
id: APRV-20
title: Retrofit Part A per AMENDMENTS.md and APRV-19 findings
status: In Progress
assignee:
  - '@fable'
created_date: '2026-08-05 02:21'
updated_date: '2026-08-05 02:42'
labels: []
milestone: m-3.1
dependencies:
  - APRV-19
priority: high
type: feature
ordinal: 20000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Code retrofit per the human's AMENDMENTS.md Part A (NOTE: AMENDMENTS.md is not yet present in the repo as of task creation, 2026-08-07 — this task is additionally blocked on that file landing on main; the human's message also references the dangling-execution recovery verb "as specced" therein). Scope adjusted by APRV-19's blocker/should-fix findings. Includes: the approval execution resolve verb (the human-specced recovery verb for dangling executions), the dedicated refusal code for grant-on-classless-request, and the dedicated append-error code for attestation's actor refusal. Spec amendments accompany their implementing code same-commit per the standing rule.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 AMENDMENTS.md Part A items implemented per the file's text, scope adjusted by APRV-19 findings adopted into this task
- [ ] #2 The dangling-execution recovery verb lands as specced in AMENDMENTS.md, human-only, with frozen exit codes and --json shape
- [ ] #3 Dedicated refusal code for grant on a classless request replaces the fail-closed empty-string path, with tests
- [ ] #4 Dedicated append-error code for attestation's human-actor refusal replaces the reused validation code, with tests
- [ ] #5 All spec amendments tied to Part A land in the same commits as their implementing code
- [ ] #6 B1: appendEvent gains a compare-and-append head precondition; a moved head refuses under the lock with a new machine-readable code; every check-then-append site in gate, token, and register adopts it; required test: two genuinely concurrent consumers of one token — exactly one execution.started lands, the loser receives the moved-head code
- [ ] #7 S1: gate, token, and execute operations read only chain-verified records, with an in-code note that linear-cost verification is accepted at v0.1 and head-caching is an M5 optimization
- [ ] #8 S2: envelope max_cost_usd enforced conjunctively with policy budgets at intake, grant, and execution start (max_latency deferred to the APRV-21 spec note)
- [ ] #9 S3: literal frozen JSON fixtures replace self-referential derivation for the verify and policy-explain shapes; shape drift now fails loudly
- [ ] #10 S4: shared state derivation extracted to state.ts; the gate-token module cycle is dissolved
- [ ] #11 S5: one exported hardened YAML parse; the frontmatter replica deleted; a test proves both paths share the single implementation
- [ ] #12 A1 handling: payload_hash with token binding and payload-mismatch as a distinct reason within existing exit classes; channel display obligations recorded in spec per the amendment text; anywhere binding payloads required REWORKING frozen behavior rather than extending it is reported to the human
- [ ] #13 A2: gate-typed events (approval.*, execution.*, budget.*, audit.*, policy.updated) get runtime-assigned ts at the write boundary with caller timestamps refused; the non-gate carve-out preserved per the amendment text
- [ ] #14 A3: the scrutiny ratchet lands with its guard test (self-reported fields never reduce sampling, downgrade autonomy, or shortcut refusals)
- [ ] #15 Recovery verb: approval execution resolve <id> --outcome completed|failed --note "<text>" with the note mandatory and non-empty, human actor required, the event carrying attested_by_human: true plus the note, no attestation requirement, and help text explaining why (records facts, exercises no policy authority)
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Build in two sequential Opus subagent passes, fable review between: pass one (seams): B1 compare-and-append in log.ts + adoption at every check-then-append site with the true-concurrency test; S1 verified reads; S4 state.ts extraction; S5 hardened-parse dedup; S3 literal fixtures. Pass two (semantics): A1 payload_hash + payload-mismatch + spec text; A2 runtime-assigned ts with carve-out; A3 ratchet + guard test; S2 max_cost_usd at intake/grant/start; the execution resolve verb; the two dedicated codes. Spec text lands same-commit as its implementing pass.
2. Report anywhere A1 forced rework of frozen behavior vs extension.
3. Fable: gates from wiped install after each pass, finalize, merge, push.
<!-- SECTION:PLAN:END -->
