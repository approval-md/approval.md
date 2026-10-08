---
id: APRV-49
title: 'Dogfood cutover: manual-class repo actions route through the live daemon'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 15:33'
updated_date: '2026-08-17 15:31'
labels: []
milestone: m-7
dependencies:
  - APRV-39
  - APRV-40
  - APRV-41
  - APRV-42
  - APRV-43
priority: medium
type: feature
ordinal: 49000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The M5 exit criterion, ordered 2026-08-05: once approvald is the sole log writer, the dogfooding escalation in CLAUDE.md stops being aspirational. Document and enable the workflow where agent sessions route manual-class repo actions (deps.add, network.call, release.publish) through approval request + approval wait against the running daemon, with the Telegram channel live: session proposes, gate holds, phone approves, execution proceeds, log records. Includes the CLAUDE.md edit this requires, drafted in this task for the human to apply by hand (CLAUDE.md is theirs; agents never edit it), replacing the stop-and-escalate interim rule with the daemon-mediated path. Closes with an end-to-end proof: one real dependency add or equivalent manual-class action flowing session -> gate -> phone -> grant -> execution, recorded in the repo public log on main.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Workflow documented: how a session registers, requests, and waits on a manual-class repo action against the running daemon, and what it does on grant, reject, and timeout
- [x] #2 Repo policy classes for deps.add, network.call, release.publish exist in APPROVAL.md via a human-applied, human-attested edit (drafted here, applied by the human)
- [x] #3 CLAUDE.md edit drafted for the human: daemon-mediated gate operations replace the stop-and-escalate interim rule; draft delivered in this task, never applied by an agent
- [x] #4 End-to-end proof executed: one real manual-class action (dep add or equivalent) flows session -> gate -> Telegram on the human phone -> grant -> execution, and the resulting events verify on the committed log on main
- [x] #5 The proof events are appended by the daemon as sole writer in the primary checkout, never from a worktree
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Riders from sign-off: amend SPEC 5.2 orphan sentence to the conservative reading (approved); verify doctor surfaces sampling-disabled state + machine-readable reason prominently, add check if missing. 2. docs/dogfood-cutover.md: the session workflow (register, request, wait against the running daemon; grant/reject/timeout paths), both human drafts (APPROVAL.md classes deps.add/network.call/release.publish + CLAUDE.md daemon-mediated section replacing stop-and-escalate) as exact fenced text, and the end-to-end proof runbook up to the human thumb. 3. Proof task file with approval envelope (real dev-dep refresh as the recommended manual-class action), created via backlog CLI, envelope added per the convention this spec defines. 4. PR the scaffolding; human applies APPROVAL.md + CLAUDE.md, attests, exports Telegram env, runs daemon in primary, session runs register/request/wait, phone grant, approval run executes, log events committed to main by the human. 5. Finalize with proof references.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Scaffolding merged as PR #11 (1130 tests): doctor audit-sampling check (sign-off rider: pass/fail-with-fix/stated-skip; secret asserted absent from output), SPEC 5.2 orphan amendment to the signed-off conservative reading, docs/dogfood-cutover.md (session workflow, both human drafts, proof runbook), and APRV-51 created with the real envelope (deps.add, npm update @types/node, argv+cwd payload hash 6f9b0421...), validated against a sandbox log: register and request both admit it, class deps.add resolves manual. Policy discovery: APPROVAL.md already carries the three manual classes attested at seq 3, so no policy edit is required for the proof; sampling additions drafted as optional via policy amend. Envelope added to the task file by direct frontmatter edit, deliberately: it is the one edit the backlog CLI cannot express and is precisely the convention this specification defines; backlog view still parses the file and the envelope round-trips through register. AWAITING THE HUMAN: apply the CLAUDE.md bullet replacement (drafted verbatim in the doc), start daemon + telegram listener in the primary checkout, then signal the session to run the three proof commands; grant on the phone; hand the token; approval run executes; human commits the log advance to main. Until the CLAUDE.md edit is applied, the interim stop-and-escalate rule still governs, which is why the session has not run register itself.

CUTOVER COMPLETE 2026-08-17. Human applied the CLAUDE.md bullet replacement and the APPROVAL.md sampling_secret_env addition (PR #16), attested at seq 4 and pushed the log advance by hand; operator env (Telegram token/chat, sampling secret) stored in macOS Keychain and exported per terminal, values never passing through the session; daemon and telegram listener run in the primary checkout. Proof (APRV-51) executed and committed to main as 7d632e5, seq 5-12. Doctor audit-sampling check earned its keep the same day: it reported secret-unset immediately after the policy named the variable, before the operator had created the secret. Findings for the report: (1) listener delivers pending requests at startup and collects decisions thereafter; live push of requests that arrive mid-run belongs to the daemon channel-dispatch role (SPEC 10.2), not yet built, follow-up candidate; (2) each log state change produced an envelope.drift because v0.1 never writes task files, the signed-off 6.3 deferral, closed by M6; (3) token handoff from listener terminal to session is the human step that makes the human the gate, as documented. Global invariants touched: none weakened; the proof exercised 2 (runtime ts on every gate event), 3 (token_sha256 only in the log), 5 (compare-and-append across daemon and CLI writers interleaving on one log without a head-moved), 6 (token-consumed refusal distinct and machine-readable).

ROUND-TRIP FINDING, caught while finalizing: backlog task edit rewrote the APRV-51 file and silently DROPPED the approval: frontmatter key (the entire envelope). Restored by hand with state: executed (what the log says). This is precisely the M6 requirement (SPEC 6: implementations MUST preserve unknown frontmatter; CLAUDE.md: round-trip fidelity is hard, M6 has the tests), observed in the wild against the real Backlog.md CLI on the first task file that ever carried an envelope. The log was never at risk (the file is a projection); the artifact was. M6 priority input: the upstream Backlog.md issue draft (docs/upstream-backlog-issue.md) now has a concrete reproduction.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Dogfood cutover live: daemon sole writer in the primary checkout, sessions route manual-class actions through register/request/wait/run against the live log per the human-applied CLAUDE.md rule, Telegram channel on the phone, doctor surfacing sampler state. Proof: real deps.add granted from the phone, executed, on main (seq 5-12, 7d632e5).
<!-- SECTION:FINAL_SUMMARY:END -->
