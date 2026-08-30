---
id: APRV-162
title: >-
  wysiwys/2: the structural view is the canonical rendering entire; folds
  removed; SPEC §9 amendment
status: To Do
assignee: []
created_date: '2026-08-30 21:48'
labels: []
dependencies:
  - APRV-161
ordinal: 139000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
canonicalRender currently emits a structural view AND "the same bytes, canonical JSON", so an approver reads the whole payload twice; the JSON appendix also serves as the completeness backstop for the 120-line diff/command folds (the fold marker points at bytes only the JSON shows). Carter has confirmed dropping the duplicate: bump the renderer to approval.md/wysiwys/2, emit the canonical-JSON section only for the opaque kind (where JSON IS the view), and remove the folds so every structured view renders whole (Telegram chunking already absorbs unbounded length, never truncating). Completeness argument to record in the module header: kind detection is a closed field set, any unknown key falls back to opaque whole-JSON, so each view shows every byte. Also lands the one remaining hashed change from APRV-161: an ELSEWHERE_QUALIFIER note branch in changeRegionText for rule protected-name-elsewhere, so LIVE_QUALIFIER is only ever shown for live-tier edits. Add the raw-bytes payload-store pointer line to file-change and email views to match the command view, inside this same version bump. SPEC.md §9 canonical-rendering paragraph gains the amendment, marked pending sign-off, never silent; SPEC.md is a protected path, so that edit itself gates through Telegram.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 CANONICAL_RENDERER_VERSION is approval.md/wysiwys/2 and appears inside the hashed text
- [ ] #2 command, file-change, and email renderings no longer contain the canonical-JSON heading; opaque renderings still do
- [ ] #3 No fold marker exists in any rendering: before/after and command bytes render whole; the fold helpers and their tests are removed or repurposed to renders-whole assertions
- [ ] #4 changeRegionText renders an elsewhere qualifier note for rule protected-name-elsewhere; LIVE_QUALIFIER wording unchanged for the live tier
- [ ] #5 file-change and email views carry the raw-bytes store pointer line the command view already has
- [ ] #6 Conformance: the raw-JSON containment assertion applies only to truncated renderings; whole payloads are checked solely against canonicalRender text verbatim
- [ ] #7 Telegram drops the redundant "--- full payload (sha256 ...) ---" prefix for non-truncated renderings and keeps a loud refusal-worded prefix for truncated ones; the chunk label names the canonical rendering rather than "the exact bytes"
- [ ] #8 SPEC.md §9 amendment text appended to the canonical-rendering paragraph, marked (Amended APRV-162, pending sign-off), stating old records re-derive under the version named inside their hashed text
- [ ] #9 Attestation-prompt payloads (policy text) still render as opaque, verified by test
- [ ] #10 All display_hash pins in tests and fixtures re-derived; determinism and purity tests pass under the new version
<!-- AC:END -->
