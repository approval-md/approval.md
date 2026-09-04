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
updated_date: '2026-09-04 22:08'
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
- [x] #1 APPROVAL.md may declare channels.telegram.prompt (and channels.cli.prompt, channels.web.prompt) with rows/always/hide; the schema validates it and an unknown row name fails policy load with a machine-readable code
- [x] #2 With no prompt block, every channel renders byte-for-byte what it renders today (existing rendering tests unchanged)
- [x] #3 Rows that must not be hidden are documented and enforced: a policy that hides them fails to load
- [x] #4 Claimed lines stay under the CLAIMED heading regardless of ordering; a test pins it
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## Key shape

`channels.<name>.prompt` under `telegram`, `web` and the new `cli` block, three keys, each doing exactly one thing so a short list is never ambiguous:

```yaml
channels:
  telegram:
    prompt:
      rows:   [class, command_breakdown, task, waiting]   # ORDER ONLY
      always: [budgets, task, chain]                       # visibility UP
      hide:   [provenance, requested_ts]                   # visibility DOWN
```

`rows` is never a whitelist: named rows render in that order ahead of every row it does not name, which keep their default relative order behind them, so a `ChannelRequest` widened by a later task cannot lose a field to a list written before that field existed (the property `orderedFields` has held since APRV-23). `always` and `hide` naming one row is refused rather than resolved by precedence.

Row vocabulary = the `ChannelRequest` member names, closed (23): action_key, task, class, command_breakdown, protected_path, policy_diff, policy_load, autonomy, provenance, state, requested_ts, waiting, ttl_remaining_ms, payload_hash, attestation, budgets, chain, token_delivery, est_cost_usd, gloss, summary, rationale, confidence. `fullPayload` is deliberately absent: the canonical block is not a row.

## What a layout may not touch

Three things stay out of reach, and each for a different structural reason rather than by a check that could be forgotten:
1. The canonical block (SPEC §9) is not in the row vocabulary at all, so no key names it. It carries the payload bytes, the renderer version, the class, the kind and the bound `payload sha256` on every channel whatever the layout says.
2. The computed/claimed split is a property of `TaggedField.kind`, applied AFTER the ordering. `rows` decides the sequence rows are considered in; the partition happens downstream, so a claimed row reordered to the front is first among the CLAIMED lines and never above the computed heading. Pinned by the AC #4 test on Telegram and by the web case.
3. REQUIRED_PROMPT_ROWS = action_key, class, command_breakdown, protected_path, policy_diff, policy_load. Naming one in `hide` refuses at load. `payload_hash` is deliberately NOT required: the bound hash is stated inside the canonical block on every channel, so hiding the row removes a duplicate rather than the binding, which is exactly what Telegram already does by default (APRV-163).

The anomaly mark stays a statement about the VALUE, not about why a line is on the screen: a row forced on with `always` carries `!! ` only when the value is in fact abnormal.

## Fail directions

Soft on absence, closed on invalidity, the split every other policy key keeps. No `prompt` block, and a policy that did not load at all, both yield the layout the channel ships: a layout is not a permission, and an unrelated typo in a class rule must not silently redecorate a phone screen. Invalid content takes the WHOLE policy down to all-`manual` with five distinct machine-readable keywords: `prompt-row-unknown`, `prompt-row-required`, `prompt-row-conflict`, `prompt-key-unknown`, `prompt-block-shape`.

Two nets, deliberately. The JSON Schema closes the row enum on the three typed channels (the write boundary). The semantic pass in the policy loader covers every channel name, including the unknown ones the schema admits as free-form objects so a third-party transport does not fail a whole policy closed; a `prompt` block written under such a name would otherwise reach a renderer unchecked. Both return the same verdict, so an operator never has to know which caught them. A test pins the schema enum against `PROMPT_ROWS` so the two closed lists cannot drift.

## Global invariants touched (CLAUDE.md / SPEC §11)

- **Refusals are machine-readable and distinct.** Five new keywords added; each names one failure and nothing else, and each is asserted by name in the tests.
- **Fail closed / ambiguity resolves to the stricter path.** An unusable layout fails the policy, not the channel; `always` + `hide` on one row refuses rather than picking.
- **Self-reported fields never reduce scrutiny.** A layout is operator-authored policy, never agent input, and it cannot promote a claimed line out of the CLAIMED region or suppress a required row. Nothing an agent writes reaches this key.
- **Enforcement paths read only verified records** is untouched: no channel learns anything new about the log. Every row a layout can turn on already travelled on the `ChannelRequest` and was already visible in `--json`, `approval queue` and the web page; rendering stays a pure function of (request, layout).

## SPEC sentence draft (for the human to apply; agents do not edit the spec)

For §5.2, after the `channels.telegram.delivery` paragraph:

> `channels.<name>.prompt` declares which INFORMATIONAL rows that channel shows and in what order: `rows` orders (never whitelists), `always` raises a row that is conditional or off by default, `hide` removes one. Absent, the channel renders the rows it ships, so a policy written before this key renders exactly as it did. A layout chooses among rows the approver reads; it cannot reach what the approver signs. The canonical rendering of §9 is not a row, the buttons are not a row, and the computed/claimed boundary is a property of the field rather than of the layout, so ordering cannot move a claimed line into the computed region. The rows required for a decision (`action_key`, `class`, `command_breakdown`, `protected_path`, `policy_diff`, `policy_load`) may be reordered but not hidden. An unknown row name, a required row in `hide`, a row named by both `always` and `hide`, or an unknown key inside the block fails the whole policy closed to all-`manual` with a machine-readable keyword.

For §9, one clause where the canonical rendering is defined:

> The canonical block is not a row, and no `channels.<name>.prompt` key can reorder, shorten, or remove it.

No behaviour diverged from the spec as written; these are additions.

## Files

- `src/core/prompt-layout.ts` (new): row vocabulary, per-channel defaults reproducing today rendering exactly, `promptLayoutFor`, `applyPromptBlock`, `promptBlockErrors`. Pure, in `core/` because more than one layer asks which rows a policy wants and none of them may answer differently; imports nothing from `channels/`, so `tests/layering.test.ts` stays true.
- `schema/policy.schema.json`: `$defs.promptRow` / `promptRows` / `promptLayout`, wired into `channels.telegram`, `channels.web`, and a new `channels.cli` block (the terminal channel needed no credential and no port, so until now it had nothing to configure).
- `src/core/policy-load.ts`: the semantic pass, refusing `schema-invalid`.
- `src/channels/telegram.ts`: `renderTelegram(request, heading, layout)`; every row now built by one `telegramRow` case, including the eight APRV-143/163 dropped from the default.
- `src/channels/cli.ts`, `src/channels/web.ts`: `FIELD_ORDER` became the channel default layout; `orderedFields` consults it and still appends members it does not name.
- `src/cli/channel.ts`, `src/cli/channel-web.ts`, `src/cli/channel-telegram.ts`: the layout is resolved at the verb, off the same policy load the credential names and the TTL came from. The channels never read a policy file.
- `docs/cli-reference.md`: new subsection under `## channel`, with cross-references in the cli, web and telegram listen sections. Per-verb help texts are unchanged and still under the 25-line cap; the prose is one `--long` away, which is the APRV-91 contract.
- `README.md`: three rows in the policy key reference.

No new dependencies.
<!-- SECTION:NOTES:END -->
