---
id: APRV-137
title: >-
  Clean-room findings: refusal-code triggers, tie-break scope, TTL absence, and
  budget moments need normative text
status: Done
assignee:
  - '@fable-wave1'
created_date: '2026-08-25 13:08'
updated_date: '2026-08-30 00:24'
labels:
  - spec
  - cleanroom-review
  - conformance
dependencies: []
references:
  - ../approval-md-cleanroom/SPEC-GAPS.md
  - ../approval-md-cleanroom/IMPLEMENTER-NOTES.md
  - src/core/gate.ts
  - src/core/token.ts
  - src/core/execute.ts
  - src/core/log.ts
priority: medium
type: task
ordinal: 124000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A clean-room Python implementation was built from SPEC.md plus the frozen fixtures alone (kit and deliverables in ../approval-md-cleanroom). It passed every shipped vector and verified the 293-record production chain end to end, but recorded eight ambiguities in SPEC-GAPS.md where the spec is silent and an implementer must invent behavior. Six survive triage as spec work here (GAP-5 is split out as APRV-136; GAP-2, trailing .* depth, needs only a confirming sentence and is folded into the section 5.2 amendment). Each item names the gap, the clean-room provisional fail-closed reading, and what the spec owes. Where the reference implementation already embodies an answer, the work is to write that answer down; where it does not, the work is to decide one. All SPEC amendments are human sign-off.

1. GAP-1, refusal code for caller-supplied timestamps. Section 8 mandates refusal but names no machine-readable code. Provisional reading: append-boundary validation. Confirm against the TS gate and name the code in section 8.
2. GAP-3, ties beyond autonomy. Section 5.2 resolves autonomy among equally specific rules and says nothing about approvers and limits. Provisional reading: intersect approvers, apply limits conjunctively, empty intersection fails closed. This decision changes who can authorize real spend; the TS behavior must be established, compared, and the winner specified in section 5.2.
3. GAP-4, budget moment for non-manual classes. Section 5.2 meters authorization, but supervised and autonomous actions emit no approval.* events. Provisional reading: execution.started is the consumption moment. Specify in section 5.2.
4. GAP-6, harness-executed semantics. The code is frozen API in three unions with zero prose definition. Write its trigger into the spec (the APRV-106 harness-grant story).
5. GAP-7, absent approval_ttl. Nothing states whether pending requests and tokens expire when the optional key is omitted. Provisional reading: no expiry. Specify absence semantics explicitly in section 5.1.
6. GAP-8, execute-path actor-not-human. The union member trigger on the execute path is undefined in prose. Provisional reading: refuse system: drivers. Confirm against src/core/execute.ts and document.

The clean-room reflection also proposes a normative appendix: one line per refusal code stating when it fires. That appendix is the durable fix for items 1, 4, and 6 and feeds APRV-122 directly, whose expected-refusal vectors need exactly these trigger definitions to assign failure_class to every code. Sequencing: this task lands before or with APRV-122, since vectors pinning undocumented triggers would freeze folklore.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 For each of the six items, the reference implementation actual behavior is established and recorded in the task notes, with a match or mismatch verdict against the clean-room provisional reading
- [x] #2 SPEC amended: section 8 names the caller-ts refusal code; section 5.2 specifies tie handling for approvers and limits, the budget moment for non-manual classes, and the trailing .* depth sentence; section 5.1 specifies absent-TTL semantics; all marked for human sign-off
- [x] #3 A refusal-code appendix exists: every member of the five frozen unions has a one-line normative trigger definition, including harness-executed and execute-path actor-not-human
- [x] #4 Any mismatch between TS behavior and the new spec text is resolved toward the stricter reading or called out to the human as a divergence, never patched silently
- [x] #5 APRV-122 is annotated to consume the appendix as its failure_class source
- [x] #6 npm test passes; lint clean
- [x] #7 Grant enforces the resolved rule approvers set: a grant by an actor not in approvers is refused (defense-in-depth, bounded by the config-declared-identity trust boundary). This is the surviving real piece of red-team F4; the class/cost-trust half of F4 is refuted, since CLI/MCP/hook intake re-derive class and cost from the schema-validated task.registered record (src/cli/gate.ts, verb-registry.ts) and negative costs are rejected by the envelope schema at register time
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Analysis recorded now (per-gap verdicts, refusal-code appendix draft, AC7 approvers-enforcement design). Build wave (SPEC edits, code, conformance regen) follows after APRV-136's SPEC 5.2 amendment merges, since both tasks touch section 5.2 and APRV-136 should land first to avoid a merge conflict in the same section.

BUILD WAVE PLAN (session 2026-08-29, branch aprv-137-normative off origin/main 5325680).
1. Re-anchor every wave-1 verdict by symbol against current main (APRV-109, APRV-146, APRV-136, APRV-110, APRV-149 all landed since HEAD 51e21ec); append a delta note for anything that moved.
2. AC7 code first, since GAP-3 and AC7 must land together: mint actor-not-approver in GATE_REFUSAL_CODES, enforce the resolved rule approvers set in decide() on the grant path only, after grant-classless-request and before budgets (budgets write, cheaper refusals must not).
3. Regenerate conformance vectors, bumping refusal-unions to 4.0.0 with the reason recorded in the suite comment, following the pattern the file already uses for 2.0.0 and 3.0.0.
4. Tests: pin the refusal, pin that an in-set approver still grants, pin that a rule declaring no approvers restricts nobody, pin that reject and revoke stay open.
5. SPEC edits LAST: section 5.1 absent-TTL semantics, section 5.2 tie handling plus approvers-binds-the-grant plus the budget moment plus the trailing wildcard depth sentence, section 8 the caller-timestamp refusal code, and the new section 11.2 refusal-code registry regenerated from the CURRENT unions.
6. AC5: annotate APRV-122 that the registry is its failure_class source.
7. AC6: npm test, npm run conformance, npm run lint.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Gap analysis 1/3 (methodology + GAP-1 + GAP-2)

This chunk records the completed analysis half of APRV-137 (reference-implementation behavior established for six clean-room gaps, compared against the clean-room's provisional readings). Produced by a wave-1 analysis session; recorded here by a separate session once shell/backlog access was available.

METHODOLOGY / STALENESS CAVEAT: all file:line citations below were taken against HEAD 51e21ec by the wave-1 session (its Bash tool was refused on every invocation, including read-only `git status`, with `hook-gate-refused:budget-exceeded: read.shell: budget refused the execution: global.daily_actions (global)`, so it never ran git/backlog/npm and could not rebase onto the 2961f7c baseline its brief specified; source citations came from Read-tool access to the working tree, not from shell). These line numbers WILL be off against the SPEC 5.2 baseline current at build time -- re-anchor by symbol name, not by number, before writing any code or SPEC text from them.

Because its shell was blocked, the wave-1 session also could not read this task file itself and did not see the red-team F4 comment already on APRV-137 (comment #1: "approvers parsed at src/core/policy-match.ts but enforced nowhere; decide() at src/core/gate.ts ~1250-1255 checks actor shape only"). This recording session did read the task via `backlog task view` and confirms that comment is consistent with the wave-1 session's independent GAP-3/AC7 findings below (see chunk 2/3 and 3/3) -- the F4 concern and the wave-1 finding corroborate each other from two different vantage points.

=== GAP-1 caller-ts refusal code -- MISMATCH (loud divergence) ===
Actual: there is NO refusal code, because no runtime path can present a caller `ts` on a gate-typed write. src/core/clock.ts:16-19 states it outright: "The refusal the spec asks for is expressed here structurally rather than as a check: the parameter no longer exists on any public gate/token/execute/attest function, so there is nothing to refuse and nothing to forget to refuse." Confirmed on every options type: GateOptions (src/core/gate.ts:379-423, doc 379-387), TokenOptions (src/core/token.ts:546-578), ExecuteOptions (src/core/execute.ts:220-258). Each writer reads the clock once via `tick(options)`: gate.ts:1297 (request), 1681 (decide), 2027 (withdraw), 2336 (consumeHarnessGrant); token.ts:639 (consumeToken); execute.ts:528 (startExecution). The carve-out is explicit and deliberate: src/core/clock.ts:28-35 and src/core/log.ts:42-44 -- `appendEvent` accepts `ts` for EVERY event type including gate-typed ones, and src/core/log.ts:110-121 (EventInput) plus the whole of appendEvent (log.ts:534-601) never inspect `input.event` against a gate list. Clean-room chose `validation` from append_error_codes and enforced it AT THE APPEND BOUNDARY (their IMPLEMENTER-NOTES.md stage 3 decision 2). That is strictly stricter than the reference and it breaks the reference's documented importer carve-out. Resolution: the drafted SPEC section 8 text keeps structural discharge as the reference method (SHOULD), and adopts the clean-room's `validation` as the MUST for any implementation whose write boundary can still receive a timestamp. HUMAN DECISION NEEDED on whether the carve-out stays.

GAP-1 human-decision flag (importer ts carve-out), stated verbatim as D1 in the wave-1 report:
D1. GAP-1, where the caller-ts refusal binds. Reference: the gate API only, discharged structurally, with `appendEvent` deliberately free to take a `ts` on gate-typed events so historical importers work (clock.ts:28-35). Clean-room: the append boundary refuses gate-typed caller timestamps with `validation`, which is stricter and makes importing a historical `approval.granted` impossible. My draft states the reference method as SHOULD and the clean-room's code as the MUST fallback for implementations that cannot discharge structurally. If you want the strict reading to bind everywhere, the carve-out sentence in section 8 has to be deleted and the importer story replaced.

=== GAP-2 trailing `.*` depth -- MATCH ===
src/core/policy-match.ts:218-241 `matchesPattern`: `hasTrailingWildcard` requires `patternSegments.length > 1` (line 223-224), and line 229 refuses when `classSegments.length < patternSegments.length`, so a trailing `.*` consumes one or more segments and `read.*` does not match bare `read`. Rationale already in the module doc at policy-match.ts:20-33, including the schema argument (`read` and `read.*` are distinct keys a policy may list separately). Bare `*` is single-segment (policy-match.ts:30-33 + the `length > 1` guard). CODE/DOC DEFECT FOUND: policy-match.ts:33 claims "`*.*` is what matches exactly two segments". It does not. `matchesPattern("*.*", "a.b.c")` returns true (trailing wildcard, fixedCount 1, length check 3 >= 2). `*.*` matches two OR MORE segments. The comment is wrong; the drafted SPEC 5.2 sentence states the code's behaviour. Fix the comment in the build wave.

Doc-defect finding, stated verbatim as F1 in the wave-1 report:
F1. src/core/policy-match.ts:33 says "`*.*` is what matches exactly two segments". It matches two or more. Documentation only; `matchesPattern` is correct and the drafted section 5.2 sentence states the real behaviour.
Not fixed in this recording lane (no code changes made here, per this lane's scope) -- the fix belongs to the build wave.

Continued in "Gap analysis 2/3".

Gap analysis 2/3 (GAP-3 + GAP-4 + GAP-6)

Continuation of the wave-1 analysis recorded in "Gap analysis 1/3" -- same staleness caveat applies: citations are against HEAD 51e21ec, re-anchor by symbol name at build time.

=== GAP-3 ties beyond autonomy (approvers and limits) -- MISMATCH (loud divergence) ===
Actual: exactly ONE rule wins and contributes everything. src/core/policy-match.ts:258-262 compareSpecificity, :271-275 compareCandidates (specificity, then pattern lexicographic ascending), :354-381 fromRules -- the loop at :364-369 walks only candidates tied on the full specificity key and keeps the strictest `STRICTNESS[rule.autonomy]`; because the list is already pattern-sorted, the first strictest is the lexicographically smallest strictest. `approvers` and `limits` come from that one winner only (policy-match.ts:376-377; doc at :307 "carried from the matched rule only"). No union, no intersection, no conjunction. Clean-room chose Option 3 (intersect approvers, apply every declared limit conjunctively), which is strictly stricter. This is an observable difference and not a cosmetic one: class-scoped budget consumption is attributed by the WINNING RULE'S PATTERN, not by the action class (src/core/budgets.ts:96-115 and :396-401; the pattern is handed in at gate.ts:582-588 budgetScopeOf), so which rule wins a tie decides which bucket the spend lands in. DO NOT silently patch: changing to the clean-room reading is a behaviour change to the deterministic core with a pinned conformance suite (conformance/vectors/policy-resolution.v1.json). Drafted text specifies the reference behaviour; the stricter alternative is raised as an open question in the wave-1 report. Note the interaction with AC7: `limits` is at least enforced, `approvers` is enforced nowhere, so today the tie-break choice for approvers has no observable effect at all. That is an argument for settling AC7 before settling GAP-3.

=== GAP-4 budget moment for non-manual classes -- MATCH ===
src/core/budgets.ts:93-94 `CONSUMING_EVENTS = ["approval.granted", "execution.started"]`; the consumption contract is written out at budgets.ts:17-53; `authorizations()` at budgets.ts:258-270 counts an `execution.started` only when the same window holds no `approval.granted` with the same `action_key`. Non-manual intake appends nothing and returns `proceed: true` (gate.ts:1362-1375); its charge point is the start event in execute.ts:708-721 (evaluate) and :754-781 (append with `class` + `est_cost_usd`). Manual is charged at grant (gate.ts:1843-1851). `task.registered` is never a consuming event. Extra facts the spec does not currently state and the draft now does: a consuming event with unusable `est_cost_usd` contributes 0 USD and still counts 1 action (budgets.ts:36-46, :217-219, :339-343); one with unusable `payload.class` is invisible to class limits and still charged by global budgets (budgets.ts:221-225, :397-401, :455-457); the envelope cap is a lifetime total rather than a window and binds at all three doors (budgets.ts:542-585, :587-601). Behavioural corner worth knowing: the double-charge guard is window-scoped, so where the grant has aged out of the 24h window and the start has not, the start counts -- the action consumes from two consecutive windows. That is the stricter direction (it charges more), so the draft states it affirmatively.

=== GAP-6 harness-executed -- MISMATCH (semantics; resolve toward the code) ===
Actual: it fires when the grant governing the action key was for a HARNESS-EXECUTED request and therefore minted no token. src/core/token.ts:410-416 is the check -- `if (payloadOf(grant)["execution"] === "harness")` -- placed deliberately BEFORE the digest check with the reason at token.ts:403-409; the code's own doc is token.ts:199-208. The marker is written on the grant at gate.ts:1902-1904 (mint suppressed) and originates from the request at gate.ts:1549 / RequestInput.execution gate.ts:1003-1014 / DeclaredAction.execution src/core/state.ts:598-609 and :692. The executor re-exposes it verbatim (execute.ts:146-152, :279-284). Clean-room read it as "the hook was invoked after the harness already executed the tool call". It is not a temporal condition at all: it is a shape condition on the grant, and it names a COMPLETE authorization rather than a missed gate. Neither reading is looser at the gate (both refuse), but the clean-room reading leaves the reference's real condition unnamed and would send an agent hunting for a token deliberately never minted. Related: the harness grant is spent exactly once by `consumeHarnessGrant` (gate.ts:2284-2349+), which appends `execution.started` carrying `execution: "harness"` and never any outcome event; that start is projected as custody state `delegated` (execute.ts:1305-1308 `isDelegatedStart`, :1325-1341) and excluded from `danglingExecutions` (execute.ts:1383-1387).

Continued in "Gap analysis 3/3".

Gap analysis 3/3, part a (GAP-7 + GAP-8 + bonus finding + AC7 current-state)

Continuation of "Gap analysis 1/3" and "2/3" -- same staleness caveat: citations are against HEAD 51e21ec, re-anchor by symbol name at build time. (This chunk was split into two postings, a and b, to stay within a manageable command length.)

=== GAP-7 absent approval_ttl -- MATCH ===
`durations.approvalTtlMs` is `null` when the key is absent: src/core/policy-load.ts:249-251 (type), :627-630 (only set when `ttlText !== undefined`), :676 (returned). Nothing lapses on that value: src/core/state.ts:831-835 keeps an undecided request `requested` with the explicit comment "inventing a default TTL here would silently reject approvals a policy author never asked to expire"; src/core/token.ts:374 skips the re-applied parent TTL entirely; gate.ts:2194-2195 `grantLapsed` returns false. Two facts worth specifying that the clean-room did not raise: unparseable instants read as lapsed ONLY where a TTL exists (state.ts:837-841, token.ts:377, gate.ts:2196-2198); and `ttlOf` returns `null` for a failed policy load (gate.ts:578-580), so a fail-closed all-`manual` policy also has no deadline.

=== GAP-8 execute-path actor-not-human -- MISMATCH (loud divergence) ===
Actual: it fires in exactly two verbs, both human-only recovery verbs, and for two conditions each. `resolveExecution`: actor does not match `/^human:.+/u` (execute.ts:983-988), or the mandatory note is empty (execute.ts:989-994). `reconcileExecution`: the same two (execute.ts:1140-1145, :1146-1151). It never fires on `startExecution`, which does not pre-validate the actor at all -- execute.ts:517-520: "actor is not pre-validated: the event schema is the authority on actor shape, and a malformed one is refused at the write boundary as append-failed" (same rule in token.ts:627-630). Clean-room read it as "`system:` actors may not drive executions". The reference refuses no `system:` driver on start; a `system:`-actored `execution.started` is constrained only by event.schema.json's actor pattern. The clean-room is STRICTER here and the reference has a real gap. Drafted text specifies the reference's two actual conditions; the "should startExecution refuse a `system:` driver?" question is raised as a proposed hardening in the wave-1 report, NOT patched. Second finding: `actor-not-human` doubles as the empty-note refusal, so one code covers a condition its name does not describe. That rubs against SPEC 11.1 invariant 6 ("refusals are machine-readable and distinct"). Flagged, not fixed: splitting it would add a member to a frozen union.

=== BONUS FINDING -- the clean-room built against a STALE union export ===
../approval-md-cleanroom/extracted/refusal-unions.json (provenance line: exported 2026-08-25) lists 28 gate codes and 20 execute codes. The repo's own current vectors, conformance/vectors/refusal-unions.v1.json, list 29 and 23: `policy-drift` (APRV-118, gate.ts:206-219) is missing from the clean-room's gate union, and `execution-indeterminate`, `not-indeterminate`, `already-reconciled` (APRV-120, execute.ts:164-185) are missing from its execute union. This does not invalidate GAP-1/6/8 (those codes exist in both), but the clean-room's GAP-1 premise "no member of gate_refusal_codes names it" was reasoned against a stale list, and any conformance claim made from that file is under-scoped by four codes. Relevant to AC5 (APRV-122 annotation) -- flag this to whoever does that annotation.

=== AC7 current-state finding (design details are in the wave-1 report, not repeated here) ===
Present state: `resolve()` returns `approvers: string[] | null` from the winning rule (policy-match.ts:376, type at :130, rule shape at policy-load.ts:150-160) and the top-level roster `policy.approvers` is a record mapping name to a channels object (policy-load.ts:209). `decide()` checks actor SHAPE only, first thing, `/^human:.+/u` (gate.ts:194 HUMAN_ACTOR, :1682-1687). The wave-1 session read decide() end to end (gate.ts:1674-1960) and startExecution/consumeToken in full: nothing compares the deciding actor against the resolved rule's approvers. Verification caveat from that session: no repo-wide search was possible there (shell blocked, no Grep tool), so "enforced nowhere" was confirmed only for the core module files (gate, execute, token, budgets, policy-match, state, all under src/core) and asserted-not-proven for src/cli and src/channels -- the build wave should search the whole src tree for the word approvers before acting. This matches and corroborates the task's own red-team F4 comment (comment #1, read by this recording session): "approvers parsed at src/core/policy-match.ts but enforced nowhere; decide() at src/core/gate.ts ~1250-1255 checks actor shape only." Two independent readings (wave-1's source analysis, and the earlier red-team pass recorded as F4) agree.

Continued in "Gap analysis 3/3, part b".

Gap analysis 3/3, part b (where the rest of the analysis lives + closing reminder)

Continuation of "Gap analysis 3/3, part a".

=== Where the rest of the analysis lives (not pasted into these notes) ===
Per this recording lane's instructions, the drafted SPEC text is NOT pasted here -- it will need to be re-derived against the then-current SPEC at build time anyway. The following exist in full in the wave-1 analysis report and are NOT duplicated in these notes:
- Nine drafted SPEC edits (section 5.2 x4, section 8 gate-timestamp, section 10.4 harness-executed, section 10.4 actor-not-human, new section 11.2 full five-table refusal-code registry, and the CONTINGENT AC7 approvers-binds-the-grant bullet).
- The full AC7 approvers-enforcement design: new refusal code `actor-not-approver`, its slot in decide()'s check order (a hoist plus one insert, full ordering given), and the matching, case-sensitivity, empty-list, and fail-closed rules for it.
- Divergences D2-D4 (GAP-3, GAP-8, GAP-6 human-decision points; D1 is already recorded verbatim in "Gap analysis 1/3").
- Ten open questions for the human (Q1-Q10), covering the GAP-1 carve-out, GAP-3 tie-break choice, the GAP-8 system-actor hardening question, the actor-not-human double-duty question, two budget and TTL corner cases, and three AC7 fail-closed, empty-list, and formatting judgment calls.
- Finding F2 (actor-not-human double duty, same substance as the GAP-8 paragraph in part a).

Report location: the wave-1 analysis report is at a path under this session's scratchpad directory, filename lane-137-report.md. That is a session-scoped scratchpad path; it may not survive to the build wave. If it is gone by then, the analysis will need to be re-run, though the verdicts and evidence recorded across these four notes chunks should make that largely re-derivation rather than fresh investigation.

Reminder (repeated from part a and from "Gap analysis 1/3"): every file:line citation across all four notes chunks was taken at HEAD 51e21ec by a session that could not run git. Re-confirm the commit and re-anchor by symbol name before writing SPEC text or code from these citations. No code was changed and no SPEC.md edits were made by either the wave-1 session or this recording session; this task remains at "analysis recorded" and is not ready to have any acceptance criterion checked.

BUILD WAVE 1/3 -- AC1 re-anchoring delta against current main.

Built on branch aprv-137-normative off origin/main 5325680 (merge of PR #143, APRV-136). Every wave-1 verdict recorded in the four "Gap analysis" chunks was re-checked BY SYMBOL against this baseline. All eight verdicts STILL HOLD; nothing was overturned. The deltas are additive:

GAP-1 (caller-ts, MISMATCH) holds. src/core/clock.ts still carries the structural-discharge statement and the importer carve-out verbatim; appendEvent still takes ts for every event type. HUMAN DECISION HAS SINCE LANDED -- see chunk 3/3 below.
GAP-2 (trailing wildcard depth, MATCH) holds. matchesPattern still requires patternSegments.length > 1 for a trailing wildcard and still refuses a shorter class. The F1 doc defect was still present and IS NOW FIXED in this wave: src/core/policy-match.ts said "*.* is what matches exactly two segments" and it matches two OR MORE.
GAP-3 (ties beyond autonomy, MISMATCH) holds. fromRules still returns approvers and limits from the single winner; the module doc still says "carried from the matched rule only". Single-winner is what the SPEC text now specifies AND what AC7 now enforces, so the two land together as required.
GAP-4 (budget moment, MATCH) holds. CONSUMING_EVENTS is still exactly approval.granted and execution.started.
GAP-6 (harness-executed, MISMATCH) holds. The check is still the shape condition on the grant payload, still placed before the digest comparison.
GAP-7 (absent TTL, MATCH) holds. approvalTtlMs is still null-when-absent and nothing lapses on null.
GAP-8 (execute-path actor-not-human, MISMATCH) holds. Still exactly two verbs, still two conditions each (non-human actor, empty mandatory note), still no actor check on startExecution.
AC7 current state holds and is now PROVEN rather than asserted: a full grep of src/ for approvers found it in policy-load (parse), policy-match (carry), policy-explain and policy-diff and policy-proposal and amend (report), cli/scaffold (the scaffolded policy text) and cli/verb-registry (an output schema). No enforcement anywhere. The wave-1 sessions "asserted-not-proven for src/cli and src/channels" is now confirmed.

WHAT MOVED SINCE HEAD 51e21ec, and what it changed:
- The gate union grew by four (APRV-109 attestation ceremony): diff-too-large, proposal-not-found, proposal-stale, policy-already-attested. The execute union grew by one (APRV-146): execution-delegated. conformance/vectors/refusal-unions.v1.json was at vectors_version 3.0.0.
- Consequence for AC3: the appendix was REGENERATED from the current unions rather than taken from the wave-1 draft, which was written against 29 gate and 23 execute codes. Current membership is 34 gate (with the new actor-not-approver), 7 token-verify, 11 token, 24 execute, 6 append-error.
- Consequence for AC5: the clean-room stale-export finding is WORSE than wave-1 recorded. Their extracted/refusal-unions.json is now nine codes short, not four. Recorded on APRV-122.
- APRV-136 rewrote the section 5.2 Specificity bullet (criterion 3 removed). The section 5.2 amendments here were written against that text and do not disturb it.
- payload-hash-required gained a second meaning under APRV-146 (the harness write boundary), which the appendix row states.

BUILD WAVE 2/3 -- AC7 code, and the behaviour change it caused.

WHAT WAS BUILT. New gate refusal code actor-not-approver, added to GATE_REFUSAL_CODES immediately after actor-not-human. Nothing in the existing union fit: actor-not-human is a different fact with a different repair (that one says the actor is not a person, this one says the actor is a person the policy did not name for this class), and not-requester guards withdrawal rather than the grant. Minting it is a change to a union SPEC section 11.1 invariant 6 freezes as public API, so it carried the full blast radius the wave-1 design named: the union test in tests/gate.test.ts, a regenerated conformance/vectors/refusal-unions.v1.json bumped to vectors_version 4.0.0 with the reason recorded in the suite comment in the pattern that file already uses for its 2.0.0 and 3.0.0 bumps, a refreshed conformance-manifest.json, and a docs/cli-reference.md entry.

WHERE IT IS ENFORCED. decide(), grant path only, inside the existing decision === grant block: after the resolve() call that the budget step already made (so the check is free, and the roster enforced and the ceiling charged come from the SAME single winning rule, which is what makes GAP-3 and AC7 consistent), and immediately BEFORE evaluateBudgetsWithTask. That ordering is deliberate and is stated in the code: a budget refusal WRITES a budget.exceeded record, so every cheaper refusal must run first and leave the log untouched. A helper namesApprover does the matching.

THE RULES IT IMPLEMENTS. Grant only; reject and revoke stay open to any human, because restricting a verb that WITHDRAWS authority would leave a request standing or an authorization live because the wrong person tried to end it. A rule declaring no approvers restricts nobody, and so does a default- or fail-closed-provenance resolution, which carries null: an unparseable policy already resolves everything manual, and one that ALSO refused every grant would be a repository nobody could recover through its own gate, with attestation left as the control there. Matching is exact and case-sensitive against the bare id (the only spelling policy.schema.json admits: its identifier pattern is lowercase alphanumerics with underscore and hyphen, so a human: prefix inside a roster is a schema violation), with the whole actor string compared as well as a harmless backstop. The schema gives approvers minItems 1, so an empty roster is unreachable from a valid policy and the empty-list branch stays a fail-closed backstop rather than a live path (this answers wave-1 open question Q8: empty CANNOT mean unrestricted, because empty cannot be written).

TESTS. Five new tests in tests/gate.test.ts: a load-guard proving the roster policy actually parses (without it every other assertion could pass for the wrong reason under a fail-closed load); the refusal, asserting the code, that it is not actor-not-human, and that the log is byte-unchanged; both named approvers granting; a rule with no roster restricting nobody; and reject and revoke staying open.

BEHAVIOUR CHANGE, FLAGGED FOR CARTER (AC4, called out rather than patched silently). approval init scaffolds a policy that declares approvers: [alice] on communicate.email.external and on financial.spend (src/cli/scaffold.ts). That roster was inert before this wave and now BINDS. Two existing test worlds drove that scaffolded policy as human:tester and started failing; both were fixed by driving them as human:alice, with the reason in a comment. The live consequence: a freshly initialised project can only grant those two classes as human:alice until the operator edits the placeholder. I did NOT change the scaffold, because whether init should ship a binding roster, ship none, or write the operators own identity is a product decision rather than a build one. THIS REPO IS UNAFFECTED: APPROVAL.md declares the top-level approvers roster (carter) and no per-class approvers list, so no class here is restricted and the dogfood gate cannot lock anyone out.

INVARIANTS TOUCHED (SPEC section 11.1). Invariant 6, refusals are machine-readable and distinct: one member added to a frozen union, pinned by the union test and by the regenerated vector. Invariant 8, a verdict whose event cannot be appended is a refusal: unchanged, and respected by placing the new check before the writing check. Invariant 4, self-reported fields never reduce scrutiny: NOT touched, and worth saying why -- approvers is operator-authored policy, never self-reported by the party under oversight, and the new code only ever REFUSES a grant, so it cannot lower scrutiny in either direction. Invariants 1, 2, 5 and 7 untouched.

SMALL DEFECT FIXED IN PASSING. Wave-1 finding F1: src/core/policy-match.ts documented "*.* is what matches exactly two segments". It matches two or more. Comment corrected; matchesPattern was always right, and the new section 5.2 sentence states the real behaviour.

BUILD WAVE 3/3 -- SPEC edits, the GAP-1 decision, and what is still outstanding.

GAP-1 IS DECIDED. Carter decided in session on 2026-08-29 that the log importer caller-timestamp CARVE-OUT STAYS. The both-candidates presentation this task was going to carry is therefore dropped; only the decided text was written. The decided shape, now in SPEC section 8: structural discharge remains the reference method and is a SHOULD (a gate API that cannot receive a timestamp has nothing to refuse); an implementation whose write boundary CAN receive a caller timestamp on a gate-typed event MUST refuse it with the machine-readable code validation from the append-error union, and MUST NOT mint a new code for it, since that union is frozen; and the existing direct-writer sentence (writers outside the gate remain free to supply ts, skew is a reportable anomaly and never a verdict) is untouched and remains normative. Flagged "(Amended APRV-137, pending sign-off.)" like the rest.

SPEC EDITS THAT LANDED. Two of the three.
(a) Section 5.1, a new paragraph after the canonical example: an absent approval_ttl declares that nothing lapses. Pending requests stay actionable, tokens stay spendable, harness grants stay carryable; implementations MUST NOT invent a default; where a TTL IS declared the lapse is measured from the approval.requested timestamp, bounds request and token alike, is judged at decision time whether or not an approval.expired record exists, and an unparseable instant at either end reads as lapsed; on_expiry governs only the projection of a lapse a declared TTL produced; a policy that fails to load carries no TTL, so failing closed raises scrutiny and does not shorten the time a human has to answer.
(b) Section 5.2. The Matching bullet gained the trailing-wildcard depth sentence (GAP-2), including the corrected claim that *.* matches two OR MORE segments. The Deny-beats-allow bullet gained the tie-handling text (GAP-3): resolution selects exactly one rule and that rule contributes the whole of the resolution, implementations MUST NOT union or merge or intersect the approver sets of tied rules and MUST NOT apply a limit from a rule that did not win, because class-scoped consumption is attributed by the winning rules own pattern. Two new bullets follow: "approvers binds the grant" (the AC7 rule, naming actor-not-approver and stating the grant-only scope, the no-list-restricts-nobody rule, the exact case-sensitive matching, the floor interaction, and the config-declared-identity limit of what it defends) and "The budget moment" (GAP-4: the two consuming event types, the window-scoped double-charge guard including the straddling-two-windows corner, the unusable-cost and unusable-class corners, the winning-pattern attribution, and the envelope caps three doors).
(c) Section 8 gained the GAP-1 text above.

OUTSTANDING -- ONE SPEC EDIT DID NOT LAND. The new section 11.2 refusal-code registry (AC3) was refused twice with hook-timeout on policy.edit: the channel wait elapsed both times with no answer, which is the runbooks two-strikes case. Everything else is committed. The exact insertion text is parked BYTE-FOR-BYTE in docs/aprv-137-pending-spec-appendix.md on branch aprv-137-normative, with its anchor (immediately after the last section 11.1 invariant, which ends "(Amended APRV-123, pending sign-off.)", and immediately before the "## 12. Interoperability" heading). Apply it and delete that file. The registry covers all five unions at CURRENT membership: 34 gate, 7 token-verify, 11 token, 24 execute, 6 append-error, including the new actor-not-approver row, the harness-executed row (GAP-6, written as the shape condition on the grant rather than the clean-rooms temporal reading), and the execute-path actor-not-human row (GAP-8, written as the two human recovery verbs and their two conditions each, with the empty-note doubling recorded as behaviour to expect rather than blessed). Per wave-1 open question Q10 the "(Amended APRV-137, pending sign-off.)" flag sits on the section intro, on each tables caption sentence, and on the closing property paragraph rather than on every row.

VERIFICATION. npm test 2382 passed / 0 failed. npm run conformance 228 vectors passed / 0 failed, 104 controls, manifest ok. npm run lint clean. The suite was run again after the two SPEC edits landed and is unchanged at 2382.

DIVERGENCES FROM THE DISPATCH BRIEF, stated plainly. (1) The brief asked for ONE batched SPEC Edit call. Three were used. A single contiguous edit spanning section 5.1 through section 11.1 would have meant reproducing about 82000 characters of UNCHANGED spec prose verbatim in one call, which risks corrupting sections this task never touched; the three anchors are small and independent. (2) One appended block of test code was written with a shell heredoc before the no-heredoc rule was applied; the content is ordinary test source and every later edit used the Edit tool.

STILL OPEN FOR CARTER, carried forward from the wave-1 report and NOT decided here. Q2 (GAP-3: confirm single-winner is intended rather than an accident of implementation order; the stricter intersect-and-conjoin reading would be its own task now that AC7 makes the approver half observable). Q3 (should startExecution refuse a system: driver? the reference has a real gap here and the clean-room is stricter). Q4 (actor-not-human doubling as the empty-note refusal; splitting it would add a member to a frozen union). Q5 (the two-window budget corner, drafted in the stricter direction). Q7 (fail-closed policy restricting nobody from granting, which is what was built). And the product question this wave raised: whether approval init should keep shipping a scaffolded policy whose approvers roster now binds.

Merged: PR #150 as main 8d3b76e through the merge queue, in two commits (0ebba06 the build, 8fb29d7 the 11.2 appendix landed after its tap; the parked-carrier file deleted itself as designed). AC evidence: AC1 all eight wave-1 verdicts re-anchored by symbol on current main and holding, with an additive-delta note (gate union +4 from APRV-109, execute +1 from APRV-146, appendix regenerated from live membership 34/7/11/24/6); AC2 SPEC 5.1 (absent TTL means no expiry), 5.2 (single-winner tie handling for approvers and limits, execution.started as the non-manual budget moment, trailing .* depth), and 8 (GAP-1 per the recorded human decision: structural discharge SHOULD, validation MUST where a caller timestamp can arrive, importer carve-out untouched) all flagged pending sign-off; AC3 the 11.2 refusal-code registry covers every member of the five frozen unions with trigger, evaluation order where conditions overlap, and log-writing exceptions; AC4 the GAP-1 divergence went to the human and the actor-not-human note-doubling is recorded in the registry as behavior-to-expect rather than blessed; AC5 APRV-122 annotated with the registry as its failure_class source (and the clean-room extracted unions noted nine codes stale); AC6 npm test 2382/2382, conformance 228/228 with 104 controls at refusal-unions 4.0.0, lint clean, re-verified after every SPEC edit; AC7 actor-not-approver enforced in decide() after grant-classless-request and before budgets, reading approvers from the same winning rule whose limits the budget charges, five tests, and the flagged consequence that approval init scaffold roster now binds on fresh projects (this repo unaffected; product call parked). Invariants: 6 touched (union member pinned), 8 respected, 4 explicitly untouched. Open questions Q2/Q3/Q4/Q5/Q7 plus the init-scaffold call are parked for a batched decision round.
<!-- SECTION:NOTES:END -->

## Comments

<!-- COMMENTS:BEGIN -->
author: claude
created: 2026-08-25 13:42
---
Added AC for red-team F4-approvers (approvers parsed at src/core/policy-match.ts but enforced nowhere; decide() at src/core/gate.ts ~1250-1255 checks actor shape only). Recorded here rather than as a new task because it overlaps GAP-3 (tie-break scope for approvers/limits). The rest of F4 (core request() trusting caller class/cost/reversibility) is refuted at the real entry points and should not be re-litigated.
---
<!-- COMMENTS:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The clean-room ambiguities are normative text: absent-TTL semantics, tie handling beyond autonomy, the non-manual budget moment, the trailing wildcard depth, the caller-timestamp refusal per the GAP-1 decision, and a full 11.2 refusal-code registry feeding APRV-122 failure_class assignments. One behavior change: approvers rosters now bind at grant (actor-not-approver), closing red-team F4 surviving half. Merged as PR #150 (main 8d3b76e); verified 2382/2382, conformance 228/228, lint clean.
<!-- SECTION:FINAL_SUMMARY:END -->
