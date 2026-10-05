---
id: APRV-489
title: >-
  Minimal Telegram prompt style: a plain-words card with the canonical rendering
  collapsed in the same message (channels.telegram.prompt.style)
status: In Progress
assignee:
  - '@agentvillage-d4-C1'
created_date: '2026-10-05 08:41'
updated_date: '2026-10-05 09:13'
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
- [x] #1 The policy schema and promptBlockErrors accept style and say under channels.telegram.prompt only. Bad values fail the policy load with distinct keywords. Absence renders today's technical bytes exactly, and existing Telegram tests pass unchanged
- [x] #2 Under minimal, a request renders one message: the headline, quotes, time line, claimed lines, and an expandable blockquote holding renderTelegram's three regions verbatim. A test asserts the canonical text appears unmodified, and that the HTML contains exactly one match of the relay quiet regex for the ttl row
- [x] #3 An opaque payload with a top-level key that say.<class>.quote does not list, or with no entry at all, renders the technical card. Email always shows to, cc, bcc and subject. Commands always show the command line or the breakdown. A gloss never renders without that computed excerpt above it
- [x] #4 Quoted values are HTML-escaped, length-bounded with an explicit cut marker, and control, format and bidi characters are marked injectively; quoted text cannot forge the headline, the deadline line, a button or the collapsed block's boundary
- [x] #5 A card whose whole message would exceed Telegram's limit falls back to today's technical multi-message form for that request, and the audit record says so. Nothing is truncated
- [x] #6 The decision edit keeps the minimal headline and the collapsed details
- [x] #7 Attestation prompts, digests, stale summaries, review cards and truncated payloads render technical under minimal; review cards and the note prompt are byte-identical in both styles
- [x] #8 Minimal cards carry a plain deadline line from the real wait and expiry and label the reject button Deny; callback verbs and recorded events are unchanged; no Defer button
- [x] #9 The audit record states which style was shown: additive, optional, absent for technical
- [x] #10 The SPEC 10.3 and 5.2 amendments, docs/cli-reference.md, the policy reference, the CHANGELOG under Unreleased, and examples/agent-village/approval-policy.md are updated; the 10.3 amendment is its own commit
- [ ] #11 The targeted test files are named in the PR. One refuter pass has run with no open finding
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built on lane/c1-minimal-card (agentvillage-d4/C1), slices: SPEC 10.3 amendment alone (d5f0239e), C1a keys+loader (ef8f5d97), C1b+C1c card, settle edit and payload.rendering (b1877395, one commit: both live in deliverOne/annotate), C1d docs (abeaa199).

Decisions and where the code disagreed with the design note (code and rulings win):
- style/say sit in the SHARED prompt block: validated on every channel, drawn by Telegram only, IGNORED by web and cli (orchestrator requirement 7). The note had proposed a Telegram-only def that refuses them elsewhere.
- Over the 3800-char budget the request gets today's technical multi-message card (requirement 5), not the note's 'card then numbered collapsed details'.
- The decision record DOES state the style: payload.rendering {style[, fallback]} on approval.granted/rejected, written only when the policy asked for a non-default style (requirement 4). No event-schema change: the payload is open; constraining the field is a follow-up for after #614/#615 settle the schema version.
- Inside the expandable blockquote the <code> (action key) and <pre> (canonical rendering) wrappers are dropped: the Bot API formatting rules say blockquotes cannot nest and 'all other entities can't contain each other'; bold/italic may sit inside any entity. The text is unchanged character for character and a test decodes it back.
- The live-tool-call fact for the deadline line is a symbol-keyed computed TaggedField on ChannelRequest (LIVE_TOOL_CALL), set by the tagger when the record declares execution: harness and harness_cap_ms. Symbol-keyed so CLI/web rows, --json and approval queue output are unchanged.
- No 'git clone' special phrase; network.call reads 'contact a website or online service'.
- Note line refs checked: renderTelegram 1168-1227, sendPrompt 3127-3178, deliverOne 3180, SPEC 555 (10.3) and 600 (10.4), schema promptLayout 370-391 all matched feddac39.

SPEC 11 touch: the approver-facing presentation rule (10.3) is amended; the canonical rendering stays in the button-bearing message; payload.rendering is a channel-reported field with no reader (11.1 invariant 4 holds by absence of a reader).

Remaining: refuter pass (orchestrator), owner confirmation of R1 before arming, control-plane template PR after the core pin moves.

AC #1 is met in requirement 7's form, not its literal 'only': style and say are accepted under every channel's prompt block (validated everywhere, unknown values fail the load), drawn by Telegram only, ignored by web and cli. AC #11 stays open until the refuter has run.
<!-- SECTION:NOTES:END -->
