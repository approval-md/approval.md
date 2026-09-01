---
id: APRV-169
title: 'Adapter contract: resolve credentials before consuming the token'
status: To Do
assignee: []
created_date: '2026-08-31 00:33'
labels:
  - core
  - gate
dependencies: []
ordinal: 148000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Decided with Carter 2026-08-30 (analysis on APRV-168, option C). Today startExecution in src/adapters/contract.ts consumes the single-use token and appends execution.started BEFORE the credential window opens, so a credential-unavailable failure burns the human's authorization and the retry refuses token-consumed: a refusal that destroys a grant. The consume-early ordering exists to make side effects never double-spendable across crash ambiguity (APRV-120 custody states), and a pre-flight credential PROBE executes nothing, so checking credentials before consumption creates no double-spend window. Change: adapters declare their required credential names; execution resolves them first and refuses credential-unavailable with the token intact (no execution.started, machine-readable refusal per SPEC 11); only then consume and run. This touches the check-then-append ordering of an enforcement path, so SPEC 10.4 gets a sentence and the implementation notes must call out the invariants touched.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Credential resolution precedes token consumption: a credential-unavailable refusal appends no execution event and leaves the token spendable, proven by a test that then succeeds with the same token once the credential appears
- [ ] #2 Double-spend safety unchanged: the consume-then-execute ordering for the actual side effect is untouched and its existing pins stay green
- [ ] #3 SPEC 10.4 states the ordering; implementation notes name the SPEC 11 invariants touched
<!-- AC:END -->
