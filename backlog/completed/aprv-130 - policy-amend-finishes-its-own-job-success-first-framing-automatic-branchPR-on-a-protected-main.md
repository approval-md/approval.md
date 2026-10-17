---
id: APRV-130
title: >-
  policy amend finishes its own job: success-first framing, automatic branch+PR
  on a protected main
status: Done
assignee: []
created_date: '2026-08-20 19:45'
updated_date: '2026-08-20 21:28'
labels:
  - cli
  - ux
milestone: m-12
dependencies: []
priority: high
ordinal: 122000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
2026-08-20, the human, after their re-tighten ceremony ended in a REJECTED headline: 'it doesnt seem user friendly that one of the few human-only actions is rewarded with a REJECTED message'. They are right twice over. The attestation - the ceremony's point, the act only a human can perform - SUCCEEDED (seq 293, in the log, on disk); only the convenience push failed; and the output led with the failure of the least important step.

Two changes to approval policy amend --commit:

1. Success-first framing. The first line after the human confirms is the achievement: a success glyph, 'attested seq N - the policy is operative', THEN publishing status as logistics beneath it. The word REJECTED (any failure headline) may describe a sub-step, never the ceremony, when the attestation landed. The --json shape gains an explicit attested: true alongside the publishing outcome so machine callers see the same split (additive field; existing fields frozen).

2. The ceremony finishes its own job. On a rejected direct push (or a probe that reports protection up front), the verb RUNS the recovery instead of printing it: git branch policy-amend-<seq>, git push -u origin, gh pr create (body per the existing one-commit rationale), and offers/attempts auto-merge, reporting each step as it lands: 'main is protected -> publishing via branch policy-amend-N... PR #M opened, auto-merge armed'. All four are non-destructive; none moves the operator's checked-out branch (the APRV-111 constraint holds). The APRV-129 runbook rendering remains as the FALLBACK when a step of the automatic path itself fails - a runbook is for when automation runs out, not the default reward.

Notes: gh absence or gh failure degrades to the runbook gracefully; the gate classifies the gh calls as it classifies them anywhere (vcs.pr supervised under the dogfood policy - state in the docs that the ceremony's publishing half may itself prompt); --no-publish flag for an operator who wants the old stop-after-commit behavior; docs/cli-reference.md transcript updated; the direct-flow success path (unprotected main) is unchanged.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 After a confirmed attestation the first output line is the success, with publishing reported beneath; no failure word headlines a ceremony whose attestation landed; pinned by tests including the rejected-push case
- [x] #2 On a protected or push-rejected main the verb executes branch, push, and PR creation itself, reporting each step; the operator's checked-out branch never moves
- [x] #3 The APRV-129 runbook renders only when the automatic path itself fails, and gh absence degrades to it gracefully; both tested
- [x] #4 --json gains attested plus a publishing outcome additively; existing fields and exit codes for pre-attestation failures unchanged
- [x] #5 --no-publish preserves stop-after-commit; docs transcript updated; docs-guard passes
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Merged as PR 114 (branch aprv-130-amend-publishes), built on APRV-129's runbook helper the same evening, after one builder stall resumed mid-flight. Success-first: '✓ attested seq N - the policy is operative' prints on stdout before any git command runs, so the achievement is the first thing the human reads; publishing is narrated beneath as logistics, per step. On a protected main the verb publishes itself: git branch policy-amend-<seq>, push, gh pr create (one-commit rationale), gh pr merge --auto, the checkout never leaving main. Per-step fallback: one canonical RunbookStep list, each failure renders the APRV-129 runbook on stderr sliced from the failed step, so the reader is never handed a command the verb already ran; steps 0-1 fail as push-rejected, step 2 as pr-failed, matching those codes' frozen definitions. Refused auto-merge stays a success (PR URL + 'merge when CI is green'). gh-absent degrades to the runbook. Exit codes preserved exactly: attested+published 0, attested+incomplete stays 4 for scripts while the text stays success-first; every pre-attestation refusal byte-identical. --json: top-level 'attested' was already frozen with a different meaning (the attestation moved FROM), so the new boolean is ceremony.attested beside an additive publishing object; collision documented. --no-publish preserves stop-after-commit. 67 amend tests, suite 2019.
<!-- SECTION:NOTES:END -->
