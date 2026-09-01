---
id: APRV-200
title: >-
  The harness hook's grant can follow the write it authorizes: PreToolUse
  returns before the human decides
status: To Do
assignee: []
created_date: '2026-09-01 19:18'
labels:
  - security
  - hook
dependencies: []
priority: high
ordinal: 165000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-08-30 22:32 UTC and recorded as comment #2 on APRV-151, where it was mis-filed as a silent hook miss. It is not one: the consent trail is complete. It is RETROACTIVE.

An Edit-tool call from the orchestrating session to /Users/carter/dev/approval-md/APPROVAL.md produced a full manual-path trail in the log — policy.edit registered at seq 3057, approval.requested seq 3058, approval.granted by human:carter at seq 3064 (22:37 UTC), execution.started with grant_seq at seq 3065 — and yet the Edit tool had already returned success and the modified file was on disk at ~22:32, five minutes BEFORE the grant landed. The session even observed its own unauthorized write in the interim: a policy-not-attested refusal fired against the modified bytes while the request was still pending.

So the write preceded its authorization. Every record says the right thing and the ordering they imply is false. This matters for three reasons that are separate from the APRV-151 bypass:

1. It defeats the property the manual path exists for. A human tap that arrives after the effect has landed is a ratification, not an approval, and SPEC.md 6.3 does not distinguish them anywhere a reader could notice.
2. execution.started carries grant_seq, which reads as 'this execution was authorized by that grant'. When the execution preceded the grant, that field is an assertion the log cannot support and an auditor has no way to detect from the record alone: the log carries no timestamp for when the tool call actually applied, only for when the gate learned of it.
3. It is adjacent to the carryover semantics of APRV-117 and APRV-150. A carried or adopted question whose write already happened is the same defect with a longer fuse, and whatever fix lands here has to say what carryover does when the bytes are already on disk.

What is NOT yet established, and is the first thing to establish: WHY the tool call returned before the hook's decision. Candidates worth separating are a hook timeout at the harness boundary (the entry in .claude/settings.json sets timeout 600 and the verb's own --timeout is 9m; a mismatch in either direction produces exactly this), a hook whose non-blocking return path is taken for file tools, and a harness that applies an Edit optimistically and consults the decision afterwards. Each implies a different fix and only one of them is fixable inside this runtime.

Related: APRV-151 (the CI-side protected-path grant cross-check, whose recency bound accepts a grant on either side of the commit precisely because this ordering is real and the guard is not the place to adjudicate it), APRV-117, APRV-150.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The mechanism is established and recorded: why the Edit tool returned success before the gate's decision, with the evidence that settles it between a harness-side timeout, a non-blocking hook return path, and optimistic application
- [ ] #2 The runtime states, in SPEC.md or in the hook's documentation, what a grant that arrives after its write means and whether it authorizes anything; if the answer is that it does not, the hook has a distinct refusal for it
- [ ] #3 A detection exists for the condition: from the committed log alone, an auditor can tell an execution that preceded its grant from one that followed it, or the task records why that is not derivable and what record would make it so
- [ ] #4 The carryover paths of APRV-117/150 are checked against this case, and what an adopted or carried question does when its bytes are already on disk is stated
- [ ] #5 npm test passes; lint clean
<!-- AC:END -->
