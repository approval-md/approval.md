---
id: APRV-175
title: 'mcp serve --guest: verb allowlist, call-time refusal, wait clamp'
status: To Do
assignee: []
created_date: '2026-08-31 01:17'
labels:
  - core
  - mcp
dependencies:
  - APRV-174
ordinal: 154000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From the approved crowd-MCP design. Guests connect their own agents but must never execute on the host: run executes argv on the server machine and adapter email spends vault credentials, so guest mode is a positive allowlist (GUEST_VERBS: instructions, register, request, wait, status, queue, log verify, policy check, policy test — fail closed when new verbs land), filtered where the registry already withholds human_only and EXCLUDED_VERBS. Defense in depth like mcp-identity-fixed: a guest calling a withheld verb by name is refused mcp-guest-restricted at call time with a message naming why, extending the existing known-but-unpublished arm. Guest wait --timeout is clamped server-side to 5s (Carter's number), appended last like --as so a caller's larger value loses — wait blocks the event loop (Atomics.wait), and the clamp bounds the stall; guest instructions text (distinct under guest mode) says wait returns fast, poll status, and states plainly that granted requests do not execute anywhere: the demo is the approval flow itself. --guest without --http is a usage error. Notes must flag the SPEC 11 tool-list surface: guest mode narrows only, never widens.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 tools/list under --guest is exactly the allowlist; run/adapter_email/token verbs absent
- [ ] #2 Calling a withheld verb by name refuses mcp-guest-restricted; wait with a large --timeout is observed clamped to 5s
- [ ] #3 --guest without --http is a usage error; full-mode tool list and behavior unchanged
<!-- AC:END -->
