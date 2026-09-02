---
id: APRV-215
title: >-
  approval up preflight: fetch, fast-forward when the log is untouched upstream,
  rebuild when dist is stale, refuse with the next command otherwise
status: To Do
assignee: []
created_date: '2026-09-02 15:57'
labels:
  - cli
  - dogfood
dependencies: []
references:
  - APRV-203
  - APRV-125
  - APRV-129
  - APRV-210
  - docs/postmortem-2026-09-02-daemon-tick-cpu.md
priority: high
type: enhancement
ordinal: 177000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Deploying the APRV-212 fix took four manual steps in the primary (git fetch, judge whether the 10 upstream commits touched .approval/log/events.jsonl while the working log was dirty, git pull --ff-only, npm run build) plus a judgment call the human cannot make from git status alone. Nothing in the CLI does this: approval doctor has a build-freshness row (src/cli/doctor.ts checkBuildFreshness) but no main-behind-origin row, and the only behind-origin logic lives in the policy-amend ceremony (src/cli/git-scope.ts, src/cli/log-advance.ts). Carter's standing view: manual git steps for the human are a defect, not a runbook. Make approval up (and approval daemon run) run a preflight before starting the writer: git fetch; report main behind/ahead of origin/main; whether the upstream range touches .approval/log/events.jsonl or .approval/QUEUE.md; whether dist/ is older than src/. When safe (upstream did not touch the working log, local main not ahead) fast-forward and rebuild, then start. When not safe, refuse in the APRV-129 runbook shape with the exact next command (git reset --keep origin/main, or approval log sync when the log diverged), never reset --hard, and touch nothing. --no-preflight opts out. approval doctor gains a matching main-behind-origin row reusing the same check. Reuse checkBuildFreshness, the git-scope helpers, and the APRV-129 refusal rendering.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval up on a checkout behind origin whose upstream range does not touch the log fast-forwards, rebuilds when dist is stale, and starts; the started line names the commit now running
- [ ] #2 When upstream touched events.jsonl while the working copy is dirty, or local main is ahead, it refuses with a machine-readable code and the one command to run next, and changes nothing
- [ ] #3 A fetch that fails on the network is a warning, not a refusal: it starts on the current build and says so
- [ ] #4 --no-preflight skips the preflight; --json carries the preflight facts (behind_by, ahead_by, log_touched, dist_stale, action taken)
- [ ] #5 approval doctor row main-behind-origin reports behind-by, whether upstream touched the log, and the same next command
- [ ] #6 Tests run the real CLI against a scratch remote for each branch of the decision; docs/cli-reference.md up and doctor sections updated; npm test passes; lint clean
<!-- AC:END -->
