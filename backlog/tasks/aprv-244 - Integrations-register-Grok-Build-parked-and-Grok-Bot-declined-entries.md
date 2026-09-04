---
id: APRV-244
title: >-
  Integrations register: Grok Build (parked) and Grok Bot (adopted as the
  connector demo) entries
status: In Progress
assignee:
  - '@claude'
created_date: '2026-09-02 21:15'
updated_date: '2026-09-04 21:12'
labels: []
dependencies: []
references:
  - 'https://docs.x.ai/build/features/hooks'
  - docs/integrations-considered.md
priority: medium
ordinal: 193000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter asked on 2026-09-02 whether approval.md should build a pre-launch adapter or integration for "grok bot". Two products answer to that name. Grok Build is the xAI coding-agent harness with a documented PreToolUse hook, a Claude/Cursor hook-file compatibility read, and fail-open failure semantics; it is parked pending a live probe and the adapter task APRV-243. Grok Bot is the separate xAI agent product; its one surface is MCP custom connectors (name, server URL, one header), which is the client half of `approval mcp serve --http --guest`. It is adopted as the connector demo: APRV-245 (`approval coverage`, the observed-effects witness) and APRV-246 (the runbook), with three tiers stated plainly: prevented by custody, witnessed by a log we do not write, not covered (credentials pasted into Grok Bot itself). This task records both in docs/integrations-considered.md per its "How to add an entry" section.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 docs/integrations-considered.md gains a Grok Build entry (parked, 2026-09-02) with the five headings, the verified hook contract quoted from docs.x.ai, the classifier table, and APRV-243 as next step
- [ ] #2 docs/integrations-considered.md gains a Grok Bot entry (declined, 2026-09-02) naming the sources as third-party and the reactivation condition (an official approval API or channel)
- [ ] #3 The summary table has both rows
- [ ] #4 The light check tier (docs guard) passes
- [ ] #5 docs/integrations-considered.md gains a Grok Build entry (parked, 2026-09-02) with the five headings, the verified hook contract quoted from docs.x.ai, the classifier table, and APRV-243 as next step
- [ ] #6 docs/integrations-considered.md gains a Grok Bot entry (adopted as demo, 2026-09-02) with the connector surface, the three-tier table, and APRV-245/246 as next steps
- [ ] #7 The summary table has both rows
- [ ] #8 The light check tier (docs guard) passes
<!-- AC:END -->
