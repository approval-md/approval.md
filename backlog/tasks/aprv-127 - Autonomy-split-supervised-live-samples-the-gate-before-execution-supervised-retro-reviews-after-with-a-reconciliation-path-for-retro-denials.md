---
id: APRV-127
title: >-
  Autonomy split: supervised-live samples the gate before execution,
  supervised-retro reviews after, with a reconciliation path for retro denials
status: To Do
assignee: []
created_date: '2026-08-20 17:01'
updated_date: '2026-08-25 10:04'
labels:
  - policy
  - gate
  - spec
  - design
milestone: m-12
dependencies: []
priority: high
ordinal: 119000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
2026-08-20, from the human, after a day of SPEC-edit taps: 'for these spec edits I'd be happy just reviewing maybe 10%'. Today's vocabulary offers no such thing: manual gates every action, supervised gates none (it samples RETROSPECTIVELY at audit.supervised_sample_rate). The proposal splits supervised into two declared modes.

supervised-live: a policy-declared fraction of actions in the class BLOCK on the human gate exactly as manual does; the rest proceed. Selection must be unpredictable to the agent and provable to the human after the fact: no RNG in the log. Reuse the audit sampling design: selected iff HMAC(sampling secret, payload hash) falls under the rate, where the secret is operator-held and policy-named (sampling_secret_env). The agent cannot compute its own luck without the secret; anyone holding the secret can later verify every selection was honest; determinism means replays and retries of the same bytes get the same verdict (no re-rolling until unsampled - state this as a tested property). A sampled action follows the manual path bit for bit: same request, same prompt, same grant, same token rules. An unsampled action proceeds as supervised does today and still enters the retro pool.

supervised-retro: today's supervised, renamed for honesty; proceeds immediately, sampled for retrospective review via the existing audit verbs.

Reconciliation for a retro denial (the part with real design weight): the runtime cannot undo anything, it can only oblige and record. A retro deny appends a reconciliation obligation event naming the action, its class, and the denial; the action's declared reversible field selects the obligation shape: reversible=true obliges 'revert and report through the gate' (the revert is itself a gated action, so the loop closes in the log); reversible=false records a policy-was-wrong finding whose sanctioned response is tightening the class, and the obligation is the review of that tightening. Open state to design: how an obligation is marked satisfied, who may mark it (human only), and what doctor/status show while one is open (an unreconciled denial should be loud).

Fail-closed rule that makes the split safe: supervised-retro MUST be refused (at policy load or at request time) for an action declaring reversible=false. Retrospective review of the irreversible is regret with a paper trail; the policy grammar should force those to manual or supervised-live. Decide at design time whether this binds per-action (the envelope declares reversible) or also per-class via a new class field.

Vocabulary and migration: policy grammar gains the two modes; bare supervised parses as supervised-retro (with a load-time note) so existing policies keep their meaning; SPEC sections 5, 7, and 11.1 amendments drafted and flagged. The dogfood payoff the human named: policy.edit at supervised-live 0.1 drops SPEC-edit taps by 90 percent while every edit stays eligible and none can predict its luck. Global invariants touched: self-reported fields never reduce scrutiny (reversible=true is self-reported - it may select the obligation shape but must never loosen which mode a class may use... note the tension: the fail-closed rule above reads reversible=false to REFUSE retro, which is scrutiny-raising, the safe direction; a false claim of reversible=true evades the refusal, so the design must say plainly that the refusal is a floor, not a proof); enforcement paths read only verified records; gate-typed events never accept caller timestamps. Related: APRV-115 (digests thin whatever taps remain), APRV-117 (carryover makes sampled-live taps missable), APRV-58 (skew, the other audit knob).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Policy grammar declares supervised-live with a rate and supervised-retro; bare supervised parses as supervised-retro; schema and load tests
- [ ] #2 Live selection is HMAC(secret, payload hash) under the rate: deterministic, agent-unpredictable, post-hoc verifiable, no RNG in the log; identical bytes always select identically (no re-roll), property-tested
- [ ] #3 A sampled supervised-live action follows the manual path bit for bit; an unsampled one proceeds and enters the retro pool
- [ ] #4 A retro denial appends a reconciliation obligation; reversible actions oblige a gated revert; irreversible ones record a policy finding; satisfaction is human-only and open obligations are loud in status and doctor
- [ ] #5 supervised-retro refuses actions declaring reversible=false, stated as a floor rather than a proof
- [ ] #6 SPEC 5/7/11.1 amendments drafted, flagged pending sign-off per the ratified convention
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Rate calibration from the human (2026-08-20): for proposal-tier protected-path edits (worktree drafts whose merge is separately gated) they want rates as low as 0.01. The design should state the layered-control argument that justifies very low live rates on proposal-tier actions: sampling thins the draft taps, never the merge tap. Depends on APRV-124's proposal-tier/live-tier distinction to express that split.

DESIGN SIGN-OFF 2026-08-25 (Carter, in session): approved as designed. The supervised-live/supervised-retro split, HMAC(secret, payload hash) selection (deterministic, agent-unpredictable, no re-roll), reconciliation obligations (gated revert for reversible, policy-finding for irreversible, human-only satisfaction, loud while open), and the reversible=false retro refusal stated as a floor rather than a proof. Policy rates land via the ordinary amendment ceremony after the mechanism ships; Carter's stated target for proposal-tier policy.edit is supervised-live 0.01. SPEC 5/7/11.1 drafting (AC 6) may proceed.
<!-- SECTION:NOTES:END -->
