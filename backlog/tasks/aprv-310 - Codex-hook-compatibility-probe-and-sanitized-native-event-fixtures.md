---
id: APRV-310
title: Codex hook compatibility probe and sanitized native event fixtures
status: In Progress
assignee:
  - '@codex-sol'
created_date: '2026-09-08 07:23'
updated_date: '2026-09-08 08:57'
labels: []
dependencies: []
references:
  - 'https://learn.chatgpt.com/docs/hooks'
priority: high
type: spike
ordinal: 228000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
User-authorized overnight Codex integration, isolated worktree only. Binding SPEC 6.3,7,9,10,11.1. Code/tests/GitHub now; everyday trust and phone decisions in morning.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Native CLI event fixtures and allow/deny, patch and success/nonzero outcomes are captured using harmless scratch effects.
- [ ] #2 Crash, timeout, malformed-output and uncovered-tool behavior are reported honestly; desktop and phone checks remain pending.
- [x] #3 No credentials or personal transcripts enter fixtures; repeatable probe and observed version are documented.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Read current contracts; run bounded scratch-only native probes; sanitize native fixtures; record failure boundaries; parent reviews before adapter implementation.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Synthetic probe harness tests pass (5/5; tsc and node --check exit 0). Native CLI invocation is pending primary gate action codex-overnight-aprv-310-native:probe, requested seq 29873; wait exit 6. No native process has run. Exact argv/payload at /private/tmp/aprv-310-native-payload.json; scratch /private/tmp/aprv-310-native-0.152.1. Invocation uses inline hooks, workspace-write, ephemeral, ignore-user-config, and no hook-trust bypass. APRV-311 independent infrastructure may proceed; native outcome interpretation remains pending.

Live evidence: v2 granted seq29877, approval run exited2 before model/tool invocation because --sandbox and --approve-for-me are mutually exclusive in CLI0.152.1. v3 corrected to --approve-for-me (workspace-write), granted and executed via approval run; CLI exit0, verifier exit1, event_count0. All scratch effects including denied marker occurred, but no hook ran: this is loading/configuration failure, not proof of ignored explicit denial. Output /private/tmp/aprv-310-native-0.152.1/native-cli-v3-output.txt. Read-only root-cause investigation underway; no live trust or everyday config changed.

Native v3 config loader positive check accepted exact inline hook arrays; negative PreToolUse=42 control failed config loading. No hook execution has been demonstrated. User clarification requested for a one-off reviewed scratch hook-trust exception; no trust bypass is authorized or executed yet. Probe remains pending. Script frozen SHA256 ce11e1c0e92cb8f484b928748ea35a7ffb6fd60e9ca677ba10f6d5bcd0057b6d; six synthetic harness tests pass (exit0), and fixtures are explicitly synthetic.

Sanitized probe tooling and documented CLI0.152.1 fixture boundary verified in final full suite (3920pass,1skip,exit0) and CI parity(exit0). Native CLI still invoked zero hooks; no trust exception was executed. AC1/2 remain pending and native outcomes must not be inferred.
<!-- SECTION:NOTES:END -->
