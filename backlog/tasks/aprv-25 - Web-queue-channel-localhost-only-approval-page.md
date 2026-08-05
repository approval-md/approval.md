---
id: APRV-25
title: 'Web queue channel: localhost-only approval page'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 10:51'
updated_date: '2026-08-05 12:02'
labels: []
milestone: m-5
dependencies:
  - APRV-22
  - APRV-24
priority: medium
type: feature
ordinal: 25000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC sections 5.1 and 10.3: the web channel is a local queue page with grant/reject. Human-settled (2026-08-08): binds localhost only, no auth in v0.1 — the same local-machine trust boundary as config-declared identity, stated plainly in the channel docs and the served page. B3 and B7 both land here: tagged computed/claimed rendering via the APRV-22 contract, and batch presentation with unit decisions in the log (each grant/reject its own event carrying the batch delivery id). Decisions are recorded through the existing human-only gate verbs with config-declared identity. Zero new dependencies: node:http, hand-rendered HTML. Port from policy channels.web.port (default 4680 per the section 5.1 example).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 approval channel web serves the pending queue on the configured port bound to 127.0.0.1 only (a test proves non-loopback binding is refused/absent), with the no-auth local-trust-boundary caveat stated in docs and page
- [x] #2 Grant and reject (with note) work from the page, each recorded as its own log event through the gate verbs with config-declared human identity; the served page renders computed vs claimed distinctly and full payloads for manual actions
- [x] #3 B7 batch approval works: one gesture over a set produces one event per request carrying the batch delivery id; forbidden mixes are refused at batch assembly, per the contract
- [x] #4 The APRV-22 conformance suite passes against the web channel unmodified
- [x] #5 Zero new dependencies; subprocess/e2e tests exercise the real HTTP surface against logs built through the real append path
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented by Opus subagent in isolated worktree (branched from post-APRV-26 main; clean merge); fable review accepted all flagged choices, surfaced in the m-4 report: (1) CSRF stance — no anti-CSRF token in v0.1 (no session to protect; anything opening a loopback socket can POST directly, inside the stated section 11 boundary); same-origin Origin/Referer soft check 403s clearly cross-origin posts, explicitly labelled a speed bump not a control; (2) token display — grant token rendered once in the POST response page (deciding human is present at a loopback-only surface; response not persisted), the deliberate asymmetry with telegram argued in both module headers; mechanically the channel never holds the token (one-shot decisionNotice at render time — never stored, never in lastRendered, never in a URL, no redirect-after-POST, absent from the log by scan); (3) fullPayload excluded from the computed field lines (rendering agent-authored JSON inside the computed block would lend it exactly the authority section 9 forbids) — forged-marker test asserts it appears only in the claimed region. Page works with zero client-side script (select-all is the only convenience script); responses carry no-store, no-referrer, nosniff, restrictive CSP; loopback host hard-coded with no widening flag by design; duplicate click surfaces already-decided as 409. Verified on merged tree: 800/800, lint, typecheck.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
src/channels/web.ts + approval channel web: loopback-only no-auth approval page with stated trust boundary, script-free tagged rendering with escaped injection defense, server-enforced reject notes, B7 batch gestures producing unit decisions with batch delivery ids, one-shot token display, port precedence flag>policy>4680. 13 tests. Verified: 800/800, lint, typecheck.
<!-- SECTION:FINAL_SUMMARY:END -->
