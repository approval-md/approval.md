---
id: APRV-416
title: >-
  SMTP adapter: omit TLS servername when the host is an IP literal (Node 26
  refuses it)
status: To Do
assignee: []
created_date: '2026-09-20 21:38'
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
- [ ] #1 The STARTTLS upgrade and the implicit-TLS connect omit servername when the host is an IP literal and keep it for hostnames
- [ ] #2 tests/smtp-probe and tests/adapter-email pass under Node 26 as well as Node 22
- [ ] #3 A regression test covers an IP-literal host under strict verification with the mock fixture certificate
- [ ] #4 docs/cli-reference.md setup adapter email notes the IP-host behaviour if it changes what a probe verifies
<!-- AC:END -->
