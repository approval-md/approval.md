---
id: APRV-368
title: >-
  Bridge conformance vectors for the refusal union, and a SPEC section 6.3 row,
  once the behaviour is pinned
status: To Do
assignee: []
created_date: '2026-09-18 01:30'
updated_date: '2026-09-19 13:48'
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
<!-- SECTION:NOTES:END -->
