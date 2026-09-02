---
id: APRV-242
title: >-
  Agent SDK hook recipe: `approval hook claude-code` from a Python HookMatcher
  callback, with JSON-shape conformance tests
status: To Do
assignee: []
created_date: '2026-09-02 20:55'
labels:
  - enhancement
dependencies: []
references:
  - docs/integrations-considered.md
  - docs/claude-code-hook.md
  - >-
    https://github.com/anthropics/commerce-agents/blob/main/merchant-agent/runtime-agent-sdk/merchant_agent_sdk/agent.py
priority: medium
ordinal: 193000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
M8 gates Claude Code (approval hook claude-code) and Cursor (approval hook cursor), but an application built on claude-agent-sdk is neither: the reference commerce-agents blueprint (github.com/anthropics/commerce-agents, assessed 2026-09-02 in docs/integrations-considered.md) runs permission_mode="dontAsk" with a tool allow-list and no PreToolUse hook, which is the "harness enforces locally, no record" pattern SPEC §2 critiques. The Python Agent SDK exposes hooks as async callables (HookMatcher) that receive the same PreToolUse input the Claude Code hook reads on stdin and return a hookSpecificOutput permission decision. A documented shim, spawning `approval hook claude-code --dir <primary> --as agent:<id>` with json.dumps(input_data) on stdin and mapping its verdict to the SDK return shape, makes every Agent SDK app gateable with no new surface and no Python client. The shapes must be verified against the SDK, not assumed; where they differ the recipe says so and a fixture pins both.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 docs/claude-code-hook.md (or a sibling doc it links) carries a Python recipe: a HookMatcher callback that runs `approval hook claude-code` and returns the SDK permission decision, with fail-closed behavior when the hook process cannot be reached
- [ ] #2 A fixture pins the PreToolUse input shape the Python Agent SDK passes to a hook callback and the hookSpecificOutput shape it expects back, and a test asserts the hook output maps onto it (allow, deny with reason)
- [ ] #3 SPEC §14 M8 sentence lists Agent SDK apps as reachable through the Claude Code hook surface, marked as an amendment for human sign-off
<!-- AC:END -->
