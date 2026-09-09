---
id: APRV-315
title: Codex hook morning trust activation and Telegram verification
status: To Do
assignee: []
created_date: '2026-09-08 07:25'
updated_date: '2026-09-09 07:11'
labels: []
dependencies:
  - APRV-314
priority: high
type: task
ordinal: 233000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
User-authorized overnight Codex integration. SPEC 6.3,7,9,10,11.1 bind. Isolated code/tests/delivery now; everyday activation and human decisions only in morning. No deployment, credentials, dependencies or production policy/log mutation.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Carter reviews/trusts intended Codex hooks with rollback available.
- [ ] #2 Closed-gate Telegram rejection prevents harmless effect, approval permits it once.
- [ ] #3 Outcome log verifies and desktop coverage is observed; configuration alone is not completion.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
2026-09-09 authorized resumption: first diagnose the existing daemon/Telegram service with sanitized read-only status. Do not start a second poller or read credentials. Prepare a harmless primary-gate manual test and observe delivery, human rejection with absent effect, human approval with one effect and verified outcome once the channel is healthy. This transport proof does not satisfy native Codex enforcement: APRV-325 researches a constrained mandatory executor separately, and existing 0.152.1 native activation remains blocked.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Resumed native probes establish a new activation blocker on Codex CLI 0.152.1: Bash hides effective per-call workdir, so the safe adapter must refuse every matched shell pre-event, including shell-dispatched patches. Direct apply_patch is the bounded experimental candidate; post outcomes remain diagnostic and native crashes/timeouts/malformed output fail open. Do not treat the morning phone test or hook trust as sufficient to enable normal Codex use. Revisit activation only after a verified effective-execution-directory contract or an explicitly agreed narrower workflow. No everyday installation/trust/configuration was performed.

Carter explicitly asked to prove phone delivery and verifiable Codex enforcement after the audit found no installed approval.md Codex hook and pending requests 30107–30109 with no transport witness. Telegram delivery is currently unknown; do not treat log intake as a sent message. Existing native activation criteria remain unchecked.

2026-09-09 read-only runtime diagnosis: no approval launchd service is loaded. A manually attached Node process PID 38697 owns the primary draw socket and an established TLS connection consistent with Telegram polling, but the sanitized daemon query returns draw-daemon-stale. Its checkout is 78baf522, behind reviewed main d42cd34. Requests 30107-30109 remain pending without delivery or callback evidence. Do not launch a second poller. Next live operation is a controlled replacement of the existing foreground runtime using a current reviewed build and primary policy/log, followed by phone confirmation. Preserve dirty primary release work; no process was stopped or started during diagnosis.
<!-- SECTION:NOTES:END -->
