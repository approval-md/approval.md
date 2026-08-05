---
id: APRV-13
title: 'Dogfood: repo APPROVAL.md parses, matches, and is wired into the suite'
status: To Do
assignee: []
created_date: '2026-08-05 00:23'
labels: []
milestone: m-2
dependencies:
  - APRV-11
priority: high
type: feature
ordinal: 13000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The milestone's dogfooding criterion (human-mandated): the repository's own APPROVAL.md — authored and committed by the human, permanently read-only to agents — must parse as a valid policy under the real engine and be wired into the fixture suite so any future edit that breaks it fails `npm test` (and therefore CI). This locks the engine and the live policy together from M2 onward: the policy file the agents operate under is continuously proven machine-valid, and engine regressions that would mis-read it surface immediately. Agents MUST NOT modify APPROVAL.md in the course of this task; every test reads the real file at the repo root, never a copy that could drift.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A test loads the repository's actual APPROVAL.md from the repo root through the real APRV-10 loader and asserts it parses and validates as a policy (no fail-closed result)
- [ ] #2 The file is wired into the fixture/test suite such that any future edit that breaks parsing, schema validity, or the assertions below fails npm test
- [ ] #3 Matching assertions lock engine and policy together: defaults.autonomy is manual; deps.add, network.call, release.publish, policy.edit, vcs.history.rewrite, and files.delete.out_of_scope resolve to manual; read.* classes resolve to autonomous; vcs.push.main resolves to supervised
- [ ] #4 No test copies or rewrites APPROVAL.md; the suite reads the committed file in place, and the task's implementation touches no byte of it
<!-- AC:END -->
