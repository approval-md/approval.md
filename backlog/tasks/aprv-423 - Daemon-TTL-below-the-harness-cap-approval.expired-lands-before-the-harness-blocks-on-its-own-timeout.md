---
id: APRV-423
title: >-
  Daemon TTL below the harness cap: approval.expired lands before the harness
  blocks on its own timeout
status: Done
assignee:
  - '@claude'
created_date: '2026-09-21 06:42'
updated_date: '2026-09-22 01:18'
labels:
  - daemon
  - hook
  - ttl
dependencies: []
priority: medium
ordinal: 324000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Harness hooks bound the wait: Hermes caps a pre_tool_call entry at 300 seconds (docs/hermes-hook.md), Claude Code and Cursor have their own ceilings. When the harness times out first, the hook returns a block while the request is still pending on the phone, and a later tap becomes a grant on a call nobody holds (the shape APRV-410 describes from the retry side). Add a per-request TTL derived from the harness cap, so the daemon expires the request and appends approval.expired before the harness gives up, and the two records agree. The hook knows its harness and can pass the cap; the daemon takes the smaller of the policy TTL and the harness-derived one.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A hook-originated request carries the harness cap; the daemon's TTL for it is the smaller of policy TTL and cap minus a documented margin
- [x] #2 In a test with a fake clock the daemon appends approval.expired strictly before the harness cap elapses, and the hook's block message names the expiry
- [x] #3 A tap arriving after expiry is refused with the existing code for a request no longer pending and never becomes a grant
- [x] #4 docs/hermes-hook.md and docs/claude-code-hook.md state the effective window
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. core/harness-wait.ts gains the cap vocabulary, beside the wait and the grace it already holds: HARNESS_PROCESS_CAP_MS (the hard ceiling a harness imposes on one hook entry, where this project has an observed one: hermes 300000 from docs/hermes-hook.md, null everywhere else rather than a guessed number), HARNESS_CAP_MARGIN_MS = 60000 (two DEFAULT_INTERVAL_MS, so a lapse has one full sweep interval to happen in and the sweep that follows it has another), harnessCapMs(kind, operatorCapMs) = the smaller of the documented ceiling and an operator-declared entry timeout, and effectiveRequestTtlMs(policyTtlMs, capMs) = min(policyTtl, cap - margin), clamped at 0, cap-only when the policy declares no TTL.

2. The clamp goes in the LAZY judge, not in the sweep. core/state.ts: declaredFrom reads harness_cap_ms off the approval.requested payload (a finite positive integer, anything else null), RequestDerivation gains effectiveTtlMs, and requestState judges the lapse against effectiveRequestTtlMs rather than the policy TTL it was handed. Every caller - the gate's grant path, expire, lapsedRequests, the queue renderer, the channel - then agrees by construction, so SPEC 10.2's 'the sweep changes no verdict' still holds: the daemon appends a record for a lapse the gate would already have judged.

3. The field is a DURATION, never an instant (invariant 2): the hook states how long its harness can hold the call, and the deadline is computed from the record's own runtime-assigned ts. core/gate.ts takes RequestInput.harnessCapMs, validates it at the write boundary, and records payload.harness_cap_ms. No schema change: the event payload is open at v0.1 and schema changes are their own task.

4. Invariant 4 in one direction only: a cap can shorten the TTL and can never lengthen it (Math.min against the policy TTL), so a lying hook narrows its own authority. Pinned by a test that passes an absurdly large cap and gets the policy TTL back.

5. cli/hook.ts: --harness-cap <duration> for the operator's own entry timeout, folded with the documented ceiling by harnessCapMs, carried into request(). The hook-expired deny names the cap-derived window so the block message says WHY the request lapsed early.

6. docs/hermes-hook.md and docs/claude-code-hook.md state the effective window in the timeout sections they already have.

7. Tests: daemon suite with a fake clock (approval.expired appended strictly before the cap elapses, and not before the effective TTL), gate/state suite for the clamp and the invariant-4 direction, hook suite for the deny naming the expiry.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What was done

A hook-originated request now carries how long its harness can hold the tool
call, and the TTL that governs that request is the smaller of the policy's and
that cap minus a documented margin.

**The narrowing is applied in the LAZY judge, and that placement is the whole
design.** `core/state.ts`'s `requestState` reads `harness_cap_ms` off the
request's own `approval.requested` record and judges the lapse against
`effectiveRequestTtlMs(policyTtl, cap)`. Every caller inherits it: the gate's
grant path, `expire`, the daemon's `lapsedRequests`, the queue renderer, the
channel. SPEC 10.2's 'the sweep changes no verdict' therefore still holds — the
daemon records a lapse the gate would already have judged, rather than an
earlier deadline only the daemon knows about. Pinned by 'the sweep changes no
verdict: the candidate list agrees with the lazy judge'.

**The vocabulary is in core/harness-wait.ts**, beside the wait and the retry
grace it already held, because these are durations and every judgment made with
them is made by a caller holding the instant. HARNESS_PROCESS_CAP_MS names a
number for hermes alone (300000, the documented per-entry MAXIMUM in
docs/hermes-hook.md) and null for every other harness: Claude Code, Cursor,
Codex, Grok and Muse document a default rather than a ceiling, and a guessed
number in the one place a deadline is computed from is worse than no number.
harnessCapMs folds that with the operator's own --harness-cap; effectiveRequestTtlMs
is the min.

**HARNESS_CAP_MARGIN_MS is 60000, two DEFAULT_INTERVAL_MS.** A sweep appends
somewhere in [lapse, lapse + intervalMs], so one interval of margin would only
put the lapse before the cap and let the append land on it; two put the append at
cap - 30s at the latest. The guarantee is stated in terms of the DEFAULT interval
and the docs say plainly that a longer --interval gets a lapse before the cap and
may record after it, rather than pretending otherwise.

**No schema change.** The v0.1 event payload is open (schema/event.schema.json
constrains four names and nothing else) and CLAUDE.md makes schema changes their
own task. The shape is enforced at the write boundary in core/gate.ts (finite,
positive, floored to an integer, dropped otherwise) and re-validated by the
reader, so the payload never carries a number a reader would have to reinterpret.

## Invariants touched, and how each is kept

- **Invariant 4 (self-reported fields never reduce scrutiny).** The cap is
  authored by the party under oversight. It reaches the TTL only through a `min`
  against the policy TTL, so it can shorten the window and can never lengthen it:
  a shorter window is strictly less authority. Pinned twice, in the pure
  arithmetic ('a cap narrows the TTL and can never widen it') and on the wire
  ('an absurd cap on the wire does not extend the policy TTL',
  '--harness-cap narrows the hold further and never widens it').
- **Invariant 2 (gate-typed events never accept caller timestamps).** The field
  is a DURATION, never an instant. The deadline is computed from the
  approval.requested record's own runtime-assigned ts. Nothing in this change
  accepts a moment from a caller, and APRV-106's wait_until stays what it was:
  display text.
- **Invariant 6 (refusals machine-readable and distinct).** No member is added
  to any frozen union. A late tap takes the gate's existing `expired` code and
  the hook's existing `hook-expired`; what moved is the instant at which they
  start firing. The hook's block message names the cap, so an operator can tell a
  policy line they can raise from a ceiling their harness imposes.
- Fail-closed: a cap at or below the margin floors the TTL at 0 rather than going
  negative. A harness that cannot hold a call that long cannot hold one for a
  human, so the request is terminal rather than pending.

## A real loss, named rather than hidden

On hermes the effective TTL is 240s, which equals the documented `--timeout 4m`
wait exactly, so APRV-287's five-minute retry grace has no room on that harness
and a retry asks fresh instead of adopting. That is the arithmetic of a
300-second ceiling rather than a choice made here, and docs/hermes-hook.md states
it as consequence 3 of the effective-window section instead of leaving an
operator to discover it.

## No SPEC amendment needed

Checked deliberately, because a change to when a request dies looks like one.
SPEC 5.2's `defaults.approval_ttl` remains the policy's deadline and is never
lengthened; 10.2's sweep property is preserved by construction (above); 10.1's
harness-adapter section already says the adapter holds every class of the command
and answers before it runs. The cap is a per-request narrowing of an existing
deadline by a field an existing invariant already bounds, so nothing in SPEC says
anything this change contradicts. If a reviewer disagrees, the hunk would go in
10.2 beside the TTL-sweep paragraph, one sentence: 'A request MAY declare the
duration its requesting harness can hold the call, in which case the TTL that
governs it is the lesser of the policy's and that duration less an
implementation-stated margin; the declaration may only shorten the window.'

## Evidence per criterion

- **AC1** (the request carries the cap; TTL is min(policy, cap - margin)).
  tests/cli-hook-hermes.test.ts 'a request opened on this harness carries its
  documented 300s hold' reads harness_cap_ms: 300000 off the approval.requested
  payload a real hook invocation wrote, and '--harness-cap narrows the hold
  further and never widens it' reads 120000 and 300000 for the two directions.
  The arithmetic itself is tests/harness-cap.test.ts 'a cap narrows the TTL and
  can never widen it' and 'the margin leaves a default-interval daemon a whole
  sweep to append in'. The margin is documented in core/harness-wait.ts,
  docs/hermes-hook.md, docs/claude-code-hook.md and docs/cli-reference.md.
- **AC2** (fake clock; approval.expired strictly before the cap; the block names
  the expiry). tests/harness-cap.test.ts 'the daemon expires a capped request
  strictly before its harness cap elapses' runs the daemon in process on a fixed
  clock: a pass at ttl-1 appends nothing, the pass at ttl+30000 appends one
  approval.expired, the record's own ts is asserted to be less than cap ms after
  the request, and a third pass is idempotent. The block half is
  tests/cli-hook-hermes.test.ts 'a block on a lapsed request names the window
  that closed it': hook-expired, and the message matches "this harness's hold on
  one tool call".
- **AC3** (a late tap is refused with the existing code, never a grant).
  tests/harness-cap.test.ts 'a tap after the cap-derived expiry is refused and
  never becomes a grant': decide(grant) at cap+5000 refuses with code `expired`
  (the union member that already existed) and the log carries no
  approval.granted. The hook-side half asserts the same on the log.
- **AC4** (both docs state the effective window). docs/hermes-hook.md gains 'The
  effective window (APRV-423)' under its two-timeout section, with the 240s
  arithmetic and the retry-grace consequence; docs/claude-code-hook.md gains a
  section of the same name with the three-duration table, the no-documented-
  ceiling statement and a config example; docs/cli-reference.md documents
  --harness-cap and the hook-expired line.

## Validation

- npm run build: exit 0. npm run typecheck: exit 0. npm run lint (oxlint src
  tests): exit 0, no output.
- node scripts/run-tests.mjs --only harness-cap: 13 tests, 13 pass, 0 fail.
- node scripts/run-tests.mjs --only cli-hook-hermes: 33 tests, 33 pass, 0 fail
  (29 before this task, 4 added).
- node scripts/run-tests.mjs --only cli-long-help cli-help: 34 tests, 34 pass, 0
  fail. This one caught a real regression: the new flag pushed HOOK_HELP to 26
  lines against the 25-line cap in tests/cli-long-help.test.ts, so --harness-cap
  was folded into the existing durations line rather than given one of its own.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
A hook-originated approval.requested now carries harness_cap_ms, the duration its harness can hold the tool call, folded by core/harness-wait.ts from the ceiling this project documents for that harness (hermes 300000, null elsewhere rather than a guess) and the operator's own --harness-cap. core/state.ts's lazy TTL judge narrows that request's deadline to min(policy TTL, cap - 60s), so the gate, expire, the daemon sweep, the queue and the channel all agree and SPEC 10.2's 'the sweep changes no verdict' still holds. The margin is two default sweep intervals, which is what puts approval.expired strictly before the cap. A late tap takes the existing `expired` refusal and the hook's existing hook-expired, whose message now names the cap. Verified with build, typecheck and lint at exit 0, tests/harness-cap.test.ts 13/13 (fixed-clock daemon passes either side of the deadline, the record's ts asserted before the cap, a grant at cap+5s refused with no approval.granted written, and the invariant-4 direction), tests/cli-hook-hermes.test.ts 33/33 including the cap on the wire in both directions and the block naming the expiry, and cli-help/cli-long-help 34/34 after folding the new flag into the existing durations line to stay under the 25-line short-help cap. The merge is NOT armed: the gate daemon is down for this session.
<!-- SECTION:FINAL_SUMMARY:END -->
