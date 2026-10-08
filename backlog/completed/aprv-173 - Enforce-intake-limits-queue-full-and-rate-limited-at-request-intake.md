---
id: APRV-173
title: 'Enforce intake limits: queue-full and rate-limited at request intake'
status: Done
assignee:
  - 'agent:opus-lane-t'
created_date: '2026-08-31 01:15'
updated_date: '2026-09-02 09:03'
labels:
  - core
  - gate
dependencies: []
ordinal: 152000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Closes the SPEC 5.2 deferred-enforcement gap: limits.max_pending (per class and budgets.global.max_pending) and limits.requests_per_hour are validated policy vocabulary that no runtime reads. New pure module src/core/intake-limits.ts in the budgets.ts style (no I/O, injected evaluationTs, exhaustive tests): pendingCount derives simultaneously-pending from verified records (an approval.requested with no terminal event for its action_key and not TTL-lapsed; withdrawn excluded), class attribution via the winning rule's pattern exactly as budgets attribute; requestsInWindow counts approval.requested by origin over a rolling 1h half-open window. APPROVED SPEC READINGS (Carter, 2026-08-31): origin = the record's actor (runtime-assigned, unspoofable through MCP since --as is appended last; per-guest actors make it per-client) — state in the module header as the v0.1 reading of 'per origin'; refusals are machine-readable only, appending NO new event type (no schema 8 change). Wire into request() in src/core/gate.ts after legality checks (duplicate-request, already-executed) and before budget evaluation: these protect attention, not budget. Add queue-full and rate-limited to GATE_REFUSAL_CODES — a frozen-union addition SPEC 5.2 already promised by name; the notes must flag it and conformance vectors regenerate per the established pattern. Refused requests append nothing and do not count toward the window. Fail closed on malformed limits.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 pendingCount and requestsInWindow deterministic over fixture logs including TTL-lapsed, withdrawn, and terminal-state requests; window edges tested half-open on both sides
- [x] #2 request() refuses queue-full / rate-limited machine-readably, appends nothing, and refused requests do not consume window or budget
- [x] #3 Unset limits enforce nothing; malformed limits fail closed with a stated note
- [x] #4 GATE_REFUSAL_CODES gains both codes with conformance vectors regenerated and version-bumped per the refusal-union rules; implementation notes flag the union change and the origin=actor SPEC reading
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. New pure module src/core/intake-limits.ts, budgets.ts-shaped (no I/O, required evaluationTs, injected ttlMs): pendingCount(records, pattern|null, now, ttlMs) counts action keys whose requestState() derivation is 'requested' (so TTL-lapsed, withdrawn, decided and executed are all excluded by the same derivation the gate and the channels use, never a second implementation); requestsInWindow(records, origin, pattern, now) counts approval.requested by actor over (now-1h, now], half-open at the bottom and closed at the top, exactly as budgets.ts tiles its 24h window. Class attribution is the winning rule's pattern via matchesPattern, exactly as budgets attributes; the global scopes count every live request whatever its class. evaluateIntakeLimits() returns per-limit verdicts (class limits ascending, then global scope names ascending) and a conjunctive pass, each verdict naming the refusal code it would produce.
2. Refusal codes: max_pending -> queue-full, requests_per_hour -> rate-limited. Unset limit enforces nothing (AC 3); a limit that is present and not a positive finite integer fails closed with pass:false and a stated note, exactly as budgets.ts refuses a limit it cannot compare. Unknown limit names are NOT this module's business (budgets.ts owns them) and vice versa.
3. budgets.ts: max_pending and requests_per_hour stop being 'unknown limit' refusals there and are skipped with a comment naming intake-limits.ts as their enforcer. Without this, any policy declaring the vocabulary SPEC 5.2 already blesses refuses every request budget-exceeded. A test pins that the skip does not lose the limit: the same policy still refuses queue-full at intake.
4. gate.ts: GATE_REFUSAL_CODES gains queue-full and rate-limited (frozen-union addition, invariant 6), each with the doc comment the union's style requires; GateRefusal gains limits?: IntakeVerdict[]. request() evaluates intake limits after duplicate-request/already-executed and before evaluateBudgetsWithTask, off the manual/sampled path only (the proceed path has already returned: a request that appends no approval.requested consumes no approver attention). Refused: nothing appended, no window consumed, no budget consumed, no payload stored, no key minted. Refusal code is the first failing verdict in verdict order.
5. Origin = the record's actor, stated in the module header as the v0.1 reading of 'per origin' (Carter's approved SPEC reading, 2026-08-31).
6. Conformance ritual: npm run build, add two gate-verdicts vectors (queue-full, rate-limited) to scripts/regen-conformance-vectors.mjs, bump refusal-unions to 6.0.0 (a pinned array grew) and gate-verdicts to 2.1.0 (new vectors, no expectation moved), regenerate, review the diff, add both codes to the tests/gate.test.ts union pin and to the tests/conformance.test.ts reachable-code list.
7. tests/intake-limits.test.ts (pure module, exhaustive: TTL-lapsed, withdrawn, terminal, both window edges, malformed, unset, class attribution) plus gate-level tests through the real append path.
8. Surfacing: QUEUE.md renders an intake-limits section (pending against each declared cap) only when a cap is declared, so existing renders are byte-identical; docs/cli-reference.md gains both codes.
9. Drafted in implementation notes, never applied: SPEC 5.2 request-volume prose (the deferred-enforcement sentence and 'and logged', which this task's approved reading contradicts) and the two 11.2 registry rows, each flagged '(Amended APRV-173, pending sign-off.)'
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
WHAT LANDED

New pure module src/core/intake-limits.ts (budgets.ts-shaped: no I/O, no clock, injected evaluationTs and ttlMs). pendingCount() derives the queue through core/state.ts requestState() per requested action key, so every exit (grant, reject, revoke, withdraw, approval.expired, TTL lapsed by arithmetic with no record, execution) is honoured by the derivation that owns it and no second definition of pending exists. requestsInWindow() counts approval.requested by actor over (now-1h, now], half-open at the bottom and closed at the top, tiling exactly as budgets.ts tiles its 24h; a record with an unparseable ts is COUNTED (fail closed), matching budgets. Class attribution is the winning rule's pattern via matchesPattern, identical to budget attribution; a global budgets scope counts the whole queue. evaluateIntakeLimits() emits verdicts class limits ascending then global scopes ascending, conjunctive, and intakeRefusalOf() names the code of the FIRST failing verdict.

gate.ts: GATE_REFUSAL_CODES gained queue-full and rate-limited after budget-exceeded; GateRefusal gained limits?: IntakeVerdict[]; request() evaluates intake limits after duplicate-request/already-executed and before evaluateBudgetsWithTask. cli/gate.ts emits error.limits under --json (its own key, not verdicts). Exit codes unchanged: both fall to EXIT_INTEGRITY like every other gate decision.

DECISIONS AND DEFAULTS

1. Unset limit enforces nothing (AC 3), and that IS the conservative reading. SPEC 5.2 says these are a tripwire whose defaults are generous; a runtime-invented ceiling would refuse requests under a policy the human attested and read, naming a number that appears nowhere in the file they signed. Absent ceiling behaves like an absent approval_ttl. A DECLARED limit that is not a positive whole number fails closed with a note (0, negative, fractional, NaN, Infinity), as does a class limit offered with no pattern to attribute it and an unparseable evaluation instant.
2. Refusals append NOTHING, per Carter's approved reading (2026-08-31). Divergence from SPEC 5.2's literal 'excess is refused with reason rate-limited and logged' — flagged below, draft prose included. Rationale in the code: budget.exceeded exists because a budget refusal is a fact about a commitment audit must reconstruct; a record per refused flood request hands the flooder the log growth it was refused the queue for. The admitted requests are all still in the log to count from.
3. Precedence: queue-full outranks rate-limited when both fail (verdict order puts max_pending first). Stated normatively in the module and in the 11.2 draft: an agent that backs off a minute on rate-limited and retries into a full queue was told the smaller of the two facts.
4. Origin = the record's actor, the v0.1 reading of 'per origin', stated in the module header with Carter's reasoning (runtime-assigned, --as appended last under MCP, per-guest actors make it per-client).
5. Placement: after the legality checks (a duplicate is refused for being a duplicate, not for the queue it would have joined) and before budgets (attention is the scarcer resource, and a flood of in-budget requests passes every budget verdict). Off the manual path the check is unreachable by construction — the proceed: true return happens first — which is correct: an unsampled supervised or autonomous action appends no approval.requested and joins no queue. Pinned by a test.
6. budgets.ts NO LONGER refuses max_pending / requests_per_hour as unknown limits; it skips them by name from intake-limits' own exported list, on all three paths (class loop, global loop, unparseable-ts branch). This was load-bearing: before the change, ANY policy declaring the vocabulary SPEC 5.2 blesses had every request refused budget-exceeded by the module that does not own it. A test pins that the skip loses no ceiling (the same policy still refuses queue-full at intake).
7. policy-load.ts Policy type gained budgets[scope].max_pending. It has been in policy.schema.json since v0.1 and was missing from the TypeScript type — which is what a key nobody reads looks like from the inside.

GLOBAL INVARIANTS TOUCHED (CLAUDE.md requires naming these)

- Invariant 6, refusals machine-readable and distinct, and the frozen unions: two codes added to GATE_REFUSAL_CODES. Union pin extended in tests/gate.test.ts; conformance refusal-unions suite regenerated and bumped 5.0.0 -> 6.0.0 (the vector pins the whole array in definition order, so a longer union is a changed expectation and a major bump).
- Invariant 5, every check-then-append through compare-and-append: the new check reads read.records from the single verified read at the top of request() and appends nothing itself; the appends downstream still pass read.head, so nothing was added between a read and a write.
- Invariant 1, enforcement paths read only verified records: counted from readGateRecords' verified records only.

CONFORMANCE RITUAL

npm run build, then node scripts/regen-conformance-vectors.mjs, then review the diff. gate-verdicts gained two vectors (queue-full, rate-limited), each a scripted scenario whose expectation is computed, both asserting records: 3 — nothing appended. gate-verdicts 2.0.0 -> 2.1.0 (new vectors, no expectation moved). schema-validation 1.2.0 -> 1.3.0, sweeping in two env_stripped event fixtures an earlier task committed without a regen (same bonus APRV-185's regen produced; not this task's work, but leaving them uncovered would have been). tests/conformance.test.ts's reachable-code list gained both codes, so a future vector deletion fails the run.

SURFACING

QUEUE.md renders a 'Request-volume ceilings' table (ceiling, scope, pending, limit, headroom) computed by the same pendingCount the gate refuses from, and says '**full** — intake is refusing queue-full until it drains'. Rendered ONLY when the policy declares at least one max_pending, so every existing render is byte-identical and a reader is not trained to skip a heading that always says 'nothing to see'. This is where a human sees the standing condition, since the refusal itself is by design invisible in the log. The rate limit gets no row: it is per origin, so a number here would be a number for whichever origin the renderer picked. docs/cli-reference.md documents both codes under 'gate refusal codes', including the append-nothing difference from budget-exceeded and the precedence rule.

DRAFTED PROTECTED TEXT (NOT APPLIED — SPEC.md is protected; for Carter's amend ceremony)

SPEC 5.2, replacing the 'Request-volume limits' bullet:

  - **Request-volume limits.** `limits.max_pending` (per class or on a `budgets` scope): maximum simultaneously pending requests; further requests are refused at intake with reason `queue-full`. `limits.requests_per_hour` (per origin): rolling-window ceiling on request creation; excess is refused with reason `rate-limited`. Origin is the requesting actor, which the runtime assigns rather than the caller. Both refusals are machine-readable and append nothing: a log record per refused request would give a queue-flooder the log growth it was refused the queue for, and the requests that were admitted are all in the log to count from. A limit that is not declared enforces nothing; a limit that is declared and cannot be evaluated refuses. Pending is counted through the same derivation the queue projection uses, so the ceiling counts the queue a human is shown, and consumption is attributed by the winning rule's pattern exactly as budget consumption is. Defaults are generous; the purpose is a tripwire against queue-flooding and approver fatigue, which attack the human's attention rather than the action budget. Refused requests consume no budget and no window. (Amended APRV-173, pending sign-off.)

SPEC 11.2, two rows for the gate_refusal_codes table, placed immediately after budget-exceeded:

  | `queue-full` | Admitting the request would exceed a declared `max_pending` (§5.2), on the winning class rule or on a `budgets` scope. Evaluated after `duplicate-request` and `already-executed`, which say whether the request may exist at all, and before budgets, which write. Nothing is appended. Where a `requests_per_hour` ceiling is met in the same evaluation this code is the one reported, because the queue being full is the standing condition and the rate limit clears on its own. |
  | `rate-limited` | The requesting origin created more `approval.requested` records in the preceding hour than `limits.requests_per_hour` allows (§5.2). Origin is the record's actor. Counted over request creation rather than over live requests, so a request answered a minute after it was made still spent the origin's share of the hour. Nothing is appended, and the window is rolling. |

SPEC 11.2 preamble sentence ('a refusal leaves the log untouched unless its row says otherwise') needs no change: both new rows say nothing is appended.

VERIFICATION

npm run build clean, npm run lint (oxlint src tests) clean, full npm test: 2732 tests, 2731 pass, 0 fail, 1 skipped (the pre-existing opt-in SANDBOX_PROBE_EXTERNAL leg), exit 0. New suite tests/intake-limits.test.ts: 23/23. Targeted re-run of gate + budgets + render-queue + cli-gate + intake-limits + conformance after the last edits: 219/219. Every fixture log in the new suite is built through the real append path.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
SPEC 5.2's request-volume limits stop being vocabulary no runtime reads. New pure module core/intake-limits.ts counts the pending queue through the same requestState derivation the channels use and counts request creation per origin over a rolling half-open hour; gate.request() enforces both after the legality checks and before budgets, refusing queue-full or rate-limited with nothing appended (Carter's approved reading) and error.limits carrying the verdicts. budgets.ts stops refusing the two names as unknown limits, which is what made a policy declaring them refuse every request; the skip is pinned as losing no ceiling. Unset enforces nothing (argued: a runtime-invented ceiling would refuse under a policy nobody signed); declared-but-unevaluable fails closed. Frozen union grew by two (invariant 6): union pin extended, conformance regenerated with two new gate vectors both asserting nothing was appended, refusal-unions 6.0.0, gate-verdicts 2.1.0, schema-validation 1.3.0. QUEUE.md gained a Request-volume ceilings table (only when a ceiling is declared) so the standing condition behind an invisible refusal is visible to a human; cli-reference documents both codes. SPEC 5.2 prose and the two 11.2 rows are drafted in the implementation notes for Carter's ceremony, including the divergence from 5.2's literal 'and logged'. Verified: npm test 2732 tests / 2731 pass / 0 fail / 1 pre-existing skip, new suite 23/23, build and lint clean.
<!-- SECTION:FINAL_SUMMARY:END -->
