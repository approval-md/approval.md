---
id: APRV-218
title: >-
  Channel prompt layout is policy-configurable: which rows a Telegram/CLI/web
  prompt shows (TTL, budget, task, state, cost, chain) per channel in
  APPROVAL.md
status: In Progress
assignee:
  - 'agent:opus-lane-m'
created_date: '2026-09-02 16:14'
updated_date: '2026-09-04 21:16'
labels:
  - channels
  - telegram
  - policy
dependencies: []
references:
  - APRV-143
  - APRV-163
  - APRV-106
  - APRV-144
  - APRV-22
priority: medium
type: enhancement
ordinal: 180000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Today the Telegram prompt layout is fixed in code (src/channels/telegram.ts rendering section): APRV-143 removed the ttl row (the 'waiting … expires HH:MM UTC' line carries it), APRV-163 removed resolved-by, payload sha256, requested, chain, task and state rows and made autonomy/budgets/attestation render only when abnormal, APRV-144 labels the model gloss as claimed. Every dropped field still travels on the ChannelRequest, so --json, approval queue and the web page carry it; only the phone rendering is slimmed. That slimmed view fits Carter's workflow; other operators will want the budget line always, or the TTL as a duration, or the task id on every prompt. Make the row set per channel a policy decision: a channels.<name>.prompt block in APPROVAL.md (proposed: rows: [list of row names in order], always: [rows that render even when normal, e.g. budgets], hide: [rows never rendered]) validated by the policy schema, with today's layout as the default when the block is absent, so existing policies render exactly as now. The CLI and web channels read the same block under their own channel name. Rows a channel may not hide: whatever the contract marks as required for a decision (the class, the command/payload block, the buttons, and the CLAIMED/verified separation of APRV-144; an operator may reorder but never blur claimed vs computed). Unknown row names refuse at policy load (fail closed, like every other policy key). Rendering stays a pure function of (request, layout): no channel learns anything new about the log.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 APPROVAL.md may declare channels.telegram.prompt (and channels.cli.prompt, channels.web.prompt) with rows/always/hide; the schema validates it and an unknown row name fails policy load with a machine-readable code
- [ ] #2 With no prompt block, every channel renders byte-for-byte what it renders today (existing rendering tests unchanged)
- [ ] #3 Rows that must not be hidden are documented and enforced: a policy that hides them fails to load
- [ ] #4 Claimed lines stay under the CLAIMED heading regardless of ordering; a test pins it
- [ ] #5 Tests cover each channel with a custom layout through the mock bot / CLI renderer / web page; docs/cli-reference.md and the policy reference document the block; npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. New core module src/core/prompt-layout.ts: closed row vocabulary (the ChannelRequest member names), per-channel default layouts (order + per-row visibility always|abnormal|off) reproducing today's rendering exactly, REQUIRED_PROMPT_ROWS (action_key, class, command_breakdown, protected_path, policy_diff, policy_load), and promptLayoutFor(load, channel) resolving channels.<name>.prompt {rows, always, hide} over the default. Fail soft when the key or the load is absent.
2. schema/policy.schema.json: channels.telegram.prompt, channels.web.prompt, new channels.cli block with prompt. rows/always/hide are arrays of a closed row-name enum, uniqueItems. Unknown row name fails schema validation, which fails the whole policy closed to all-manual.
3. src/core/policy-load.ts: a post-schema semantic pass over every channels.<name>.prompt (including untyped channel names the schema leaves free-form), refusing schema-invalid with machine-readable ValidationError keywords prompt-row-unknown and prompt-row-required.
4. src/channels/telegram.ts: renderTelegram builds a candidate row per vocabulary name (including the rows APRV-143/163 dropped: task, state, provenance, requested_ts, ttl_remaining_ms, payload_hash, chain, token_delivery) and emits them in layout order under layout visibility. The anomaly mark stays a function of the value being abnormal, not of why the row rendered. Computed/claimed split still comes from the TaggedField kind, so ordering cannot move a claimed line into the computed block.
5. src/channels/cli.ts and src/channels/web.ts: FIELD_ORDER becomes the channel's default layout order; orderedFields consults the layout, still appending members the layout does not name.
6. Wire the layout in: CliChannel/WebChannel/TelegramChannel take an optional layout, resolved from the policy load by cli/channel.ts, cli/channel-web.ts and cli/channel-telegram.ts.
7. Tests: policy-load cases (unknown row, required row hidden, absent block, valid block), a prompt-layout unit suite, and per-channel custom-layout tests through the mock bot / CLI renderer / web page, plus the AC4 pin that a reordered claimed row stays under the CLAIMED heading.
8. Docs: docs/cli-reference.md channel sections and the policy reference. SPEC sentence drafted into the notes.
<!-- SECTION:PLAN:END -->
