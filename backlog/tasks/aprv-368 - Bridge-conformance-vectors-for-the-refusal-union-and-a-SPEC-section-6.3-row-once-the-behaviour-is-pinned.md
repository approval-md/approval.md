---
id: APRV-368
title: >-
  Bridge conformance vectors for the refusal union, and a SPEC section 6.3 row,
  once the behaviour is pinned
status: To Do
assignee: []
created_date: '2026-09-18 01:30'
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
