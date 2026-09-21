---
id: APRV-421
title: >-
  approval serve: an HTTP transport for the agent-facing verb surface, plus hook
  envelopes, log follow and export, with agent and tenant credentials
status: To Do
assignee: []
created_date: '2026-09-21 06:41'
labels:
  - hosting
  - daemon
  - hook
  - transport
dependencies: []
priority: high
ordinal: 322000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A tenant whose harness runs in a sandbox (Agent Village's Hermes tenants, APRV-399; the Meta Muse connector packet, APRV-405) has no local log and no local policy, so approval hook <harness> has nowhere to write and nothing to read. The hosted daemon (design/hosted-daemon-identity.md, APRV-383) runs elsewhere, one process per tenant; what is missing is a way to reach it. Add approval serve: a foreground HTTP server that publishes the same registry-derived agent-facing surface approval mcp serve does (human-only verbs absent, --as stripped, identity fixed at launch, refusals returned as results), and adds the three things the MCP transport withheld for transport reasons: hook <harness> taking the harness envelope as the request body and answering the same verdict the stdin form prints; log follow paged by an exclusive (seq, hash) cursor with the verified-subscription semantics of SPEC section 8 (verify from genesis before emitting, refuse a mismatched cursor hash with the existing integrity code, at-least-once on reconnect); and export, the store as an archive. Two bearer credentials read from the launch environment: an agent credential that may classify, request, wait and consume, and a tenant credential that may follow, export and read status. The agent credential must never read the log it is judged by. This is transport: it dispatches to the same functions the CLI dispatches to (decideHarnessCall, the verb registry, core/log-subscribe.ts) and reimplements no classification, policy resolution or token minting; two implementations of the gate sequence would be two gates. src/codex/serve.ts is the precedent for a server with a deliberately fixed catalog. Bind loopback by default; a non-loopback bind requires an explicit flag and TLS is the operator's proxy. The first deployment target is one Firecracker microVM per tenant (Bountify's hosted layer), so the server must survive a sleeping host: no in-memory state a restart loses beyond what the daemon already keeps. SPEC section 13 still says no hosted service; this verb is the local-first runtime's own door and a separate task amends section 13.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval serve starts under a launch environment naming the two credentials and the identity, prints the daemon instance id, and refuses to start on a non-loopback bind without the explicit flag
- [ ] #2 POST hook/<harness> with a harness envelope body returns the same verdict, code and message that approval hook <harness> prints for the same envelope on stdin, for every adapter in HARNESS_ADAPTERS, covered by a table test
- [ ] #3 The agent-facing verbs published match approval mcp serve's tool list exactly (registry filtered by human_only), with --as absent from every schema and the launch identity appended last; grant is absent
- [ ] #4 GET log/follow with an exclusive (seq, hash) cursor returns the same batch approval log follow prints; a cursor whose hash does not match is refused with the existing integrity code and no records; the response carries the new cursor
- [ ] #5 An agent-credential call to log/follow, export or status is refused with a distinct machine-readable code; a tenant-credential call to request, wait or consume is refused likewise; both through tests
- [ ] #6 export returns the store as an archive containing APPROVAL.md, the log and projections and nothing under .approval/keys, .approval/env or the vault
- [ ] #7 Every refusal is a result body with {error:{code,message}} and never a bare HTTP error; the server appends no record on its own account
- [ ] #8 docs/cli-reference.md and docs/README-extended.md gain the verb; SPEC section 10 hunk proposed in the implementation notes, not applied; build, typecheck, lint and the mcp, hook, log and channels suites pass
<!-- AC:END -->
