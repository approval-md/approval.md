---
id: APRV-512
title: >-
  SEC-1: residents can install arbitrary Hermes plugins from the dashboard and approval.md does not gate them; plugin routes become admin-only and av-approval is re-enabled on every upgrade
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
ordinal: 390000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found Mon 12 Oct 2026 by the context seat (read-only research; evidence in the orchestration plan's findings/2026-10-12-hermes-plugin-installs.md). The Hermes dashboard's /plugins page (install, enable, disable, update, delete under /api/dashboard/agent-plugins/* and /api/dashboard/plugin-providers) is live behind a resident's ordinary dashboard login. Install clones any git URL, pip-installs its dependencies and loads the plugin into the running gateway at once; it persists across restarts, recreates and rc rolls. approval.md gates tool calls by a fixed list of about 35 names, so the install itself and any plugin tool with another name are ungated. A loaded plugin runs as `hermes` in the gateway and can read the box's secrets (including a fleet-wide key) and tamper with the hooks. Today a resident's Disable of av-approval also survives every upgrade.

Carter's ruling (12 Oct ~15:00Z): residents may not install plugins; admin only. PRIORITIES.md item 10. Owner: the approval seat (lane in agentvillage-wt/approval-sec1, dashboard-auth-edgecity 1.2.0); rides overlay rc34 (release seat); read-back by the verify seat. Prefer a closed allow-list of admin sessions (cp SSO exchange) over a deny-list of routes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 dashboard-auth-edgecity: every non-GET /api/dashboard/agent-plugins/* and /api/dashboard/plugin-providers request from a non-admin session answers 403, and the /plugins UI and its feeds are hidden for residents (closed allow-list of admin sessions); tests pin the 403 and the allow-list
- [ ] #2 Installer: av-approval is removed from plugins.disabled on every upgrade, so a resident's Disable never survives a roll; a test pins it
- [ ] #3 Until shipped: no plugin installs on resident boxes (Carter's own test agent only); the verify seat's fleet sweep reads each live box's plugins directory and config.yaml plugins.enabled/disabled (names only) and posts any box whose list is not exactly the bundled set
- [ ] #4 Rolled to the fleet in rc34 (or the next roll after it lands) and read back by the verify seat: a resident session gets 403 on install/enable/disable on one live box; av-approval enabled on every box after the roll
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-12 15:55: filed by float@b1 from BACKLOG.md SEC-1 and briefs/claude-approval.md (OPS-1 follow-up: the live SEC work had no task file). The approval seat's build lane was dispatched 15:14Z (CLAIMS 'SEC-1 LANE DISPATCHED').
<!-- SECTION:NOTES:END -->
