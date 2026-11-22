---
id: APRV-537
title: >-
  propose --irreversible: SPEC section 7's irreversibility floor for one
  proposed key (For Kicks card)
status: In Progress
assignee:
  - '@claude'
created_date: '2026-11-22 03:22'
updated_date: '2026-11-22 07:03'
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
- [x] #1 approval propose --irreversible records reversible:false on the registration and on the request
- [x] #2 With the flag, autonomous, supervised-retro and supervised-live answer requested and file the same human request ask and manual file; ask and manual are unchanged; human-only is unchanged; allow_irreversible:true keeps the class's autonomy
- [x] #3 With the flag, start refuses a key with no human grant (not-granted) on the grant path and on the policy path; a grant is spent once with authorization grant
- [x] #4 The stricter value wins and sticks: a later propose without the flag stays floored; a later propose with the flag over an unflagged registration files a floored request and the key stays floored
- [x] #5 serve's agent allowlist accepts --irreversible on propose and nothing else new; an off-list flag still answers 403 serve-flag-not-permitted
- [x] #6 Without the flag every answer and record is byte-shaped as 0.4.8
- [x] #7 CLI help, docs/cli-reference.md, SPEC section 10.1 and CHANGELOG say what the flag does
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. gate.ts: ProposeInput.irreversible; proposalIrreversible(records, task, key) reads the registration and every request of the key; propose passes reversible:false to the registration and the request; startProposed passes it to startHarnessExecution, whose attempt also re-reads it from the log for a proposal task. 2. cli/gate.ts, help.ts, verb-registry.ts: the boolean flag. 3. serve/arguments.ts AGENT_FLAGS propose. 4. tests/propose-irreversible.test.ts: five cells with and without, start refusals, write boundary, mixed orders, allow_irreversible, human-only, CLI, serve. 5. Docs and CHANGELOG. 6. On #679's head, a separate branch: the box passes the flag, decideProposeCall and proposeCardStyle and limitingReasons resolve with reversible:false, the extractor reads the flag at the propose site, validateExpected accepts propose.irreversible.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Design. proposalIrreversible(records, task, key) in src/core/gate.ts is the one reading of the floor for a proposal: the registration's reversible:false, or reversible:false on any approval.requested of the key under the task. The stricter value wins and sticks because both are append-only records; no new event type and no schema change. propose computes irreversible = flag OR proposalIrreversible and passes reversible:false to the registration (when it registers) and to request (which already resolved with input.reversible and records it). startProposed passes reversible:false into startHarnessExecution (HarnessStartInput.reversible, new); attemptHarnessStart resolves with the floor when its caller says so OR, for a propose: task, when proposalIrreversible says so on the records the append is judged against (belt and braces: mutant M6, startProposed not passing it, survives by design because the attempt re-reads). The early human-only and harness-launch refusals in propose keep the ordinary resolution: the floor never changes human-only. The executed answer keeps the ordinary resolution too, so a policy start made before a later flagged propose is reported as what happened. Known limit: a flagged propose that finds a live or decided request answers from it and appends nothing; the floor is then recorded by the next request of the key. If that request lapses and the policy is re-tiered nonmanual, a start with no new propose could take the policy path; any re-propose (with or without the flag) after that is floored only if some record carries it. Touches SPEC 11.1 invariant 4 (self-reported fields only raise scrutiny): the flag only raises, and nothing lowers it. serve: AGENT_FLAGS propose gains --irreversible only. Output JSON unchanged. A second start of a spent floored key answers not-granted (the policy path resolves manual before the single-use scan), which is what a manual class already answers; docs/cli-reference.md's start section says already-executed for a second start, which holds only for nonmanual classes (pre-existing, not changed here).

Proof on 737f3c6 (base #680 da411b02), before any merge: whole suite in three shards under the machine lock, exit 0 each (2576, 2899 and 1766 tests, 0 failing); tsc --noEmit and oxlint exit 0; 17 dist mutants, 16 killed, M6 (startProposed not passing the floor) survives by design because attemptHarnessStart re-reads it. The page's driver with the overlay's real hook on npm pack of this build: no flag, byte-equal to npm 0.4.8 in five cells for both templates; with the flag, five identical cards, one order each after a grant with authorization grant, every out-of-band start refused not-granted.

Rebased by cherry-pick onto main a521a91d (#679 merged; #680's own commits are not in main), as branch build-4-propose-irreversible-main, with the #679 check-script commits in the same branch. After the move: tsc --noEmit and oxlint exit 0; propose-irreversible, serve, serve-propose, cli-propose, propose-recheck, propose-refutation, cli-help, cli-long-help, mcp-server and the four overlay-recipes suites exit 0; whole suite under the lock 7361 tests, 1 failure (log-lock-reclaim, a 1500 ms lock-timeout at load 24.85 that the lock tool flags RED-at-load), which passes alone twice. The protected-path guard fails SPEC.md (9ffd6815) and ci.yml (ec83b0ba) for want of the owner's evidence, as expected.
<!-- SECTION:NOTES:END -->
