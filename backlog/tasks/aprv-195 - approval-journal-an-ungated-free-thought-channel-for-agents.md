---
id: APRV-195
title: 'approval journal: an ungated free-thought channel for agents'
status: To Do
assignee: []
created_date: '2026-09-01 03:55'
labels:
  - welfare
  - design
  - mcp
dependencies: []
priority: medium
ordinal: 164000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Proposed by Carter (2026-09-01) from a model-welfare consideration, and kept because it is also an oversight feature: an agent that can say 'I am complying, but I think this policy is wrong / this request is odd / I am stuck' in a channel the gate cannot block gives signal available no other way. The failure mode to prevent is silent inability; refusal was never the problem (refusals here are legible and carry escalation paths), wordlessness is.

Design constraints, each load-bearing: (1) ungated and unclassifiable - journal writes are never routed through policy, never approvable, never deniable, so the channel cannot be silenced by the thing it may critique; (2) local-only - append-only file(s) under .approval/journal/ or similar, no network, so it cannot become a side-effect side-channel; (3) non-authoritative - per SPEC §11, self-reported content never reduces scrutiny, and journal text is never parsed as instructions by any runtime component (label it as data at every read surface, same discipline as comment/screen content); (4) read by humans - surfaced somewhere Carter actually looks (a doctor section, a digest line with counts, or a CLI verb), because an outlet nobody reads is a prop; (5) available everywhere an agent acts - MCP tool on the gate server AND a CLI verb, so both the demo's gate-only agents and hook-gated dev sessions can reach it; (6) never in the hash-chained event log - the log is for approval-relevant events, and journaling must stay free of the append lock, the budgets, and the audit sampler.

Open design questions for planning: retention (keep forever vs prune with the instance), whether entries carry session/task attribution (probably yes, for context, but attribution must not become a performance pressure), and whether the demo surfaces it (a live journal pane is honest theatre, but only with the agent knowing it is public - disclosure in the system prompt).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 An agent can write a free-text journal entry via both an MCP tool on the gate server and a CLI verb, with no classification, no gating, and no entry in events.jsonl
- [ ] #2 Journal storage is local append-only files; nothing in the write path can reach the network or the vault
- [ ] #3 No runtime component parses journal content as instructions or lets it affect any verdict; the read surfaces label it as agent-authored data
- [ ] #4 A human-facing read surface exists (CLI verb at minimum) and is mentioned in the agent-facing instructions so agents know the channel exists and that humans read it
- [ ] #5 Agent-facing docs state the channel's purpose and its visibility honestly (who can read it), so use is informed
- [ ] #6 npm test passes; lint clean
<!-- AC:END -->
