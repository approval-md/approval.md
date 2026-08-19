---
id: APRV-109
title: >-
  Attest and amend from the phone: the policy ceremony collects its human act
  through a channel
status: To Do
assignee: []
created_date: '2026-08-19 22:13'
updated_date: '2026-08-19 22:14'
labels:
  - ux
  - channels
  - policy
  - spec
milestone: m-11
dependencies: []
priority: medium
ordinal: 101000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Human feedback 2026-08-19: "this all feels quite manual - why do i have to run these git commands myself? why do i have to edit the spec and merge it?" The gate already reduces DECISIONS to a tap, but the two attestation ceremonies (policy attest, policy amend) still require the human at a terminal, because attestation is human-only and identity is config-declared (SPEC 11): an agent running amend would be claiming the human identity. The log-advance commit was retired as a human chore the same day (an agent staging .approval/ is a protected-path manual action, so it is one tap); this task retires the last terminal ceremony. DESIGN: (1) A new gate-typed request kind for attestation: an agent (or the amend verb run by an agent identity) prepares the policy edit on a branch and appends an attestation REQUEST carrying the policy file SHA-256 and the semantic diff summary as COMPUTED fields; channels render it like a manual action prompt: the hash, the class-resolution changes in before -> after form, the load advisory verdict, and Approve/Reject buttons. (2) A tap by the approver appends policy.updated (the attestation) under the human identity the listener holds, exactly as a grant lands today; the attested hash is the one the prompt displayed, so the human signed bytes they were shown (the phone shows the diff and the hash; the full policy text is reachable as the payload). (3) The amend git ceremony (two-file commit, PR) then proceeds agent-side; the attestation seq is cited in the commit as today. (4) Fail closed: no channel configured, or the tap times out, means the ceremony refuses and nothing is attested; the withdrawn flow (APRV-106) retires stale attestation prompts. (5) SPEC amendments: 10.1/10.3 (attest via channel), 11 (the human act is the tap; the trust boundary statement unchanged: the listener holds the human identity the way it does for grants). CAUTION to resolve in design: a diff on a phone is small; the prompt MUST carry the semantic diff and the load advisory, never just a hash, and SHOULD refuse to render a diff too large for the channel rather than truncating it silently (fall back to "review at a terminal"). Related decision recorded the same day: agents MAY perform the log-advance commit and the APPROVAL.md edit mechanics behind the gate (protected-path manual approvals); CLAUDE.md dogfooding wording update drafted for the human in the notes here.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 An attestation request renders on Telegram, web and cli with the policy hash, the semantic diff and the load advisory as computed fields; Approve appends the attestation under the approver identity; Reject and timeout attest nothing
- [ ] #2 approval policy amend run by an agent identity prepares everything, requests attestation through the channel, and completes the two-file ceremony only on the tap; run by a human identity it behaves exactly as today
- [ ] #3 A diff too large for the channel refuses to the terminal path rather than truncating; fail closed on no channel; withdrawn retires stale prompts
- [ ] #4 SPEC 10.1/10.3/11 amendments drafted and flagged; npm test and lint clean
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
CLAUDE.md wording drafted for the human (the file is yours): in "Dogfooding", replace "The committed log has one writer: the daemon" paragraph sentence "log-touching commits never ride feature branches" context with an added sentence: "Log-advance commits and APPROVAL.md edit mechanics MAY be performed by an agent: staging .approval/ or the policy file is a protected-path manual action, so the human act is the approval tap; attestation itself remains human-only (via APRV-109 once built, at a terminal until then)." And in the Permissions summary, "Require approval first" already covers it via policy.edit; no change needed there.
<!-- SECTION:NOTES:END -->
