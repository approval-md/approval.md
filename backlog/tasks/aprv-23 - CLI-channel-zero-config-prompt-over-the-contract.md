---
id: APRV-23
title: 'CLI channel: zero-config prompt over the contract'
status: To Do
assignee: []
created_date: '2026-08-05 10:50'
labels: []
milestone: m-5
dependencies:
  - APRV-22
priority: medium
type: feature
ordinal: 23000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC section 10.3 ships cli as the zero-config channel: notify surfaces the pending request in the terminal (tagged fields rendered with computed/claimed visually distinguished; full payload for manual actions), and the decision is collected interactively (grant/reject with note), recorded through the existing human-only gate verbs with resolveHumanActor identity. First consumer of the APRV-22 contract, proving the conformance suite against a real implementation. No new dependencies; plain readline.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval channel cli surfaces pending requests and collects grant/reject decisions interactively, recording them through the existing gate verbs with config-declared human identity
- [ ] #2 Rendering distinguishes computed from claimed fields visibly and shows the full payload for manual actions, verified via the shared conformance suite
- [ ] #3 The APRV-22 conformance suite passes against the cli channel unmodified
- [ ] #4 Non-interactive invocation degrades gracefully (documented exit code, no hang), covered by subprocess tests
<!-- AC:END -->
