---
id: APRV-162
title: >-
  wysiwys/2: the structural view is the canonical rendering entire; folds
  removed; SPEC §9 amendment
status: Done
assignee: []
created_date: '2026-08-30 21:48'
updated_date: '2026-08-31 01:15'
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
- [x] #1 CANONICAL_RENDERER_VERSION is approval.md/wysiwys/2 and appears inside the hashed text
- [x] #2 command, file-change, and email renderings no longer contain the canonical-JSON heading; opaque renderings still do
- [x] #3 No fold marker exists in any rendering: before/after and command bytes render whole; the fold helpers and their tests are removed or repurposed to renders-whole assertions
- [x] #4 changeRegionText renders an elsewhere qualifier note for rule protected-name-elsewhere; LIVE_QUALIFIER wording unchanged for the live tier
- [x] #5 file-change and email views carry the raw-bytes store pointer line the command view already has
- [x] #6 Conformance: the raw-JSON containment assertion applies only to truncated renderings; whole payloads are checked solely against canonicalRender text verbatim
- [x] #7 Telegram drops the redundant "--- full payload (sha256 ...) ---" prefix for non-truncated renderings and keeps a loud refusal-worded prefix for truncated ones; the chunk label names the canonical rendering rather than "the exact bytes"
- [x] #8 SPEC.md §9 amendment text appended to the canonical-rendering paragraph, marked (Amended APRV-162, pending sign-off), stating old records re-derive under the version named inside their hashed text
- [x] #9 Attestation-prompt payloads (policy text) still render as opaque, verified by test
- [x] #10 All display_hash pins in tests and fixtures re-derived; determinism and purity tests pass under the new version
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read src/core/wysiwys.ts whole (kind views, folds, canonicalRender, constants) plus src/channels/payload-view.ts, conformance.ts:180-230, telegram.ts:660-700 and :1340-1390.
2. Bump CANONICAL_RENDERER_VERSION to approval.md/wysiwys/2; canonicalRender emits the canonical-JSON section only for the opaque kind.
3. Remove folds in diffLines and commandRegionText; views render whole; retire foldMarker if unreferenced; module header records the closed-field-set completeness argument.
4. ELSEWHERE_QUALIFIER branch in changeRegionText keyed on rule protected-name-elsewhere; LIVE_QUALIFIER untouched.
5. rawBytesLine store pointer added to file-change and email views to match the command view.
6. Conformance: raw-JSON containment scoped to truncated renderings; canonical-text check stands alone for whole payloads.
7. Telegram: drop the redundant full-payload sha prefix for whole renderings, loud refusal-worded prefix for truncated; chunk label names the canonical rendering.
8. SPEC.md §9 amendment appended to the canonical-rendering paragraph, marked (Amended APRV-162, pending sign-off); single Edit call (protected path, gates through Telegram).
9. Re-pin hashes/version in wysiwys + telegram + contract tests; fold tests become renders-whole; attestation payload pinned opaque. npm test + lint.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built 2026-08-30 by an Opus subagent, reviewed by fable. canonicalBody now hands the opaque kind its JSON as the view (byte layout of the opaque block unchanged); canonicalRender appends nothing after the kind view. Folds deleted wholesale (foldMarker, fold, DIFF_LINE_BUDGET, COMMAND_LINE_BUDGET): with the appendix gone a fold would hide bytes from the only reading, and module-header property 5 now carries the closed-field-set completeness argument. changeRegionText/emailRegionText gained the recomputed hash and end with rawBytesLine, so every structural view names the content-addressed store as the route back to the bytes. ELSEWHERE_QUALIFIER branch checks the exact rule name BEFORE the startsWith("protected-path") arm. Conformance raw-JSON containment now applies only to truncated renderings (which get no canonical block); telegram whole payloads carry no prefix (the block states its own sha256), truncated ones a refusal-worded prefix, and the chunk label is PAYLOAD — the canonical rendering this approval's display_hash names. SPEC §9 amendment appended and granted through the gate (tap on the phone mid-task). Docs (claude-code-hook.md, cursor-hook.md) updated where they described the JSON-underneath arrangement and fold marker. No display_hash fixtures existed to re-pin. Known stale leftovers, deliberately out of scope: web.ts/cli.ts still say "FULL PAYLOAD — the exact bytes" with their own delimiters; examples/email-demo.md is a historical transcript of a v1 run. One flaky hook-timeout test failed under parallel load once and passed standalone and on the second full run. 2411 tests pass, oxlint clean.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The canonical renderer is approval.md/wysiwys/2: a structured kind's view is the rendering entire (no canonical-JSON appendix, no folds, every view names the payload store), opaque keeps the JSON as its view, and the elsewhere tier renders its own qualifier. Conformance scopes the raw-JSON check to truncated renderings; Telegram drops the redundant sha prefix and labels chunks as the canonical rendering. SPEC §9 amended (APRV-162, pending sign-off), granted through the gate. Verified: 2411/2411 tests, lint clean.
<!-- SECTION:FINAL_SUMMARY:END -->
