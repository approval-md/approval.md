---
id: APRV-71
title: >-
  approval init: scaffold APPROVAL.md, .approval/, gitignore, and the vault
  placeholder
status: In Progress
assignee:
  - '@fable'
created_date: '2026-08-17 21:40'
updated_date: '2026-08-17 22:12'
labels: []
milestone: m-9
dependencies: []
priority: medium
type: feature
ordinal: 70000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC 10.1 lists approval init (scaffold APPROVAL.md, .approval/, schemas) and it does not exist; every ceremony doc tells the human to mkdir by hand. M7 adds the vault, which needs a gitignore line and a scaffolded location, so init lands here. init writes: APPROVAL.md from the SPEC 5.1 canonical example with the origin.app placeholder convention (example-capture), .approval/log/ (empty; the first attest creates the log), .approval/QUEUE.md header, .gitignore entries (.approval/*.sqlite, .approval/vault.enc, .approval/payloads/ decision documented: payloads are evidence and default to tracked; note both choices), and prints the next steps (edit policy, attest, doctor). Refuses to overwrite anything that exists (distinct code per file). Idempotent re-run reports what already exists. approval instructions (the agent-facing guide, also SPEC 10.1) is a companion follow-up, not this task.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval init scaffolds the listed files in an empty directory and refuses to overwrite existing ones with distinct codes
- [ ] #2 Ceremony docs and README point at init instead of manual mkdir where they currently do
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, worktree from main, parallel. 2. src/cli/init.ts: approval init [--dir] [--json]: writes APPROVAL.md (SPEC 5.1 canonical example verbatim from the frozen fixture), .approval/log/ dir, .approval/QUEUE.md header, .gitignore entries (.approval/*.sqlite, .approval/vault.enc, tmp) — payloads default tracked (evidence) with the choice documented in the printed next steps; refuses to overwrite with distinct per-file codes; idempotent re-run reports existing. 3. Prints next steps (edit policy, attest, doctor). 4. Ceremony docs point at init. Tests: empty dir scaffold, refuse-on-existing, idempotent report, gitignore merge into existing file. PR.
<!-- SECTION:PLAN:END -->
