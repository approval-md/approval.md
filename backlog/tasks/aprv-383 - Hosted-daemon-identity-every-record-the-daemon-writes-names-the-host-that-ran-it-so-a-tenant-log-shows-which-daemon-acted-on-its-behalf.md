---
id: APRV-383
title: >-
  Hosted daemon identity: every record the daemon writes names the host that ran
  it, so a tenant log shows which daemon acted on its behalf
status: To Do
assignee: []
created_date: '2026-09-19 16:18'
labels:
  - daemon
  - identity
  - hosting
  - schema
dependencies: []
priority: medium
ordinal: 297000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter asked on 2026-09-19 how a records advance and the rest of the daemon work when the daemon is hosted by one party for another (an external approval.md user whose repo, log and policy are their own). Three properties already hold or are near: authority comes from the tenant attested policy and never from the host (a manual class prompts the tenant phone through their sender mapping, APRV-324 and 356); credentials come from the launch environment only, so one process per tenant with a token the tenant issued and scoped to their repo; and decisions arrive only through the tenant mapping, so the host cannot mint one. What is missing is identity: records the daemon appends (audit.sampled, audit.dark_session, log advances, gloss, channel bookkeeping) carry a generic daemon actor, so a tenant reading their own log cannot tell which host process wrote them. Define a daemon identity: a stable id per daemon instance (declared in the launch environment beside APPROVAL_HUMAN, or derived from the keystore instance id doctor already prints as keychain-scope), carried on every daemon-written record in a field the schema names, and printed by approval status and doctor. A tenant policy may then name which daemon ids may act (a hosts allowlist next to senders), refusing records from an unlisted one at the write boundary. Keep it to identity and allowlist: multi-tenant process isolation, token scoping and billing are separate tasks. Related: APRV-324, APRV-356, APRV-382, the keychain-scope doctor row, SPEC 11.1 invariant that self-reported fields never reduce scrutiny (an unlisted host is refused, a listed one gains nothing).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A daemon instance id is declared or derived at start, printed by approval up on start and by status and doctor, and stable across restarts on the same machine and keystore
- [ ] #2 Every record the daemon appends carries the id in a schema-named field (schema change called out, fixtures, conformance vectors); records from before the change validate unchanged
- [ ] #3 APPROVAL.md may list allowed daemon ids; when the list is present a daemon-written record from an unlisted id is refused at the write boundary with a machine-readable code, and an absent list means no restriction, with tests through the real append path
- [ ] #4 A design note under design/ states the hosting model (authority from the tenant policy, credentials from the tenant, decisions only through the tenant mapping, identity from this task) and what is out of scope; build, typecheck, lint and the daemon, schema and policy suites pass
<!-- AC:END -->
