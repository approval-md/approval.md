---
id: APRV-193
title: >-
  Capability inversion for spawned agents: gate-only tools, so a missing hook
  fails closed
status: To Do
assignee: []
created_date: '2026-09-01 03:21'
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
The APRV-151 root cause showed the hook's polarity is wrong for spawned sessions: the session holds ambient capability (built-in Edit/Write/Bash) and the hook is a veto that must show up to say no, so a harness that never invokes it fails OPEN with no trace. The demo already has the right architecture (examples/web-agent-demo/server.mjs agentArgv: --allowedTools mcp__approval__* plus --disallowedTools Bash,Edit,Write,WebFetch,WebSearch): the agent's only door to the world is the gate's MCP server and approval run with a granted token, so a missing gate means no capability at all - absence fails CLOSED. This task designs and lands the same posture for the repo's own dev fleet (orchestrator-spawned subagents first, whole sessions after): spawn configuration that disables or scopes built-in side-effect tools for agent worktree sessions, routing writes/exec through gate-mediated tools; decide what read-only built-ins remain; decide how the orchestrator verifies the spawn config it passed (the config is verifiable at spawn time, unlike hook invocation); measure the workflow cost on real tasks before mandating. Changes the dogfood posture, so SPEC needs a section and CLAUDE.md dogfooding prose an amendment - both are protected: this task produces the proposal text and the mechanism; the human lands the policy. Rung 4 of the APRV-151 defense ladder; complements APRV-192 (detective) and the APRV-151 CI guard (diff backstop).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A written design (in the task or docs/proposals) for gate-only tool configuration of spawned dev-fleet agents, including what remains allowed, how exec and file writes route through the gate, and how the orchestrator attests the config it spawned with
- [ ] #2 A working spawn profile proven on a real coding task in an agent worktree: the agent completes the task with built-in side-effect tools disabled, or the friction is measured and documented as the reason not to mandate it
- [ ] #3 A protected-path edit attempted under the profile is impossible or gate-routed, demonstrated
- [ ] #4 SPEC and CLAUDE.md amendment text drafted for human sign-off (not applied by the agent)
- [ ] #5 npm test passes; lint clean
<!-- AC:END -->
