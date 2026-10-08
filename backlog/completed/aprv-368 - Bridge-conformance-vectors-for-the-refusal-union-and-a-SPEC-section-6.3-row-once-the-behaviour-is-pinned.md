---
id: APRV-368
title: >-
  Bridge conformance vectors for the refusal union, and a SPEC section 6.3 row,
  once the behaviour is pinned
status: Done
assignee:
  - '@claude'
created_date: '2026-09-18 01:30'
updated_date: '2026-09-19 16:43'
labels:
  - codex
  - bridge
  - spec
dependencies:
  - APRV-361
priority: low
ordinal: 285000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From docs/codex-app-server-bridge.md follow-up 8 (APRV-349). After the bridge (APRV-361) and its refusal-bearing follow-ups land, pin the union of bridge refusal codes in the conformance suite and add the SPEC section 6.3 row describing the Codex app-server surface: what it binds (command, cwd, item identity), what it does not (patch content by identity, the guarantee that a question is asked, the guarantee that a question reaches this client), and the two-word reply vocabulary. SPEC edits are few and land in one Edit call with a records advance before the guard runs.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 conformance/ carries vectors for every bridge refusal code and node conformance/run.mjs passes
- [x] #2 SPEC.md section 6.3 gains one row for the Codex app-server surface, amended through the gate
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
From APRV-366 (2026-09-19): the bridge grew a SECOND closed code array, BRIDGE_STOP_CODES (bridge-thread-start-refused, bridge-approval-policy-mismatch), for the ways it stops a session rather than declines a request. They were deliberately kept OUT of the bridge_refusal_codes union, because that union is documented as every way the bridge can decline an approval request, so conformance is unchanged. Whether the stops earn a union of their own is this task question, and the answer should be written down either way: a checker that saw only the declines union would think it had covered the whole vocabulary.

IMPLEMENTED 2026-09-19 on the orchestrator ruling: option (a), a second union, in ONE commit with the SPEC section 6.3 row.

AC1. bridge_stop_codes joins the conformance refusal-unions suite beside bridge_refusal_codes, carrying all FOUR stops (bridge-thread-start-refused, bridge-approval-policy-mismatch, bridge-auto-reviewer-active, bridge-preflight-void). Each union description now NAMES THE OTHER, which is the part that closes the door the notes worried about: a checker that read the declines alone is told, in the vector file itself, that it has read half.

THE VERSION IS MAJOR, 16.0.0, and that is this suite own rule rather than a choice. The refusal-unions suite pins WHICH unions exist and has bumped major for every addition since 7.0.0; 14.0.0 was exactly this shape when bridge_refusal_codes was born. The minor shape used earlier today (schema-validation 2.4.0, command-class 1.3.0) is for a suite that gains VECTORS, and this one gains a member of its own subject matter. Said in the script comment beside the version.

AC2. One SPEC section 6.3 row, at the end of the lifecycle section: what a harness app-server surface BINDS (the command as words and as the rendering that arrived, the harness-minted working directory, a stable call identity) and the three things it does not (item-based file-change content, the guarantee that an action produces a question, the guarantee that a question reaches this client), the vocabulary rules (answer only what the request advertised, never a word that converts one decision into standing authority, never a turn-stopping word in place of a no), the two-union rule, and the custody sentence from APRV-365. It cites section 11.1 invariant 6 rather than the section 11.2 registry, because the bridge unions are verb-local and that registry covers the six gate-facing ones plus the channel decision refusals.

VALIDATION. build, typecheck and lint exit 0. npm run conformance: 396 vectors passed, 0 failed, exit 0 (13 union vectors now, one of them the new stop union). codex-bridge, conformance-regen and docs-guard: 64 tests, 64 pass, exit 0. Full npm test recorded in the PR.

PROTECTED PATH: SPEC.md. The records advance is the orchestrator and this PR is not armed until they reply.

---

THE OPTIONS THIS RULING CHOSE FROM, recorded on main at 3a6d1ea before the ruling and kept here because the ruling is only legible next to them.

NOT STARTED as code by lane 6 (2026-09-19). Two things block it, one of them the open question the notes above already name.

BLOCKER 1, THE OPEN QUESTION, restated with what today added. The bridge now carries FOUR stop codes, not two: APRV-364 added bridge-auto-reviewer-active and bridge-preflight-void beside bridge-thread-start-refused and bridge-approval-policy-mismatch, and all four stayed OUT of the bridge_refusal_codes union for the reason APRV-366 gave (that union is documented as every way the bridge can DECLINE an approval request, and a stop ends the session instead). So the question is sharper now, and the options are:

(a) A SECOND UNION, bridge_stop_codes, beside the declines. A second implementation then answers both vocabularies and a checker that read only one knows it has read only one. The cost is a new union name in the conformance manifest and the version bump that carries.
(b) ONE UNION, renamed, carrying all seven codes with a field saying which are declines and which are stops. Cheaper for a reader, and it moves an existing union that a second implementation may already hold itself to, which is the MAJOR-bump shape.
(c) LEAVE THE STOPS UNPINNED and document, in the vector file own description, that the declines union is not the whole vocabulary. Cheapest and the weakest: a door left open is exactly what a conformance union exists to close.

Lane 6 would pick (a) and say so in both union descriptions, but this is a conformance-surface decision and the lane did not take it.

BLOCKER 2, PROCESS. AC2 is a SPEC section 6.3 row, which is a protected-path edit and therefore its own records advance and orchestrator ceremony. Today already spent one on APRV-378. Worth sequencing deliberately rather than stacking a second inside the same session.

WHAT THE SPEC ROW SHOULD SAY, since the behaviour is now settled enough to write it: the Codex app-server surface binds the command as words and as the rendering that arrived (APRV-362), the cwd the harness minted, and a stable call identity; it does NOT bind item-based patch content (APRV-379), the guarantee that an action produces a question (the approval policy and sandbox posture decide that, and APRV-366 pins and checks the policy), or the guarantee that a question reaches this client (APRV-364 probes one command and records a pre-emption as audit.question_preempted, APRV-378). The reply vocabulary is two words in eight spellings (APRV-367), and a login-shell exec is classified by its inner script while the outer argv stays bound (APRV-380).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The bridge stop codes are a conformance union of their own, bridge_stop_codes, carrying all four ways approval codex bridge ends a session rather than declining one request, and each of the two bridge unions now names the other so a second implementation that read one knows it has read half. The suite goes to 16.0.0, major by its own rule that it pins which unions exist, which is the same shape 14.0.0 took when the declines union was born. SPEC section 6.3 gains one row for the harness app-server surface: what it binds, the three things it does not and may not be claimed to, the reply-vocabulary rules, the two-union rule, and the custody sentence. Verified by npm run conformance at 396 vectors passed and 0 failed, the codex-bridge, conformance-regen and docs-guard suites at 64/64, and build, typecheck and lint at exit 0.
<!-- SECTION:FINAL_SUMMARY:END -->
