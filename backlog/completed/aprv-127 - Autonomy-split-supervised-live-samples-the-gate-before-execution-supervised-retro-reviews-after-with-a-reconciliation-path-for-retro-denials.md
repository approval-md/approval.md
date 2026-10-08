---
id: APRV-127
title: >-
  Autonomy split: supervised-live samples the gate before execution,
  supervised-retro reviews after, with a reconciliation path for retro denials
status: Done
assignee: []
created_date: '2026-08-20 17:01'
updated_date: '2026-08-29 04:33'
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
- [x] #1 Policy grammar declares supervised-live with a rate and supervised-retro; bare supervised parses as supervised-retro; schema and load tests
- [x] #2 Live selection is HMAC(secret, payload hash) under the rate: deterministic, agent-unpredictable, post-hoc verifiable, no RNG in the log; identical bytes always select identically (no re-roll), property-tested
- [x] #3 A sampled supervised-live action follows the manual path bit for bit; an unsampled one proceeds and enters the retro pool
- [x] #4 A retro denial appends a reconciliation obligation; reversible actions oblige a gated revert; irreversible ones record a policy finding; satisfaction is human-only and open obligations are loud in status and doctor
- [x] #5 supervised-retro refuses actions declaring reversible=false, stated as a floor rather than a proof
- [x] #6 SPEC 5/7/11.1 amendments drafted, flagged pending sign-off per the ratified convention
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Rate calibration from the human (2026-08-20): for proposal-tier protected-path edits (worktree drafts whose merge is separately gated) they want rates as low as 0.01. The design should state the layered-control argument that justifies very low live rates on proposal-tier actions: sampling thins the draft taps, never the merge tap. Depends on APRV-124's proposal-tier/live-tier distinction to express that split.

DESIGN SIGN-OFF 2026-08-25 (Carter, in session): approved as designed. The supervised-live/supervised-retro split, HMAC(secret, payload hash) selection (deterministic, agent-unpredictable, no re-roll), reconciliation obligations (gated revert for reversible, policy-finding for irreversible, human-only satisfaction, loud while open), and the reversible=false retro refusal stated as a floor rather than a proof. Policy rates land via the ordinary amendment ceremony after the mechanism ships; Carter's stated target for proposal-tier policy.edit is supervised-live 0.01. SPEC 5/7/11.1 drafting (AC 6) may proceed.

Reconciliation takeover 2026-08-27 (session emilia-protocol-comparison, after the authoring session ended): the two granted SPEC-stitch payloads (b3385790 Edit, d2c77339 sed 135,137d;130d) were traced against the live file and would have dropped the APRV-121 budgets paragraph and orphaned a >>>>>>> marker in either order, and neither touched the 105/140 block; both were left to expire unexecuted (a grant authorizes, it does not oblige). A fresh single-command stitch (one policy.edit grant, Carter tap 2026-08-26 ~22:30 local) deleted exactly the marker and superseded lines in both blocks: SPEC 5.2 keeps the three APRV-127 bullets plus the APRV-121 budgets text, 10.4 keeps the APRV-105 token-delivery paragraphs plus the APRV-140 recomputation rule. Merge concluded at f1022a4, test fixes at 79a1dfb: autonomy-split startExecution call sites now present the declared binding per APRV-140. Also fixed en route: the primary checkout dist/ was stale (built 12:26, pre-#131 merges), so the post-121 strict schema ran without historical read mode and the hook refused the whole log as schema-invalid at seq 6; npm run build in the primary restored log verify clean (644 records). The daemon still runs pre-121 code and writes numeric est_cost_usd (accepted on read); restart is Carter's call. PR #132 MERGEABLE, auto-merge armed, blocked only on CI at note time.

Finalization 2026-08-28 (takeover session): shipped in PR #132, merged as main 73ac778 (merge f1022a4 + reconciliation fixes 79a1dfb). Evidence per AC, verified by running the merged suite fresh (npm test: 2295/2295 pass, lint clean): AC1 policy grammar + alias tests (bare supervised parses as supervised-retro with a load-time note; schema/load tests in cli-policy and policy-load); AC2 sampler tests (selection is a pure function of secret+payload_hash+rate, different secret different draw, identical bytes identical verdict, fails closed with no usable secret, no selection value in the log); AC3 byte-identical sampled path tests (sampled request byte-identical to manual, granted/tokened/spent as manual; unsampled proceeds and enters retro pool; sampled not drawn again retrospectively); AC4 reconciliation tests (retro denial obliges gated revert for reversible, policy finding otherwise, human-only satisfaction needing a note, gated revert closes once against the chain, open obligation makes status unhealthy and doctor fail); AC5 floor tests (retro and live refuse reversible:false at every rate, floor-not-proof stated and tested); AC6 SPEC 5.2/7/6.3/11.1-invariant-4 amendments merged carrying '(Amended APRV-127, pending sign-off.)' flags per convention; flag removal rides Carter's ratification pass. Policy rates (target: proposal-tier policy.edit at supervised-live 0.01) land via the ordinary amendment ceremony, still pending.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Supervised split shipped: supervised-live blocks a HMAC-selected fraction on the manual path bit for bit, supervised-retro is the honest rename, retro denials append reconciliation obligations (gated revert or policy finding, human-only satisfaction, loud while open), reversible:false refuses retro as a floor. Merged as PR #132 (main 73ac778); verified with autonomy-split.test.ts and full suite 2295/2295 + lint on the merged tree.
<!-- SECTION:FINAL_SUMMARY:END -->
