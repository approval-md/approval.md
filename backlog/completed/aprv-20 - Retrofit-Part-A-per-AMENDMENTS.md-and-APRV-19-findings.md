---
id: APRV-20
title: Retrofit Part A per AMENDMENTS.md and APRV-19 findings
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 02:21'
updated_date: '2026-08-05 15:32'
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
Code retrofit per the human's AMENDMENTS.md Part A (NOTE: AMENDMENTS.md is not yet present in the repo as of task creation, 2026-08-05 — this task is additionally blocked on that file landing on main; the human's message also references the dangling-execution recovery verb "as specced" therein). Scope adjusted by APRV-19's blocker/should-fix findings. Includes: the approval execution resolve verb (the human-specced recovery verb for dangling executions), the dedicated refusal code for grant-on-classless-request, and the dedicated append-error code for attestation's actor refusal. Spec amendments accompany their implementing code same-commit per the standing rule.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 AMENDMENTS.md Part A items implemented per the file's text, scope adjusted by APRV-19 findings adopted into this task
- [x] #2 The dangling-execution recovery verb lands as specced in AMENDMENTS.md, human-only, with frozen exit codes and --json shape
- [x] #3 Dedicated refusal code for grant on a classless request replaces the fail-closed empty-string path, with tests
- [x] #4 Dedicated append-error code for attestation's human-actor refusal replaces the reused validation code, with tests
- [x] #5 All spec amendments tied to Part A land in the same commits as their implementing code
- [x] #6 B1: appendEvent gains a compare-and-append head precondition; a moved head refuses under the lock with a new machine-readable code; every check-then-append site in gate, token, and register adopts it; required test: two genuinely concurrent consumers of one token — exactly one execution.started lands, the loser receives the moved-head code
- [x] #7 S1: gate, token, and execute operations read only chain-verified records, with an in-code note that linear-cost verification is accepted at v0.1 and head-caching is an M5 optimization
- [x] #8 S2: envelope max_cost_usd enforced conjunctively with policy budgets at intake, grant, and execution start (max_latency deferred to the APRV-21 spec note)
- [x] #9 S3: literal frozen JSON fixtures replace self-referential derivation for the verify and policy-explain shapes; shape drift now fails loudly
- [x] #10 S4: shared state derivation extracted to state.ts; the gate-token module cycle is dissolved
- [x] #11 S5: one exported hardened YAML parse; the frontmatter replica deleted; a test proves both paths share the single implementation
- [x] #12 A1 handling: payload_hash with token binding and payload-mismatch as a distinct reason within existing exit classes; channel display obligations recorded in spec per the amendment text; anywhere binding payloads required REWORKING frozen behavior rather than extending it is reported to the human
- [x] #13 A2: gate-typed events (approval.*, execution.*, budget.*, audit.*, policy.updated) get runtime-assigned ts at the write boundary with caller timestamps refused; the non-gate carve-out preserved per the amendment text
- [x] #14 A3: the scrutiny ratchet lands with its guard test (self-reported fields never reduce sampling, downgrade autonomy, or shortcut refusals)
- [x] #15 Recovery verb: approval execution resolve <id> --outcome completed|failed --note "<text>" with the note mandatory and non-empty, human actor required, the event carrying attested_by_human: true plus the note, no attestation requirement, and help text explaining why (records facts, exercises no policy authority)
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Build in two sequential Opus subagent passes, fable review between: pass one (seams): B1 compare-and-append in log.ts + adoption at every check-then-append site with the true-concurrency test; S1 verified reads; S4 state.ts extraction; S5 hardened-parse dedup; S3 literal fixtures. Pass two (semantics): A1 payload_hash + payload-mismatch + spec text; A2 runtime-assigned ts with carve-out; A3 ratchet + guard test; S2 max_cost_usd at intake/grant/start; the execution resolve verb; the two dedicated codes. Spec text lands same-commit as its implementing pass.
2. Report anywhere A1 forced rework of frozen behavior vs extension.
3. Fable: gates from wiped install after each pass, finalize, merge, push.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Two-pass Opus build, fable review between. PASS 1 (seams): B1 compare-and-append (expectedHead under the lock, head-moved code, adopted at every check-then-append site; attest documented as exempt — no read-dependent check; TRUE concurrency test with two child processes barriered on the parent-held lock, 3 rounds, exactly one execution.started ever lands); S1 verified reads via state.ts readVerifiedRecords (log-corrupt code; v0.1 linear-cost note in header); S3 literal frozen fixtures (cli.test no longer imports verify; explain candidates are literal arrays); S4 cycle dissolved (token no longer imports gate — source-scan test); S5 one hardened parse (parseHardenedYaml; frontmatter replica deleted; alias-bomb proven through both paths). PASS 2 (semantics): A1 payload_hash (schema + fixtures; payload-hash-required at manual intake; grant records the hash; consume/start require presentedPayloadHash; approval run auto-computes runPayloadHash(argv,cwd) with --payload-hash override; SPEC 6.2/10.4/11 verbatim incl. not-defended splice); A2 runtime clocks (ts dropped from all gate-typed writer signatures; injected clock option; appendEvent keeps ts per the section 8 carve-out; arity-pinned tests); A3 ratchet (source-scan + behavioral guards: confidence 0.01 vs 0.99 identical outcomes; zero-cost still charges daily_actions); S2 evaluateBudgetsWithTask at intake/grant/start (task-scope verdict appended last, order stable); resolve verb (mandatory non-empty note, human actor, attested_by_human:true, exit_code null, no attestation — help explains it records facts and exercises no policy authority); dedicated codes grant-classless-request (gate) and actor-not-human (new ATTEST_ERROR_CODES extending APPEND_ERROR_CODES rather than widening the writer union — rationale documented). A1 REWORK-VS-EXTEND (human-required report): four frozen shapes reworked — approval.requested, approval.granted, execution.started payloads gained payload_hash, and consume/start now demand the binding (previously any valid token spent); plus attest actor code validation->actor-not-human and grant no longer substitutes class:"". FABLE OVERRIDE (stricter-path invariant): flipped the agent's judgment call — a grant recorded without payload_hash refuses consumption (payload-mismatch, "predates content binding", remedy revoke+re-request) instead of accepting; new test proves a valid token cannot spend a binding-less grant. Verify-side skew check deliberately not implemented (M5, spec text only). max_latency untouched (APRV-21 note); register now copies the envelope budget block into task.registered for M4/M5. Verified from wiped node_modules/dist: 703/703, lint, typecheck.

Date corrected in place per the 2026-08-05 human ruling (log-is-authoritative, applied to all APRV-46 findings): prose previously claimed 2026-08-07; this task's own created_date (2026-08-05) is the cited source. The wrong date was orchestrator confabulation, part of the systematic drift reported in APRV-46.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Full consolidated retrofit: compare-and-append closing the B1 race (true-concurrency proof), verified reads on every enforcement path, content binding of approvals to payload bytes with fail-closed legacy grants, runtime-assigned clocks on gate-typed events, scrutiny ratchet guards, envelope max_cost_usd conjunctive enforcement, literal frozen wire fixtures, dissolved module cycle, single hardened YAML parse, execution resolve verb, and two dedicated refusal codes — with AMENDMENTS.md Part A spec text landed verbatim same-commit. Verified: 703/703, lint, typecheck from wiped install.
<!-- SECTION:FINAL_SUMMARY:END -->
