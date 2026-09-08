---
id: APRV-312
title: Codex apply_patch gating and hook configuration protection
status: To Do
assignee: []
created_date: '2026-09-08 07:25'
labels: []
dependencies:
  - APRV-311
priority: high
type: feature
ordinal: 230000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
User-authorized Codex patch integration. SPEC 6.3,7,9,10,11.1 bind. Isolated code and fixtures; parent owns protected edits/delivery; no live configuration activation.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 All Add/Update/Delete/Move targets are classified and the full patch plus directory binds approval and rendering.
- [ ] #2 Malformed/ambiguous/traversal/symlink/mixed-protection and changed-payload cases cannot get weaker authority.
- [ ] #3 Codex config.toml, hooks.json and hooks directory classify policy.core with shell/copy/patch tests.
<!-- AC:END -->
