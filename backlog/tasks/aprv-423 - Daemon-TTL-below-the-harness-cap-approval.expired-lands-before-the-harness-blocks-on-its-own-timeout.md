---
id: APRV-423
title: >-
  Daemon TTL below the harness cap: approval.expired lands before the harness
  blocks on its own timeout
status: To Do
assignee: []
created_date: '2026-09-21 06:42'
updated_date: '2026-09-22 02:16'
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
- [ ] #1 A hook-originated request carries the harness cap; the daemon's TTL for it is the smaller of policy TTL and cap minus a documented margin
- [ ] #2 In a test with a fake clock the daemon appends approval.expired strictly before the harness cap elapses, and the hook's block message names the expiry
- [ ] #3 A tap arriving after expiry is refused with the existing code for a request no longer pending and never becomes a grant
- [ ] #4 docs/hermes-hook.md and docs/claude-code-hook.md state the effective window
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## PR #535 carries this task; a second implementation was dropped (2026-09-22)

Two sessions built APRV-423 in parallel. **PR #535 (branch lane/aprv-423)** is
the one that lands. A second implementation on PR #539
(branch worktree-agent-ae6dd87c3cbb01931) was dropped after review: its commits
1c09b1b (the feature) and a9048e3 (a schema pin added under review) were removed
from that branch, which now carries only APRV-403 and APRV-425. Nothing from the
dropped work is in main or in any open PR.

The task stays To Do here rather than Done, because #535 is the PR that closes it
and it is not merged yet. The comparison below is kept so the choice is
reviewable later rather than being a decision nobody wrote down.

### Where the two implementations agreed

Both put the seam in the same place, which is the decision that matters most:
core/state.ts's requestState reads harness_cap_ms off the request's own
declaration and narrows the lapse arithmetic there, so every downstream reader
(decide, expire, lapsedRequests, findHarnessCarry, the queue, the channels)
inherits one answer and SPEC 10.2's 'the sweep changes no verdict' survives.
Both used HARNESS_CAP_MARGIN_MS = 60_000, justified identically as two of the
daemon's 30s DEFAULT_INTERVAL_MS. Both took the cap as a min against the policy
TTL, so it can only shorten (invariant 4). Both added --harness-cap and recorded
a duration, never an instant (invariant 2). Both left SPEC unedited and proposed
the hunk in their notes.

### Why #535 won: two of the differences were defects, not preferences

1. **grantLapsed was unbounded in the dropped version.** core/gate.ts:3343's
   grantLapsed takes the raw policy ttlMs, and findHarnessCarry calls it at :3388
   beside the requestState call the narrowing did cover. So a carried GRANT for a
   capped request was judged against the policy's hour: a retry could adopt and
   spend it past the point the harness abandoned the call, which is the hole this
   task exists to close, on the carry path. #535 takes the effective window there
   too.
2. **The Hermes default was wrong in the dropped version.** It assumed the 300s
   per-entry CEILING when no flag was passed, giving a 240s window. But
   plugins.hook_callback_timeout defaults to 30s and fails closed on
   pre_tool_call, so on a default Hermes install it asserted a T+240s deadline for
   a hook the harness kills at 30s — APRV-410's shape again with a fictional
   deadline, which is the failure this task was filed against. #535's F2 names it
   and splits capCeilingMs (a clamp on a stated flag) from capDefaultMs (30_000,
   the assumed value), refusing until an operator states one.

### The rest of what #535 has and the dropped version did not

3. A distinct refusal, hook-harness-cap-too-short, denied before anything is
   registered or requested, with the adapter's own repair sentence and the classes
   it refused for. The dropped version floored the effective TTL at 0 instead,
   which opens a question that lapses as it is asked: fail-closed, but it spends a
   log record and an approver's attention to say what a deny says for free.
4. A stricter schema pin: harness_cap_ms paired with execution: "harness"
   through dependentSchemas (a cap on a token-minting request would be a window
   shorter than the token's shelf life) and floored at HARNESS_CAP_MARGIN_MS + 1 =
   60001, pinned equal to the constant by a test, so a caller that skips the hook
   cannot open a zero-length window at the write boundary. The dropped a9048e3
   pinned only 'optional positive integer', which is strictly weaker.
5. Reach beyond the gate: cli/execute.ts reads derivation.effectiveTtlMs so
   `approval queue` shows a capped request its real remaining window (and a
   number rather than 'no TTL' under a policy that declares none), QueueEntry
   gains ttl_ms, and channels/telegram.ts gives every Delivery a per-request
   windowMs so buttons are forgotten when THAT request's window closes rather than
   the policy's. Without it a four-minute question renders as a sliver of the
   policy's hour.
6. appendExpiry records the EFFECTIVE ttl_ms and the harness_cap_ms that
   shortened it, so the expiry record says why its window was short.
7. Serve integration (cli/serve.ts, serve/server.ts), docs/cursor-hook.md, and
   ttl_ms in the queue verb's --json schema in verb-registry.ts.

### The two things worth porting onto #535

Small, and neither blocks it:

- A test that the cap constraint does not LEAK onto another event type, and the
  refused shapes a fixture set does not reach on its own (null, true, an array, an
  object). Cheap to add if #535's schema test does not already assert them.
- A HARNESS_PROCESS_CAP_MS-style table covering all six HarnessKinds explicitly,
  with null for the five that document no ceiling, reads as a checklist a future
  adapter has to answer. #535 puts the numbers on the adapter instead, which is
  the better home — that is already where originApp and defaultActor live — so
  this is a note rather than a recommendation.

### Why they could not both land

Both edited schema/event.schema.json's approval.requested block and
scripts/regen-conformance-vectors.mjs, with disagreeing vector versions (the
dropped pin bumped schema-validation 2.7.0 -> 2.8.0; #535 bumps refusal-unions
21.0.0 -> 22.0.0 for its new deny code and regenerates schema-validation from its
own fixtures). Both also edited docs/hermes-hook.md, docs/claude-code-hook.md,
docs/cli-reference.md, src/cli/help.ts, src/cli/hook.ts, src/core/gate.ts,
src/core/harness-wait.ts and src/core/state.ts.

### What the duplication cost, and what would have caught it

A session each. The check that would have caught it is a look at open PRs by task
id before a lane starts; the review round trip that added a9048e3 while #535
already carried a stronger pin was avoidable for the same reason.
<!-- SECTION:NOTES:END -->
