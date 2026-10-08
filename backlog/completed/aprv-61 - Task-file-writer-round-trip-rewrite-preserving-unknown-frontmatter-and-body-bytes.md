---
id: APRV-61
title: >-
  Task-file writer: round-trip rewrite preserving unknown frontmatter and body
  bytes
status: Done
assignee:
  - '@fable'
created_date: '2026-08-17 16:17'
updated_date: '2026-08-17 17:56'
labels: []
milestone: m-8
dependencies:
  - APRV-65
priority: high
type: feature
ordinal: 60000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The M6 foundation (SPEC 6: implementations MUST preserve unknown frontmatter keys when rewriting task files; CLAUDE.md: round-trip fidelity with Backlog.md is a hard requirement). Today core/frontmatter.ts is read-only by design. This task adds the writer: given a task file and a set of envelope edits, produce a new file whose frontmatter preserves every key it does not own (order, quoting style where the parser exposes it, comments where feasible), whose body bytes are untouched, and whose only change is the approval: subtree requested. Byte-identical output when no edit is requested. Corpus-driven: fixtures are REAL Backlog.md task files produced by the pinned CLI (APRV-52 pin) across the shapes it emits (single-quoted titles, arrays, nested sections, comment markers like SECTION:DESCRIPTION), so format drift upstream fails a fixture, never a user. Deterministic, never throws, structured errors. This is a write path to a file that is a projection, never to the log; nothing here appends.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Rewrite with no edits is byte-identical for every fixture in the real-Backlog.md corpus
- [x] #2 Editing only approval.state leaves every other frontmatter key, ordering, and the entire body byte-identical
- [x] #3 Unknown top-level and nested keys survive; a fixture with keys we have never seen round-trips
- [x] #4 Corpus generated from the pinned Backlog.md CLI with a documented regeneration command; drift in a regenerated corpus fails tests loudly
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, isolated worktree branched from aprv-65-backlog-fixtures (corpus needed; main may lag during the GitHub outage). 2. src/core/task-file.ts (or frontmatter-write.ts): parse the frontmatter block into a key-order-preserving document using the yaml package Document API (already a dependency) under the hardened settings from policy-load; apply envelope edits to the approval: subtree only; serialise; splice back between the original delimiters with the body bytes untouched. 3. Byte-identity: no-edit rewrite must equal input for every fixture in tests/fixtures/backlog; where the yaml serialiser cannot reproduce quoting style byte-for-byte, prefer a splice strategy that rewrites only the approval: block lines and leaves all other frontmatter lines as raw text. 4. Corpus-driven tests; structured errors, never throws; no log writes. 5. PR, auto-merge.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Opus subagent build, PR #22, merged. Design: line-splice, not YAML reserialisation. The hardened parser (parseHardenedYaml, reused; a test asserts parseDocument never appears in the module) is a structural oracle only; a column-0 scan finds the approval: range; only that range (or exactly one line for a state edit) is rewritten; every other line re-emits its own bytes, terminator included. Byte-identity is therefore a property of construction and is still asserted against every real Backlog.md fixture. Post-conditions on every rewrite: same suffix bytes, re-parses, non-approval keys identical in value and position, subtree equals the intended envelope, envelope validates against envelope.schema.json before any bytes exist. Load-bearing test: envelope-edit-before round-trips through OUR writer with the envelope preserved (the key 1.49.3 drops). Decisions: insertion last-before-delimiter (the corpus shows the CLI rewrites from its own model in canonical order and preserves no unknown key, so there is no convention to match; last moves no existing line); CRLF preserved per-line (reader already accepts such files; a narrower writer buys no safety); kind none returns input verbatim (honest, not a splice proof; the one-line state test carries the proof); envelope-not-a-map refused for set-envelope too (fail closed; a human repairs such a file by hand); comments inside the owned block do not survive set-envelope, comments outside do. Closed 12-code error union pinned both directions. EnvelopeState imported type-only from daemon/projection.ts (erased at runtime; moving the vocabulary to core is a possible follow-up). Incidental finding: render-queue.ts documents an fsync its code does not perform, nor does payload-store; the writer followed the actual idiom (temp+rename); the stale doc comment is a small follow-up. 1172 tests (+33).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Round-trip task-file writer: line-splice design preserving every byte outside the approval: subtree, corpus-verified against real Backlog.md files, envelope preserved where the CLI drops it. Merged as PR #22, 1172 tests.
<!-- SECTION:FINAL_SUMMARY:END -->
