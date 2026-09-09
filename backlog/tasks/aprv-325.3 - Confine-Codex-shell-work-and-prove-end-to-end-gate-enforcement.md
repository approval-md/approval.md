---
id: APRV-325.3
title: Confine Codex shell work and prove end-to-end gate enforcement
status: To Do
assignee: []
created_date: '2026-09-09 07:39'
updated_date: '2026-09-09 08:04'
labels: []
dependencies:
  - APRV-325.2
references:
  - docs/codex-boundary-probe.md
parent_task_id: APRV-325
priority: high
type: feature
ordinal: 245000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Provide practical shell and patch compatibility in the constrained Codex workflow. Shell runs in a disposable isolated workspace; only policy-bound changes can reach the canonical workspace. Verify the whole session before advertising mandatory enforcement.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Shell receives no canonical workspace or gate write authority, ambient credentials, external egress or mutable executor code; no opt-out or raw fallback exists.
- [ ] #2 Native write/patch tools and all alternate mutable app/browser/MCP capabilities are demonstrably constrained; managed configuration presence alone is insufficient evidence.
- [ ] #3 Denied or missing authority, crashes, disconnects, timeouts and replay cannot produce unauthorized canonical effects; one approved bound change produces exactly its permitted effect and a verifiable outcome.
- [ ] #4 Installed-package setup/start/doctor and activation/rollback instructions are tested on supported configurations, and unsupported hosts refuse rather than silently weakening enforcement.
<!-- AC:END -->
