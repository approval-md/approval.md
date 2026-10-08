---
id: APRV-64
title: 'AGENTS.md import: parse permissions prose into draft policy classes'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-17 16:17'
updated_date: '2026-08-17 18:09'
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
- [x] #1 approval import agents-md <file> emits a valid approval-policy YAML draft; the repo CLAUDE.md permissions section is a fixture whose output is pinned
- [x] #2 Heuristic from bullet phrase to class name and autonomy is documented and deterministic; unrecognised bullets land as manual with the original text as comment (fail closed)
- [x] #3 Never writes APPROVAL.md; never appends; draft states its provenance in a header comment
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, isolated worktree from main, parallel with 61. 2. src/core/agents-md.ts: deterministic markdown parser for permissions sections (headings: allowed without prompting / require approval first / never, case-insensitive, under a Permissions heading), bullet extraction, documented phrase-to-class heuristic (stable table), autonomy mapping (autonomous / manual / manual+never-comment), unrecognised bullets -> manual with the original text as comment. 3. approval import agents-md <file> [--out] [--json] verb printing a fenced approval-policy YAML draft with a provenance header, never writing APPROVAL.md, never appending. 4. Fixture: this repo CLAUDE.md permissions section with pinned output; a synthetic AGENTS.md fixture. 5. PR, auto-merge.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Opus subagent build, PR #23. Deterministic parser (no model, no clock) over AGENTS.md-style permissions sections: three canonical sub-headings with tolerant variants (allowed without prompting / allowed / autonomous; require approval first / requires approval / ask first / approval required; never / forbidden / prohibited), with or without a parent Permissions heading. Documented ordered keyword table, first match wins; two orderings are load-bearing and tested (network.call before deps.add because "beyond package installs" contains "install"; vcs.push before vcs.push.main). Deny beats allow across sections with a named warning; unmappable bullets preserved as comments under manual (fail closed); never-section bullets rendered manual with a never: comment since v0.1 has no forbid level (stated in the draft header). Prints a DRAFT with a provenance header stating nothing was applied; never writes APPROVAL.md, never appends; --out writes bare YAML (a fragment for the fence), refuses to overwrite. Output loads cleanly through loadPolicy. This repo CLAUDE.md permissions section is the pinned fixture (copied with provenance, not referenced): 13 bullets -> 12 classes + 1 correctly unmapped (the events.jsonl bullet). REVIEWER-WEIGH ITEM, surfaced in the draft header: the emitted names (vcs.*, deps.*, release.*, exec.local, network.call, policy.edit) are top-level namespaces SPEC 7 reserves; they are also the names this repo APPROVAL.md has used since M2, so the tension predates this task; resolution (a SPEC 7 developer-workstation namespace amendment, or remapping) is a spec decision for the human. exec.local chosen over files.write.workspace for run-tests/lint/build (running is not writing; conflating would let a build script inherit an edit permission). --json shape: specified keys plus additive out and unmapped, pinned. Follow-ups noted: --suggest via claude -p (propose-only, off by default, into the UNMAPPED comment block, never into classes); approval import claude-settings for .claude/settings.json allow/ask/deny (already machine-readable, no heuristic needed). 1163 tests on its base.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
approval import agents-md: deterministic prose-to-draft-policy importer with a documented keyword table, fail-closed unmapped handling, and this repo CLAUDE.md permissions section as the pinned fixture. Draft only; never writes or appends. Namespace tension with SPEC 7 surfaced for human decision. PR #23.
<!-- SECTION:FINAL_SUMMARY:END -->
