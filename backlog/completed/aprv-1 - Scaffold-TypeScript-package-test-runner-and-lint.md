---
id: APRV-1
title: 'Scaffold TypeScript package, test runner, and lint'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-04 21:44'
updated_date: '2026-08-04 22:04'
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
- [x] #1 package.json exists with `engines.node >= 20`, and `npm test`, `npm run lint`, and `npm run typecheck` scripts all exit 0 on a fresh clone after `npm install`
- [x] #2 TypeScript is configured (tsconfig.json, strict mode) and a trivial module under `src/` compiles
- [x] #3 A test runner is wired up and a trivial passing test under `tests/` runs via `npm test`
- [x] #4 Repository layout matches SPEC.md section 14: `schema/`, `src/`, `tests/` directories exist (placeholders acceptable)
- [x] #5 Every added dependency is justified in the task implementation notes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Extend the existing placeholder package.json (name approval-md, bin approval -> cli.js already published as placeholder) rather than replacing it: add engines.node >=20, type: module, and scripts test / lint / typecheck. Keep bin and files intact.
2. Dev dependencies (minimal, dev-only, no runtime deps): typescript (compiler + typechecker), @types/node (node:* types), oxlint (single-package zero-config linter; chosen over eslint+typescript-eslint to honor the minimal-dependencies invariant). Each justified in implementation notes.
3. tsconfig.json: strict, NodeNext module/resolution, outDir dist, includes src/ and tests/.
4. Test strategy with zero extra deps: node:test built-in runner; npm test compiles with tsc then runs node --test against dist tests. npm run typecheck = tsc --noEmit; npm run lint = oxlint src tests.
5. Create SPEC section-14 layout: schema/ (with .gitkeep placeholder), src/ (trivial real module, e.g. src/core/version.ts), tests/ (trivial passing test importing it).
6. Implementation delegated to an Opus subagent per CLAUDE.md model tiers; fable reviews the diff and runs npm install/test/lint/typecheck to verify ACs.
7. Commit on this feature branch; record implementation notes and dependency justifications.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Dependency justifications (all dev-only, zero runtime dependencies):
- typescript@^7.0.2 — compiler and typechecker; non-negotiable for a TS repo. npm resolved the current major (7.0.2, not 5.x); it compiles the strict config cleanly. Flag: pin to ^5 later if 7 causes churn.
- @types/node@^26.1.2 — type declarations for node:test, node:assert, and all node:* modules used by the zero-dependency test strategy.
- oxlint@^1.77.0 — linter. Chosen over eslint+typescript-eslint (2 direct + many transitive packages) to honor the minimal-dependencies invariant: one package, zero config. Verified it reports real diagnostics on TS files.
Decisions: test runner is built-in node:test (no dependency) via compile-then-run: npm test = tsc then node --test over dist/tests. Extended the existing npm-placeholder package.json in place — name, version, bin approval->cli.js, files, license all preserved; added type:module, engines.node>=20, scripts, devDependencies. tsconfig is stricter than the AC minimum (noUncheckedIndexedAccess, exactOptionalPropertyTypes, verbatimModuleSyntax et al) — cheaper to be strict from file one. Implemented by an Opus subagent per CLAUDE.md model tiers; fable reviewed the diff (one fix: removed a speculative spec_version claim from a doc comment) and independently re-verified from a clean node_modules.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Scaffolded the TypeScript package on top of the existing npm placeholder: package.json (type:module, engines.node>=20, test/lint/typecheck/build scripts, three dev-only deps), strict NodeNext tsconfig, .gitignore, SPEC section-14 layout (schema/, src/, tests/), src/core/version.ts with a real node:test suite. Verified by wiping node_modules and dist, then npm install && npm test && npm run lint && npm run typecheck — all exit 0 (2/2 tests pass); node cli.js still works.
<!-- SECTION:FINAL_SUMMARY:END -->
