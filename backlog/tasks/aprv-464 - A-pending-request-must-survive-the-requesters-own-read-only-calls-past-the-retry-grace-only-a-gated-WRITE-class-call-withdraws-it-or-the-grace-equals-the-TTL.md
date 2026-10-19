---
id: APRV-464
title: >-
  A pending request must survive the requester's own read-only calls: past the
  retry grace only a gated WRITE-class call withdraws it, or the grace equals
  the TTL
status: In Progress
assignee:
  - '@claude-nonav'
created_date: '2026-10-04 09:23'
updated_date: '2026-10-17 02:44'
labels:
  - ergonomics
dependencies: []
priority: high
ordinal: 351000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Evidence 2026-10-04: a network.call request for a git clone waited the hook's nine minutes, was denied into its five-minute retry grace, and was then withdrawn (approval.withdrawn, reason timeout) by the requester's next gated call, which was an autonomous read (a grep in a sweep). The human, who had just restarted the listener, found nothing to tap and the request had to be re-issued, twice. The withdrawal-by-next-call rule (APRV-106, APRV-410) is right for ownership; the trigger is too broad. A read that resolves autonomous should not consume the grace of an unrelated pending manual request, and the grace should not be shorter than the time a human needs to restart a listener.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A pending request is withdrawn by the requester's next gated call only when that call's class is not read-only (or when the requester issues an explicit withdraw); autonomous read classes leave it pending; tests on both
- [x] #2 The retry grace is configurable and defaults to the policy's approval_ttl for hook-originated requests outside the harness cap, with the hook message stating the actual window
- [x] #3 The hook's denial message names the pending request's action key and says which classes of later calls will withdraw it
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Rulings this builds on (Carter, 2026-10-17, decisions batch D-4 and D-5): only a gated call whose class is not read.* withdraws a pending request past the grace (or an explicit withdraw), and the default grace becomes the policy TTL, with one SPEC paragraph on SPEC.md 'A harness wait that expires'. APRV-410 AC2 gets no new refusal code.

1. src/core/harness-wait.ts: add defaultRetryGraceMs(ttlMs, waitMs). With a policy approval_ttl the default is the TTL less the wait (floored at zero), so the abandonment window (wait plus grace, measured from the request's own ts) equals the TTL and 'past the grace' and 'expired' are one moment. With no TTL the old 5 min stands.
2. src/cli/hook.ts: --retry-grace absent becomes null and is resolved in decideHarnessSteps once the policy is loaded (HookRun gains graceFromTtl for the wording). codex-bridge passes null so it shares the default.
3. src/cli/hook.ts: the two sweeps that take back OTHER invocations' questions (gateHarnessSteps intake, and the APRV-410 autonomous branch) run only when some class of the current call is side-effecting (core/loop.ts isSideEffectingClass, the predicate the loop floor already uses). A read-only call sweeps nothing. The own-keys withdrawal at the end of a wait is unchanged: it is the asking call ending its own question under its own configured grace.
4. Deny and announce text: name which later calls withdraw (a gated call whose class is not read.*), and when the grace came from the TTL say so, so the message states the actual window (AC2, AC3).
5. Tests: tests/cli-hook.test.ts (a read past the grace leaves the question pending; a non-read autonomous call sweeps it; a manual read call's intake sweeps nothing; default grace under a TTL policy keeps the question to the TTL and a late tap refuses expired), tests/harness-wait unit cases for defaultRetryGraceMs; update the APRV-410 case that used a read as the sweeper. Planted-bug check: revert the class gate and confirm the new read case fails.
6. Docs: docs/claude-code-hook.md, docs/hermes-hook.md where they state the default and the sweep; help.ts flag text; CHANGELOG Unreleased.
7. SPEC.md paragraph from the decisions batch in its own commit (needs Carter's attest).
8. Verify: npm run build, typecheck, lint, targeted suites, conformance, then node scripts/classify-tier.mjs --base origin/main --run.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-17 build (claude-nonav, branch nonav/aprv-464-withdraw-on-non-read). Rulings: Carter 2026-10-17, decisions batch D-5 (as drafted) and D-4 (no new refusal code for APRV-410 AC2).

What changed.
1. src/core/harness-wait.ts: defaultRetryGraceMs(ttlMs, waitMs). With a policy approval_ttl the default grace is the TTL less the wait, floored at zero, so the abandonment line (wait plus grace from the request's own ts, abandonedAfterMs) is exactly the TTL: past the grace and expired are one moment. With no TTL the old 5 min stands. HOOK_RETRY_GRACE_MS is kept as that fallback.
2. src/cli/hook.ts: an absent --retry-grace is null at parse time and resolved in decideHarnessSteps once the policy is loaded; HookRun gains graceFromTtl (wording only). cli/codex-bridge.ts passes null, so it shares the default.
3. src/cli/hook.ts mayWithdrawAbandoned(classes): the two sweeps that take back OTHER invocations' questions (gateHarnessSteps intake, and the APRV-410 autonomous branch) run only when some class of the current call is side-effecting, using core/loop.ts isSideEffectingClass (read or read.* is a read; an unknown class is side-effecting). A mixed read-and-write command sweeps. Deliberately unchanged: the own-keys withdrawal at the end of an expiring wait (the asking call ending its own question under its configured grace; under the default grace it never fires before the TTL), and pass-through allows (never swept, as before).
4. Wording (AC2, AC3): the hook-timeout deny names the action key (as before) and, with an operator grace, says the withdrawing call is THE NEXT GATED TOOL CALL THIS ACTOR MAKES WHOSE CLASS IS NOT A read.* CLASS; under the default grace it says the grace ends when the policy's approval_ttl does and that a later tap is refused (expired). The announce line adds the same clause. HOOK_DENY_CODES doc, help.ts flag text, docs/claude-code-hook.md, docs/hermes-hook.md, docs/codex-app-server-bridge.md and CHANGELOG Unreleased updated.
5. SPEC.md 'A harness wait that expires' amended with the batch's hunk, in its own commit, marked pending sign-off (needs Carter's attest).

Not changed, worth knowing: cli/channel-telegram.ts COLLAPSE_STALE_AFTER_MS still uses the 55s wait plus the 5 min constant to decide which pending requests a restarted listener collapses into one message. Collapsing decides nothing (collapsed requests stay decidable), so it was left; a follow-up may want it to read the TTL-derived window.

Invariants touched. SPEC 11.1 invariant 4 (self-reported fields never reduce scrutiny): the grace default comes from the attested policy's TTL and the caller's own flags; nothing the requester states enters it. Invariant 5 (compare-and-append): unchanged, withdraw still re-reads and compare-and-appends. Invariant 6 (refusals distinct): no union gained or lost a member.

Tests. tests/cli-hook.test.ts: APRV-464 cases (autonomous read past the grace leaves the question pending and the next write takes it back; a mixed command sweeps; a supervised read through the intake sweep leaves it and a supervised write takes it back; the default-grace deny states the TTL window; no-TTL policy keeps 5m). The APRV-410 sweeper case now uses a workspace write, and the APRV-410 deny-wording case passes --retry-grace 5m. tests/harness-cap-ttl.test.ts: two defaultRetryGraceMs unit cases; F7's literal 5m became 60m (the 1h TTL less a 1s wait).
Planted-bug check: with mayWithdrawAbandoned forced true and the default grace forced to 5m, the read case, the gated-read case and the TTL-wording case fail (3 fail, 10 pass of the APRV-464/410 set); restored, all pass.
npm run typecheck exit 0; npm run lint (oxlint src tests) exit 0; npm run conformance exit 0, vectors 669 passed 669 failed 0 controls 290.
node scripts/run-tests.mjs --only cli-hook harness-cap-ttl cli-hook-hermes cli-hook-codex gate harness-enum serve-concurrency hermes-wait-interrupt harness-wait-interrupt cli-hook-hermes-rules channels-telegram codex-bridge: tests 674, pass 674, fail 0, exit 0.
Status stays In Progress until the PR merges (the post-merge sweep closes it, as for APRV-479/503). Repository has no Postgres suite; the log is the JSONL file, and the tests above run through the real append path.

2026-10-17 fix round 1 (aprv#646 refute, 1 M / 5 S / 6 N). SPEC paragraph (still pending sign-off): the withdrawal deadline is now 'the requester's next non-read call the gate admits or asks about' (S4: a call the hook refuses before either sweep, such as human-only, sandbox-required or the unattended guard, withdraws nothing, as before this branch), and a read is 'a call every class of which is read or a read.* class (a read, as §10.2 counts one)', any other class making it a non-read call (S3, the mixed-call contradiction; N6 resolved by naming bare read as a read, which is what §10.2 and isSideEffectingClass already say, so no code change). hook-timeout deny: 'BY THE NEXT NON-READ TOOL CALL THIS ACTOR (<actor>) MAKES THAT THE GATE ADMITS OR ASKS ABOUT'; the default-grace form says 'no later tool call of this actor under the same grace does' (S5: a later call with its own shorter --retry-grace can still sweep, since abandonedRequests judges against the sweeping call's grace). Telegram first-cycle collapse (S2): staleness comes from the request's own expiry (ttl_remaining_ms, the effective TTL) and falls back to the hook's wait plus the 5m no-TTL grace only when nothing expires the request; the digest says 'older than their approval window' and no longer claims nothing is waiting or that a decision can still authorize a retry. Docs name the second residual (no-TTL policy, M1); CHANGELOG says --retry-grace 5m restores the old grace only (N5); harness-wait.ts states the one-millisecond boundary (N4). Left: N1, N2, N3 (each needs logic, not a wording fix). M1: Carter's decision (a), accept the no-TTL residual with no new code (D-4); it is named in both hook docs and the CHANGELOG, and APRV-410 AC2 stays ticked with the note there.
<!-- SECTION:NOTES:END -->
