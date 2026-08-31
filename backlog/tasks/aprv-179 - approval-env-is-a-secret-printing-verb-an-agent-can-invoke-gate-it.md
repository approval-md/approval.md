---
id: APRV-179
title: 'approval env is a secret-printing verb an agent can invoke: gate it'
status: To Do
assignee: []
created_date: '2026-08-31 22:44'
labels: []
dependencies: []
references:
  - src/cli/env.ts
  - src/core/command-class.ts
  - docs/claude-code-hook.md
priority: high
type: feature
ordinal: 148000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
APRV-73 built approval env as the one verb that resolves .approval/env and emits real secret values as an export block. The design intent is that a human evaluates it in their own shell (invariant 7), but nothing enforces the human: a harness-driven session (Claude Code Bash tool, any agent shell) can run it, and the resolved values then enter the model context, are transmitted for inference, and persist in plaintext session transcripts (~/.claude/projects). The claude-code hook does not help: refineApproval in src/core/command-class.ts classifies approval env into the pass-through gate-self class, so the hook answers allow. Close both halves. The verb should refuse to emit values when stdin is not a terminal, matching the existing approval setup refusal (the primary human use, eval "$(approval env)", keeps a terminal stdin; a harness does not), with a distinct machine-readable refusal code. The classifier should stop treating value-emitting approval env invocations as pass-through readable and give them a class a policy can hold to manual. Value-free surfaces (--check, and --json --check) stay available everywhere so diagnostics and CI keep working. This touches SPEC 11.1 invariant 3 (raw secrets never appear in the log) adjacency and invariant 7; the task must say so in its implementation notes per CLAUDE.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval env refuses to emit values (plain and --json forms) when stdin is not a terminal, with a distinct frozen machine-readable refusal code; the refusal message names the value-free alternative
- [ ] #2 eval "$(approval env)" from an interactive shell still works: the guard is stdin-based, and a test pins that stdout-as-pipe with terminal stdin emits the export block
- [ ] #3 approval env --check and --json --check remain available with stdin from anywhere and stay value-free on every path, pinned by the existing secret sweep extended to the new refusal path
- [ ] #4 The command classifier assigns value-emitting approval env invocations a non-pass-through class resolvable by policy (flag-order invariance preserved: --json env and env --json classify identically); --check invocations keep the readable pass-through class; hook table docs updated
- [ ] #5 SPEC 5.2 environment-map bullet and 11.1 invariant 7 amended same-commit for human sign-off, stating that the export surface is terminal-gated and why
- [ ] #6 Tests cover: non-tty refusal (both output forms), refusal code frozen in the union, classifier class for env vs env --check, and no secret value in any captured refusal output
<!-- AC:END -->
