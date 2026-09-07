---
id: APRV-294
title: >-
  Hook denies hook-io when its own just-appended requests are not yet in the
  verified view
status: To Do
assignee: []
created_date: '2026-09-07 02:41'
labels:
  - hook
  - daemon
dependencies: []
priority: high
ordinal: 218000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
2026-09-07 02:00Z, minutes after approval log sync replaced the committed baseline and the daemon restarted: a hook call appended its requests, re-read the verified log, found every key in state none, and denied at once with hook-io 'the verified log does not show every request as granted (states: none, none, none)' (src/cli/hook.ts around line 2097). The requests were real and later showed on the phone; the verified view the hook read (verified-head.json, seq 26931 at 01:58:07) did not yet include them. A second call in the same minute took the bypass path on a stale 'window open' reading and was refused gate-not-open by the append, which re-derived the window from a fresher read. Both are the same fault: the hook decides from one read and acts on another. The immediate deny also counts as a failed side-effecting call for the loop-escalation floor (APRV-287).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 After appending its requests the hook treats state none for its own keys as 'not yet verified' and keeps waiting (bounded by the hook timeout), never as a terminal hook-io; a test appends requests, serves a verified view that lags them, and asserts the hook waits then allows on the grant
- [ ] #2 The window decision and the bypass append read the same records: a window that closed between the two refuses with a distinct code that names the closing seq, and the refusal is not counted as a failed side-effecting call
- [ ] #3 docs/claude-code-hook.md explains the verified-view lag after a sync or daemon restart and what the hook does about it; CHANGELOG entry
<!-- AC:END -->
