---
id: APRV-64
title: 'AGENTS.md import: parse permissions prose into draft policy classes'
status: To Do
assignee: []
created_date: '2026-08-17 16:17'
labels: []
milestone: m-8
dependencies: []
priority: high
type: feature
ordinal: 63000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC 12: approval import agents-md parses "require approval first / allowed without prompting" permissions sections into draft policy classes for human confirmation. This repo CLAUDE.md Permissions section is the first fixture by design (it says so in its own footnote). Deterministic parser over markdown: recognises the three canonical headings (allowed without prompting / require approval first / never) under a permissions section, maps each bullet to a proposed class name (a documented, stable heuristic from verb+object phrases to dotted classes, with the bullet text preserved as the class comment) and autonomy (autonomous / manual / manual with a never marker as a policy comment since the vocabulary has no forbid level). Output is a DRAFT: a fenced approval-policy YAML block printed to stdout (or --out), never written over an existing APPROVAL.md, never attested; the human edits and attests via policy amend. LLMs confined to language: no model call in the parser; a --suggest mode that shells to claude -p for better class names is optional and marked as such in output.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval import agents-md <file> emits a valid approval-policy YAML draft; the repo CLAUDE.md permissions section is a fixture whose output is pinned
- [ ] #2 Heuristic from bullet phrase to class name and autonomy is documented and deterministic; unrecognised bullets land as manual with the original text as comment (fail closed)
- [ ] #3 Never writes APPROVAL.md; never appends; draft states its provenance in a header comment
<!-- AC:END -->
