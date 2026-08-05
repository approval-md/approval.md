---
id: APRV-28
title: 'Payload store: one source of bytes for gate, render, and channels'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 12:19'
updated_date: '2026-08-05 12:54'
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
- [x] #1 Requesting a manual action persists its payload material content-addressed by hash under .approval/payloads/ (or records an explicit external reference), through the existing write-boundary discipline; material is verified against its filename hash on every read and a mismatch is refused, never rendered
- [x] #2 render and all channels read the store by default: a manual request whose material was stored renders fully everywhere with no per-invocation payload flags; the flags remain as overrides
- [x] #3 QUEUE.md pending count agrees with approval queue for stored-material requests, with a test pinning the agreement; payload-unavailable remains only for genuinely absent material
- [x] #4 The e2e demo drops its per-invocation payload plumbing where the store now serves; SPEC section 6.2/10.4 wording is checked and any needed one-line amendment lands same-commit, drafted for review
- [x] #5 Store writes never touch the log file; log verify stays clean throughout; conformance suite still passes for all channels
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented by Opus subagent in isolated worktree; fable review found nothing to override. Store: .approval-sibling payloads/ dir (never inside the chain-walked directory), files hold RFC 8785 canonical bytes so sha256(bytes)==filename, every read re-hashes and withholds on mismatch; references are minimal {"$ref"} never resolved. Ordering accepted as argued: declared-hash comparison early (pure, before duplicate/budget), write after every check immediately before append — refused requests store nothing; a head-moved orphan is harmless content-addressed residue, whereas the reverse ordering would record a manual request whose bytes no channel can display. Two sanctioned GATE_REFUSAL_CODES additions: payload-mismatch (exit 1), payload-store-failed (exit 4, fails closed). SPEC unchanged: section 6.2 already says stored-or-referenced; the only arguable addition (naming payloads/ in section 9 layout) deliberately left for human judgment. Demo simplified: request --payload carries the whole chain, count-agreement asserted, override flags still covered in channel tests. Three tail findings for the m-4.1 report: the store is the one UNREBUILDABLE cache (loss is not derivable from the log; operator warning proposed for status or docs before M5); retention is unbounded incl. terminal-state and orphan files (a SPEC decision, deliberately not invented here); --payload-dir/--payloads are now redundant surface (deprecate at M6 or document the vault-backed use case). Global invariants: touches none; store writes never touch the log (byte-checked). Verified on merged tree: 859/859, lint, typecheck.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
src/core/payload-store.ts + gate/tagging/channel integration: content-addressed, read-verified payload store beside the log as the shared source for render and channels, request --payload at intake, QUEUE.md/queue count agreement pinned, payload-unavailable reduced to the genuine-absence exception path. 20 tests; demo simplified. Verified: 859/859, lint, typecheck.
<!-- SECTION:FINAL_SUMMARY:END -->
