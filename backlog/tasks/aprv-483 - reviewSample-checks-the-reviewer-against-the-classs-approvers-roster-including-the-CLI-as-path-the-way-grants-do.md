---
id: APRV-483
title: >-
  reviewSample checks the reviewer against the class's approvers roster,
  including the CLI --as path, the way grants do
status: In Progress
assignee: []
created_date: '2026-10-05 06:51'
updated_date: '2026-10-05 07:26'
labels:
  - agentvillage
dependencies: []
priority: high
ordinal: 368000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Supervised-retro core piece (in scope for Oct 11). Grants check the sender against the class's approvers roster; reviewSample does not, and the CLI --as path can name anyone. A review by a non-roster reviewer must not count.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A non-roster reviewer is refused with a named code, on every channel and on the CLI --as path
- [x] #2 A test covers roster, non-roster and --as
- [x] #3 Docs state the roster rule for reviews
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Commits 950cccef, eda31f99.

Done:
- reviewSample resolves the sample's class. It comes from the registration, falling back to the runtime-written sample's `class`. The class is resolved under the policy, and when the winning rule names `approvers`, a reviewer off the roster is refused `actor-not-approver`. The comparison is gate's own `namesApprover`, now exported.
- The check lives in core, so the CLI `--as` path and sender-mapped Telegram taps are held to the same list.
- A rule with no roster restricts nobody, the same as for grants.
- Docs: audit review section and Telegram section. Help text updated.

Security review findings (coordinator relay, src/core/audit.ts):

(1) "authorization-bypass": CONFIRMED, FIXED in eda31f99.
- 950cccef read the roster from whatever policy the caller pointed at. `approval audit review --policy <any file> --as human:<off-roster>` could therefore record.
- Now the roster is parsed only from the bytes of the file a grant reads (gate `policyPathOf`, exported), and only when they equal the latest attestation. Anything else is refused with the new code `policy-not-attested`.
- Test: tests/audit.test.ts "APRV-483 refutation: the roster cannot come from a file the reviewer chose or nobody attested". It covers the chosen file through core and through the CLI, an unattested edit, and a missing file.

(2) "fail-open": CONFIRMED for two inputs, FIXED in eda31f99.
- An unreadable or unparseable policy resolved to "no roster". It is now refused policy-not-attested.
- A sample with no class resolved as default, meaning no roster. It is now refused actor-not-approver.
- Test: "APRV-481/483 refutation: a sample that names no subject hash or no class is refused, never reviewed". It also pins: a missing sampled_subject_hash is refused not-sampled; a garbled verdict is refused verdict-required, never ok; and `namesApprover([], ...)` is false. An empty roster is otherwise unreachable, because policy.schema.json sets minItems 1.

Checked and not fail-open:
- reviewSample has no try/catch that swallows an error. loadPolicyText and resolve fail closed by returning a result.
- The Telegram handler rethrows after drawing TELEGRAM_HANDLER_FAILED, and nothing is appended.
- The reaction-tap path reaches the same core check (Telegram test "APRV-483: a mapped reviewer off the class roster ...").

Remaining by design, same as grants:
- An attested rule with no `approvers` lets any human:<id> review.
- The listener's configured identity is a config-declared trust boundary (§11).

Behavior change for orchestrator/human: a review now needs the policy attested, and before this it needed none. A policy edited and not yet re-attested holds the review backlog open until someone re-attests. This reverses the old "no attestation for review" rationale on purpose. The SPEC hunk proposes it, pending sign-off.

Touches §11.1 invariant 1 (verified records and attested policy) and invariant 6 (two new distinct codes).

PROPOSED SPEC HUNK (pending sign-off). §5.2, after the APRV-137 approvers text, add:
"A retrospective review is held to the same roster. Where the rule resolving the sampled action's class names `approvers`, a reviewer it does not name is refused `actor-not-approver`, and the roster is read only from the attested policy bytes: otherwise the review is refused `policy-not-attested` (Amended APRV-483)."
This reverses "review requires no attestation" in §10.1/§5.2 wherever stated.
§11.2 audit_refusal_codes, new rows after `actor-not-human`:
"| `actor-not-approver` | The reviewer is not on the approvers roster of the rule resolving the sample's class, or the sample names no class. |"
"| `policy-not-attested` | The policy the roster would be read from is unattested, edited since attestation, or unreadable. |"
<!-- SECTION:NOTES:END -->
