---
id: APRV-286
title: >-
  sandbox-probe control test depends on the host network: EHOSTUNREACH where it
  expects a timeout
status: Done
assignee: []
created_date: '2026-09-06 11:59'
updated_date: '2026-09-07 06:03'
labels:
  - tests
  - flaky
dependencies: []
type: bug
ordinal: 212000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
tests/sandbox-probe: the CONTROL assertion "outside the sandbox, the non-routable address times out rather than being refused" fails on some networks (seen 2026-09-06 on Carter's laptop, twice, on unmodified main and on the release stack) because the host answers the non-routable address with EHOSTUNREACH in ~120 ms instead of letting it time out. The security assertion beside it ("outbound network inside the sandbox is DENIED, not merely slow") passes, so the sandbox is fine and the control is host-dependent. Make the control robust: accept any outcome that is not an immediate refusal-by-sandbox (timeout, EHOSTUNREACH, ENETUNREACH), or pick a target the host cannot answer synchronously (a blackhole documentation address behind a route), and say in the test which shapes count as "not sandboxed".
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The control passes on a host that answers the non-routable address with EHOSTUNREACH and on one that times out, and still fails if the address is refused by the sandbox denial path
- [x] #2 The security assertion is unchanged
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read tests/sandbox-probe.test.ts, scripts/sandbox-probe.mjs and tests/sandbox.test.ts. Confirm the host-dependence is confined to the sandbox-probe control (tests/sandbox.test.ts uses loopback stubs and is unaffected).
2. Replace the control's denylist (not connected, not EPERM) with a named allowlist of shapes that prove no bytes reached the network: timeout, EHOSTUNREACH, ENETUNREACH, ENETDOWN, EADDRNOTAVAIL, ETIMEDOUT, ECONNREFUSED. EPERM and EACCES stay excluded, so the sandbox denial path can never satisfy the control.
3. Extract that decision into a pure helper, unsandboxedShape(verdict), and add a table test over it so AC1's third clause (still fails if refused by the sandbox denial path) is pinned on every host without needing a sandbox.
4. Give the control a second leg that needs no route at all: bind a 127.0.0.1 port, close it, and assert the connect is refused ECONNREFUSED. Loopback exists everywhere, and under the profile the same connect is EPERM, so this leg carries the discriminating property on a machine with no network.
5. Keep the reserved TEST-NET-1 target (RFC 5737, 192.0.2.1) for the leg that pairs with the sandboxed case, and leave the security assertion untouched (AC2).
6. Verify: npm run build, node --test dist/tests/sandbox-probe.test.js, npm run lint.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
The control no longer asserts one host's spelling of a failure. It asserts the SHAPE, through a pure helper, unsandboxedShape(verdict), backed by a named set NOT_SANDBOXED_CODES: timeout, EHOSTUNREACH, ENETUNREACH, ENETDOWN, EADDRNOTAVAIL, ETIMEDOUT, ECONNREFUSED. EPERM and EACCES are excluded by name, which is what keeps the control discriminating: the kernel refusing the socket outright is Seatbelt's signature, so a no-op profile can never satisfy the control. Unrecognised codes are rejected rather than waved through, so a novel shape stops the suite instead of silently widening it.

The control gained a second leg that needs no route to exist: bind a 127.0.0.1 port, close it, and connect to it. Loopback is present on every machine, in a tunnel, with the wifi off, and the refusal is ECONNREFUSED there; under the profile the same connect is EPERM, because loopback is not excepted. That leg carries AC1's discriminating property on a host with no network at all. The reserved TEST-NET-1 target (RFC 5737, 192.0.2.1) stays for the leg that pairs with the sandboxed case, and no public address is contacted.

AC1's third clause is pinned by a pure table test rather than by hoping a host produces each shape: the table feeds unsandboxedShape a synthetic EPERM, EACCES, connected and unnamed-code verdict and asserts each is rejected, and feeds it every accepted routing failure and asserts each passes. That runs on every platform, sandbox or not.

AC2: the security assertion (outbound network inside the sandbox is DENIED, not merely slow) is byte-for-byte untouched, comments included.

Evidence on this machine, which is one that reproduces the bug. Unsandboxed connect to 192.0.2.1:443 answers {outcome error, code EHOSTUNREACH, ms 76}, the very shape the old control failed on. Unsandboxed connect to a closed 127.0.0.1 port answers {outcome error, code ECONNREFUSED, ms 2}. The same two connects run under the profile answer {outcome error, code EPERM, ms 1}, which the shape table rejects, so a sandbox-refused address still fails the control. npm run build clean; node --test dist/tests/sandbox-probe.test.js exit 0, 11 tests, 10 pass, 0 fail, 1 skipped (the opt-in external curl leg); npm run lint (oxlint src tests) exit 0.

No global invariant in SPEC section 11.1 is touched: this is a test-only change, it appends nothing to the log and reads no policy.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Made the sandbox-probe control host-independent: it asserts an enumerated set of failure shapes that prove no bytes reached the network (timeout, EHOSTUNREACH, ENETUNREACH, ENETDOWN, EADDRNOTAVAIL, ETIMEDOUT, ECONNREFUSED) with the sandbox's EPERM/EACCES excluded by name, adds a route-free leg against a closed 127.0.0.1 port, and pins the discriminating property with a pure table test. Verified on a host that reproduces the bug (EHOSTUNREACH in 76ms): build clean, node --test dist/tests/sandbox-probe.test.js exit 0 with 10 pass and 0 fail, oxlint clean.
<!-- SECTION:FINAL_SUMMARY:END -->
