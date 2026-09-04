---
id: APRV-228
title: 'Classifier: harness self-update verbs classify deps.upgrade'
status: In Progress
assignee:
  - 'agent:fable-lane-o'
created_date: '2026-09-02 17:01'
updated_date: '2026-09-02 21:48'
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
- [x] #1 `claude update`, `codex update`, `gemini update`, `uca`, `uca <name>` and `uca service install` classify `deps.upgrade` in src/core/command-class.ts, with fixtures for each
- [x] #2 `approval hook classify -- "claude update"` prints `deps.upgrade`
- [x] #3 Under the repo policy the commands still resolve `manual`; a test shows the hook denies them with a class-naming reason rather than `hook-unclassified`
- [x] #4 docs/claude-code-hook.md class table lists the new rule
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add one table row per harness family to src/core/command-class.ts: 'harness-update' (claude|codex|gemini update -> deps.upgrade) and 'harness-updater' (uca, any args -> deps.upgrade). No new class, no refinement; strictest reading (uca --dry-run is still deps.upgrade).
2. Fixtures in tests/command-class.test.ts for each spelling the AC lists, plus negatives: claude --version, claude -p, bare claude/codex/gemini stay unclassified; npm install -g <harness> stays deps.add.
3. cli-hook test: under the fixture policy 'claude update' denies hook-timeout (manual path) with a deps.upgrade request in the log, never hook-unclassified.
4. Pin deps.upgrade manual/default in src/core/policy-expectations.ts so the AC-3 resolution is stated as data.
5. docs/claude-code-hook.md rule table rows; refresh the classification table in docs/integrations-considered.md.
6. Build, run command-class, dogfood, cli-hook suites, oxlint, then full npm test.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Two rows in src/core/command-class.ts: harness-update (claude|codex|gemini update) and harness-updater (uca, any args, --dry-run included) both resolve to the EXISTING deps.upgrade. No new class, no refinement, no protected-path change. Negatives pinned: claude --version, claude -p, bare claude/codex/gemini and ucas stay unclassified; npm install -g <harness> stays deps.add (unchanged, deliberately: the rows add spellings, they do not move rows). 'approval hook classify -- "claude update"' prints deps.upgrade / harness-update; 'uca service install' prints deps.upgrade / harness-updater; 'claude --version' stays unclassified.

Policy: the repo policy declares neither deps.upgrade nor deps.*, so it resolves manual by DEFAULT (provenance default), same as before for npm update. Pinned as such in src/core/policy-expectations.ts with a note; a ceremony declaring the class must move the pin. Dogfood reachability pin unaffected (deps.upgrade is not a literal class in the policy).

Invariants touched (SPEC §11.1): inv. 9 (human-only inert) is respected, not weakened: the rows emit a manual class and mint no authority for a human-only one. Inv. 4: nothing self-reported is read; the classifier stays pure over command text. Fail-closed preserved: the negatives remain refusals.

Tests: tests/command-class.test.ts fixtures for every spelling in AC 1 plus negatives (319 pass); tests/cli-hook.test.ts 'a harness self-update is gated as deps.upgrade, not refused as unclassified' under the fixture policy: hook-timeout deny (the ordinary manual path), a task.registered in the log carrying class deps.upgrade, not hook-unclassified. Docs: docs/claude-code-hook.md rule table gained both rows; docs/integrations-considered.md UCA table notes the post-APRV-228 classification.

SPEC draft, if the class table wants a sentence (deps.* row of §7): 'A harness self-update (the harness binary's own update verb, or an unattended updater driving it) is a deps.upgrade: it swaps the binary that hosts the hook, and an implementation SHOULD classify it by name rather than refuse it as unclassified, so the refusal names a class a human can grant.'

docs/cursor-hook.md rule table also gained both rows: tests/cli-hook-cursor.test.ts pins that the Cursor doc names every COMMAND_RULES id (8/8 pass after the edit). Suite results: command-class 319/319, dogfood 32/32, cli-hook 89 (88 pass + the APRV-228 test, which failed once on a payload-field assumption and passes after the log-record rewrite), cli-hook-cursor 8/8, oxlint clean.
<!-- SECTION:NOTES:END -->
