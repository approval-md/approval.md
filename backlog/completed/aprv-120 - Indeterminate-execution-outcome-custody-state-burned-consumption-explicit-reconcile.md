---
id: APRV-120
title: >-
  Indeterminate execution outcome: custody state, burned consumption, explicit
  reconcile
status: Done
assignee: []
created_date: '2026-08-20 14:47'
updated_date: '2026-08-26 20:27'
labels:
  - adapters
  - gate
  - schema
  - emilia-review
dependencies: []
priority: high
ordinal: 112000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
execution.failed currently conflates "the provider refused" with "we do not know whether the side effect happened". An email adapter that times out mid-send looks identical in the log to one that never sent, and a retry against a genuinely-unknown outcome is a blind double-execution risk that idempotency keys only partially cover (a second request with a new key is legal). Emilia treats this as a custody state: an exception after the provider call is entered burns the consumption anyway, records outcome-unknown under a closed reason code, refuses blind retry, and resolves only through an explicit reconcile step fed by relying-party-supplied evidence ("INDETERMINATE is a custody state. The reservation remains held. A blind retry is refused."; "recovery is never evidence that the provider did not execute").

Outcome for our adapter contract (§10.4): the fixed sequence distinguishes where the exception happened. An exception before act is entered remains execution.failed (provably not committed). An exception after act is entered appends execution.indeterminate: the token stays consumed, the idempotency key stays burned, and the action is neither retryable nor reportable as failed. A reconcile verb (human-or-operator invoked; the daemon never auto-resolves) records what actually happened as a separate event referencing the indeterminate one, so the original observation survives resolution; resolution to not-executed is what re-opens the possibility of a fresh request.

Schema change is in scope and called out per CLAUDE.md: new event type(s) for the indeterminate outcome and its reconciliation, following the §8 enum-versioning precedent (verifiers accept the additions). SPEC amendment to §6.3, §8 and §10.4 for human sign-off is part of the task. Touches §11.1 invariants 5 and 6 (compare-and-append, machine-readable distinct refusals); implementation notes must say so. Scope note: this may want splitting (schema task, adapter-contract task, reconcile verb) at pickup per one-task-one-context; the splitter decides then.

Reference: emiliaprotocol/emilia-protocol packages/gate/src/proposal-to-effect.ts (closed transition union RESERVED/INVOKING/INDETERMINATE/COMMITTED/RELEASED/ESCALATED), packages/gate/src/index.ts run() phase machine (effect_attempted burns consumption, closed code effect_attempted_outcome_unknown, exception text kept out of evidence), reconcileCapabilityOperation in capability-receipt.ts (caller-invoked, injected evidence verifier, reconciliation outcome stored beside the original outcome, idempotent on same evidence digest).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Adapter contract distinguishes pre-entry failure (execution.failed) from post-entry unknown (execution.indeterminate); the boundary is the moment act is invoked, pinned by tests that throw on each side
- [x] #2 An indeterminate outcome leaves the token consumed and the idempotency key burned; a retry or re-run against it is refused with its own stable reason code
- [x] #3 Exception text stays out of the event; only closed machine-readable codes are recorded, and the credential-redaction scan still passes
- [x] #4 A reconcile path appends a resolution event referencing the indeterminate event; the original record is never rewritten; resolving as not-executed is recorded distinctly from resolving as executed
- [x] #5 Event schemas added and verifiers accept the new types alongside the existing enum per the §8 precedent
- [ ] #6 SPEC §6.3/§8/§10.4 amended, marked for human sign-off
- [ ] #7 npm test passes; lint clean
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built 2026-08-26, merged in PR #130. Custody vocabulary (SPEC §6.3): settled / open / delegated / indeterminate / reconciled. Harness records (execution:'harness') classify delegated, terminal by design — fixing the live bug where status reported 48 harness records as dangling; open is now the 3 real cases. Failed/indeterminate boundary is positional: through the adapter read = failed (nothing attempted); from invocation onward a throw = indeterminate; a returned failure stays failed. Fail-closed choices where the task left them open: unreconciled indeterminate fails health; reconcile never un-burns a key (not-executed re-opens the effect via a fresh action); resolve/finish refuse over indeterminate; indeterminate neither increments nor clears the loop streak; envelope projection stays approved rather than claiming executed; one closed reason value act-threw at v0.1. New human-only verb approval execution reconcile with mandatory evidence note. Three new frozen refusal codes (execution-indeterminate, not-indeterminate, already-reconciled), regenerated into the conformance vectors. Exception text reaches the caller redacted and never the log, pinned. doctor untouched (environment checks only); status is the health surface. Follow-up APRV-146 filed (harness records bind payload_hash; delegated refuses outcomes).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Executions that end nowhere have a name and a human path out: five custody states, a positional failed/indeterminate boundary, a human-only reconcile verb, and 48 false danglings reclassified delegated. Merged in PR #130.
<!-- SECTION:FINAL_SUMMARY:END -->
