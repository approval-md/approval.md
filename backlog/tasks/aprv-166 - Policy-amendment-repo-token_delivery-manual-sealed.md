---
id: APRV-166
title: 'Policy amendment: repo token_delivery manual -> sealed'
status: In Progress
assignee:
  - '@opus-policy'
created_date: '2026-08-30 22:31'
updated_date: '2026-09-06 07:56'
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
- [x] #3 A subsequent manual-class grant proves sealed end to end: approval wait returns granted and approval run executes with no human token relay
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read the CURRENT committed policy rather than the task's historical draft: defaults already carry token_delivery: sealed, with the APRV-166 comment attached, in the file attested at seq 23351 (sha256 a6d7b83d…). AC1/AC2 are recorded as landed at the seq 3067 ceremony; nothing about the YAML is still owed.
2. Answer the one open criterion (AC3, sealed end to end with no human token relay) from the log rather than from a fresh ceremony, since the proof is an observation and not an edit.
3. Scan the committed log for the two additive fields SPEC 10.4 defines: approval.requested.token_recipient_key and approval.granted.token_sealed. Correlate them by payload_hash so a request, its grant, and the execution that followed are read as one action.
4. Report the count, the class spread, the date range, and one full trace, and check AC3 only if the requested -> granted(sealed) -> execution.started shape is present on real actions.
5. State in the proposal what sealed delivery costs operationally: which process must hold the private half, what refusal a requester sees without it, and what a human does when a seal cannot be opened.
6. No APPROVAL.md, .approval/, SPEC.md, src/ or CLAUDE.md edits from this lane; the deliverable is docs/proposals/policy-amendments-184-166.md.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
AC1: the one-line edit applied through the gate — policy.edit requested seq 3058, granted human:carter seq 3064, execution seq 3065 (grant followed the write; ordering anomaly noted on APRV-151). AC2: Carter ran approval policy amend --as human:carter --require-load at a terminal in the primary; attested seq 3067, loads clean, live hash fb72c4d962f1. The ceremony's direct push to protected main bounced (non-fast-forward + protection, the seq-293/513 precedent), so the commit a77eabb (APPROVAL.md + events.jsonl through 3067, the two ceremony files together) was published as branch policy-amend-3067 and PR #155 by the session; merge by merge commit through the queue is Carter's. Two operational lessons: a first amend attempt was abandoned at ~33s of silent chain-verify (looked frozen — APRV-167 filed), and while the policy sat edited-but-unattested the hook correctly refused every agent command repo-wide (fail-closed proven live, ~40 min). AC3 (sealed end-to-end on a real grant) stays open for the next manual-class action.

2026-09-01: AC3 still needs one real manual-class grant proving wait -> run with no relayed token. Candidate: the 0.1.0 release ceremony (release.publish, manual) doubles as this proof; recorded in the release task.

2026-09-06, @opus-policy proposal lane (worktree agent-a9022a34174fdc9f9, read-only against origin/main). AC3 CHECKED on log evidence rather than on a fresh ceremony, because the criterion is an observation and the amendment itself landed at seq 3067.

Evidence. Read the committed log through approval log export (no byte under .approval/ was written) and correlated events by payload_hash. Both additive fields SPEC 10.4 defines are present on real actions: 17 approval.requested records carry token_recipient_key (60-char base64 X25519 SPKI, MCowBQYDK2...), 17 approval.granted records carry token_sealed, and every one of the 17 has the identical shape {alg: 'x25519-hkdf-sha256/aes-256-gcm', epk, nonce, ct, tag}, exactly the scheme 10.4 specifies. 10 of those actions go on to an execution.started. They span 2026-08-31 to 2026-09-05 across three classes (policy.edit, log.advance, network.call) and three agent identities (agent:claude-code, agent:codex, agent:codex-claude-import), so this is the ordinary path and not one rehearsed demo. Full trace: seq 19223 approval.requested agent:codex network.call +token_recipient_key (02:02:08Z) -> seq 19231 approval.granted human:carter +token_sealed (02:02:59Z) -> seq 19251 execution.started agent:codex (02:03:53Z). Earlier pairs with executions: 3774/3902/3905 and 7279/7282/7286 (policy.edit), 15739/15740/15741 (policy.edit), 18030/18034/18042 and 19256/19267/19273 (network.call).

What the log CANNOT show, recorded so this check can be reversed on better information: no event field records how the executing process obtained its token. execution.started carries grant_seq and grant_origin (values seen: direct 41, carried 14), and grant_origin names WHICH grant authorized the execution rather than how the token travelled. So the log proves the seal was minted, addressed to the requester's ephemeral key and recorded, and that the action then executed under it; it cannot prove the negative that nobody read the token off a terminal and pasted it. The corroboration is the code path: under token_delivery: sealed, approval run opens the grant's token_sealed with the private key approval request wrote and needs no --token in the argv (docs/cli-reference.md, '--token is optional under sealed delivery'), and approval wait --json returns the raw token in the granted action's entry. The raw token is still printed once on the granting surface by design, so a relay remains possible and is no longer necessary. If Carter wants the stricter reading (one named run watched from wait to run with the argv visible), uncheck AC3 and let the 0.1.0 release ceremony serve as that observation.

Policy state re-derived: defaults.token_delivery: sealed is present in the file attested at seq 23351 (APPROVAL.md sha256 a6d7b83d492994a7ab5152ccc6881dd849cc9fe9a0cfb15c449ff3e2ce40ac2d, equal to that policy.updated record). No YAML diff and no src/core/policy-expectations.ts diff are owed: token_delivery is a defaults key and moves no class resolution, and the dogfood suite passes 39/39 against the live policy unchanged. Deliverable: docs/proposals/policy-amendments-184-166.md, which carries the verdict, the ceremony runbook for the day a line does move, and the operational risks of sealed delivery (machine-local and action-local private key at .approval/keys/<action-key>.key unlinked at consume/expiry/revocation; a requester without the keypair falls back to the paste and refuses token-required rather than losing the authorization; sealToken returns null on an unusable recipient key and the grant still stands, because a convenience must not void a human's yes; the daemon is not in the seal's path).

Task left In Progress: the amendment needs no ceremony and this lane does not move tasks to terminal status.
<!-- SECTION:NOTES:END -->
