---
id: APRV-454
title: >-
  SPEC attestation batch: 383, 415, 421, 422, 423, 424, 428 and 445 in one
  ceremony
status: In Progress
assignee:
  - '@claude'
created_date: '2026-10-03 03:50'
updated_date: '2026-10-04 11:19'
labels:
  - spec
  - policy.edit
dependencies: []
references:
  - private/agentvillage-integration/06-gap-register.md
priority: medium
ordinal: 342000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The 2026-09-22 handover asked for one SPEC attestation batch (383 plus 421 plus 423 plus the 422 draft, no fourth copy). Since then APRV-424 (webhook, section 10.3), APRV-428 (section 11.2 preamble naming wait), APRV-415 (section 10.1 hermes row and the section 11.1 organ list with the .hermes spelling caveat) and APRV-445 (section 5.2 agent-requestable classes, section 9 payload store modes, section 10.1 propose and start, seven section 11.2 rows) added hunks, and PR 569 edited the spec file outside this repo's gate with pending-sign-off markers. Build the combined diff from each task's proposed hunk text, apply it on a branch, and hand Carter the one attestation ceremony. The section 13 wording for 422 is: No hosted service with authority over decisions. A hosted process may deliver, render, transport, operate and, once decisions are independently signed by the approver, record. Context: private/agentvillage-integration/06-gap-register.md G8.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 One branch carries every listed hunk applied verbatim from its source (design/hosted-daemon-identity.md section 7, APRV-421 notes, APRV-423 notes, APRV-424 notes, APRV-428 notes, docs/hermes-hook.md SPEC status section, PR 569's spec diff, the 422 wording) with the pending-sign-off markers removed and one Amended marker per task
- [x] #2 The diff is reviewed against each source hunk by a verifier and the docs guard and conformance suites pass
- [ ] #3 Carter attests with approval policy attest --path and the policy.updated record for the spec file lands; the task notes record the seq
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Worktree lane/aprv-454 from origin/main (af3e591a, #569 merged).
2. Collect each hunk from its source: design/hosted-daemon-identity.md section 7 (383); task notes of 421, 423, 424, 428, 455; docs/hermes-hook.md SPEC status (415); 447 notes on origin/lane/aprv-447; the 422 wording from this task's description; #569's markers already in SPEC.md (445).
3. Apply each verbatim at its named section, in SPEC voice (section -> §), one (Amended APRV-n.) marker per hunk, and resolve the APRV-445 pending-sign-off markers to plain. Leave other tasks' pending markers (317, 309, 322, 325.x, 338's n examples) untouched.
4. npm run build, docs-guard and conformance suites; one opus verifier compares every applied hunk against its source; fix drift.
5. One commit, push, PR with per-task sections and the SPEC.md sha256; do not arm. CLAIMS.md line with digest and attest command.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Applied on branch lane/aprv-454 (from origin/main af3e591a, #569 merged). Each hunk, its source, and where it landed:

- APRV-383: design/hosted-daemon-identity.md section 7. 7.1 is a new section 8 bullet, The writing daemon, after The provider reference. 7.2 is two append_error_codes rows (daemon-id-invalid, daemon-not-allowed) after head-moved. One marker per bullet and per row.
- APRV-415: docs/hermes-hook.md, SPEC status. Hunk 1 is the approval hook hermes block line in section 10.1, after hook codex, verbatim. Its marker sits in one sentence after the Six entries paragraph. Hunk 2 had no verbatim text and was drafted: three HERMES_HOME organs, with .env and auth.json beside them (a read classifies account.credential), plus the .hermes spelling caveat. The source calls this the section 11.1 organ list, but SPEC's organ list is section 5.2 Attestation of the gate's organs, so it was applied there.
- APRV-421: task notes, Proposed SPEC.md section 10 hunk. The approval serve line goes in the section 10.1 block after mcp serve. The new section 10.7, HTTP transport for a remote harness, follows 10.6 so the numbering reads in order. Added-pending became Amended.
- APRV-422: this task's description wording replaces the section 13 clause No hosted service (local-first; a sync story can come later).
- APRV-423: task notes, two hunks. The F1 hunk, A harness-stated ceiling is a bounded input, follows the approval_ttl paragraph; it reads The prohibition above. The A requester may shorten its own question hunk is in section 6.3, after the withdrawal paragraph. Its source header said section 6 after line 128, which contradicts itself. Placing it in 6.3 lets F1's cross-reference to section 6 resolve.
- APRV-424: task notes, section 10.3 hunk, after the What each channel authenticates table, verbatim with its inline marker.
- APRV-428: task notes item 2. The gate_refusal_codes preamble names wait (not-registered and the log-read codes).
- APRV-445: #569's text was already on main. All 11 pending markers became plain (Amended APRV-445.). No prose changed.
- APRV-447: the REVISED hunk from origin/lane/aprv-447 df99093c, which supersedes the earlier one, as a section 8 bullet after The writing daemon. section N became §N.
- APRV-455: task notes. In section 5.2 the senders key set now names edgeos. In section 10.3: an edgeos table row, the So two channels / RELAY paragraph, and the reaffirmation paragraph (placed after the section 10.1 ceremony paragraph inside the APRV-109 block). In section 11.2: the relay_refusal_codes preamble sentence, a 14-row table matching RELAY_REFUSAL_CODES, and the policy-not-attested and sender-unmapped trigger additions. The Classifier line was not applied as prose.

Other tasks' pending markers (317, 309, 322, 325.1, 325.2, and the APRV-n examples in the preamble) are untouched; 19 remain.

SPEC.md sha256 at head: d6732aa0e272934ab829e9df228a6836ca8c420a93a0cbc6344202b6a358e2fe

Verification: npm run build exit 0. docs-guard, conformance, conformance-regen, attest-path-signoff, protected-path-guard (three files) and cli-attest: 218/218, exit 0 (re-run on the final bytes).

Verifier (opus, read-only): EXACT for 383, 421, 422, 423, 424, 428 and 445. It found three issues, all fixed: 447 had the superseded hunk; 415 hunk 2's credential clause was too broad (narrowed to reads); the reaffirmation paragraph was misplaced (moved). It also suggested rewording the 415 connective sentence, which was done.

Open for a human (pre-existing text the hunks now strain, not applied):
- section 8 cites daemons under section 5.2, which names no such key.
- attest --organ takes repository-relative paths only, so the Hermes organs cannot be attested by that verb.
- section 10.5 says five verbs are withheld, but hook hermes makes six.
- section 10.7 says three transport-withheld verbs and includes export; it says the agent credential cannot read the log, yet log_verify is on serve's agent allowlist.
- section 10.3 v0.1 ships three channels and section 13 says no channel breadth beyond three, despite edgeos.
- the section 5.2 senders configured-identity fallback against the relay's no-fallback rule.
- the policy-already-attested row against relay reaffirmation.
- the gate_refusal_codes preamble does not name propose or start.
- 447's code (PR 587) is not merged, so attesting now ratifies its bullet ahead of its behaviour.

Full suite (node scripts/run-tests.mjs --baseline, started before the verifier's prose fixes): 5559 tests, 5558 pass, 0 fail, 1 skipped, exit 0; ci-baseline: 0 failing. The targeted re-run above covers the final bytes. AC 3 stays open for Carter's attestation.
<!-- SECTION:NOTES:END -->
