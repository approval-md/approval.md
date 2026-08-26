---
id: APRV-119
title: >-
  WYSIWYS: channels render manual-class payloads through a deterministic
  canonical renderer
status: Done
assignee: []
created_date: '2026-08-20 14:47'
updated_date: '2026-08-26 17:42'
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
- [x] #1 A canonical renderer exists: same payload bytes and class always produce byte-identical text and display_hash; property pinned by tests including a determinism test across repeated invocations
- [x] #2 Renderer has no access to clock, locale, env, randomness, or IO; rendered field set per payload kind is closed and absent values render explicitly
- [x] #3 Telegram, web, and cli channels present the canonical text for manual-class requests, with claimed fields visibly separated and labeled; channel tests cover the separation
- [x] #4 display_hash recorded on approval.requested (schema updated; older records without it still validate)
- [x] #5 SPEC §9/§10.3 amended to name the canonical renderer requirement, marked for human sign-off
- [ ] #6 npm test passes; lint clean
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built 2026-08-26, merged in PR #128. The three structural views moved into src/core/wysiwys.ts as the closed kinds (command/file-change/email/opaque) of one canonical renderer; payload-view.ts is a facade so import paths survive. Layering forced the move to core/: gate.ts computes display_hash at the write boundary and core cannot import channels. Formalized in the move: closed field set per kind with explicit '(absent)' rendering; renderer version approval.md/wysiwys/1 printed INSIDE the hashed text (a version beside the digest would let two renderer versions produce one digest for two readings); the raw-bytes line names the recomputed binding. All three channels — including the CLI, which previously showed a terminal approver different text than the phone — present the canonical text, asserted by the shared conformance suite. display_hash on approval.requested assigned like policy_sha256 (no caller field, smuggled values ignored, absent rather than invented). Deliberate scope call: a truncated rendering gets no canonical block — partial bytes get no signing authority. SPEC §9 and §10.3 amended, pending sign-off, human-approved through the gate. Out of scope, noticed: tagging.ts/renderer JSON+hash duplication; whether maxPayloadChars should retire (no non-test caller sets it and batch refuses truncated members); the 3000-line telegram test file wants splitting.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
One deterministic canonical renderer behind every channel: same bytes, same reading, on the phone, the web, and the terminal; display_hash records at the write boundary which rendering the approver was shown. Merged in PR #128.
<!-- SECTION:FINAL_SUMMARY:END -->
