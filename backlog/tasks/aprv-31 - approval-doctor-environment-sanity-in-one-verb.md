---
id: APRV-31
title: 'approval doctor: environment sanity in one verb'
status: In Progress
assignee:
  - '@fable'
created_date: '2026-08-05 12:19'
updated_date: '2026-08-05 12:19'
labels: []
milestone: m-6
dependencies: []
priority: medium
type: feature
ordinal: 31000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up 4-adjacent (human-approved 2026-08-09), motivated by the stale-checkout and placeholder-binary detours in the amendment ceremony: the operator ran against an outdated build and an unbuilt bin before finding the real one. approval doctor checks, in one pass, each failure paired with a suggested fix: build freshness (dist mtime/content vs git HEAD state, and cli.js loader vs dist presence), identity resolution (APPROVAL_HUMAN/--as), attestation status vs the live policy hash, log verification summary, and channel reachability probes — Telegram send-capability via getMe (never sending a decision or message), web port availability. Read-only except the probes' outbound calls; appends nothing.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval doctor reports pass/fail per check — build freshness, identity, attestation vs live hash, log verification, channel probes — each failure with a concrete suggested fix line
- [ ] #2 The Telegram probe proves send-capability without sending anything a human sees (getMe/token validity only, never a message or decision); web probe checks the configured port is free or held by us
- [ ] #3 Exit 0 all-pass, 1 any-fail; --json frozen; appends nothing to the log (byte-check test); probes skipped cleanly with a note when env is absent
- [ ] #4 Subprocess tests cover: stale dist (older than a touched source file), missing dist (the placeholder-binary shape), unattested and hash-mismatched policy, unreachable mock Telegram, all-green
<!-- AC:END -->
