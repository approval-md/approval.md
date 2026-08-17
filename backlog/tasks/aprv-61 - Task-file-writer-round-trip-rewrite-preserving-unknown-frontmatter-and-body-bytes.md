---
id: APRV-61
title: >-
  Task-file writer: round-trip rewrite preserving unknown frontmatter and body
  bytes
status: To Do
assignee: []
created_date: '2026-08-17 16:17'
updated_date: '2026-08-17 16:17'
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
- [ ] #1 Rewrite with no edits is byte-identical for every fixture in the real-Backlog.md corpus
- [ ] #2 Editing only approval.state leaves every other frontmatter key, ordering, and the entire body byte-identical
- [ ] #3 Unknown top-level and nested keys survive; a fixture with keys we have never seen round-trips
- [ ] #4 Corpus generated from the pinned Backlog.md CLI with a documented regeneration command; drift in a regenerated corpus fails tests loudly
<!-- AC:END -->
