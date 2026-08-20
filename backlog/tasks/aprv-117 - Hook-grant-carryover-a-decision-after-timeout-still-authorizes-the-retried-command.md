---
id: APRV-117
title: >-
  Hook grant carryover: a decision after timeout still authorizes the retried
  command
status: To Do
assignee: []
created_date: '2026-08-20 14:06'
labels:
  - hook
  - ux
  - design
milestone: m-12
dependencies: []
priority: high
ordinal: 109000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
2026-08-20: two gated commits timed out because the human was not watching the phone; both requests were withdrawn (APRV-106 working as designed), and the human asked to extend the wait to 60 minutes. A longer wait is the wrong lever: the 9m wait already sits near the harness ceiling for a hook call, and a long wait blocks the whole session on every manual command.

Proposal: make the decision asynchronous instead of the wait longer.
- Key hook requests by payload hash (the exact command bytes plus cwd) instead of the per-invocation tool-use id.
- On intake, before registering a new request, look for an existing request for the same payload hash: still pending -> adopt it and wait out the remainder of its window rather than opening a duplicate; granted, within TTL, and not yet consumed -> proceed on it with no new prompt.
- On timeout, withdraw nothing if adoption is possible on retry; otherwise keep today's withdrawal. Design question to settle: whether the timed-out request stays pending for the policy TTL (so a later tap plus a retry succeeds) and what marks it consumed once a retried invocation proceeds on it, since hook grants mint no token. A consumed marker must go through compare-and-append like everything else (SPEC 11.1 invariant 5).
- Replay bounds to design explicitly: a grant authorizes the same bytes in the same cwd, once, within TTL. The idempotency_key vocabulary exists for exactly this.
- Invariants touched (must be named in implementation notes): gate-typed events never accept caller timestamps; every check-then-append passes through compare-and-append; enforcement paths read only verified records.

Interim option for the human (their file, their call): raise the wait moderately in .claude/settings.json (--timeout and the hook entry's own timeout must move together), accepting the session block. The carryover design makes that knob mostly irrelevant.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A grant landed after the hook wait elapsed authorizes a retry of the identical command within TTL, with no second prompt
- [ ] #2 A retry while the original request is still pending adopts it rather than opening a duplicate; the phone never shows two prompts for one command
- [ ] #3 A carried grant is consumed exactly once; a second retry after consumption is refused through the ordinary path
- [ ] #4 Replay bounds stated in SPEC and tested: same bytes, same cwd, once, within TTL; any difference is a new request
- [ ] #5 Withdrawal behavior redefined coherently with APRV-106 and the decided-prompt annotations of APRV-113
<!-- AC:END -->
