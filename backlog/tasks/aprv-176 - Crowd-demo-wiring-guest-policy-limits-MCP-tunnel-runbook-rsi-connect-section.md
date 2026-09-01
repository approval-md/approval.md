---
id: APRV-176
title: >-
  Crowd demo wiring: guest policy limits, MCP tunnel runbook, rsi connect
  section
status: To Do
assignee: []
created_date: '2026-08-31 01:19'
labels:
  - demo
dependencies:
  - APRV-173
  - APRV-174
  - APRV-175
ordinal: 155000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Final assembly of the crowd-MCP track. Demo policy declares the now-enforced intake limits: requests_per_hour: 3 on the guest-reachable classes and budgets.global.max_pending: 10 (the tripwire firing on stage is the pitch: these limits protect the human's attention, and the audience watches them refuse). Runbook gains the guest section: second quick tunnel for the MCP port, URL published only when the demo starts and rotated after, session/lifetime caps stated, flood management (digest coalescing; a flood-clear of rejections is not a considered denial). HARD REQUIREMENT stated as a MUST: the guest instance runs in a throwaway directory with an EMPTY vault and no email adapter configured, so even a verb-filter bug has nothing to spend. rsi/index.html's connect-your-agent section activates: paste box for the MCP URL plus the claude mcp add one-liner for attendees. Defaults settled by Carter: wait clamp 5s, 20 sessions, guests can see the shared queue (mild info leak accepted as demo theater).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Demo policy with the declared limits passes policy check and the limits are observed refusing in a rehearsal (queue-full or rate-limited fires at least once)
- [ ] #2 Runbook guest section covers tunnel, URL rotation, caps, flood management, and the empty-vault MUST
- [ ] #3 One full rehearsal: a real external MCP client (another machine) connects, files a request, the phone decides, the rsi page shows it live
<!-- AC:END -->
