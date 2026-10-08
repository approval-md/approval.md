---
id: APRV-117
title: >-
  Hook grant carryover: a decision after timeout still authorizes the retried
  command
status: Done
assignee: []
created_date: '2026-08-20 14:06'
updated_date: '2026-08-20 18:49'
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
- [x] #1 A grant landed after the hook wait elapsed authorizes a retry of the identical command within TTL, with no second prompt
- [x] #2 A retry while the original request is still pending adopts it rather than opening a duplicate; the phone never shows two prompts for one command
- [x] #3 A carried grant is consumed exactly once; a second retry after consumption is refused through the ordinary path
- [ ] #4 Replay bounds stated in SPEC and tested: same bytes, same cwd, once, within TTL; any difference is a new request
- [x] #5 Withdrawal behavior redefined coherently with APRV-106 and the decided-prompt annotations of APRV-113
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Merged as PR 106 (branch aprv-117-grant-carryover) after one merge-queue-caught semantic conflict with APRV-114 (the adoption test's curl specimen became an autonomous read; specimen now carries a body). Requests keyed by payload hash + cwd + class; adoption is read-only (a retry waits on the existing key and appends nothing, so duplicate prompts are impossible); consumption is one execution.started with execution: harness through compare-and-append on EVERY granted proceed, appended by the new gate.consumeHarnessGrant which re-checks attestation (the carried path is the only allow that never passes through request). Deliberately NO completion event: the runtime never observes the harness outcome, and a fabricated completed would clear loop-escalation streaks; the harness marker tells a reader why no outcome lands. Builder soundness fixes beyond the spec: a decided request is not immortal (token shelf-life rule applied to token-less grants, else hook grants never staled); hook prompts drop the now-false 'requester waits until' line (TTL is the governing deadline). Timeout no longer withdraws (carryover serves APRV-106's intent); withdrawal survives on SIGTERM, thrown failure, and intake refusal, reason cancelled; adopted keys never retracted by the adopter; APRV-113 annotations unchanged. AC 4 left UNCHECKED on its SPEC half: replay bounds (same bytes, same cwd, same class, once, within TTL, harness-only) are tested and documented in docs/claude-code-hook.md but not yet stated in SPEC - that amendment plus the section 6.3 withdrawal-rationale rewording and the harness execution-record shape are listed for the next spec pass, flagged per the ratified pending-sign-off convention. Invariants touched and named: compare-and-append on the new append site; gate-typed events runtime-timestamped; enforcement reads only verified records; the consumed-once rule reuses the gate's existing execution.started terminality rather than a second mechanism.
<!-- SECTION:NOTES:END -->
