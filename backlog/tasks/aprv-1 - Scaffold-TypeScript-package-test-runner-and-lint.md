---
id: APRV-1
title: 'Scaffold TypeScript package, test runner, and lint'
status: To Do
assignee: []
created_date: '2026-08-04 21:44'
labels: []
milestone: m-0
dependencies: []
priority: high
type: chore
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The repo currently contains only SPEC.md, CLAUDE.md, and the landing page — no package.json, src/, tests/, or schema/ directories. Every M0/M1 task needs a working `npm test`, typecheck, and lint loop before any schema or runtime code can land, so this task exists to unblock all of them. Stack per CLAUDE.md: TypeScript, Node >= 20, minimal dependencies (each new dependency must be justified in implementation notes, and adding dependencies requires human approval per the repo permissions).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 package.json exists with `engines.node >= 20`, and `npm test`, `npm run lint`, and `npm run typecheck` scripts all exit 0 on a fresh clone after `npm install`
- [ ] #2 TypeScript is configured (tsconfig.json, strict mode) and a trivial module under `src/` compiles
- [ ] #3 A test runner is wired up and a trivial passing test under `tests/` runs via `npm test`
- [ ] #4 Repository layout matches SPEC.md section 14: `schema/`, `src/`, `tests/` directories exist (placeholders acceptable)
- [ ] #5 Every added dependency is justified in the task implementation notes
<!-- AC:END -->
