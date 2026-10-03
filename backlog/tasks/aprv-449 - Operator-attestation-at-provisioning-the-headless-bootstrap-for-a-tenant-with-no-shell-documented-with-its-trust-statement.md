---
id: APRV-449
title: >-
  Operator attestation at provisioning: the headless bootstrap for a tenant with
  no shell, documented with its trust statement
status: Done
assignee:
  - '@opus-lane'
created_date: '2026-10-03 03:49'
updated_date: '2026-10-03 13:20'
labels:
  - hosting
  - attest
  - agent-village
  - docs
dependencies:
  - APRV-446
references:
  - private/agentvillage-integration/05-integration-architecture.md
priority: high
ordinal: 337000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
An Agent Village resident has no shell. The control plane provisions the sandbox, runs approval init as the approvald user (which scaffolds the canonical policy unattested), and until a human attests, every gated call refuses policy-not-attested and the Hermes hook, fail closed, blocks the tool. Core's approval policy attest --as human:<id> has no TTY requirement (identity is declared; the attest-requires-terminal refusal is the channel bootstrap case where the policy maps no sender yet), so a root step can attest as the operator. The attester must be the operator (one fixed identity, for example human:carter), never the resident, because an attestation the resident did not perform would be a fabricated human act. Every later amendment rides the channel path (SPEC section 10.3, APRV-109) with the resident's tap. This is operator trust in the sense APRV-422 names. Deliver the documented bootstrap, its idempotency (policy-already-attested on a re-run), the trust statement for hosted doc 04 and consent copy, and a doctor or status line that shows who attested the policy in force. Context: private/agentvillage-integration/05-integration-architecture.md section 5; relay spec Q1 in the agentvillage private drafts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 docs/hermes-hook.md or a new docs/hosted-provisioning.md documents the sequence init, write policy, attest --as human:<operator> as the store user, with the exact commands, the idempotent re-run behaviour and the refusal codes
- [x] #2 approval status or approval doctor shows the attester identity and attestation seq of the policy in force so a tenant can see who set their starting policy
- [x] #3 A test proves attest succeeds headless (no TTY) with a declared human identity and that the attested text lands in the payload store
- [x] #4 The trust statement (operator sets the starting policy; every change needs the approver's tap through the channel) is written once in docs and referenced from APRV-422's section 13 wording
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Finding first: `approval policy attest` today is NOT idempotent. A second run over the same bytes appends a second policy.updated; `policy-already-attested` exists only on the channel proposal path (core/policy-proposal.ts). Re-running the bare verb from ensureApprovald on update/recreate would also REPLACE a later resident attestation as attester of record. So the documented re-run needs a real refusal.
2. Add `--bootstrap` to `approval policy attest` (opt-in, the default verb unchanged): new core/attest-bootstrap.ts reads the VERIFIED records, refuses `policy-already-attested` when the live bytes match the latest attestation, refuses `policy-amendment-required` when the log carries an attestation of other bytes (a change after the first policy is the approver's act through the channel), and otherwise appends through appendAttestation with expectedHead from the read (compare-and-append; head-moved on a race). Exit 1 for both refusals (a runtime decision), 3/4 for torn/io as today.
3. `approval status`: the attestation row and --json gain the attester identity (`attested_by`), read from the verified record at the in-force seq, never from the file. Registry output schema updated; frozen-shape test updated.
4. `approval doctor` attestation row names the attester beside the seq.
5. Tests: headless (stdin ignored, no TTY) attest with --as human:<operator> succeeds and the attested text lands in the payload store byte for byte; --bootstrap first run appends, re-run refuses policy-already-attested and appends nothing; edited bytes refuse policy-amendment-required; status and doctor show the attester.
6. docs/hosted-provisioning.md: the sequence (init, write policy, attest --bootstrap as the store user, exact commands, cwd rule for the log), the re-run behaviour, every refusal code, and the trust statement written once, citing APRV-422's proposed section 13 wording. cli-reference attest/status/doctor sections, help text within the 25-line cap, CHANGELOG bullet.
7. Propose a SPEC §5.2 hunk for --bootstrap and a §13 cross-reference in the notes (no SPEC edit).
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Resume point: code, tests and docs written (core/attest-bootstrap.ts, attesterAt in core/attest.ts, --bootstrap in cli/attest.ts, status/doctor attester, tests/cli-attest-bootstrap.test.ts, docs/hosted-provisioning.md, cli-reference, help, CHANGELOG). Next: full npm test, then commit APRV-449, push, PR.

Implementation notes (2026-10-03, opus lane):

FINDING THAT SHAPED THE WORK. `approval policy attest` was not idempotent: it reads no log and appends a policy.updated on every run. `policy-already-attested` existed only on the channel proposal path (core/policy-proposal.ts). A provisioning step re-run on update/recreate would therefore (a) add an attestation per redeploy and (b) once the resident has attested, put the operator back on record as attester. So the documented re-run is a real refusal, not prose.

WHAT CHANGED.
- core/attest-bootstrap.ts (new): appendBootstrapAttestation reads the VERIFIED log, refuses policy-already-attested (live bytes match the latest attestation) or policy-amendment-required (log carries an attestation of other bytes), else appends via appendAttestation with expectedHead = the head it read and expectedSha256 = the digest it checked. Both refusals carry seq and attested_by. Agent actor refused before the log is read.
- core/attest.ts: attesterAt(records, seq), the actor of the attestation record at a seq.
- cli/attest.ts: --bootstrap (opt-in; the plain verb is unchanged). Exit 1 for both refusals, head-moved and log-corrupt (a runtime decision, as the gate verbs do); 3 for torn tail; 2 beside --organ/--path.
- status: attestation.attested_by (always present, null when unattested; on hash-mismatch it names who attested the bytes the file no longer matches); text row 'attested (seq N, by human:x)'. Registry output schema updated.
- doctor: attestation row 'is attested at seq N by human:x (sha256 ...)'.
- docs/hosted-provisioning.md (new): trust statement (written once), why operator and never resident, the sequence with exact commands, the cwd rule, the refusal table, what the tenant can see. cli-reference policy-attest (No terminal paragraph + --bootstrap section), status, doctor. Help within the 25-line cap. CHANGELOG.

GLOBAL INVARIANTS TOUCHED. Compare-and-append: the bootstrap is a check-then-append and passes expectedHead (plus a byte binding). Enforcement reads only verified records: the bootstrap and attesterAt read readVerifiedRecords / the status/doctor verified records. Human-only attestation unchanged (actor-not-human before anything is read). No caller timestamps (policy.updated is core-stamped, unchanged).

LAUNCHER FINDING (for the orchestrator / controlplane). approval up resolves its log and QUEUE.md against the working directory (src/cli/up.ts:432); approval serve --dir resolves the log under --dir. A launcher running both with --dir data from a different cwd writes two logs. Documented in hosted-provisioning.md; docs/RAILWAY.md (controlplane) should start up from the store or pass --log.

SPEC HUNKS PROPOSED (not applied; agents may not edit SPEC.md):
1. §5.2, after the attestation paragraph: 'approval policy attest --bootstrap attests only a log that carries no attestation. Over bytes that match the latest attestation it refuses policy-already-attested; over bytes that differ it refuses policy-amendment-required; it appends nothing in either case, and it compares and appends against the head it read (§11.1). It is the provisioning step for a hosted store whose approver has no terminal; a change to an attested policy is an amendment and reaches the log only as the approver's act (§10.3).'
2. §10.1 verb listing, the attest line gains '[--bootstrap]  # a store's first policy only; re-run refuses policy-already-attested'.
3. §13, when APRV-422 is applied: '... Below that level a hosted runtime operates under stated operator trust (docs/hosted-provisioning.md, The trust statement), and the local-first path remains complete without it.'

VERIFICATION. tests/cli-attest-bootstrap.test.ts (9 tests, every child spawned with stdin ignored and no APPROVAL_HUMAN): headless attest stores the attested text byte for byte in the payload store; bootstrap first run, re-run refusal, refusal over another human's attestation, amendment refusal, agent actor, flag mixes; status and doctor name the attester. Full npm test: 5397 pass, 1 fail (tests/cli-style-render.test.ts 'status paints no timestamp and no seq', which pinned the old row text); fixed, and cli-style-render + cli-status + cli-attest-bootstrap rerun 55/55, exit 0. tsc --noEmit 0, lint 0.

AC #4 reading: the trust statement is written once (docs/hosted-provisioning.md, 'The trust statement') and cites APRV-422's proposed section 13 wording verbatim; the reverse pointer from SPEC.md section 13 is SPEC hunk 3 above, for the human applying APRV-422.

Resume point: pushed lane/aprv-449-446 at 5fbb6ab8; next: gh pr create, watch checks.

CI: PR #570 green (full gate shards 1-3, protected paths, classify tier, ci). Full local npm test on the stacked branch (449 + 446): 5405 pass, 0 fail, 2 skipped, exit 0.

Review fixes (refuter on #570, 2026-10-03):
1. --bootstrap resolves the log under --dir (the store's default log path) unless --log is given; the plain verb keeps its cwd default. Test: attest --bootstrap --dir <store> from a foreign cwd lands in the store's log, the re-run refuses there, no stray log appears, and an explicit --log still wins.
2. docs/hosted-provisioning.md step 2 now writes the render only when the store has no log file at all; --bootstrap is the only attestation guard; step 3 passes --dir; the doc says why a status --json guard is wrong (a torn tail reads not-attested; status exits 1 so pipefail makes the if always false) and that steps 1-3 run before up/serve start.
3. BOOTSTRAP_REFUSAL_CODES pinned by a deepEqual freeze test (SPEC §11.1 invariant 6, verb-local union per §11.2).
4. The orphan payload file on a refused append is documented, not removed (core/attest-bootstrap.ts header, cli-reference, the refusal table): removal is unsafe because the record that moved the head may be another attestation of the same bytes, which binds that file. Inert; status counts it under payload_store.orphans.
SPEC HUNK 4 (added): the §11.2 refusal-code registry gains a verb-local note for approval policy attest --bootstrap: policy-already-attested (the live policy already matches its latest attestation; nothing appended; the expected answer on a provisioning re-run) and policy-amendment-required (the log carries an attestation of other bytes; a change to an attested policy is the approver's act through a channel; nothing appended), exported as BOOTSTRAP_REFUSAL_CODES, frozen, pinned in tests/cli-attest-bootstrap.test.ts. All four SPEC hunks stay pending sign-off and ride APRV-454.
Verification: tsc 0, lint 0; cli-attest-bootstrap, cli-attest, cli-status, cli-style-render, e2e-demo, cli-long-help, cli-help, docs-guard, cli-doctor: 233/233.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Operator bootstrap attestation for a hosted tenant with no shell. New `approval policy attest --bootstrap` (core/attest-bootstrap.ts) attests a store's first policy only, refusing policy-already-attested on a re-run and policy-amendment-required on changed bytes, compare-and-append against the head it read; the plain verb is unchanged. approval status gains attestation.attested_by and doctor's attestation row names the attester, both read from verified records. docs/hosted-provisioning.md carries the sequence, refusal codes and the trust statement (citing APRV-422's section 13 wording). Verified by tests/cli-attest-bootstrap.test.ts (headless, no TTY, payload store byte-for-byte) and the full suite (one pinned-text failure fixed and rerun green); tsc and lint clean. SPEC hunks proposed in the notes.
<!-- SECTION:FINAL_SUMMARY:END -->
