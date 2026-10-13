---
id: APRV-514
title: >-
  SEC-3: plugin installs are invisible to events; emit plugin.installed and plugin.enabled and consider failing closed when config.yaml enables a plugin that is neither bundled nor ours
status: In Progress
assignee:
  - '@claude-approval'
created_date: '2026-10-12 15:55'
updated_date: '2026-10-12 15:55'
labels:
  - agent-village
  - security
dependencies: []
priority: high
ordinal: 392000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Same finding as SEC-1: av-events records an unknown plugin tool only as category `other` with a null name, so a plugin install or enable on a resident box leaves no trace in the research or ops data. After SEC-1 (admin-only installs) the remaining gap is observability and a fail-closed default: emit a plugin.installed / plugin.enabled event (names only) when the plugin set changes, and consider refusing to start the gateway when config.yaml enables a plugin that is neither bundled nor one of ours.

Owner: the approval seat, after SEC-1 and SEC-2 (briefs/claude-approval.md item 4); the event types are registered at the data repo's door by the data seat.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Event types plugin.installed@1 and plugin.enabled@1 (plugin name, source kind, who enabled it; no values) are registered at the ingest door and documented in the data repo's catalogue
- [ ] #2 av-events emits them when the plugin set or plugins.enabled/disabled changes, including on an rc roll; a test pins one install and one enable
- [ ] #3 Decision recorded here on failing closed for an unknown plugin in config.yaml (refuse the gateway start, or alert only), with Carter's word and the date
- [ ] #4 Read-back by the verify seat on one live box after the roll that carries it
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-12 15:55: filed by float@b1 from BACKLOG.md SEC-3 and briefs/claude-approval.md item 4 (OPS-1 follow-up).
<!-- SECTION:NOTES:END -->
