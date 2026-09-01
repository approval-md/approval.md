---
id: APRV-185
title: >-
  Autonomy vocabulary: a level above manual for actions reserved to human hands,
  and whether manual should be renamed
status: To Do
assignee: []
created_date: '2026-08-31 23:39'
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
- [ ] #1 Design decision recorded: level name, refusal semantics and code, strictness ordering, fail-closed target unchanged and justified
- [ ] #2 SPEC 5/7/11 amendment drafted and flagged pending sign-off; schema updated with load tests
- [ ] #3 Requests, grants, and tokens against the new level refuse machine-readably with a distinct code; tested
- [ ] #4 Rename-of-manual question answered with rationale; if adopted, alias + load-time note per the supervised precedent, or explicitly declined in notes
- [ ] #5 Dogfood proposal drafted: which APPROVAL.md classes move to the new level (human's amendment to make)
<!-- AC:END -->
