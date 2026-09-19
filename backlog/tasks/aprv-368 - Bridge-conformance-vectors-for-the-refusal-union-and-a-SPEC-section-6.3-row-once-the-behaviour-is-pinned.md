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
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The bridge stop codes are a conformance union of their own, bridge_stop_codes, carrying all four ways approval codex bridge ends a session rather than declining one request, and each of the two bridge unions now names the other so a second implementation that read one knows it has read half. The suite goes to 16.0.0, major by its own rule that it pins which unions exist, which is the same shape 14.0.0 took when the declines union was born. SPEC section 6.3 gains one row for the harness app-server surface: what it binds, the three things it does not and may not be claimed to, the reply-vocabulary rules, the two-union rule, and the custody sentence. Verified by npm run conformance at 396 vectors passed and 0 failed, the codex-bridge, conformance-regen and docs-guard suites at 64/64, and build, typecheck and lint at exit 0.
<!-- SECTION:FINAL_SUMMARY:END -->
