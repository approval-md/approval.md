---
id: APRV-184
title: 'Policy amendment: policy.edit moves to supervised-live 0.1'
status: To Do
assignee: []
created_date: '2026-08-31 23:38'
updated_date: '2026-09-01 21:40'
labels:
  - policy
  - gate
dependencies:
  - APRV-127
priority: medium
ordinal: 160000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
2026-08-31, from the human, confirming the APRV-127 dogfood payoff: 'yeah we should probably make that policy amendment'. Amend APPROVAL.md so class policy.edit declares autonomy supervised-live with live_rate 0.1: roughly one in ten policy/SPEC/CLAUDE.md edits blocks on a Telegram tap (selected by HMAC(sampling secret, payload_hash), agent-unpredictable, post-hoc verifiable), the rest proceed and stay in the retro pool.

Prerequisites, in order:
(1) APRV-127's SPEC 5/7/11.1 amendments are still flagged pending sign-off; the human signs those off first, since the policy grammar this amendment uses is defined there.
(2) approval setup sampling must be run by the human: approval env --check on 2026-08-31 reports APPROVAL_SAMPLING_SECRET unresolved and no .approval/env file. Supervised-live fails closed without a usable secret in the gate process's environment: every action in the class gates, making the amendment a no-op that still costs a ceremony. Verify the daemon terminal resolves the secret before amending.
(3) The ceremony itself: approval policy amend --commit from the primary checkout (protected main auto-switches to the policy-amend-<seq> branch + PR flow). Amendment ends in human attestation; the agent's role is drafting the exact YAML in this task and verifying prerequisites, per the dogfood rule that agents do not edit APPROVAL.md.

Note for the drafter: consider whether the live grants for sampled policy.edit actions need their own dogfood pin in the same PR, per the session practice that pins for newly declared classes move in the same PR as the policy.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Exact APPROVAL.md diff drafted in this task: policy.edit autonomy supervised-live, live_rate 0.1, everything else on the rule unchanged
- [x] #2 APRV-127 SPEC sign-off confirmed landed before the ceremony
- [ ] #3 Sampling secret verified resolvable in the gate process environment (approval doctor or env --check clean on APPROVAL_SAMPLING_SECRET)
- [x] #4 Human runs the amend ceremony; attestation seq and PR recorded in implementation notes
- [ ] #5 Post-amend: one sampled and one unsampled policy.edit observed and their selection verified against the secret, recorded in notes
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Exact APPROVAL.md diff drafted (AC 1). Line 46 changes from:

  policy.edit:               { autonomy: manual }       # this file, CLAUDE.md, CI config

to:

  policy.edit:               { autonomy: supervised-live, live_rate: 0.1 }  # this file, CLAUDE.md, CI config; APRV-184

Everything else on the rule unchanged (no approvers list or limits declared today, none added). Sampled edits follow the manual path bit for bit; unsampled ones proceed and stay in the retro pool.

Prerequisites verified 2026-09-01: APRV-127 grammar is BUILT and its SPEC amendments still carry pending-sign-off flags (Carter's step 1). APPROVAL_SAMPLING_SECRET is unresolved and .approval/env absent (approval env --check), so supervised-live would fail closed and gate 100 percent: Carter runs approval setup sampling first (step 2), then verifies the daemon terminal resolves the secret, then approval policy amend --commit in the primary (step 3; expect the ~33s silent pre-diff verify, APRV-167). Blocked on those three human steps; nothing further for an agent until the ceremony lands.

2026-09-01: ceremony landed. Carter hand-applied line 46 (policy.edit: { autonomy: supervised-live, live_rate: 0.1 }) and ran approval policy amend --commit: attested seq 5147, PR #175 (policy-amend-5147, merged 05:39Z with the dogfood pin moved to supervised in the same PR), log advance PR #176 merged 08:14Z. AC2: APRV-127 sign-off PR #174 merged 05:21Z, before the ceremony. Still open: AC3 (APPROVAL_SAMPLING_SECRET minted via approval setup sampling into keychain + .approval/env, but not yet resolvable in hook/agent gate processes, so supervised-live fails closed and gates 100 percent; safe, no tap reduction yet) and AC5 (observation of one sampled + one unsampled edit, possible only after AC3). Hardening dependency: APRV-198 narrows policy.edit so the 0.1 sampling stops covering APPROVAL.md and the log; landing today.

DEPENDENCY ADDED 2026-09-01 by the APRV-198 lane: this task now depends on APRV-198, which splits the classifier's single protected class three ways (policy.edit narrows to CLAUDE.md / AGENTS.md / .npmrc / .github/workflows/ and the policy's own protected_paths entries; policy.core is APPROVAL.md and the rest of the approval home plus the harness files that install the hook; log.mutate is anything aimed at .approval/log/). Until that lands, the supervised-live 0.1 already attested at seq 5147 is sampling a class that still covers APPROVAL.md itself and log-redirect writes, which is the second blocker recorded above.

The proposed APPROVAL.md block for the next amend ceremony, updated to name the split (APRV-198 AC5, and the APRV-185 draft it supersedes):

classes:
  policy.edit:         { autonomy: supervised-live, live_rate: 0.1 }   # UNCHANGED, now the narrowed class: agent instructions, CI/release config, protected_paths entries
  policy.core:         { autonomy: human-only }   # NEW -- APPROVAL.md, .approval/* outside the log, .claude/settings*, .cursor/hooks*
  log.mutate:          { autonomy: human-only }   # NEW -- any write, redirect, append, truncation or rename aimed at .approval/log/
  account.credential:  { autonomy: human-only }   # NEW -- emitted since APRV-194
  vcs.history.rewrite: { autonomy: human-only }   # was: manual

This resolves the 184-vs-185 tension APRV-185's notes flagged: policy.edit stays sampled BECAUSE it no longer covers the gate's organs, and the human-only line lands on policy.core, log.mutate, account.credential and vcs.history.rewrite instead. The ceremony is Carter's; nothing here is applied.
<!-- SECTION:NOTES:END -->
