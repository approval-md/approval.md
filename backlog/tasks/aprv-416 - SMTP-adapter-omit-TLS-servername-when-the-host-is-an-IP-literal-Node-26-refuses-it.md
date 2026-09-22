---
id: APRV-416
title: >-
  SMTP adapter: omit TLS servername when the host is an IP literal (Node 26
  refuses it)
status: Done
assignee:
  - '@claude-lane-d'
created_date: '2026-09-20 21:38'
updated_date: '2026-09-22 01:28'
labels: []
dependencies: []
references:
  - src/adapters/smtp.ts
  - tests/smtp-probe.test.ts
ordinal: 320000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Under Node 26.8.2 every SMTP probe and send against an IP-literal host fails smtp-protocol-error with "Setting the TLS ServerName to an IP address is not permitted. Received 127.0.0.1". src/adapters/smtp.ts passes servername: options.host unconditionally at the STARTTLS upgrade (line ~496) and the implicit-TLS connect (line ~548). Node 26 turned the long-standing deprecation into a hard error; Node 22 (CI) still accepts it. On this Mac the failure takes down smtp-probe, adapter-email, cli-setup adapter email, and the e2e email demo suites. Real operators pointing at an IP-addressed relay hit the same refusal. Fix: set servername only when net.isIP(options.host) === 0; certificate verification against an IP host then relies on the certificate SAN IP entry as TLS intends.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The STARTTLS upgrade and the implicit-TLS connect omit servername when the host is an IP literal and keep it for hostnames
- [x] #2 tests/smtp-probe and tests/adapter-email pass under Node 26 as well as Node 22
- [x] #3 A regression test covers an IP-literal host under strict verification with the mock fixture certificate
- [x] #4 docs/cli-reference.md setup adapter email notes the IP-host behaviour if it changes what a probe verifies
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read src/adapters/smtp.ts: servername: options.host is passed unconditionally at the implicit-TLS connect (~line 496) and at the STARTTLS upgrade (~line 548).
2. Add an exported pure helper tlsServername(host): string | undefined next to the transport options, returning undefined when net.isIP() reads the host as an IP literal (bracketed IPv6 stripped first, since omitting SNI for an address can only be correct) and the host otherwise.
3. Use it at both call sites, spreading it so the key is absent rather than explicitly undefined.
4. Tests: unit cases over tlsServername (IPv4, IPv6, bracketed IPv6, hostname, uppercase hostname) plus a session-level regression in tests/smtp-probe.test.ts that probes the 127.0.0.1 mock under tlsRejectUnauthorized: true and asserts the failure is certificate trust (self-signed fixture CA), never the Node 26 ServerName refusal.
5. Check docs/cli-reference.md setup adapter email: the probe verifies the same things either way, so only note the IP-host behaviour if the text claims SNI/hostname verification.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
WHAT CHANGED. src/adapters/smtp.ts gained one exported pure helper, tlsServername(host), and both TLS entry points call it instead of passing servername: options.host. The implicit-TLS connect and the STARTTLS upgrade were the only two call sites; nothing else in the adapter reads the host for TLS purposes.

WHY A HELPER RATHER THAN AN INLINE TERNARY. The decision is the whole task and it is worth naming and testing on its own, so the unit cases pin IPv4, IPv6, the bracketed IPv6 spelling and hostnames directly rather than inferring the rule from two session tests. Bracket stripping is included because [::1] is an address in every sense that matters here and omitting SNI for an address can only ever be correct; a hostname is never shaped that way.

EXPLICIT undefined IS EQUIVALENT TO ABSENT, verified rather than assumed. A scratch probe against node:tls on Node 26.8.2 showed connect({servername: undefined}) succeeding exactly as connect({}) does, and connect({servername: '127.0.0.1'}) throwing ERR_TLS_... 'Setting the TLS ServerName to an IP address is not permitted'. So the call sites assign the helper's result directly and do not need a conditional spread.

THE REGRESSION TEST TURNS VERIFICATION ON, which no other case in tests/smtp-probe.test.ts does. The fixture certificate is self-signed with CA:true and carries 'DNS:localhost, IP Address:127.0.0.1', so a strict session against the mock cannot succeed in this process whatever the fix. WHICH failure it gives is the evidence: before the fix the handshake died on ServerName without reading a certificate, after it the failure is DEPTH_ZERO_SELF_SIGNED_CERT. Both cases assert the message matches self[- ]signed certificate and does NOT match ServerName, in both TLS modes. The spelling regex tolerates Node 22's 'self signed certificate' and Node 26's 'self-signed certificate'.

AC4 IS NOT A NO-OP. The probe's guarantee does change for an address: identity is checked against the IP SAN entry instead of an SNI-selected hostname, so a relay whose certificate names only a hostname passes when configured by name and fails when configured by address. docs/cli-reference.md 'setup adapter email' now says that in one paragraph.

GLOBAL INVARIANTS. None touched. This is transport code below the gate: no log write, no verdict, no classification, no self-reported field.

FULL-SUITE EVIDENCE, and what is left failing on this machine. A whole npm test run on Node 26.8.2 from this worktree ends with five failures and they are all one environmental cause, named here so the next lane does not chase it:

  tests/package-adapters.test.ts (4): the package exposes exactly the five runtime names and refuses private paths / a strict NodeNext TypeScript consumer implements the public types / the packed contract binds bytes and permits one execution / a consumer runs public conformance against the packed contract
  tests/codex-package.test.ts (1): packed npm artifact installs without scripts and runs outside the checkout

Both suites read <REPO_ROOT>/node_modules directly, the first to symlink ajv, yaml and four more into a temporary consumer, the second to read node_modules/yaml/package.json. This agent worktree has no node_modules of its own: it sits under the primary checkout, so node and npm find the primary's by walking up, which is why tsc, oxlint and the other 4940 tests are fine, while a test that names the path explicitly gets ENOENT. Not a regression, not related to this stack, and green in CI, where the checkout root has its own node_modules.

EVERY SMTP BASELINE FAILURE IS GONE. The failures this task was filed on (tests/smtp-probe, tests/adapter-email, the cli-setup adapter email transcript, and the e2e email demo) all pass in that run, and the five above are the only failures left in the whole suite.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
src/adapters/smtp.ts now omits the TLS servername when smtp.host is an IP literal, through a new exported helper tlsServername() used at both the implicit-TLS connect and the STARTTLS upgrade; SNI is unchanged for hostnames. Verified on Node 26.8.2: node scripts/run-tests.mjs --only smtp-probe adapter-email cli-setup exits 0 (smtp-probe + adapter-email: 53 tests, 53 pass, 0 fail), including three new cases covering the helper's rule and strict-verification probes of the 127.0.0.1 mock in both TLS modes, which now fail on the self-signed fixture certificate rather than on the ServerName refusal. docs/cli-reference.md records what an IP host changes about what the probe verifies. build, typecheck and lint each exit 0.
<!-- SECTION:FINAL_SUMMARY:END -->
