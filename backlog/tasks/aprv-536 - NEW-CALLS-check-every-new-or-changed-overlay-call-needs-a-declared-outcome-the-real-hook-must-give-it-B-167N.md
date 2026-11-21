---
id: APRV-536
title: >-
  NEW-CALLS check: every new or changed overlay call needs a declared outcome,
  the real hook must give it (B-167N)
status: In Progress
assignee: []
created_date: '2026-10-21 14:47'
updated_date: '2026-11-21 15:45'
labels:
  - release-gate
  - overlay
dependencies:
  - APRV-532
priority: high
ordinal: 406000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter's rule (B-167N): approval.md must never limit existing functionality OR a new capability. B-167 (APRV-532) covers the calls the boxes already run. This covers new ones: every call NEW or CHANGED at the candidate vs the previous release (shell recipes plus harness-tool envelopes derived from mini-app manifests and gated plugin tools) needs its outcome declared in the overlay's scripts/approval-class-diff/expected.json, and the real hook (and the daemon propose behind a plugin call) of the pinned core, in the box layout, under the village default template and in each settings cell, must give exactly it. Spec: approval L17350; review-b pre-refute folds P1-P7 (L17356); release brief B167N-NEW-CALLS-GATE-BRIEF.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Extractor --with-envelopes: mini-app manifest operations as the exact village call the hook sees (3a, P5) and every gated plugin tool with its registered schema (3b); without the flag the output is byte for byte as before
- [ ] #2 check.mjs --expected/--tag-corpus: undeclared NEW or CHANGED call, class mismatch, decision mismatch (hazard B: an expected card that runs auto), undeclared deny/refusal/unclassified, technical card, stale or duplicate entry, schema-invalid envelope input each exit 1
- [ ] #3 P1: a limiting entry (decision stricter than auto, or a class whose template default is manual) needs accepted_by human:carter exactly and an accepted_at date
- [ ] #4 P2: the settings matrix (ask, autonomous, supervised-retro, supervised-live, manual) is run and compared; supervised-live is drawn with a fixed sampling secret, asserted both ways
- [ ] #5 P3: a core move on an unchanged recipe is reported as changed (core move), read from B-167's diff
- [ ] #6 tests/overlay-recipes-new-calls.test.ts planted first: fails at the base, passes here
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built in release lane R1 (B-167N). New module scripts/overlay-recipes-newcalls.mjs; box runner runs declared envelopes and daemon proposes; extractor --with-envelopes (3a manifests, 3b gated plugin tools via python3 ast, never an import); check --expected/--tag-corpus. ci.yml: gate-file pins only (+PIN_NEWCALLS). Global invariants touched: none weakened; the check fails closed on an unknown schema keyword, an unreadable gated registration, an unmapped new manifest operation and a propose that neither answers nor refuses (exit 2). Open: ask vs manual cell vocabulary; exec.local as an existing class; pinned corpus refresh with envelopes.

Review fold (the B-167N refute at ce36c9d9, approval.md side): M1 register_tool by local name and loop, gated_tools diffed against the tag, every gated pattern must reach a call; M2 one envelope per village enum operation, unmapped when in neither list; M3 daemon proposes extracted (file, line, class or template) and required of an entry; S1 accepted answers extracted and declared, a refused answer is a refused call; S4 four box tests; N1, N2, N3, N5 folded. Declarations for overlay main 255f9291 against v2.1.27: 14 new calls and the Gold Stars send propose; the For Kicks propose source moved to _forkicks.py:345.

Unhooked proposes (review S1, the fix left part-done at M3): every daemon propose is judged, in a plugin with a gated tool or without; a propose-only entry declares one with no hooked call; a held entry's class reads from the module's guards; N1 every propose spelling read; the four av-events sites declared, six of eight entries limiting and awaiting Carter's acceptance.
<!-- SECTION:NOTES:END -->
