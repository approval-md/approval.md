---
id: APRV-537
title: >-
  propose --irreversible: SPEC section 7's irreversibility floor for one
  proposed key (For Kicks card)
status: In Progress
assignee:
  - '@claude'
created_date: '2026-11-22 03:22'
labels:
  - propose
  - floor
  - serve
dependencies: []
ordinal: 408000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
An agent that proposes an action which cannot be undone (a For Kicks order: money and a café's kitchen) needs a person to decide under every resident setting, not only under ask and manual. Core 0.4.8 cannot say so: propose has no way to declare reversible:false, so autonomous, supervised-retro and supervised-live answer autonomous or supervised and file no card, and the agent's only other asking verb (request) refuses a propose task. SPEC section 7 already has the floor; this exposes it on propose. Lead ruling (CLAIMS 'RULED build-4's For Kicks page 9a55e501'): on serve's agent allowlist, stacked after #680, ships in the next core release, no release of its own; #679's check scripts learn the floor in the same change (a separate commit on #679's head, since #679 is not in #680's base).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval propose --irreversible records reversible:false on the registration and on the request
- [ ] #2 With the flag, autonomous, supervised-retro and supervised-live answer requested and file the same human request ask and manual file; ask and manual are unchanged; human-only is unchanged; allow_irreversible:true keeps the class's autonomy
- [ ] #3 With the flag, start refuses a key with no human grant (not-granted) on the grant path and on the policy path; a grant is spent once with authorization grant
- [ ] #4 The stricter value wins and sticks: a later propose without the flag stays floored; a later propose with the flag over an unflagged registration files a floored request and the key stays floored
- [ ] #5 serve's agent allowlist accepts --irreversible on propose and nothing else new; an off-list flag still answers 403 serve-flag-not-permitted
- [ ] #6 Without the flag every answer and record is byte-shaped as 0.4.8
- [ ] #7 CLI help, docs/cli-reference.md, SPEC section 10.1 and CHANGELOG say what the flag does
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. gate.ts: ProposeInput.irreversible; proposalIrreversible(records, task, key) reads the registration and every request of the key; propose passes reversible:false to the registration and the request; startProposed passes it to startHarnessExecution, whose attempt also re-reads it from the log for a proposal task. 2. cli/gate.ts, help.ts, verb-registry.ts: the boolean flag. 3. serve/arguments.ts AGENT_FLAGS propose. 4. tests/propose-irreversible.test.ts: five cells with and without, start refusals, write boundary, mixed orders, allow_irreversible, human-only, CLI, serve. 5. Docs and CHANGELOG. 6. On #679's head, a separate branch: the box passes the flag, decideProposeCall and proposeCardStyle and limitingReasons resolve with reversible:false, the extractor reads the flag at the propose site, validateExpected accepts propose.irreversible.
<!-- SECTION:PLAN:END -->
