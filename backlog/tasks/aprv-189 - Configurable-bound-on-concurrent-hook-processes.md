---
id: APRV-189
title: Configurable bound on concurrent hook processes
status: To Do
assignee: []
created_date: '2026-09-01 03:14'
labels: []
dependencies: []
references:
  - docs/postmortem-2026-08-31-hook-cpu.md
priority: medium
type: enhancement
ordinal: 164000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Nothing caps how many 'approval hook claude-code' processes run at once. Claude Code spawns one per Bash/Edit/Write tool call, each with a long wait (repo config: --timeout 9m), and manual-class hooks hold their process (cheaply, sleeping on Atomics.wait) until a decision or timeout. A rogue or runaway agent with fan-out subagents can therefore pile up many concurrent hooks; even when each is near-0% CPU while waiting, this is unbounded process/fd pressure, and combined with the O(log length) cold walk (APRV-186) a burst is what produced the 2026-08-31 load-68 incident. Add an approval.md-configurable ceiling on concurrent hook processes (and reconsider the default wait length), so the gate cannot be turned into a resource-exhaustion lever. Security follow-up to APRV-186; complements APRV-188 (which removes the per-hook CPU, not the process count). Fail closed: reaching the ceiling must deny/queue safely, never silently allow an ungated command.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A configurable maximum number of concurrent hook processes is honored, with a documented default
- [ ] #2 When the ceiling is reached, additional hook invocations resolve safely (deny or bounded-wait), never bypass the gate
- [ ] #3 The wait timeout is configurable from the same config surface, with its interaction with the ceiling documented
- [ ] #4 Config lives in the approval.md convention (not just the settings.json command line) and is covered by tests; SPEC updated if behavior diverges
- [ ] #5 npm test passes; lint clean
<!-- AC:END -->
