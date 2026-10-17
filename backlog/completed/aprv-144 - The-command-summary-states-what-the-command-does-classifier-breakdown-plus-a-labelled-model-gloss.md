---
id: APRV-144
title: >-
  The command summary states what the command does: classifier breakdown plus a
  labelled model gloss
status: Done
assignee: []
created_date: '2026-08-25 13:47'
updated_date: '2026-08-26 10:27'
labels:
  - channels
  - ux
  - llm
dependencies: []
priority: high
ordinal: 129000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Born 2026-08-25 from Carter: 'the claimed isnt very useful - i mostly see the path, not a readable claim of what is happening (passing this through an llm could be useful?)'. Today the claimed summary is truncate(command, 120): a path prefix. Decision (Carter, in session): BOTH halves. (1) Deterministic: COMPUTED gains a per-segment breakdown derived from the same parse the hook classifies with — verb plus salient argument per segment, dot-joined ('git add (log records) · git commit · git push origin main:records-… · gh pr create'). Runtime-derived from the payload bytes, so it belongs in COMPUTED with derivation (classifier). (2) Model gloss: CLAIMED gains an optional one-sentence gloss from a haiku subprocess (claude -p, CLAUDE.md's cheap-classification tier), clearly labelled model-authored, produced by the LISTENER at render time and never by the gate; hard timeout ~2s failing toward absence; absent silently when the subprocess is unavailable. The gate, the hash, and the log never see or store the gloss — display-side only, never load-bearing (LLMs are confined to language tasks; the runtime decides). The raw-command headline stays beneath both.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 COMPUTED carries the classifier-derived segment breakdown for multi-segment commands, derived from the hook's own parse, tested against representative compounds
- [x] #2 The listener renders a model gloss labelled model-authored when the subprocess answers within the timeout; renders without it otherwise; both paths tested (subprocess mocked)
- [x] #3 The gloss never enters the payload store, the hash, or the log, asserted by test
- [x] #4 npm test passes; lint clean
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built 2026-08-26 by an Opus subagent, reviewed by fable, merged in PR #120 (commit e85c372). command_breakdown in COMPUTED from commandSegmentWords over the classifier's OWN tokenizer (one parser; a string the tokenizer refuses gets no breakdown rather than a guess); flag heuristic drops the word after bare short flags only, so push destinations survive. Gloss in src/cli/gloss.ts: claude -p --model haiku, spawnSync no shell, 2s SIGKILL timeout, 64KB maxBuffer; timeout/non-zero/empty/missing-binary/throw all resolve to absence; output collapsed to one line, 200-char cap, claimed(model:haiku), escaped by the channel's escapeHtml; attached in the LISTENER after the tagger finishes, opt-in wiring so no test or programmatic driver spawns a model; the prompt asks for description and forbids safety judgments (a model recommendation beside an Approve button is the failure mode the gate exists against); nothing branches on gloss content — AC 3's never-enters-store/hash/log property is asserted by test. New source label 'classifier' added to COMPUTED_SOURCES rather than borrowing payload-binding's authority. 2096 tests (21 new), lint clean. Out of scope, noticed: payload-view.ts deserves its own test file; mock.sentTexts() accumulates suite-wide so absence assertions over it are unsound (new tests use lastRendered()/slice windows).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
COMPUTED carries a classifier-derived per-segment breakdown; CLAIMED carries an optional haiku-written gloss that is labelled, escaped, capped, never load-bearing, and absent on any failure. Verified with mocked-subprocess tests both ways plus the never-recorded assertion; merged in PR #120.
<!-- SECTION:FINAL_SUMMARY:END -->
