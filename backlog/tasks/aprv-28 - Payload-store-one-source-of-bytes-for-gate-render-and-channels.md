---
id: APRV-28
title: 'Payload store: one source of bytes for gate, render, and channels'
status: To Do
assignee: []
created_date: '2026-08-05 12:19'
labels: []
milestone: m-6
dependencies: []
priority: high
type: feature
ordinal: 28000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up 1 from the M4 demo (human-approved 2026-08-09). v0.1 logs only payload_hash, so every surface needs the bytes handed to it separately: channels take --payloads/--payload-dir, render has no bridge at all, and QUEUE.md's pending count reads 0 while queue reads 1 for material-less manual requests. This task gives requests a persisted payload (or reference) at request time under .approval/payloads/ keyed by hash, so render and channels share one source; the payload-unavailable listing becomes the exception path it was meant to be (material genuinely lost), and the two counts agree. The store is content-addressed (file named by the payload_hash it must hash to), verified on read, and never trusted over the recorded binding.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Requesting a manual action persists its payload material content-addressed by hash under .approval/payloads/ (or records an explicit external reference), through the existing write-boundary discipline; material is verified against its filename hash on every read and a mismatch is refused, never rendered
- [ ] #2 render and all channels read the store by default: a manual request whose material was stored renders fully everywhere with no per-invocation payload flags; the flags remain as overrides
- [ ] #3 QUEUE.md pending count agrees with approval queue for stored-material requests, with a test pinning the agreement; payload-unavailable remains only for genuinely absent material
- [ ] #4 The e2e demo drops its per-invocation payload plumbing where the store now serves; SPEC section 6.2/10.4 wording is checked and any needed one-line amendment lands same-commit, drafted for review
- [ ] #5 Store writes never touch the log file; log verify stays clean throughout; conformance suite still passes for all channels
<!-- AC:END -->
