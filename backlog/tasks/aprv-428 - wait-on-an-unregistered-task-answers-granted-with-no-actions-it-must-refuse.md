---
id: APRV-428
title: wait on an unregistered task answers granted with no actions; it must refuse
status: In Progress
assignee:
  - '@opus-428'
created_date: '2026-09-22 01:27'
updated_date: '2026-09-25 04:29'
labels:
  - wait
  - gate
  - refusal
dependencies: []
priority: medium
ordinal: 328000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-09-22 through approval serve on a hosted tenant: POST /verb/wait with positionals [req-does-not-exist] and --json returned {ok:true, task: req-does-not-exist, status: granted, actions: []} in under a second. A wait for a task the log has never seen reads as a grant. Nothing downstream can consume it (there is no token and no action), so it mints no authority, but a caller that branches on status sees granted for a typo, and a harness shim that polls wait until granted would proceed on a request it never opened. SPEC section 11.1: ambiguity resolves to the stricter path; refusals are machine-readable and distinct. wait should refuse an unregistered task with the existing task-not-registered code (or a distinct wait-specific one), and a registered task with zero pending actions should say so as a distinct state rather than granted.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 approval wait <unknown-task> exits non-zero with a machine-readable refusal naming the task; through approval serve the body carries the same code
- [x] #2 approval wait on a registered task whose actions are all already executed or none declared answers a distinct status, never granted
- [x] #3 Existing wait tests for a genuinely granted request are unchanged; conformance refusal-union vectors regenerated if a code is added
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Code choice: reuse gate_refusal_codes member `not-registered`, whose SPEC §11.2 row ("No task.registered record exists for the task id") is exactly this condition. No union changes membership, so no vector regen/bump. Exit 1 (EXIT_INTEGRITY), matching what `approval request` exits for the same refusal and wait's existing exit-1 meaning (not authorized, terminal).
2. core/gate.ts: extract `taskRegistration(records, task)` returning the task.registered record or the not-registered GateRefusal; registeredAction reuses it so the code and message have one raise site.
3. cli/execute.ts commandWait: after each verified read, refuse not-registered before deriving anything (stderr {ok:false,error:{code,message}} under --json, renderRefusal otherwise). Nothing appended.
4. Status derivation: precedence rejected > withdrawn > expired unchanged; the remaining case splits: at least one granted action with no execution.started -> "granted" (byte-identical to today); otherwise (no requests at all, or every granted action already executed) -> "nothing-to-wait-for" at exit 0, ok:true. Exit 0 kept because the registered contract says a task with no requests returns immediately at exit 0 and the supervised path tells agents their proceed:true needs no wait; exit 0 mints nothing (run still needs a token). Per-action rows unchanged.
5. Human render: nothing-to-wait-for gets the skip glyph / warn role rather than ok.
6. verb-registry wait entry (status enum, exit 0/1 meanings, purpose), WAIT_HELP, docs/cli-reference.md#wait updated.
7. Tests: cli-run wait tests (unregistered refusal json+human, no requests -> nothing-to-wait-for replacing the old vacuous-granted assertion, all-executed -> nothing-to-wait-for, mixed executed+unexecuted grant stays granted); serve test proving POST /verb/wait on an unknown task carries not-registered and non-zero exit_code in the body.
8. build, typecheck, lint, targeted suites (cli-run, gate, serve, conformance, sealed-delivery, mcp), full npm test once with --baseline comparison.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implementation (APRV-428):
- Code: reused `not-registered` from gate_refusal_codes. Its SPEC §11.2 row ("No task.registered record exists for the task id") is exactly this condition, so no new code and no union membership change: refusal-unions.v1.json is untouched and needs no regen or major bump. Exit 1 (EXIT_INTEGRITY), which is what `approval request` exits for the same refusal and what wait's exit 1 already meant (not authorized, terminal).
- core/gate.ts: new exported `taskRegistration(records, task)` is now the single raise site for not-registered; `registeredAction` delegates to it (same message, same latest-registration-wins rule).
- cli/execute.ts commandWait: after each verified read, a task with no task.registered is refused before any derivation, with a wait-local writer (`emitWaitRefusal`, GateRefusal-typed) because wait's other refusals ride the execute union's log-read codes and not-registered is a gate-union member only. Nothing is appended.
- Status: precedence rejected > withdrawn > expired unchanged. The old vacuous-grant branch now splits: at least one granted action with no execution.started -> `granted` (unchanged bytes); otherwise (no approval.requested at all, or every grant already spent by an execution) -> `nothing-to-wait-for`, ok:true, exit 0. Exit 0 kept because the registered wait contract returns at once and at 0 for a task with no requests, and the supervised path tells agents proceed:true needs no wait; exit 0 mints nothing since run still needs a token. Per-action rows are unchanged (an executed grant still reads state `granted`); only the task-level status moved. Human render: skip glyph, warn role.
- "All terminal" from the brief: rejected/revoked/withdrawn/expired keep their existing statuses and exits, because they are decisions a caller must see (exit 1/3); only the all-granted-and-spent and no-request cases became nothing-to-wait-for.
- Contract surfaces updated: verb-registry wait entry (status enum gains nothing-to-wait-for, exit 0/1 meanings, purpose), WAIT_HELP (kept inside the 25-line short-help cap), docs/cli-reference.md#wait.
- Serve: no server change was needed; handleVerb passes the verb's stderr and exit code through. New serve test proves it.
- Global invariants touched: "refusals are machine-readable and distinct" (strengthened: a typo'd task id is now a distinct machine-readable refusal instead of a success) and fail-closed ambiguity. None weakened. wait still writes nothing on these paths.
- Not done (flag for human): SPEC §11.2's gate_refusal_codes preamble enumerates register/request/decide/withdraw/expire as the union's emitters; wait now also emits not-registered (it already emitted log-unreadable/log-torn-tail, which are members too). A one-clause SPEC amendment naming wait would make that explicit; left out because SPEC edits are policy.edit and the code's condition row is unchanged.

Validation: cli-run 32/32 (new: 'wait on a task the log never registered refuses not-registered at exit 1', 'wait on an empty log refuses not-registered too, rather than granting', 'wait after the only grant was spent answers nothing-to-wait-for, not granted', 'wait with one grant spent and one still unspent answers granted'; rewritten: 'wait on a task with no requests returns immediately with 0, and never says granted', which had asserted the old vacuous grant). serve 45/45 incl. new 'wait on a task the log never registered carries not-registered through serve' (exit_code 1, stderr error.code not-registered, log digest unchanged). Existing genuine-grant wait tests (cli-run 'wait exits 0 when a grant lands mid-wait', sealed-delivery wait cases) pass unmodified. Targeted gate/cli-gate/conformance/conformance-regen/sealed-delivery/mcp-*/help/instructions: 343 pass, 0 fail. conformance/run.mjs clean; refusal-unions.v1.json unchanged (no code added). typecheck + oxlint clean. Full npm test --baseline: 5360 pass, 2 fail, SMTP/APRV-416 failures 0 of the 22 baselined. The 2 non-baseline failures (cli-quickstart 'Telegram preflight uses the selected local API...', demo-provision '--check reports the instance's doctor...') were doctor build-freshness: I edited verb-registry.ts mid-run, which made dist stale; both pass on a fresh build in isolation.

Refutation follow-up (behaviour clean; three items):
1. Agent-facing text that still read exit 0 as granted is updated: src/cli/instructions.ts (the sequence's step 3), src/cli/help.ts (root verb list), docs/dogfood-cutover.md (step 3). Each now says exit 0 is granted OR nothing-to-wait-for, exit 1 includes not-registered, and only --json status "granted" (an unspent grant) means proceed to run. Suites: cli-instructions, cli-help, cli-long-help, docs-guard, cli-run, mcp-server 115 pass / 0 fail; typecheck and oxlint clean.
2. Proposed SPEC §11.2 amendment, NOT applied (rides Carter's attestation batch): in the gate_refusal_codes preamble, change "every way register, request, decide, withdraw, expire, the policy-amendment ceremony, and harness-grant consumption can refuse" to also name wait, e.g. "... expire, wait (not-registered and the log-read codes; APRV-428), the policy-amendment ceremony, ...". Union membership and every code's condition row are unchanged, so no vector bump.
3. Residual raised by the refuter: a verified view that is behind this process's own appends (log-sync or daemon-restart lag, the case SPEC §11.1 invariant 1's APRV-294 scope note covers) used to answer granted [] and now answers not-registered at exit 1 on the first pass. This is the safer direction: the lagging view now yields a refusal where it used to yield a success, so nothing proceeds on a registration the verified chain does not carry, and waiting again is harmless. If it ever needs the keep-waiting treatment, hook.ts's APRV-294 handling is the model: keep polling inside the existing --timeout bound and report that the view lags, never reading unverified bytes. Not implemented here because a plain CLI wait has no record of its own earlier appends to tell lag from a typo.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
approval wait now refuses a task with no task.registered record with the existing gate code not-registered (exit 1, same refusal and exit as approval request; passes through approval serve unchanged). A registered task with nothing a wait can resolve (no requests, or every grant already spent by an execution) answers status nothing-to-wait-for at exit 0 instead of the old vacuous granted; a genuine unspent grant is byte-identical. No refusal union changed membership, so conformance vectors are untouched. Registry, --help and docs/cli-reference.md#wait updated. Verified by new cli-run and serve tests, targeted suites and a full baseline run.
<!-- SECTION:FINAL_SUMMARY:END -->
