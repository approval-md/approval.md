---
id: APRV-399
title: >-
  Agent Village Hermes skill: install the approval.md hook per tenant, pointed
  at the hosted daemon
status: To Do
assignee: []
created_date: '2026-09-20 09:03'
labels:
  - hermes
  - agent-village
dependencies: []
priority: medium
ordinal: 308000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Agent Village v2 runs every resident agent on Hermes Agent in a Railway sandbox, one tenant each, and its design document (share.carter.md/8z43LqvaXMNSG6daneeFrh) names an optional approval.md Hermes skill as the Sprint 3 deliverable. APRV-398 shipped the adapter this would install; the skill itself is the part this repo does not own yet. It writes the hooks block into the tenant HERMES_HOME, sets the headless consent (hooks_auto_accept or HERMES_ACCEPT_HOOKS, without which Hermes silently never registers the hook and the tenant runs ungated while looking gated), sets fail_closed on every entry, raises plugins.hook_callback_timeout and keeps the wait under the 300s per-entry cap. Blocked on APRV-383: a sandboxed tenant has no local log and no local policy, so the hook has nowhere to write and nothing to read until the hosted daemon is reachable. See docs/hermes-hook.md, section For Agent Village.
<!-- SECTION:DESCRIPTION:END -->
