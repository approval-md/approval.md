---
id: APRV-115
title: 'Telegram channel: coalesce similar pending requests into one digest prompt'
status: Done
assignee: []
created_date: '2026-08-20 12:17'
updated_date: '2026-08-25 12:42'
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
- [x] #1 Grouping heuristic documented and signed off; digests only group same-class same-origin requests from the same window
- [x] #2 A batch decision appends one event per member through compare-and-append; no event spans actions; log verify clean under batch decisions
- [x] #3 Every member payload is visible or reachable before the all-N buttons render; overflow falls back to per-member messages
- [x] #4 Digest annotates per member on decision, expiry, and withdrawal (APRV-113 semantics)
- [x] #5 e2e test: burst of similar requests yields one digest, mixed per-member decisions land correctly
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
GROUPING HEURISTIC SIGN-OFF 2026-08-25 (Carter, via approved session plan): digests group only same-class, same-origin requests pending in one poll window, keyed on (class, origin session/task, argv[0] or payload shape). Approve all / Deny all is sugar for N individual decisions appended through compare-and-append; no event spans actions. Every member payload visible or reachable before the all-N buttons render; overflow fails toward more messages, never toward a grant covering an unseen payload. AC 1's sign-off recorded here; build proceeds after APRV-126 in the same worktree lineage.

Built 2026-08-25 by an Opus subagent on top of APRV-126, reviewed by fable, merged in PR #117 (commits ca397a4 + separator fix). Grouping: digestKeyOf = (class, task, autonomy, requesting actor, argv0-or-payload-shape), NUL-escape-joined; requesting actor added to the signed-off tuple because it can only split a group, the safe direction. groupForDigest caps at 8, window is one dispatch cycle. Digest = every member's full prompt+payload first (buttonless, REQUEST i OF n), then ONE trailing message with numbered lines, per-member Approve/Reject rows, and an all-row rendered only while >=2 members are open. AC 2 verified end-to-end: an Approve-all tap through the real mock Bot API and real decision path appends exactly N approval.granted records, each naming one action key and binding its OWN payload hash, consecutive seqs, chain verify clean; a companion test proves an already-decided member refuses individually while the rest land. Safety decisions: the all-callback carries no action keys (the decided set is what the process knows is open); fallback to per-member messages is decided BEFORE anything sends; nonces arm only after the digest message exists; one redraw per gesture. Fable review fix: the digest-key separator was committed as a raw NUL byte, which made telegram.ts read as binary to grep and diff tooling; rewritten as the "\0" escape (same runtime string). Out of scope, noticed: listener digest/delivery maps are never pruned (pre-existing pattern, worth a task for week-long listeners); groupForDigest is channel-agnostic and would suit the web queue. Verified: 9 new channel tests, 2053 total at build, hook+telegram files re-verified standalone after the separator fix, lint clean, merged through the queue.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Bursts of same-shaped requests arrive as one digest with per-member and all-N buttons; an all-tap appends one individually-bound event per member through compare-and-append, the log never learns 'batch'. Verified end-to-end through the mock Bot API with chain verify, merged in PR #117.
<!-- SECTION:FINAL_SUMMARY:END -->
