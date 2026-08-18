---
id: APRV-82
title: >-
  Claude Code PreToolUse hook: route harness Bash commands through the gate
  (approval hook claude-code)
status: To Do
assignee: []
created_date: '2026-08-18 11:00'
updated_date: '2026-08-18 11:29'
labels:
  - cli
  - dogfood
milestone: m-11
dependencies:
  - APRV-85
references:
  - SPEC.md
  - docs/dogfood-cutover.md
  - 'https://code.claude.com/docs/en/hooks'
priority: high
type: feature
ordinal: 81000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Today the runtime only gates what is executed via 'approval run'. Shell commands the Claude Code harness runs directly (git push, gh pr create, npm install, curl) bypass APPROVAL.md entirely, so enforcement of vcs.push.*, network.call, deps.add and release.publish in this repo is still social prose in CLAUDE.md, the exact AGENTS.md failure SPEC §2 critiques. Two consecutive sessions (APRV-81 and its PR) got the rule wrong from prose alone. Add a Claude Code PreToolUse hook adapter so the harness cannot run a gated command without a gate verdict.

Intended slot: M8, alongside the MCP wrapper (both expose the gate to a harness). SPEC §13's Rust fast-path stays post-v1 as the latency accelerator; this task is the TypeScript reference.

Scope: (1) new verb 'approval hook claude-code' that reads the PreToolUse JSON on stdin (tool_name, tool_input.command), classifies the command into an action class via a small deterministic table (regex -> class, e.g. 'git push origin main' -> vcs.push.main, 'git push' -> vcs.push.branch, 'gh pr create' / 'curl' / 'wget' -> network.call, 'npm install <pkg>' -> deps.add, 'npm publish' / 'npm version' / 'git tag' -> release.publish, force-push or rebase onto a shared branch -> vcs.history.rewrite), fails closed (unclassified non-allowlisted commands -> defaults.autonomy), resolves the class against the primary checkout's attested policy, and for autonomous returns allow, for supervised/manual runs approval request + wait and returns allow only on a granted decision, otherwise deny with a machine-readable reason (SPEC §11 refusals). (2) Hook output follows Claude Code's PreToolUse decision JSON (permissionDecision allow/deny with reason). (3) A documented .claude/settings.json hooks entry the human commits (policy.edit class; agents do not write it). (4) Non-Bash tools pass through unchanged.

Constraints: classifier is pure and exhaustively tested; every gate write goes through the existing request/wait/compare-and-append path, no new log writer; the hook never reads self-reported fields to reduce scrutiny; when the daemon or channel is unreachable the hook denies (fail closed) rather than falling back to ask.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval hook claude-code reads PreToolUse stdin JSON and prints a valid Claude Code hook decision JSON for Bash tool calls; non-Bash tool calls print an allow pass-through
- [ ] #2 Command classifier is a pure function with a fixture table covering vcs.push.branch, vcs.push.main, vcs.history.rewrite, network.call, deps.add, release.publish, read.* and an unclassified case that resolves to defaults.autonomy
- [ ] #3 autonomous classes return allow without touching the log; supervised/manual classes create a request through the existing gate path and return allow only after a granted decision, deny otherwise, with a machine-readable refusal code
- [ ] #4 Daemon/channel unreachable or wait timeout returns deny, never ask or allow
- [ ] #5 docs/ documents the .claude/settings.json hooks entry and states that the human commits it (policy.edit)
- [ ] #6 SPEC §14 names the harness hook as v1 with the Rust engine as its post-v1 accelerator; edit called out to the human
- [ ] #7 npm test and lint pass; dogfood test confirms every class in the repo's own APPROVAL.md is reachable from the classifier table
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Assigned to M8 at decomposition (2026-08-18) per its stated intended slot: the MCP wrapper (APRV-87) and this hook are the two harness-facing surfaces, and both should derive their verb knowledge from the APRV-85 instructions/schemas registry where they overlap (the class table here is its own thing; the request/wait semantics are shared). Sequenced after 85 and in parallel with 86/87: it does not need the SDK. It closes the gap that produced APRV-50 and that APRV-81 tripped again from prose alone.
<!-- SECTION:NOTES:END -->
