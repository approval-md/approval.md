---
id: APRV-106
title: >-
  Protect human attention: approval.withdrawn for abandoned requests, hook
  withdraws on timeout, channels show age and deadline and retire withdrawn
  prompts, no token minted for hook grants
status: Done
assignee:
  - '@fable'
created_date: '2026-08-19 17:14'
updated_date: '2026-08-19 18:31'
labels:
  - security
  - ux
  - hook
  - channels
  - spec
milestone: m-11
dependencies: []
priority: high
ordinal: 98000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-08-19: a builder session ran git commit --amend, the hook classified it vcs.history.rewrite (manual) and appended approval.requested (seq 28, and again at seq 30), waited its 9-minute --timeout, got no decision, and moved on. The requests stayed pending under the policy 24h TTL, so the human was prompted on Telegram ~30 minutes later, approved both (seq 33, 34), and the grants authorized nothing: the hook treats every tool call as a new request and the waiter was gone. Human attention is the audit budget (SPEC 11); a decision nobody can consume is the system spending that budget on noise, which is the failure mode it exists to prevent. ROOT CAUSE: nothing in the log records that the requester stopped waiting, so no channel can know. DESIGN: (1) New event approval.withdrawn, appended by the REQUESTING actor (agent: or human:) for its own request only, only while the request is pending (not granted, rejected, revoked or expired); payload {action_key, reason: timeout|cancelled|superseded, note?}. A later grant/reject/revoke on a withdrawn request is refused with a distinct code request-withdrawn; a withdraw racing a grant loses to whichever landed first, through compare-and-append (invariant 5). requestState gains withdrawn; wait exits with a new distinct code for it; queue and QUEUE.md drop withdrawn requests. Schema (event.schema.json, actor rule: withdrawn is the requester, never system:, never another actor), SPEC 6.3 lifecycle and SPEC 8 amended in the same commit and FLAGGED for human sign-off. (2) The hook appends approval.withdrawn {reason: timeout} when its wait elapses and on any exit path that leaves its own request undecided (exception thrown, SIGTERM), best effort and never blocking the deny it already returns. approval wait gains --withdraw-on-timeout (default off for the CLI, on for the hook) so a scripted agent can opt in. (3) Telegram: every prompt carries "requested N min ago; the requester waits until HH:MM UTC" computed from the request ts and, when the request came from the hook, the hook wait deadline carried in the envelope; when a withdrawn event is observed the listener edits the message (editMessageText / editMessageReplyMarkup) to "withdrawn by the requester at HH:MM, nothing to do" and removes the buttons; a tap on an already-withdrawn prompt answers with the refusal, not a grant. Web and cli channels mirror the text. (4) Hook grants mint no token and the listener prints no token panel for them: the hook is an authorization query, not a spend (nothing runs approval run); mark hook-originated envelopes so decide() can skip the mint, or mint and suppress the panel if skipping the mint would fork the gate path (builder decides and records why). Invariants touched: 5 (new check-then-append through compare-and-append), 6 (new codes pinned), 2 (withdrawn ts runtime-assigned).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 approval.withdrawn is a schema-valid event appendable only by the request actor while the request is pending; grant/reject/revoke afterwards refuse with request-withdrawn; withdraw after a decision refuses with already-decided; all codes pinned
- [x] #2 The hook appends approval.withdrawn {reason: timeout} when its wait elapses and on thrown/signal exits; a test proves a grant after the hook timeout is refused and the queue no longer shows the request
- [x] #3 approval wait --withdraw-on-timeout and requestState/queue/QUEUE.md/status treat withdrawn as terminal; wait exits with its own code for it
- [x] #4 Telegram prompts show request age and the requester deadline; a withdrawn request has its message edited and buttons removed; a late tap answers with the refusal; web and cli channels mirror; conformance suite extended
- [x] #5 Hook-originated grants produce no token panel on the listener (mint skipped or suppressed, decision recorded in notes); existing token tests unchanged for CLI requests
- [x] #6 SPEC 6.3 and 8 amended in the same commit as the schema and flagged; docs/claude-code-hook.md, cli-reference and the telegram demo updated; npm test and lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, worktree from main. 2. Schema: approval.withdrawn (requester actor, pending only, reason timeout|cancelled|superseded); SPEC 6.3 and 8 same commit, flagged. 3. core/gate: withdraw() through compare-and-append; request-withdrawn refusal; requestState withdrawn terminal; wait/queue/QUEUE.md/status. 4. Hook: withdraw on timeout and on thrown/signal exits; wait --withdraw-on-timeout. 5. Telegram: age and deadline line; edit message and drop buttons on withdrawn; late tap refuses; web and cli mirror; conformance. 6. No token panel for hook grants (skip mint or suppress; record why). 7. Docs. 8. PR by branch, auto-merge; records here.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Opus subagent build, PR by branch aprv-106-withdrawn (#88), five commits. A. approval.withdrawn in event.schema.json (actor agent: or human:, never system:; payload action_key, reason timeout|cancelled|superseded, note?); three fixtures; core/gate withdraw() through compare-and-append beside decide(); new refusal codes request-withdrawn and not-requester pinned with the union; requestState withdrawn is terminal; a withdrawn request projects the task envelope to proposed (nothing was decided), so envelope schema unchanged; daemon, queue, QUEUE.md and channel queues needed no code because all derive from state requested, and no approval.expired is ever appended for a withdrawn request; concurrency test: grant races withdraw and exactly one lands. B. approval withdraw verb (agent-facing, in the registry, so MCP publishes it; safe because the gate checks the actor against the approval.requested record); wait --withdraw-on-timeout (CLI default off); the hook withdraws its own undecided requests on timeout and on thrown or signal exits, best effort, deny still returned. EXIT CODE: reused 1 (the table in exit-codes.ts is frozen; adding a code is a spec change); withdrawn distinguished in --json status and the human line. C. Channels: computed line "requested N min ago · expires HH:MM UTC" or "· requester waits until HH:MM UTC" from log ts plus the hook wait budget carried on the envelope; on approval.withdrawn the listener edits the message (editMessageText without reply_markup, buttons gone) to WITHDRAWN, no decision is needed; a stale tap toasts and records nothing; web and cli mirror; conformance extended; telegram mock records edits. D. TOKEN: option (i): hook requests carry execution: harness on approval.requested, decide() copies it to the grant and mints nothing; token.ts gains a distinct harness-executed refusal checked before the digest check so run/consume say there was never a key; approval token prints none minted: harness-executed. Ratchet-safe: a false harness claim only removes the claimant own ability to execute. Existing CLI token tests unchanged. E. SPEC 6.3 (lifecycle branch and paragraph) and SPEC 8 (event list, enum versioning bullet) amended, Amended APRV-106, FLAGGED FOR THE HUMAN. Docs: claude-code-hook.md, cli-reference.md, telegram-demo.md, instructions text. 1863 tests, lint and typecheck clean; merged main (#87) cleanly. FOLLOW-UP noted: daemon prune TerminalState comes from SPEC 5.2 payload_retention and does not include withdrawn, so a withdrawn request payload is never pruned (conservative; a 5.2 decision for the human, can ride APRV-103). The hook poll loop still duplicates commandWait (APRV-101 note stands). INVARIANTS TOUCHED: 2 (withdrawn ts runtime-assigned), 5 (new check-then-append through compare-and-append), 6 (two new codes pinned).

Merged at 0ce31af (PR #88) via auto-merge behind ci; primary dist rebuilt so the live hook withdraws on timeout from now on.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
approval.withdrawn (requester-only, pending-only, terminal) with request-withdrawn/not-requester refusals; the hook withdraws on timeout and on thrown/signal exits; wait --withdraw-on-timeout; Telegram prompts carry age and deadline, withdrawn prompts are edited and disarmed, stale taps record nothing; hook grants mint no token (harness-executed). SPEC 6.3 and 8 amended and flagged. PR #88 merged at 0ce31af; 1863 tests, lint, typecheck, conformance for all three channels.
<!-- SECTION:FINAL_SUMMARY:END -->
