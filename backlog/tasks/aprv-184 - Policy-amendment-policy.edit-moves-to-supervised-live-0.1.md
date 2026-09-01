---
id: APRV-184
title: 'Policy amendment: policy.edit moves to supervised-live 0.1'
status: To Do
assignee: []
created_date: '2026-08-31 23:38'
updated_date: '2026-09-01 01:04'
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
- [ ] #1 Exact APPROVAL.md diff drafted in this task: policy.edit autonomy supervised-live, live_rate 0.1, everything else on the rule unchanged
- [ ] #2 APRV-127 SPEC sign-off confirmed landed before the ceremony
- [ ] #3 Sampling secret verified resolvable in the gate process environment (approval doctor or env --check clean on APPROVAL_SAMPLING_SECRET)
- [ ] #4 Human runs the amend ceremony; attestation seq and PR recorded in implementation notes
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
<!-- SECTION:NOTES:END -->
