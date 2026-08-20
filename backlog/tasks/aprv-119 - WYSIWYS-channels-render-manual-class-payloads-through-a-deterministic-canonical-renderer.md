---
id: APRV-119
title: >-
  WYSIWYS: channels render manual-class payloads through a deterministic
  canonical renderer
status: To Do
assignee: []
created_date: '2026-08-20 14:47'
labels:
  - channels
  - schema
  - emilia-review
dependencies: []
priority: high
ordinal: 111000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC §9/§10.3 already require the computed-vs-claimed display split and that channels present the full payload for manual actions, but the Telegram message body is assembled ad hoc by the channel, so what the approver reads is not mechanically derived from the bytes the token binds to. The failure mode (Emilia RT-079, signoff social engineering; their root threat model: "if the approval UI renders benign text while the hashed payload is malicious, the human signs blind") is a request whose agent-authored summary and channel formatting mislead the approver about the payload they are approving.

Outcome: a pure canonical renderer, one function from (payload bytes, action class) to {text, display_hash}, with no access to clock, locale, environment, randomness, or IO; a closed set of rendered fields per payload kind; absent values rendered explicitly (not omitted); claimed fields (summaries, estimates, rationale) rendered only outside the canonical block and visibly labeled. Channels (telegram, web, cli) MUST present the canonical text for manual-class requests and MAY append claimed material after it. display_hash is recorded on the approval.requested event so the log states what rendering the approver was shown.

Schema change (the display_hash field) is in scope and called out per CLAUDE.md. SPEC amendment to §9/§10.3 for human sign-off is part of the task. Channel conformance: the renderer determinism and closed-field properties get their own tests, in the spirit of the existing channel display rules being conformance requirements.

Reference: emiliaprotocol/emilia-protocol lib/wysiwys/render.ts (pure function, closed field set, absent renders as an explicit marker), docs/security/THREAT_MODEL.md WYSIWYS section.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A canonical renderer exists: same payload bytes and class always produce byte-identical text and display_hash; property pinned by tests including a determinism test across repeated invocations
- [ ] #2 Renderer has no access to clock, locale, env, randomness, or IO; rendered field set per payload kind is closed and absent values render explicitly
- [ ] #3 Telegram, web, and cli channels present the canonical text for manual-class requests, with claimed fields visibly separated and labeled; channel tests cover the separation
- [ ] #4 display_hash recorded on approval.requested (schema updated; older records without it still validate)
- [ ] #5 SPEC §9/§10.3 amended to name the canonical renderer requirement, marked for human sign-off
- [ ] #6 npm test passes; lint clean
<!-- AC:END -->
