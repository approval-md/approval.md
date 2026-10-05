---
id: APRV-482
title: >-
  A review verdict needs an explicit affirmative: a reaction-only tap or a bare
  CLI review no longer writes verdict ok
status: In Progress
assignee: []
created_date: '2026-10-05 06:51'
updated_date: '2026-10-05 07:26'
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
<!-- SECTION:NOTES:END -->
