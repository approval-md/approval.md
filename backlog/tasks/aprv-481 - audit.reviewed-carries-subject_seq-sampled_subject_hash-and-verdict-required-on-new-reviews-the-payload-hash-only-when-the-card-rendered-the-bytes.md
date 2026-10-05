---
id: APRV-481
title: >-
  audit.reviewed carries subject_seq, sampled_subject_hash and verdict (required
  on new reviews); the payload hash only when the card rendered the bytes
status: In Progress
assignee: []
created_date: '2026-10-05 06:51'
updated_date: '2026-10-05 08:21'
labels:
  - agentvillage
dependencies: []
priority: high
ordinal: 366000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Supervised-retro core piece (in scope for Oct 11). The follower and dbt halves (claude-main) read audit.reviewed, so the record must name which subject was sampled and the verdict. Required on new records; old records read unchanged. The payload hash is recorded only when the card actually rendered the bytes (see APRV-480), so a hash never claims more than the reviewer saw.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The schema requires subject_seq, sampled_subject_hash and verdict on new audit.reviewed records; old records still read unchanged
- [x] #2 The payload hash field is present only when the card rendered the bytes, absent otherwise; tests cover both
- [x] #3 The follower-facing field names are documented in one place and posted for the follower and dbt halves
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Commit 98bb66c7.

Done:
- schema/event.schema.json: the audit.reviewed branch now `$ref`s `$defs/audit_reviewed_record`, which requires payload.subject_seq, payload.sampled_subject_hash and payload.verdict, and adds patterns for sampled_subject_hash and payload_hash. `audit_reviewed_record_historical` has the same shape without the three requirements.
- `WIDENED_DEFS` (src/core/validate.ts) maps the strict definition to the historical one, so the verifier (historical mode) reads old reviews unchanged.
- reviewSample always writes sampled_subject_hash. A sample with no subject hash is refused `not-sampled`.
- `ReviewOptions.renderedPayloadHash` is checked against `boundPayloadHash`. A mismatch, or no binding at all, is refused with the new code `rendered-payload-mismatch`. A match is written as payload.payload_hash.
- The Telegram channel sets `ReviewTap.payloadHash` only when `reviewPayloadView(card).kind === "bytes"`. The CLI never sets it.
- Fixtures: the five audit.reviewed fixtures were updated, and invalid/audit-reviewed-no-subject-hash.json was added. Conformance schema-validation was regenerated at 3.0.0 (a major: expectations moved), with the README noted.
- tests/money.test.ts pairing check generalised. tests/render-queue.test.ts hand-written review now carries the fields.

FOLLOWER-FACING FIELD NAMES (single definition: docs/cli-reference.md#the-review-record). For the orchestrator to post to the follower and dbt halves:
- record: event="audit.reviewed", seq, ts, hash, actor (human:<id>), action_key, task, channel
- payload.subject_seq (int, REQUIRED): seq of the audit.sampled record. This is NOT the execution's seq.
- payload.sampled_subject_hash (64-hex, REQUIRED): hash of the execution.started record. Join key to the execution.
- payload.verdict ("ok"|"denied", REQUIRED, explicit since APRV-482)
- payload.payload_hash (64-hex, OPTIONAL): present only when the reviewer was shown the bytes whole
- payload.reaction (disliked|indifferent|liked|loved, optional), payload.note, payload.sender{channel,id,hashed?}, payload.sender_source
- payload.subject_event="audit.sampled", payload.reviewed=true (constants)
- denial link: reconciliation.required.payload.review_seq = review seq
- On reviews written before APRV-481, the three required fields may be missing. Treat that as "not recorded", never as a default.

Touches §11.1 invariant 4 (self-reported fields): the surface's claim that it showed the bytes is verified against the log and never trusted as given.

PROPOSED SPEC HUNK (pending sign-off). §8 event log, after the event-types list:
"`audit.reviewed` records written since APRV-481 MUST carry `payload.subject_seq` (the seq of the `audit.sampled` it answers), `payload.sampled_subject_hash` (the hash of the `execution.started` that sample named) and `payload.verdict`. Verifiers MUST accept earlier records without them. `payload.payload_hash` MAY be recorded only when the reviewing surface rendered the bound bytes whole, and it MUST equal the execution's binding (Amended APRV-481)."
§11.2 audit_refusal_codes, new row after `ambiguous-subject`:
"| `rendered-payload-mismatch` | The reviewing surface said it showed bytes whose hash is not the sampled execution's binding. Nothing is appended. |"

Fix round 1 (refutation of PR #614), lane claude-edge/A3-fix1.
- F5 (should-fix) FIXED in 62913219. New audit.reviewed records REQUIRE payload.verdict_source = "explicit" (const); reviewSample writes it on every surface. The historical form allows it without requiring it, so old reviews verify through the existing audit_reviewed_record widening. Tests: event-schema 'PR #614 F5: a new review says its verdict was explicit; an old one without the field still reads', audit 'PR #614 refutation F5: every review the runtime writes says its verdict was explicit'. Fixture audit-reviewed-no-verdict-source added; review fixtures gained the field.
- F6 (should-fix) FIXED in 2bd7af75. The schema-validation harness names the missing property on every required error (missing), thrown as a harness failure if the validator message has another shape. New fixtures audit-reviewed-no-verdict, audit-reviewed-no-subject-seq, audit-reviewed-bad-payload-hash; each review/sample required field now has its own signature. Still the unreleased 3.0.0 major. conformance/run.mjs exit 0, 490/490, manifest ok.
- F2's schema half (audit.sampled pins policy_sha256) is in 52ba4de0, see APRV-483.
- Follow-up filed: APRV-487 (N3, match reviews to samples by subject_seq exclusively when present).
FOLLOWER-FACING FIELD LIST CHANGE (for the orchestrator to post to the follower and dbt halves): payload.verdict_source ('explicit', REQUIRED on new reviews). Count a review as an explicit approval only when it carries verdict_source; a review without it predates APRV-482 or came from an old build, and its ok may have been defaulted. audit.sampled gains payload.policy_sha256 (64-hex, REQUIRED on new samples).
UPDATED PROPOSED SPEC HUNKS (N4, pending sign-off). §8, replacing the APRV-481 hunk: '`audit.reviewed` records written since APRV-481 MUST carry `payload.subject_seq`, `payload.sampled_subject_hash` and `payload.verdict`, and since PR #614 `payload.verdict_source` with the value `explicit`. Verifiers MUST accept earlier records without them, and a reader MUST NOT treat a verdict on a record without `verdict_source` as explicit. `payload.payload_hash` MAY be recorded only when the reviewing surface rendered the bound bytes whole, and it MUST equal the execution's binding.' Also §8: '`audit.sampled` records written since PR #614 MUST carry `payload.policy_sha256`, the hash the latest policy attestation named when the sample was taken; verifiers MUST accept earlier samples without it.' §11.2 row unchanged: rendered-payload-mismatch.
<!-- SECTION:NOTES:END -->
