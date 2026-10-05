---
id: APRV-482
title: >-
  A review verdict needs an explicit affirmative: a reaction-only tap or a bare
  CLI review no longer writes verdict ok
status: In Progress
assignee: []
created_date: '2026-10-05 06:51'
updated_date: '2026-10-05 08:21'
labels:
  - agentvillage
dependencies: []
priority: high
ordinal: 367000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Supervised-retro core piece (in scope for Oct 11). Today a bare reaction or a CLI review with no verdict can write verdict ok, which would count as individual approval without an affirmative act. Require an explicit form per channel.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Bare paths (reaction-only tap, bare CLI review) are refused with a named code and write no verdict
- [x] #2 The explicit forms are documented per channel
- [x] #3 A test per channel covers the refusal and the explicit form
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Commit cc7ac82a.

Done:
- reviewSample has no default verdict. A missing verdict, or one that is neither "ok" nor "denied", is refused with the new code `verdict-required`. The check runs right after the actor check and before the log is read.
- CLI: `--ok` added. Exactly one of --ok/--deny is required. Both together is a usage error (exit 2). Neither, including `--reaction` alone, is verdict-required (exit 1). Help text was compressed to stay under the 25-line cap. The verb registry gained `--ok`.
- Telegram: a grade tapped with nothing armed goes to the runtime with NO verdict, so the refusal on the card is core's own code and message. The card holds the grade (`heldReaction`, process memory, heading `GRADE X HELD`). A following OK or second Deny records the held grade; loved/disliked ask for a note at that point.
- Explicit forms per channel are documented in docs/cli-reference.md (Telegram table and audit review section). docs/dogfood-cutover.md and the /skip hint now say `--ok`.
- Existing tests were updated to state their verdicts.

PROPOSED SPEC HUNK (pending sign-off). §5.2 Reactions bullet, append:
"A review's verdict MUST be given explicitly. A grade alone, or a review naming no verdict, is refused `verdict-required` and records nothing, because under supervised-retro the review is the approval (Amended APRV-482)."
§11.2 audit_refusal_codes, new row after `reaction-conflicts-verdict`:
"| `verdict-required` | A review named no verdict (a grade alone, or a bare terminal review). Evaluated after the actor check and before the log is read; nothing is appended. |"
§10.3: replace "The gestures it collects are a verdict and, optionally, the graded reaction" with "The gestures it collects are an explicit verdict and, optionally, the graded reaction; a reaction with no verdict MUST NOT record one".

Fix round 1 (refutation of PR #614), lane claude-edge/A3-fix1.
- F3 (should-fix) FIXED in e0fd9498. ReviewCardState gains armedBy and heldBy (the transport sender id at tap time). A tap that would finish another account's half-finished review (any OK or Deny while another account holds the grade or armed Deny; any grade while another account armed Deny) is refused on the card with TELEGRAM_REVIEW_OTHER_SENDER and never reaches the runtime. A grade with nothing armed only replaces the held grade. Tests: 'PR #614 refutation F3: a grade one account holds never rides on another account's OK' and '... a Deny one account armed is never finished by another account's tap'; both fail with the guard mutated off.
- N6 FIXED in 3d81cf5e. verdict-required is now judged after the sample is located and the roster check passes, so an off-roster reviewer hears actor-not-approver first. The reaction rules still run before the log read, only when a verdict was given (a lone loved hears verdict-required, not note-required). On the card a lone grade is held only when the runtime answers verdict-required (ReviewTapResponse.code), so an unmapped or off-roster account's grade is never held and cannot block another account under F3. The ordering test was replaced: 'APRV-482: a review with no verdict is refused verdict-required, after the roster check (PR #614 N6)'.
- Residual for the orchestrator: an armed Deny from ANY account in the approver chat (arming does not reach the runtime) blocks other accounts' taps on that card until that account finishes, the listener restarts, or /skip re-offers a fresh card.
UPDATED PROPOSED SPEC HUNK (N4, §5.2/§10.3, pending sign-off): 'A verdict MUST be explicit. A grade alone records nothing and is refused `verdict-required`, judged after the reviewer's roster check. A grade or an armed denial on a card belongs to the account that gave it and MUST NOT be recorded under another account's verdict.'
<!-- SECTION:NOTES:END -->
