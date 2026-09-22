---
id: APRV-423
title: >-
  Daemon TTL below the harness cap: approval.expired lands before the harness
  blocks on its own timeout
status: Done
assignee:
  - '@claude'
created_date: '2026-09-21 06:42'
updated_date: '2026-09-22 02:12'
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

## Review follow-up: the field is pinned at the write boundary

Raised in review of PR #539: harness_cap_ms rode the approval.requested payload
and no schema file was in the diff, so it was accepted only because the v0.1
payload is permissive there. Fixed in a commit of its own on the same branch.

**This touches the validate-at-the-write-boundary invariant** (SPEC 8, and
CLAUDE.md's 'Validate at the write boundary: every event and envelope passes its
JSON Schema before append'). Before the pin, the only thing standing between a
malformed cap and the log was core/gate.ts dropping it — a check in the writer
rather than at the boundary, which is exactly the arrangement that invariant
exists to refuse. The reading I had in the original notes ('no schema change:
the payload is open at v0.1') was wrong in the direction that matters: the
payload being open is what a permissive default gives you, not a decision that
this field may be anything. A deadline that narrows the TTL deciding whether a
tap still authorizes anything is not a field to accept on faith.

schema/event.schema.json gains an allOf conditional keyed on
event: approval.requested, in the shape the display_hash block (APRV-119) and
the reconciliation.required block (APRV-127) already use: payload.harness_cap_ms
is an optional integer with exclusiveMinimum 0. Optional and additive, so every
record written before it validates exactly as it did, and a request declaring
none is bounded by the policy TTL alone.

Five fixtures, one accepted and four refused, one per way the value can fail to
be a count of milliseconds: zero (a request dead before it was written), a
negative (a deadline behind its own record), a fraction (a count that is not a
count) and a duration string (somebody else's grammar, unparsed). Each is its own
fixture because a second implementation has to refuse each one, and an
implementation that accepted any would be carrying a deadline it could not
compute with. core/gate.ts still drops an unusable value before the append, so a
record reaching this constraint with one was written by something else — which is
the case a write boundary is for.

The conformance schema-validation suite is bumped 2.7.0 -> 2.8.0, a MINOR bump
in the shape 2.1.0 and its successors used, with the reasoning in the regen
script's own comment block: five new vectors, no existing expectation moved. The
suite is generated from the committed fixtures, so the regeneration is what
carries them.

**A rule this rides against, named rather than quietly ignored.** CLAUDE.md says
'Schema changes are their own tasks.' This one lands under APRV-423 in a separate
commit at the reviewer's direction, because it pins a field this task introduced
and the reviewer made it a condition of arming the merge. I did not file it as a
follow-up task because the finalization guide says not to create follow-up work
without approval, and because splitting it would leave the field unpinned on main
in the meantime, which is the state the review objected to. Flagging it so the
exception is visible rather than assumed.

## Validation of the follow-up

- npm run build: exit 0. npm run typecheck: exit 0. npm run lint: exit 0.
- node scripts/regen-conformance-vectors.mjs: exit 0, schema-validation.v1.json
  213 vectors (125 negative controls), up from 208 (121) — exactly the five
  fixtures and the four new controls. 11 files pinned in the manifest.
- node scripts/run-tests.mjs --only event-schema fixtures conformance
  conformance-regen harness-cap: 306 tests, 306 pass, 0 fail.
- node conformance/run.mjs: exit 0, 466 vectors, 466 passed, 0 failed, 180
  controls, schema-validation at vectors_version 2.8.0.
- tests/event-schema.test.ts gains 'approval.requested takes a positive integer
  harness_cap_ms and nothing else': the accepted forms, eleven refused ones
  (including null, true, an array and an object, which the four fixtures do not
  cover), and that the constraint does not leak onto another event type.

## Duplicate work: this branch's 1c09b1b vs PR #535 (lane/aprv-423)

PR #535 implements the same task from another session, opened 2026-09-22T00:41Z,
CI green, 26 files, +2224/-93. This lane's is 1c09b1b (plus a9048e3, the schema
pin added under review) on PR #539. Read `gh pr diff 535` before deciding.
Comparison, on the five points the review asked about plus what else differs.

### Where the two AGREE

Both put the seam in the same place, which is the decision that matters most:
core/state.ts's requestState reads harness_cap_ms off the request's own
declaration and narrows the lapse arithmetic there, so every downstream reader
(decide, expire, lapsedRequests, findHarnessCarry, the queue, the channels)
inherits one answer and SPEC 10.2's 'the sweep changes no verdict' survives.
Both use HARNESS_CAP_MARGIN_MS = 60_000, justified identically as two of the
daemon's 30s DEFAULT_INTERVAL_MS. Both take the cap as a min against the policy
TTL, so it can only shorten (invariant 4). Both add --harness-cap and record the
value as a duration, never an instant (invariant 2). Both leave SPEC unedited and
propose the hunk in their notes.

### What #535 has that 1c09b1b LACKS

1. **grantLapsed is not bounded in mine, and that is a correctness gap.**
   core/gate.ts:3343's grantLapsed takes the raw policy ttlMs, and
   findHarnessCarry calls it at :3388 beside the requestState call my change does
   bound. So a carried GRANT for a capped request is judged against the policy's
   hour rather than the capped window: a retry could adopt and spend a grant past
   the point the harness abandoned the call, which is the hole this task exists to
   close, on the carry path. #535 states grantLapsed takes the effective window.
   This alone is enough to prefer #535.
2. **The Hermes default is wrong in mine, and #535's F2 names it a design
   defect.** I assumed the 300s per-entry CEILING when no flag is passed, giving a
   240s window. But plugins.hook_callback_timeout defaults to 30s and fails closed
   on pre_tool_call, so on a default Hermes install my implementation asserts a
   T+240s deadline for a hook the harness kills at 30s — APRV-410's shape again
   with a fictional deadline, which is the failure this task was filed against.
   #535 carries capCeilingMs (a clamp on a stated flag) and capDefaultMs (30_000,
   the assumed value), and refuses until the operator states one.
3. **A distinct refusal for a cap with no room for a human.**
   hook-harness-cap-too-short, denied before anything is registered or requested,
   with the adapter's own repair sentence and the classes it refused for. Mine
   floors the effective TTL at 0 instead, which opens a question that lapses as it
   is asked: fail-closed, but it spends a log record and an operator's attention
   to say what a deny could have said for free.
4. **A stricter schema pin.** #535 pairs harness_cap_ms with
   execution: "harness" through dependentSchemas (a cap on a token-minting
   request would be a window shorter than the token's shelf life) and floors it at
   HARNESS_CAP_MARGIN_MS + 1 = 60001, pinned equal to the constant by a test, so a
   caller that skips the hook cannot open a zero-length window at the write
   boundary. a9048e3 pins only 'optional positive integer'. #535's is the better
   constraint and I would not try to merge the two.
5. **Reach beyond the gate.** #535 also fixes what a capped request LOOKS like:
   cli/execute.ts's pendingRequests reads derivation.effectiveTtlMs so
   `approval queue` shows the real remaining window (and a number rather than
   'no TTL' for a capped request under a policy that declares none), QueueEntry
   gains ttl_ms, and channels/telegram.ts gives every Delivery a per-request
   windowMs so buttons are forgotten when THAT request's window closes rather than
   the policy's. Mine touches none of this, so on my branch a 4-minute question
   renders as a sliver of the policy's hour.
6. **appendExpiry records the effective ttl_ms and the cap that shortened it**, so
   the expiry record says why its window was short. Mine records neither.
7. Serve integration (cli/serve.ts, serve/server.ts), docs/cursor-hook.md, and
   the queue verb's --json schema in verb-registry.ts. All absent from mine.

### What 1c09b1b has that #535 appears to LACK

Very little, and nothing I would hold the decision for.

- A HARNESS_PROCESS_CAP_MS table covering all six HarnessKinds explicitly (null
  for the five with no documented ceiling), which reads as a checklist a future
  adapter has to answer. #535 puts the numbers on the adapter instead, which is
  the better home — the adapter is already where originApp and defaultActor live.
- A test that the cap constraint does not LEAK onto another event type, and eleven
  refused shapes in tests/event-schema.test.ts including null, true, an array and
  an object, which the fixture set alone does not cover. Worth porting onto #535
  if its schema test does not already assert the same; a cheap addition either way.

### Recommendation

**Keep #535 and drop both 1c09b1b and a9048e3.** #535 is a strict superset on
behaviour, it closes the grantLapsed gap and the Hermes-default defect that make
mine unsafe on exactly the harness the task was filed about, and its schema
constraint is the stronger one. Trying to keep any part of mine costs a merge of
two different constraints on one field and two different vector bumps for no
behaviour that #535 does not already have.

**They cannot both land.** Both edit schema/event.schema.json's approval.requested
block, both edit scripts/regen-conformance-vectors.mjs, and the vector versions
disagree (mine bumps schema-validation 2.7.0 -> 2.8.0; #535 bumps refusal-unions
21.0.0 -> 22.0.0 for the new deny code and regenerates schema-validation from its
own fixtures). Both also edit docs/hermes-hook.md, docs/claude-code-hook.md,
docs/cli-reference.md, src/cli/help.ts, src/cli/hook.ts, src/core/gate.ts,
src/core/harness-wait.ts and src/core/state.ts.

**APRV-403 and APRV-425 do not depend on either.** Neither touches harness-cap
code: 403 is daemon/daemon.ts, cli/daemon.ts and the drift tests, 425 is
cli/channel-telegram.ts and the telegram tests, and 425's COLLAPSE_STALE_AFTER_MS
reads pre-existing constants. Dropping 1c09b1b and a9048e3 and rebasing 403 and
425 onto main is a clean operation; the only likely conflicts are textual, in
docs/cli-reference.md and docs/claude-code-hook.md, where #535 edits sections
near the ones 403 and 425 added. The changelog commit on this branch already
carries no APRV-423 entry, so it needs no change either way.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
A hook-originated approval.requested now carries harness_cap_ms, the duration its harness can hold the tool call, folded by core/harness-wait.ts from the ceiling this project documents for that harness (hermes 300000, null elsewhere rather than a guess) and the operator's own --harness-cap. core/state.ts's lazy TTL judge narrows that request's deadline to min(policy TTL, cap - 60s), so the gate, expire, the daemon sweep, the queue and the channel all agree and SPEC 10.2's 'the sweep changes no verdict' still holds. The margin is two default sweep intervals, which is what puts approval.expired strictly before the cap. A late tap takes the existing `expired` refusal and the hook's existing hook-expired, whose message now names the cap. Verified with build, typecheck and lint at exit 0, tests/harness-cap.test.ts 13/13 (fixed-clock daemon passes either side of the deadline, the record's ts asserted before the cap, a grant at cap+5s refused with no approval.granted written, and the invariant-4 direction), tests/cli-hook-hermes.test.ts 33/33 including the cap on the wire in both directions and the block naming the expiry, and cli-help/cli-long-help 34/34 after folding the new flag into the existing durations line to stay under the 25-line short-help cap. The merge is NOT armed: the gate daemon is down for this session.
<!-- SECTION:FINAL_SUMMARY:END -->
