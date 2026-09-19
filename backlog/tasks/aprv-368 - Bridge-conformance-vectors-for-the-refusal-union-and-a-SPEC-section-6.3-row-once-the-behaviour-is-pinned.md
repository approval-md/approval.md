---
id: APRV-368
title: >-
  Bridge conformance vectors for the refusal union, and a SPEC section 6.3 row,
  once the behaviour is pinned
status: To Do
assignee: []
created_date: '2026-09-18 01:30'
updated_date: '2026-09-19 16:34'
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
- [ ] #1 conformance/ carries vectors for every bridge refusal code and node conformance/run.mjs passes
- [ ] #2 SPEC.md section 6.3 gains one row for the Codex app-server surface, amended through the gate
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
From APRV-366 (2026-09-19): the bridge grew a SECOND closed code array, BRIDGE_STOP_CODES (bridge-thread-start-refused, bridge-approval-policy-mismatch), for the ways it stops a session rather than declines a request. They were deliberately kept OUT of the bridge_refusal_codes union, because that union is documented as every way the bridge can decline an approval request, so conformance is unchanged. Whether the stops earn a union of their own is this task question, and the answer should be written down either way: a checker that saw only the declines union would think it had covered the whole vocabulary.

NOT STARTED as code by lane 6 (2026-09-19). Two things block it, one of them the open question the notes above already name.

BLOCKER 1, THE OPEN QUESTION, restated with what today added. The bridge now carries FOUR stop codes, not two: APRV-364 added bridge-auto-reviewer-active and bridge-preflight-void beside bridge-thread-start-refused and bridge-approval-policy-mismatch, and all four stayed OUT of the bridge_refusal_codes union for the reason APRV-366 gave (that union is documented as every way the bridge can DECLINE an approval request, and a stop ends the session instead). So the question is sharper now, and the options are:

(a) A SECOND UNION, bridge_stop_codes, beside the declines. A second implementation then answers both vocabularies and a checker that read only one knows it has read only one. The cost is a new union name in the conformance manifest and the version bump that carries.
(b) ONE UNION, renamed, carrying all seven codes with a field saying which are declines and which are stops. Cheaper for a reader, and it moves an existing union that a second implementation may already hold itself to, which is the MAJOR-bump shape.
(c) LEAVE THE STOPS UNPINNED and document, in the vector file own description, that the declines union is not the whole vocabulary. Cheapest and the weakest: a door left open is exactly what a conformance union exists to close.

Lane 6 would pick (a) and say so in both union descriptions, but this is a conformance-surface decision and the lane did not take it.

BLOCKER 2, PROCESS. AC2 is a SPEC section 6.3 row, which is a protected-path edit and therefore its own records advance and orchestrator ceremony. Today already spent one on APRV-378. Worth sequencing deliberately rather than stacking a second inside the same session.

WHAT THE SPEC ROW SHOULD SAY, since the behaviour is now settled enough to write it: the Codex app-server surface binds the command as words and as the rendering that arrived (APRV-362), the cwd the harness minted, and a stable call identity; it does NOT bind item-based patch content (APRV-379), the guarantee that an action produces a question (the approval policy and sandbox posture decide that, and APRV-366 pins and checks the policy), or the guarantee that a question reaches this client (APRV-364 probes one command and records a pre-emption as audit.question_preempted, APRV-378). The reply vocabulary is two words in eight spellings (APRV-367), and a login-shell exec is classified by its inner script while the outer argv stays bound (APRV-380).
<!-- SECTION:NOTES:END -->
