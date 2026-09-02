---
id: APRV-208
title: >-
  The live draw moves to the daemon: supervised-live selection answered over
  local IPC, so the sampling secret never enters an agent-launched process
status: To Do
assignee: []
created_date: '2026-09-02 08:03'
updated_date: '2026-09-02 08:21'
labels:
  - sampling
  - daemon
  - design
dependencies:
  - APRV-188
priority: high
ordinal: 172000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Verified 2026-09-02 (APRV-184 notes): every supervised-live action since the seq 5147 ceremony gated to a human, 15 of 15, because resolveLiveSelector reads APPROVAL_SAMPLING_SECRET from its own process environment and nothing sources it into a hook or gate process launched from an agent session. That is correct fail-closed behaviour and it also means supervised-live is manual in practice: policy.edit and log.advance cost a tap every time. SPEC forbids an agent-readable secret, so the fix is not to hand it to the hook. Outcome: the daemon, which the operator starts with the secret resolved (from the keychain or the env file, never from an agent session), owns the live draw. The hook and any other gate process ask the daemon over the local IPC surface APRV-188 introduces (owner-only Unix socket under the approval home): request carries the action key and payload hash, answer carries selected or not plus a MAC over the question that the asker records with its verdict, so a later verifier with the secret can recompute it. With no daemon, or a daemon that cannot answer, selection fails closed exactly as today. The audit.sampled record and the retrospective pool are unchanged. Why: supervised-live is the setting that makes the gate liveable, and it has never once been live.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 With the daemon running and the secret resolved in its process only, a supervised-live class resolves to executed-and-sampled roughly live_rate of the time from a hook process that has no secret in its environment, proven by a test that asserts the secret is absent from the hook child env and that selection outcomes over 200 fixture actions fall within a binomial band around live_rate
- [ ] #2 With no daemon, a stale daemon, or a daemon whose answer fails MAC verification, selection fails closed to a human decision, each with a distinct machine-readable reason recorded on the request
- [ ] #3 The daemon answer is bound to the action key and payload hash and carries a MAC the hook records; a fixture verifier with the secret recomputes it, and a tampered answer is rejected
- [ ] #4 The secret is read by the daemon from the same sources setup writes (keychain scoped item or the env file) and by nothing else; the hook test proves no gate process launched from a session reads it
- [ ] #5 SPEC section 6 or wherever the live draw is specified gains the daemon-answered draw paragraph, drafted in the notes pending sign-off; docs/dogfood-cutover.md explains that supervised-live needs the daemon up
- [ ] #6 npm test passes; lint clean
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Orchestrator (2026-09-02): APRV-188 shipped as a daemon-published verified-head snapshot file, not a socket, because the hook request path is synchronous end to end and a node:net client cannot be awaited from it. So the IPC this task needs does not exist yet. Options for the draw: (a) a spawnSync helper that asks the daemon over an owner-only socket under the approval home (20-40 ms node start, acceptable for a supervised-live draw since it is off the pass-through path); (b) a file-based request/answer with the daemon polling (slow, avoid); (c) pre-published answers (not viable). Recommend (a), with the MAC as specified. The dependency on 188 stays for the verified-snapshot pattern and the doctor row shape.
<!-- SECTION:NOTES:END -->
