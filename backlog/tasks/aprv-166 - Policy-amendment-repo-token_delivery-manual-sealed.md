---
id: APRV-166
title: 'Policy amendment: repo token_delivery manual -> sealed'
status: To Do
assignee: []
created_date: '2026-08-30 22:31'
updated_date: '2026-09-01 18:46'
labels:
  - policy
dependencies: []
ordinal: 145000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Directed by Carter in session 2026-08-30 after the APRV-159 manual-token handoff friction (grant tapped on Telegram, token printed once on the listener terminal, human had to relay it into the session). Sealed delivery (APRV-105, built and proven on the demo instance) removes the relay while keeping the channel free of usable tokens: the token is sealed to an ephemeral X25519 key held beside the log; only the requesting process opens it. Change: defaults gains token_delivery: sealed in APPROVAL.md. Path: gated one-line edit (policy.edit tap), then approval policy amend --as agent:fable (APRV-109 phone attestation), ceremony publishes policy-amend-<seq> branch + PR per precedent (seq 293, 513).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 APPROVAL.md defaults carry token_delivery: sealed, applied through a gated edit with the approval tap as the human act
- [x] #2 approval policy amend attests via the Telegram prompt (policy.proposed -> tap -> policy.updated) and the two-file ceremony publishes as a branch + PR
- [ ] #3 A subsequent manual-class grant proves sealed end to end: approval wait returns granted and approval run executes with no human token relay
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
AC1: the one-line edit applied through the gate — policy.edit requested seq 3058, granted human:carter seq 3064, execution seq 3065 (grant followed the write; ordering anomaly noted on APRV-151). AC2: Carter ran approval policy amend --as human:carter --require-load at a terminal in the primary; attested seq 3067, loads clean, live hash fb72c4d962f1. The ceremony's direct push to protected main bounced (non-fast-forward + protection, the seq-293/513 precedent), so the commit a77eabb (APPROVAL.md + events.jsonl through 3067, the two ceremony files together) was published as branch policy-amend-3067 and PR #155 by the session; merge by merge commit through the queue is Carter's. Two operational lessons: a first amend attempt was abandoned at ~33s of silent chain-verify (looked frozen — APRV-167 filed), and while the policy sat edited-but-unattested the hook correctly refused every agent command repo-wide (fail-closed proven live, ~40 min). AC3 (sealed end-to-end on a real grant) stays open for the next manual-class action.

2026-09-01: AC3 still needs one real manual-class grant proving wait -> run with no relayed token. Candidate: the 0.1.0 release ceremony (release.publish, manual) doubles as this proof; recorded in the release task.
<!-- SECTION:NOTES:END -->
