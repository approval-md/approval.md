---
id: APRV-35
title: 'Payload store: unrebuildable warning, vault paragraph, SPEC section 9 line'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 13:48'
updated_date: '2026-08-05 15:32'
labels: []
milestone: m-6
dependencies: []
priority: medium
type: feature
ordinal: 35000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Human rulings 2a, 2c, 3 (2026-08-05). The store is the one cache whose loss is unrecoverable from the log; that fact reaches operators now: a docs note, a status line, and a doctor detail. The vault-backed use case for the --payload-dir/--payloads overrides gets its one documented paragraph (deprecation deferred to M6). SPEC section 9 gains one line placing .approval/payloads/ in the layout as a content-addressed material store holding the bytes approvals bind to, unrebuildable from the log, distinct from the projections the section defines.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 approval status reports the payload store (present/absent, file count) with the unrebuildable-from-the-log warning; --json shape extended additively and tests updated
- [x] #2 approval doctor gains a payload-store detail (exists/writable, count) with the same warning in its detail text
- [x] #3 README (or store docs) carries the unrebuildable note and the one-paragraph vault-backed override use case
- [x] #4 SPEC section 9 places .approval/payloads/ in one line per the ruling wording; docs-guard suite still green
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented by Opus subagent; fable review found nothing to override. status gains an additive informational payload_store key (never moves healthy or the exit code, asserted); doctor's seventh check probes with a real create-and-unlink rather than mode bits and leaves nothing behind (asserted); README carries the unrebuildable note and the vault-backed override paragraph with M6 deprecation deferral; the SPEC section 9 line landed with one punctuation adjustment from the ruling (comma-and in place of a semicolon pileup). Verified: 904/904, lint, typecheck.

Date corrected in place per the 2026-08-05 human ruling (log-is-authoritative, applied to all APRV-46 findings): prose previously claimed 2026-08-10; this task's own created_date (2026-08-05) is the cited source. The wrong date was orchestrator confabulation, part of the systematic drift reported in APRV-46.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Payload-store operator visibility: status payload_store key, doctor seventh check, README unrebuildable + vault paragraphs, SPEC section 9 placement line. +4 tests. Verified: 904/904.
<!-- SECTION:FINAL_SUMMARY:END -->
