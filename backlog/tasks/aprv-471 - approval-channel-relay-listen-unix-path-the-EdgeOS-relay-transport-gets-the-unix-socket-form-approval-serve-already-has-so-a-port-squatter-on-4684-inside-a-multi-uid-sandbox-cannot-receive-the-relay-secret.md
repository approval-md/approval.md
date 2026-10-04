---
id: APRV-471
title: >-
  approval channel relay --listen unix:<path>: the EdgeOS relay transport gets
  the unix-socket form approval serve already has, so a port squatter on 4684
  inside a multi-uid sandbox cannot receive the relay secret
status: To Do
assignee: []
created_date: '2026-10-04 21:36'
labels:
  - agent-village
dependencies:
  - APRV-455
priority: medium
ordinal: 358000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From agentvillage-d4's 2026-10-04 reading of the 4682 squat (confirmed by claude-edge): the DATA-234 shim checks the listener's uid before every post to the facade, so a squatter on 4682 is a block, and APPROVALD_LISTEN=unix (approval serve --listen unix, shipped in 0.4.0 by APRV-445) removes even the millisecond window. The relay transport APRV-455 added (approval channel relay, loopback 4684, shared secret in x-approval-relay-secret) has --listen [host:]port and --allow-non-loopback but no unix form, so the control plane's DATA-259 review route must check the 4684 listener's uid before every post (it does) and still carries the same window; APRV-455's own report named a unix socket as the fix that removes the listener check. Build: --listen unix:<path> on channel relay with the same socket-permission rules serve uses (0600 or a group the control plane's exec can reach as approvald), the secret still required on the socket, the control plane's review route and the launcher (control-plane scripts/approvald-launcher.sh) pointed at the socket when APPROVALD_LISTEN=unix, docs/cli-reference.md and the relay spec amended. Related: cp #76 (DATA-285) evicts a foreign 4684 listener; with unix both layers stand.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval channel relay accepts --listen unix:<path>, refuses a path whose parent is not approvald-owned or whose mode is wider than the serve rule, and answers gestures over the socket exactly as over TCP; tests for the socket path and the refusals
- [ ] #2 APPROVAL_RELAY_LISTEN env mirrors the flag the way APPROVAL_SERVE_LISTEN does; the frozen relay startup refusals gain the socket cases with vectors
- [ ] #3 docs/cli-reference.md and docs/hermes-hook.md state the unix form and that the control plane posts to the socket when APPROVALD_LISTEN=unix; a control-plane follow-up is filed in agentvillage-data for the review route and launcher
<!-- AC:END -->
