---
id: APRV-244
title: >-
  Integrations register: Grok Build (parked) and Grok Bot (adopted as the
  connector demo) entries
status: Done
assignee:
  - '@claude'
created_date: '2026-09-02 21:15'
updated_date: '2026-09-05 02:02'
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
- [x] #1 docs/integrations-considered.md gains a Grok Build entry (parked, 2026-09-02) with the five headings, the verified hook contract quoted from docs.x.ai, the classifier table, and APRV-243 as next step
- [x] #2 docs/integrations-considered.md gains a Grok Bot entry (declined, 2026-09-02) naming the sources as third-party and the reactivation condition (an official approval API or channel)
- [x] #3 The summary table has both rows
- [x] #4 The light check tier (docs guard) passes
- [ ] #5 docs/integrations-considered.md gains a Grok Build entry (parked, 2026-09-02) with the five headings, the verified hook contract quoted from docs.x.ai, the classifier table, and APRV-243 as next step
- [ ] #6 docs/integrations-considered.md gains a Grok Bot entry (adopted as demo, 2026-09-02) with the connector surface, the three-tier table, and APRV-245/246 as next steps
- [ ] #7 The summary table has both rows
- [ ] #8 The light check tier (docs guard) passes
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Grok Build verified against docs.x.ai/build/features/hooks on 2026-09-02 (camelCase envelope, exit 2 deny, fail-open on timeout with no setting, Claude/Cursor hook files read for compatibility); classifier run on the installer (opaque), npm install -g (deps.add), grok, grok -p and grok mcp add (unclassified). Grok Bot first drafted as declined; revised to adopted (demo) when its MCP custom-connector surface was found, which is the client half of approval mcp serve --http --guest. The three tiers (prevented by custody, witnessed, not covered) are the register's framing and the demo's. Merge with main kept the commerce-agents entry (APRV-241) beside these. Verified: docs guard passes in the full tier (3208 pass on the merged tree).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
docs/integrations-considered.md gains Grok Build (parked on the APRV-243 probe, hook contract quoted, classifier table) and Grok Bot (adopted as the connector demo, three tiers, pointers APRV-245/246); summary rows added; verified by the docs guard inside the full check tier.
<!-- SECTION:FINAL_SUMMARY:END -->
