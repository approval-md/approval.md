---
id: APRV-185
title: >-
  Autonomy vocabulary: a level above manual for actions reserved to human hands,
  and whether manual should be renamed
status: Done
assignee:
  - 'agent:fable'
created_date: '2026-08-31 23:39'
updated_date: '2026-09-01 04:48'
labels:
  - policy
  - gate
  - spec
  - design
dependencies: []
priority: medium
ordinal: 161000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
2026-08-31, from the human: 'should we also have language for actions that truly require a human to hand edit? we have supervised/autonomous/manual... maybe we need deny? maybe manual is confusing terminology for this?'

The gap is real. The ladder tops out at manual (SPEC 5: manual > supervised-live > supervised-retro > autonomous), and manual means 'the AGENT executes, after a human grants'. Nothing in the policy grammar can say 'no grant exists for this; a human performs it themselves'. Today that lives only as prose (CLAUDE.md's Never section: credentials, history rewrite, log mutation) and in hook deny-by-unclassified, neither of which is a policy-declarable, machine-readable class property.

Design questions to settle:
(1) Name. 'deny' reads as firewall-flavored refusal; the actual semantic is 'reserved to human hands' — the action is legitimate, the performer is constrained. Candidates: human-only, reserved, never, deny. Lean human-only: it states the repair ('ask a human to do it') the way actor-not-approver does.
(2) Semantics. A request against such a class refuses machine-readably with its own code (distinct from a reject: no human decision occurred, the policy itself answers); no token can be minted; grant/reject/revoke verbs refuse too (nothing to authorize). The refusal message names the class and says a human performs this outside agent execution. Strictness ordering: human-only > manual.
(3) Fail-closed target stays manual, deliberately: unparseable policy -> everything human-only would brick the gate, and SPEC 5's approver reasoning shows why a broken policy must stay recoverable through its own gate. State this in the SPEC text.
(4) Whether manual should be renamed (gated? ask?). It does confuse: it sounds like 'a human does it manually' and the confusion sharpens once human-only exists beside it. Precedent for a safe rename: the supervised split kept bare supervised as an alias with a load-time note. Weigh the ripple (docs, hook prompts, dogfood muscle memory) against the clarity; renaming can be its own follow-up task if adopted.
(5) Dogfood: CLAUDE.md's Never list becomes declarable — e.g. vault.*, vcs.history.rewrite, log.mutate as human-only in APPROVAL.md — moving those prohibitions from prose into the enforced policy. New cross-cutting property joins SPEC 11 global invariants per CLAUDE.md rule.

Deliverable is a design + SPEC amendment (flagged pending sign-off) plus implementation; split implementation into its own task if the design lands large.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Design decision recorded: level name, refusal semantics and code, strictness ordering, fail-closed target unchanged and justified
- [x] #2 SPEC 5/7/11 amendment drafted and flagged pending sign-off; schema updated with load tests
- [x] #3 Requests, grants, and tokens against the new level refuse machine-readably with a distinct code; tested
- [x] #4 Rename-of-manual question answered with rationale; if adopted, alias + load-time note per the supervised precedent, or explicitly declined in notes
- [x] #5 Dogfood proposal drafted: which APPROVAL.md classes move to the new level (human's amendment to make)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Design decisions (fable, 2026-09-01), AC 1:

NAME: human-only. 'deny' describes the refusal; human-only states the repair (ask a human to perform it), matching the actor-not-approver naming philosophy.

SEMANTICS: approval request against a human-only class refuses with its own machine-readable code class-human-only, distinct from a reject because no human decided anything; the policy itself answers. grant/reject/revoke/token/run against such an action refuse with the same code: no verb may mint or withdraw authority that cannot exist. The hook answers deny for human-only commands, carrying the code. Strictness ordering: human-only > manual > supervised-live > supervised-retro > autonomous.

DEFAULTS AND FLOORS: defaults.autonomy MAY declare human-only (an author's explicit maximal strictness, coherent with no rate slot needed). The fail-closed target for an unparseable policy STAYS manual: a broken policy must remain recoverable through its own gate (SPEC 5 approvers reasoning); state this in the SPEC text. The section 7 irreversibility floor raises to manual at most and never to human-only: floors are runtime escalations, human-only is a declaration only, since an auto-forbid could deadlock the gate's own repair paths.

RENAME OF MANUAL (AC 4): recommendation is gated as the canonical name with manual as a permanent alias plus load-time note, per the supervised precedent; ADOPTION DEFERRED out of this task. Rationale: the rename touches the attested policy's vocabulary, every doc, and the phone prompts; batching it here would swamp review of the new level. If Carter wants it, it becomes its own task with the alias mechanism already proven by this one.

NEW GLOBAL INVARIANT for SPEC 11: human-only classes are inert to agents; no verb may mint authority for them and their refusal is its own code. The matching CLAUDE.md invariant-list line is a separate gated edit the orchestrator makes after this lands (per APRV-182 convention), noted here so it is not lost.

DOGFOOD PROPOSAL (AC 5): draft an APPROVAL.md amendment moving the Never-list prohibitions into declared classes (candidate classes to verify against the live classifier: vault/credential access, vcs.history.rewrite, log mutation). Draft only; the amend ceremony is Carter's.

Implementation landed via PR #171 (a1fa773 code + 6a5c225 SPEC, the latter applied under a policy.edit grant from the CLI channel after two hook timeouts). class-human-only joined three frozen unions (gate: after grant-classless-request; token: after the verify-prefix spread; execute: after action-not-registered) plus hook-class-human-only in HOOK_DENY_CODES; exit codes unchanged. Normative evaluation order pinned by test: class-human-only fires before policy-drift. Reject and revoke refuse too (a decision record about a human-only class would read as a class the gate transacts in); withdraw and expire stay open so amendment-raised requests leave the queue. No new schema allOf needed: the existing else branches already forbid both rates on the new level, pinned by two invalid fixtures. humanOnlyRefusal() lives in policy-match (pure) so all four surfaces share one text. approval token reports unspendable. Bonus: conformance vectors regenerated, closing three vectors APRV-183's fixtures added without a regen (121 -> 127). Verification: tests/human-only.test.ts 20/20, gate-verb suites 232/232, full 2487/2488 (pre-existing lane-only ci-guard ENOENT), conformance 238/238 over 110 controls, CI green on the merged PR. Global invariants touched, as required by CLAUDE.md: adds SPEC 11.1 invariant 9; refusals-machine-readable-and-distinct extended with the new code. CLAUDE.md invariant-list line for invariant 9 is still owed (gated edit, orchestrator's follow-up). Dogfood probe findings and the drafted APPROVAL.md human-only block are in the 2026-09-01 notes above; classifier gaps filed as APRV-194.

The drafted APPROVAL.md amendment (AC 5), verbatim from the build's dogfood probe, for Carter's amend ceremony:

classes:
  vcs.history.rewrite:       { autonomy: human-only }   # was: manual
  policy.edit:               { autonomy: human-only }   # was: manual  -- SEE CAVEAT
  account.credential:        { autonomy: human-only }   # NEW -- inert until APRV-194

Prose above the block: 'Three classes are not mine to delegate. Rewriting shared history destroys the record this project exists to keep; editing the policy, the log, or the agent instructions is editing the gate from inside it; and a credential is the one thing an agent holding it needs no gate for. These are human-only: I do them myself, at a terminal, and no approval of mine can move one of them into an agent's hands. Anything genuinely blocked by this is a task for me, not a policy amendment.'

CAVEATS (the build's, endorsed): policy.edit at human-only would END gated agent edits of SPEC.md and CLAUDE.md, the workflow APRV-182 just established and APRV-184 wants to relax to supervised-live 0.1 -- the two amendments are in direct tension, and Carter should pick ONE direction for policy.edit (184's sampled gate, or 185's human-only) before any ceremony. account.credential is inert until APRV-194 gives the classifier rules that emit it.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
human-only landed via PR #171: the level above manual, inert to agents (class-human-only across three frozen unions plus the hook deny), defaults admission, rates forbidden, floor stops at manual both directions, fail-closed stays manual for recoverability. SPEC 5.2/7/11.1(+9)/11.2 amended under a CLI-channel grant, flagged pending sign-off. Rename of manual deferred with a written recommendation (gated + alias). Verified: 20/20 new tests, 2487/2488 lane suite, conformance 238/238, green CI on the merged PR. Follow-ups: APRV-194 (classifier), CLAUDE.md invariant-list line, and the 184-vs-185 policy.edit direction Carter must pick.
<!-- SECTION:FINAL_SUMMARY:END -->
