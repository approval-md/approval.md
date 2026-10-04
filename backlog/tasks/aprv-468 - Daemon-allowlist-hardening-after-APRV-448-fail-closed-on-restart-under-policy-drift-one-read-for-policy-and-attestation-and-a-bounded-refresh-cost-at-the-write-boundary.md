---
id: APRV-468
title: >-
  Daemon allowlist hardening after APRV-448: fail closed on restart under policy
  drift, one read for policy and attestation, and a bounded refresh cost at the
  write boundary
status: To Do
assignee: []
created_date: '2026-10-04 12:36'
labels:
  - hosting
dependencies:
  - APRV-448
  - APRV-383
ordinal: 355000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From the refuter on PR #588 (APRV-448, 2026-10-04). Three findings left open: (1) Restart under drift: a serve, webhook or daemon process restarted while the policy on disk is unattested starts with no daemons allowlist and runs unrestricted (design/hosted-daemon-identity.md section 4.4); hosted and co-located facades restart often, so the rule should fail closed: when the log holds an attestation the live policy no longer matches, the effective list is empty (no daemon may write) until the policy is re-attested, with a distinct startup line. (2) resolveDaemonAllowlist loads the policy and checks its attestation in two separate reads (APRV-383 code), a two-read race of the same shape as APRV-467's; make it one read through checkAttestationOfBytes. (3) APRV-448 refreshes the allowlist inside the store lock before every serve verb and hook call; measure it on the APRV-440 bench pattern and, if it costs, cache on the policy file's mtime and size with the attestation seq as the key. Also: a startup warning when the list excludes the process's own id (nit 1), and the docs say the derived id hashes the log path string, so a symlinked or differently spelled --log yields a different id (nit 2).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A process that starts under an unattested policy that the log once attested runs with an empty effective daemons list and refuses every append with daemon-not-allowed until re-attestation; design section 4.4 amended in the notes; tests for serve, webhook and daemon
- [ ] #2 resolveDaemonAllowlist reads policy bytes and attestation in one read; a test interleaves a re-attest between the old two reads and shows no window
- [ ] #3 Refresh cost measured and recorded; cached on mtime+size+attestation seq if above the per-call budget, with a test that a changed policy is seen on the next call
- [ ] #4 Startup warns when the list excludes the own id; docs/cli-reference.md notes the log-path-string derivation
<!-- AC:END -->
