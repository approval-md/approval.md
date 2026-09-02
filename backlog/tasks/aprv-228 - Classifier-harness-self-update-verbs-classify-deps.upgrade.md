---
id: APRV-228
title: 'Classifier: harness self-update verbs classify deps.upgrade'
status: To Do
assignee: []
created_date: '2026-09-02 17:01'
updated_date: '2026-09-02 20:59'
labels:
  - enhancement
dependencies: []
references:
  - docs/integrations-considered.md
priority: low
ordinal: 184000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Today `approval hook classify` returns `hook-unclassified` for `claude update`, `codex update` and the UCA updater verbs (`uca`, `uca <name>`, `uca service install`), while `npm install -g <pkg>` and `bun install -g <pkg>` already classify `deps.add`. Unclassified is denied, so nothing is open today; the fix is legibility. SPEC §7 calls a dependency change a supply-chain decision, and a harness upgrade is one for the binary that hosts the hook. Naming the class lets the refusal say what it is and lets a human grant it through the ordinary manual path. Filed from the UCA assessment in docs/integrations-considered.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `claude update`, `codex update`, `gemini update`, `uca`, `uca <name>` and `uca service install` classify `deps.upgrade` in src/core/command-class.ts, with fixtures for each
- [ ] #2 `approval hook classify -- "claude update"` prints `deps.upgrade`
- [ ] #3 Under the repo policy the commands still resolve `manual`; a test shows the hook denies them with a class-naming reason rather than `hook-unclassified`
- [ ] #4 docs/claude-code-hook.md class table lists the new rule
- [ ] #5 `pip install <pkg>`, `pip install -e <path>`, `pipx install <pkg>` and `uv pip install <pkg>` classify `deps.add` (and their upgrade forms `deps.upgrade`), with fixtures; filed from the commerce-agents assessment in docs/integrations-considered.md (APRV-241), where every one of these was `hook-unclassified`
<!-- AC:END -->
