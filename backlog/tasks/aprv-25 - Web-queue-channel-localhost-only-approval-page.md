---
id: APRV-25
title: 'Web queue channel: localhost-only approval page'
status: To Do
assignee: []
created_date: '2026-08-05 10:51'
labels: []
milestone: m-5
dependencies:
  - APRV-22
  - APRV-24
priority: medium
type: feature
ordinal: 25000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC sections 5.1 and 10.3: the web channel is a local queue page with grant/reject. Human-settled (2026-08-08): binds localhost only, no auth in v0.1 — the same local-machine trust boundary as config-declared identity, stated plainly in the channel docs and the served page. B3 and B7 both land here: tagged computed/claimed rendering via the APRV-22 contract, and batch presentation with unit decisions in the log (each grant/reject its own event carrying the batch delivery id). Decisions are recorded through the existing human-only gate verbs with config-declared identity. Zero new dependencies: node:http, hand-rendered HTML. Port from policy channels.web.port (default 4680 per the section 5.1 example).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval channel web serves the pending queue on the configured port bound to 127.0.0.1 only (a test proves non-loopback binding is refused/absent), with the no-auth local-trust-boundary caveat stated in docs and page
- [ ] #2 Grant and reject (with note) work from the page, each recorded as its own log event through the gate verbs with config-declared human identity; the served page renders computed vs claimed distinctly and full payloads for manual actions
- [ ] #3 B7 batch approval works: one gesture over a set produces one event per request carrying the batch delivery id; forbidden mixes are refused at batch assembly, per the contract
- [ ] #4 The APRV-22 conformance suite passes against the web channel unmodified
- [ ] #5 Zero new dependencies; subprocess/e2e tests exercise the real HTTP surface against logs built through the real append path
<!-- AC:END -->
