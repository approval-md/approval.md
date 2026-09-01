---
id: APRV-201
title: >-
  cli-hook tests: decideLater races a cold CLI start with a fixed 700ms delay
  and swallows the decision verb's failure
status: To Do
assignee: []
created_date: '2026-09-01 20:37'
labels:
  - test
  - hook
  - dogfood
dependencies: []
priority: high
ordinal: 165000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found by the APRV-151 lane on 2026-09-01 and reproduced on main at 5e16ac0 with no other changes: decideLater in tests/cli-hook.test.ts (line ~201) spawns a detached helper that sleeps a FIXED 700ms and then runs approval grant|reject <key> --as human:alice exactly once with stdio ignore. At 700ms the hook under test has not yet appended approval.requested (it must spawn node, load the CLI, verify the chain, check attestation, validate schema), so the decision hits not-requested, the refusal is swallowed, nothing ever decides, and the hook waits its full 20s and returns hook-timeout where the test expects hook-rejected. Instrumented output: status=1, stderr: not-requested: action hook:sess-1:tu-reject:network.call has no approval.requested record to decide. The same fixed-delay race underlies the two sibling tests (a manual command is allowed when a grant lands mid-wait; a grant that lapsed its TTL carries nothing), which fail with load. Every lane this week misfiled these as load flakes; the suite reports the wrong defect because the helper discards its exit status.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 decideLater polls the log for the approval.requested record (bounded, with a clear failure) instead of a fixed delay
- [ ] #2 The helper's decision verb exit status and stderr are captured and surfaced in the assertion message, never ignored
- [ ] #3 The three affected cli-hook tests pass 10 consecutive runs on a loaded machine (run alongside a full npm test)
- [ ] #4 npm test passes; lint clean
<!-- AC:END -->
