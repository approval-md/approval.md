---
id: APRV-80
title: 'SPEC follow-on: the record.* worked example and grant-with-choice'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-18 08:13'
updated_date: '2026-08-18 09:27'
labels: []
milestone: m-10
dependencies:
  - APRV-79
priority: medium
type: docs
ordinal: 79000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Prompted by the human notes-app design (notes submitted via a Telegram bot, auto-categorised by an LLM, human signs off or reroutes in a web/iOS app). Two additions drafted for human sign-off. (a) A record.* worked example making the notes app the canonical record.* story the way the deposit chaser is the canonical communicate.* one: record.categorize manual (or supervised + sampling); the LLM proposal is approval.requested with payload {note_id, category, rationale}; the note sits provisional per SPEC 7 (staged state invisible to, or visibly provisional in, the record proper); the human tap in the app is approval.granted; the app write path is the adapter committing only against a token; batching per 10.3 B7 for the morning review. State plainly the enforcement answer to can-an-agent-press-the-button: the channel is not the boundary, the adapter/write path is (10.4); in an app the agent and the human hold different credentials (server-side session vs a worker with none), so forging a human decision means stealing a session, a stronger boundary than v0.1 config-declared identity (11 names cryptographic identity as future work; this is where it lands). Position the in-app surface as a fourth channel type (channel-webapp) implementing the M4 contract + conformance suite; note the Telegram capture bot is literally the post-v1 inbound-adapters example in 12. (b) Grant-with-choice scoped as a spec QUESTION with a recommendation, not a decision: today a grant binds one payload, so reroute is reject + fresh request. Options: (i) keep reject+re-request; (ii) a request whose payload lists candidates and a grant that carries the chosen one (the grant binds the payload_hash of the CHOSEN candidate, so 10.4 a-grant-approves-specific-bytes still holds if candidates are each hashed and the grant names one); (iii) reject with a structured reroute note the agent MUST re-request from. Recommend (ii) as a v0.2 amendment with the binding rule spelled out, (i) as the v0.1 answer the worked example uses. Docs-only, no code.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 SPEC and/or docs/record-example.md text drafted in the prose style, flagged for sign-off, consistent with SPEC 7/9/10.3/10.4/11 as written
- [x] #2 The grant-with-choice question is written as options with a recommendation and the binding rule for (ii) spelled out
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent (docs-only), worktree from main. 2. docs/record-example.md: the notes-app record.* worked example consistent with SPEC 7/9/10.3/10.4/11; SPEC pointer sentence in 7 or 12; the grant-with-choice question as options + recommendation. 3. Prose style; flagged for sign-off. PR.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Opus subagent (docs-only), PR #49. docs/record-example.md (302 lines): setting, policy (manual, or supervised+sampling with the 7/11 rationale for each), envelope, lifecycle as events, the in-app surface as a fourth channel (computed vs claimed; batching per B7), enforcement stated plainly (channel never the boundary; write path is; different credentials for human and agent; where 11 future-work identity lands), rerouting today, grant-with-choice as an UNRESOLVED question with three options and the recommendation ((ii) as v0.2 with the binding rule spelled out; (i) as the v0.1 answer the example uses), the capture bot as the 12 inbound-adapter example. SPEC 7 pointer paragraph drafted (flagged); README one sentence. FIVE TENSIONS RECORDED (valuable; feed the v0.2 spec pass): (1) the envelope assumes a task file (6); a notes deployment has notes; approval register --json is hinted but no non-file envelope shape exists: SHARPEST; (2) 10.3 batching vs 10.4 full-payload rule at forty notes; (3) a fourth channel beside 13 non-goal (resolved in prose as constraining what the reference ships; flagged for a first-pass reader); (4) the identity boundary moving off the local machine (stronger; v0.1 does not define it; deployments must state it); (5) re-request-after-reject idempotency_key reuse undefined (example uses :2). docs-guard green.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The record.* worked example and the grant-with-choice question, plus five honest spec tensions the notes-app story surfaces. PR #49.
<!-- SECTION:FINAL_SUMMARY:END -->
