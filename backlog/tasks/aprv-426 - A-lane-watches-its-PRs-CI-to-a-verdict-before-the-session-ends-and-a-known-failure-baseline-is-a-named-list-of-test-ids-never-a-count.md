---
id: APRV-426
title: >-
  A lane watches its PR's CI to a verdict before the session ends, and a
  known-failure baseline is a named list of test ids, never a count
status: To Do
assignee: []
created_date: '2026-09-22 00:00'
labels:
  - workflow
  - ci
  - dogfood
dependencies: []
priority: medium
ordinal: 323000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
PR #532 (APRV-415, the Hermes live-probe results) was pushed and armed for auto-merge at 03:09 on 2026-09-21 and sat about twenty hours armed and red. Nothing signalled it: CLAUDE.md workflow item 7 (APRV-182) makes the session arm the merge, APRV-284 makes records PRs arm themselves, and the merge queue takes it from there, but every one of those assumes CI goes green. An armed PR whose CI is red waits forever and looks shipped from the backlog side (the task said Done). Every session cut from main in that window branched from a main that did not know the probe had run, which is exactly the stale-context churn the pull-before-starting rule exists to prevent, and no pull fixes it. Two gaps. First, no rule makes a lane wait for a CI verdict: the lane's local matrix was green and it closed. Second, the lane's closing note said full npm test had 22 failures, exactly the known SMTP baseline, a COUNT; the new failure hid inside it because a count cannot tell one red from another. The red itself was one machine-dependent conformance vector (hermes-terminal-absolute-workdir-allows: the scratch gate root was an unresolved macOS temp path under the /var symlink, so the Mac regenerated a deny and Linux CI produced the allow), fixed on the lane branch in this session by resolving the root with realpath. The desktop app already has a CI monitor (bind_pr, set_monitor auto_fix) that wakes a session on failure; the rule should require a lane to use it or poll gh, and to end only on a verdict. Same-session observation, cause unknown: the claude-code hook once answered policy-not-attested citing seq 57505 while the primary was attested at seq 65736; it cleared on the next command.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 CLAUDE.md workflow item 7 gains the rule: after pushing a PR the session watches CI to a verdict (the app's CI monitor or gh pr checks --watch) and ends only on green or on a named, filed failure; a red PR is never left armed and unattended. The edit classifies policy.edit and Carter taps it
- [ ] #2 A known-failure baseline lives in a committed file (scripts/ci-baseline.json or similar) as a list of test ids with the task that owns each; a lane's closing note compares failures by id against it, and a failure not on the list is a new failure regardless of the total
- [ ] #3 The SMTP baseline the lanes have been citing by count is captured in that file by id, with its owning task
- [ ] #4 docs or CLAUDE.md name the ergonomic path for the human: how to see at a glance which armed PRs are red (gh pr list with mergeStateStatus, or the app's PR bar) so a blocked arm is visible without opening each PR
<!-- AC:END -->
