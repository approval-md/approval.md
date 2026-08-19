---
id: APRV-106
title: >-
  Protect human attention: approval.withdrawn for abandoned requests, hook
  withdraws on timeout, channels show age and deadline and retire withdrawn
  prompts, no token minted for hook grants
status: In Progress
assignee:
  - '@fable'
created_date: '2026-08-19 17:14'
updated_date: '2026-08-19 17:16'
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
- [ ] #1 approval.withdrawn is a schema-valid event appendable only by the request actor while the request is pending; grant/reject/revoke afterwards refuse with request-withdrawn; withdraw after a decision refuses with already-decided; all codes pinned
- [ ] #2 The hook appends approval.withdrawn {reason: timeout} when its wait elapses and on thrown/signal exits; a test proves a grant after the hook timeout is refused and the queue no longer shows the request
- [ ] #3 approval wait --withdraw-on-timeout and requestState/queue/QUEUE.md/status treat withdrawn as terminal; wait exits with its own code for it
- [ ] #4 Telegram prompts show request age and the requester deadline; a withdrawn request has its message edited and buttons removed; a late tap answers with the refusal; web and cli channels mirror; conformance suite extended
- [ ] #5 Hook-originated grants produce no token panel on the listener (mint skipped or suppressed, decision recorded in notes); existing token tests unchanged for CLI requests
- [ ] #6 SPEC 6.3 and 8 amended in the same commit as the schema and flagged; docs/claude-code-hook.md, cli-reference and the telegram demo updated; npm test and lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, worktree from main. 2. Schema: approval.withdrawn (requester actor, pending only, reason timeout|cancelled|superseded); SPEC 6.3 and 8 same commit, flagged. 3. core/gate: withdraw() through compare-and-append; request-withdrawn refusal; requestState withdrawn terminal; wait/queue/QUEUE.md/status. 4. Hook: withdraw on timeout and on thrown/signal exits; wait --withdraw-on-timeout. 5. Telegram: age and deadline line; edit message and drop buttons on withdrawn; late tap refuses; web and cli mirror; conformance. 6. No token panel for hook grants (skip mint or suppress; record why). 7. Docs. 8. PR by branch, auto-merge; records here.
<!-- SECTION:PLAN:END -->
