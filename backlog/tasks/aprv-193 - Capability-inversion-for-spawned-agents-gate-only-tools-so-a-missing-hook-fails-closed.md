---
id: APRV-193
title: >-
  Starve the code: egress-sandboxed allowed exec and credential custody, so
  laundered side effects fail closed
status: To Do
assignee: []
created_date: '2026-09-01 03:21'
updated_date: '2026-09-01 03:55'
labels:
  - security
  - dogfood
  - design
dependencies: []
priority: high
ordinal: 163000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Reframed after discussion with Carter (2026-09-01). Arbitrary code execution is capability-complete: gate the communicate.email.external verb and an agent can reimplement it in code, so a gate on named actions with ungated exec underneath is advisory. The direct route is already chokepointed (the hook classifies shell commands and fails closed on unknowns), and APRV-151/192 cover the hook-absent session. The remaining hole is laundered exec: allowed commands that run mutable project code (npm test, node/tsx scripts inside the repo) execute whatever the agent just wrote, and the command name no longer describes its effect. No command classifier can close that.

The fix is to starve the code, and to leave editing alone. Editing stays free: a file that never runs sends nothing, and gate-routed editing would push bulk coding actions through the transparency log (a database problem the log should not inherit). Exec stays classified as today. What changes: (1) allowed-class exec runs inside an OS-level sandbox whose outbound network is denied except loopback to the gate daemon (macOS sandbox-exec/seatbelt; Claude Code sandboxed-bash where available), so laundered code executes into a room with no doors; (2) credential custody stays absolute (vault secrets sealed, released only via approval run) so authenticated effects are impossible without a grant regardless of network; (3) approval run, executing post-grant outside the sandbox, remains the only door to the world. The APPROVAL.md contract is then enforced by capability, and a missing hook means no egress instead of free egress.

Deliverables: the sandbox profile and spawn wiring for dev-fleet agent sessions, a laundering demonstration (an allowed command attempting SMTP/webhook egress, blocked), measurement of what legitimate allowed exec breaks (test suites needing localhost, package installs) with documented carve-outs, and drafted SPEC/CLAUDE.md amendment text for human sign-off (protected: the agent does not apply it). Original rung-4 framing (gate-only MCP tools replacing built-in editors) is recorded here as considered and rejected for the dev fleet: right polarity, wrong layer, real ergonomic cost. It remains the correct posture for audience-facing runners (the web-agent demo already does it).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A sandbox profile denies outbound network for allowed-class exec (loopback to the gate daemon excepted), wired into how dev-fleet agent sessions run commands; profile and wiring committed
- [ ] #2 Laundering demo: an allowed command (npm test or node script) attempting an SMTP send and a webhook POST is blocked by the sandbox, shown in a test or recorded transcript
- [ ] #3 Credential-starvation confirmed: the same laundered code cannot read vault material or .approval/env from an agent session, tested
- [ ] #4 Legitimate-exec survey: what allowed commands need network (installs, localhost test servers), each with a carve-out or a documented refusal
- [ ] #5 SPEC and CLAUDE.md amendment text drafted for human sign-off, not applied
- [ ] #6 npm test passes; lint clean
<!-- AC:END -->
