---
id: APRV-115
title: 'Telegram channel: coalesce similar pending requests into one digest prompt'
status: To Do
assignee: []
created_date: '2026-08-20 12:17'
labels:
  - channel
  - telegram
  - ux
  - design
milestone: m-12
dependencies: []
priority: medium
ordinal: 107000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
2026-08-20: a research session produced ~40 network.call prompts in twenty minutes, one Telegram message per request, and the human tap-approved a stream of near-identical asks (events ~94-167). APRV-114 removes this instance at the classifier, but the failure mode is general: any burst of same-shaped manual actions turns the channel into a notification hose, and attention spent per-tap on identical asks is attention not spent reading the one payload that matters.

Proposal: group, then present once.
- Grouping key: requests pending in the same poll window that share (class, origin session/task, argv[0] or payload shape) coalesce into one digest message: a headline (N requests, class, requester), one summary line per member (argv or payload summary), and full payloads reachable per member.
- Buttons: per-member Approve/Deny plus Approve all / Deny all. A batch tap is sugar for N individual decisions: the runtime appends N individual approval.granted (or rejected) events, each bound to its own action and payload hash, through the same compare-and-append path. No grant record spans more than one action; the log never learns the word batch.
- The human sees every member before any grant: if the digest cannot render all members within Telegram limits, it splits or falls back to one message per member (todays behavior). Fail toward more messages, never toward a grant covering an unseen payload.
- Decided digests annotate per member (APRV-113 semantics, per-line ticks); a partially decided digest shows mixed state.
- Window: one poll cycle to start (no new latency mechanism); a config knob can come later if bursts outlive a cycle.
- The channel contract already models batches (telegram currently renders them degenerately, one message per member): this is the telegram renderer growing real batch support plus the grouping heuristic in the listener, no contract change expected.

Design task first: the grouping heuristic and the all-N button need sign-off (a bulk approve is a new human-attention surface; the mitigation is that every member is rendered and every decision is recorded individually). Related: APRV-114 (classifier fidelity), APRV-109 (attest from phone), APRV-110 (ambient runtime).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Grouping heuristic documented and signed off; digests only group same-class same-origin requests from the same window
- [ ] #2 A batch decision appends one event per member through compare-and-append; no event spans actions; log verify clean under batch decisions
- [ ] #3 Every member payload is visible or reachable before the all-N buttons render; overflow falls back to per-member messages
- [ ] #4 Digest annotates per member on decision, expiry, and withdrawal (APRV-113 semantics)
- [ ] #5 e2e test: burst of similar requests yields one digest, mixed per-member decisions land correctly
<!-- AC:END -->
