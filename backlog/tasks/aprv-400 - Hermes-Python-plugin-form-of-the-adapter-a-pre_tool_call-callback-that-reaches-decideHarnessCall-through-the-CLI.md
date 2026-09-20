---
id: APRV-400
title: >-
  Hermes Python plugin form of the adapter: a pre_tool_call callback that
  reaches decideHarnessCall through the CLI
status: To Do
assignee: []
created_date: '2026-09-20 09:03'
labels:
  - hermes
  - hook
dependencies: []
priority: low
ordinal: 309000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
APRV-398 shipped the SHELL hook form, which matches every other adapter and needs no new language. Hermes also exposes a Python plugin hook API: a package whose register(ctx) calls ctx.register_hook('pre_tool_call', callback), where the callback returns the same directive shapes. A plugin would avoid a process spawn per gated tool call, which is the one cost the shell form cannot remove, and it reaches hook events that shell hooks cannot (transform_api_error_classification is plugin-only). The rule it must not break: the plugin decides nothing itself. It reaches decideHarnessCall through the CLI, exactly as the shell hook does, because two implementations of the gate sequence would be two gates and the second one would be the one nobody reviewed. See docs/hermes-hook.md and the HarnessAdapter table in src/cli/hook.ts.
<!-- SECTION:DESCRIPTION:END -->
