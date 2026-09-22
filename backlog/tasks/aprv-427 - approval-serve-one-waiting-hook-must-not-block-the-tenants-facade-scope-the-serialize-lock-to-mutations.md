---
id: APRV-427
title: >-
  approval serve: one waiting hook must not block the tenant's facade; scope the
  serialize lock to mutations
status: To Do
assignee: []
created_date: '2026-09-22 01:27'
labels:
  - hosting
  - serve
  - concurrency
dependencies: []
priority: high
ordinal: 327000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-09-22 on the first hosted tenant (Bountify dogfood on Maritime, docs in bountify-ai/approval-md-hosted HOSTED-1): while a POST /hook/hermes call was held open waiting for a human decision, the tenant's POST /verb/queue and GET /status through the same approval serve did not answer until the hook's wait ended. src/serve/server.ts runs every verb invocation, hook call, follow page and export through a single serialize() lock. A waiting hook is a read-mostly poll; holding the tenant's whole facade for it means one pending question hides the queue from the very person who has to answer it, and N concurrent gated calls from a sandbox queue behind each other. Decide the lock's true scope: appends and projections need it (the CLI's own append lock already guards the log), waits and reads do not, or the lock becomes per-store and per-kind. Keep the invariant that the server appends nothing on its own account and that two verbs never interleave an append.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 With a fake decider that holds one /hook call open for 60 s, GET /status, POST /verb/queue and GET /log/follow with the tenant credential answer within 2 s
- [ ] #2 Two concurrent /hook calls for different tasks both open their requests and both wait; neither is refused or delayed by the other beyond the append
- [ ] #3 A test proves no interleaving of two appends through the facade (the existing single-appender property still holds)
- [ ] #4 docs/cli-reference.md states what serve serialises and what it does not
<!-- AC:END -->
