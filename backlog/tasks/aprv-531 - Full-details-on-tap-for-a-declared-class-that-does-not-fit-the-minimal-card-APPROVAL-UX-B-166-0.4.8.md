---
id: APRV-531
title: >-
  Full details on tap for a declared class that does not fit the minimal card
  (APPROVAL-UX B-166, 0.4.8)
status: In Progress
assignee: []
created_date: '2026-10-20 10:56'
updated_date: '2026-10-20 11:36'
labels:
  - channels
  - telegram
  - spec
dependencies: []
ordinal: 405000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Under prompt.style minimal a declared class gets the simple card only when the whole canonical rendering fits collapsed in the same message as the buttons (SPEC §10.3, MINIMAL_MESSAGE_BUDGET 3800). Every real For Kicks order exceeds that and falls back to the technical card (too-long). Lead ruling L15758 option b: a declared class never falls back for size; the resident sees the simple card with a computed notice and a third control, Full details, which sends the canonical rendering whole and byte for byte as threaded replies. Design: private handover APRV-0.4.8-details-on-tap-design.md. SPEC §10.3 amendment pending Carter's attestation. Class-diff: none (rendering only).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 SPEC.md §10.3 carries the exception sentence and the amended fallback clause (pending attestation)
- [x] #2 A declared request that fails only on size renders the minimal card with the notice and Approve / Deny / Full details buttons
- [x] #3 The Full details tap sends the canonical rendering whole as threaded replies (reply_to the card), each under 4096, split never mid-grapheme, opened and closed by the computed lines; concatenation is byte-equal to the canonical rendering
- [x] #4 Replies carry no buttons; the details callback never decides and appends nothing to the log; a repeat tap answers Already sent above.
- [x] #5 A decision from the card binds the same display_hash as the technical card
- [x] #6 Undeclared oversize stays technical (undeclared); every other fallback unchanged; settle edit drops all three buttons
- [x] #7 Tests at 1, 2 and 5 For Kicks items; mutants killed (reply cut short, buttons on a reply, decision via details callback, opener missing)
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. SPEC.md first, own commit: §10.3 exception sentence (design note text verbatim), fallback clause, §5.2 prompt.style pointer. 2. telegram-minimal.ts: after every other fallback, a declared opaque request over the budget gets the card without the collapsed block plus MINIMAL_ON_TAP_NOTICE and onTap.rendering; detailsReplies() builds the threaded replies. 3. telegram.ts: third button d:<nonce>, its own parser ahead of the decision vocabulary, handleDetailsTap sends replies with reply_parameters and no markup, repeat tap answers Already sent above., settle edit tolerates an empty collapsed block. 4. Docs, CHANGELOG, tests incl. mutants.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Done in two commits on approval/048-details-on-tap (stacked on loki-g1-withdraw): SPEC first (7369b3ec), then code, docs and tests.

Decisions:
- Declared means an opaque payload whose every top-level key the class's say.quote names (excerptOf already refuses anything else). A command, a file change or an email over the budget keeps too-long: those payloads are not what say declares, and the SPEC's MAY lets a channel apply the exception more narrowly.
- The replies carry only the canonical rendering (rendering.payloadText, the text display_hash names), inside <pre>, escaped exactly as the technical card escapes it; the technical header and claimed block are not resent. Each reply is at most MINIMAL_MESSAGE_BUDGET (3800) HTML units, which leaves room for a relay label line under Telegram's 4096. The split is between grapheme clusters and, where possible, between two non-blank clusters, because Telegram trims white space at a message's edges and a continuation reply starts with its <pre>.
- The details callback is d:<nonce>, parsed by its own parser before the decision vocabulary, like the checkpoint and review verbs; CALLBACK_VERBS has no d, so the bytes cannot reach the decision ladder. An unknown nonce gets the anomaly path (unknown-callback) and a toast; nothing is sent.
- The tap is acked first (empty text) so the spinner stops; sent is set only after every reply has gone, so a half-failed send is resent whole on the next tap.
- The decision record stays {style: minimal}: no new rendering field, so the event schema and gate are untouched. The optional channel.details_sent counter was not added (it would widen the counters shape).
- The settle edit is outcome, headline and detail lines (minimalSettleText drops an empty collapsed block); replies are left as sent.

Global invariants touched: none weakened. The new control appends nothing and reaches no handler (tests assert a byte-identical log and a zero handler count). No refusal union, vector file or schema changed.

Cross-repo gap: the control plane's approval relay forwards only SEND_FIELDS (parse_mode, disable_web_page_preview, link_preview_options, disable_notification, protect_content), so behind the relay reply_parameters is dropped and the replies arrive unthreaded until the relay adds it.
<!-- SECTION:NOTES:END -->
