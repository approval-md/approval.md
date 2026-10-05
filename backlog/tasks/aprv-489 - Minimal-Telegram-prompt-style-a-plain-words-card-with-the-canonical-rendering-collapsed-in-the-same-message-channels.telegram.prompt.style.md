---
id: APRV-489
title: >-
  Minimal Telegram prompt style: a plain-words card with the canonical rendering
  collapsed in the same message (channels.telegram.prompt.style)
status: To Do
assignee: []
created_date: '2026-10-05 08:41'
labels:
  - agentvillage
dependencies: []
priority: high
type: feature
ordinal: 370000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Residents find today's Telegram approval card verbose and technical (owner, 2026-10-05: switch between output types, technical as today and minimal as new; minimal must be simple, user friendly and non technical; it is what village residents see through the approvals bot unless they change their setting). Add channels.telegram.prompt.style: technical | minimal (default technical) and channels.telegram.prompt.say (per-class does, quote, note) to the attested policy.

A minimal card is one message with these parts:
- a headline computed by the runtime from the class (never model or agent text);
- quoted lines copied verbatim from the bound payload, under a closed field set: an unlisted key or a missing declaration falls back to the technical card;
- a plain deadline line computed from the request's real wait and expiry;
- claimed lines labelled in plain words, below the computed excerpt;
- Approve and Deny (label only; callback data unchanged);
- the full technical card, including the canonical rendering verbatim, collapsed inside an expandable blockquote in the same message.

The canonical renderer, display_hash, callback data and the log's event shapes are unchanged. Attestation prompts, digests, stale summaries, review cards and truncated payloads stay technical. This amends SPEC 10.3 (the canonical rendering may be collapsed in the button-bearing message when the attested policy says so) and 5.2. This touches SPEC 11's invariants on what an approver is shown: say so in the implementation notes. Rulings R1 to R7 (orchestrator, owner-approved; R1 pending owner confirmation of the SPEC text): no Defer button, no conformance vectors or schema-version bump, Deny label on minimal only, phrases for operator classes declared in the policy. Design note: agentvillage/private/handover/lanes-main/C1-minimal-card-design.md (Carter's private checkout).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The policy schema and promptBlockErrors accept style and say under channels.telegram.prompt only. Bad values fail the policy load with distinct keywords. Absence renders today's technical bytes exactly, and existing Telegram tests pass unchanged
- [ ] #2 Under minimal, a request renders one message: the headline, quotes, time line, claimed lines, and an expandable blockquote holding renderTelegram's three regions verbatim. A test asserts the canonical text appears unmodified, and that the HTML contains exactly one match of the relay quiet regex for the ttl row
- [ ] #3 An opaque payload with a top-level key that say.<class>.quote does not list, or with no entry at all, renders the technical card. Email always shows to, cc, bcc and subject. Commands always show the command line or the breakdown. A gloss never renders without that computed excerpt above it
- [ ] #4 Quoted values are HTML-escaped, length-bounded with an explicit cut marker, and control, format and bidi characters are marked injectively; quoted text cannot forge the headline, the deadline line, a button or the collapsed block's boundary
- [ ] #5 A card whose whole message would exceed Telegram's limit falls back to today's technical multi-message form for that request, and the audit record says so. Nothing is truncated
- [ ] #6 The decision edit keeps the minimal headline and the collapsed details
- [ ] #7 Attestation prompts, digests, stale summaries, review cards and truncated payloads render technical under minimal; review cards and the note prompt are byte-identical in both styles
- [ ] #8 Minimal cards carry a plain deadline line from the real wait and expiry and label the reject button Deny; callback verbs and recorded events are unchanged; no Defer button
- [ ] #9 The audit record states which style was shown: additive, optional, absent for technical
- [ ] #10 The SPEC 10.3 and 5.2 amendments, docs/cli-reference.md, the policy reference, the CHANGELOG under Unreleased, and examples/agent-village/approval-policy.md are updated; the 10.3 amendment is its own commit
- [ ] #11 The targeted test files are named in the PR. One refuter pass has run with no open finding
<!-- AC:END -->
