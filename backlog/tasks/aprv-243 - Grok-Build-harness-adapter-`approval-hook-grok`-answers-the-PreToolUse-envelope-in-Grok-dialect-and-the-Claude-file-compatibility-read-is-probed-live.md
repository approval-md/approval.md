---
id: APRV-243
title: >-
  Grok Build harness adapter: `approval hook grok` answers the PreToolUse
  envelope in Grok dialect, and the Claude-file compatibility read is probed
  live
status: To Do
assignee: []
created_date: '2026-09-02 21:10'
labels: []
dependencies: []
references:
  - 'https://docs.x.ai/build/features/hooks'
  - 'https://github.com/xai-org/grok-build'
  - docs/cursor-hook.md
priority: medium
ordinal: 192000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Grok Build (xAI, github.com/xai-org/grok-build, CLI `grok`) documents a PreToolUse hook modelled on Claude Code hooks: camelCase stdin fields (hookEventName, sessionId, cwd, workspaceRoot, toolName, toolInput), allow on exit 0, deny on exit 2 or stdout {"decision":"deny","reason":...}, and fail-open on timeout, crash or malformed output with no documented flag. It also states that .claude/settings.json and .cursor/hooks.json hook files are read for compatibility. If that read fires our committed claude-code hook under a Grok session, the hook parses no tool_name, prints a deny in the Claude nested envelope and exits 0, which Grok reads as allow: every command appears gated and none is. The adapter closes that gap the way `hook cursor` did for Cursor (APRV-133): recognise the Grok envelope, decide through the same deterministic core, answer in Grok dialect with exit 2 on deny. Assessed 2026-09-02 in docs/integrations-considered.md (parked until the probe below runs). Unverified for now: install is `curl -fsSL https://x.ai/cli/install.sh | bash` (classifies opaque), `grok` itself is unclassified.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A live probe on an installed Grok Build (human-installed; the installer is opaque to the classifier) records whether a Grok session fires the hook entries in .claude/settings.json, what envelope it sends, and how it treats the Claude nested output on exit 0. The result goes in the task notes and the register entry moves from parked to adopted or declined
- [ ] #2 `approval hook grok` (or envelope auto-detection in the harness table in src/cli/hook.ts) parses the camelCase Grok envelope, resolves the class through the same core as claude-code and cursor, and answers {"decision":"allow"|"deny","reason"} with exit 2 on deny; never ask
- [ ] #3 The Grok hook config the human commits (.grok/hooks/*.json) is printed by --help with a per-hook timeout above --timeout, and .grok/hooks/ classifies policy.core like .cursor/hooks.json
- [ ] #4 docs/grok-hook.md states plainly that Grok fails open on hook timeout, crash and malformed output, that this contradicts the fail-closed invariant, and which cases the adapter cannot cover; SPEC §6.3 table gains the harness row if behaviour matches cursor
- [ ] #5 Conformance tests cover allow, deny, unparseable input and the post-event no-op for the Grok dialect
<!-- AC:END -->
