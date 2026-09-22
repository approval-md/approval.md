---
id: APRV-426
title: >-
  A lane watches its PR's CI to a verdict before the session ends, and a
  known-failure baseline is a named list of test ids, never a count
status: Done
assignee:
  - '@claude'
created_date: '2026-09-22 00:00'
updated_date: '2026-09-22 02:18'
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
- [x] #1 CLAUDE.md workflow item 7 gains the rule: after pushing a PR the session watches CI to a verdict (the app's CI monitor or gh pr checks --watch) and ends only on green or on a named, filed failure; a red PR is never left armed and unattended. The edit classifies policy.edit and Carter taps it
- [x] #2 A known-failure baseline lives in a committed file (scripts/ci-baseline.json or similar) as a list of test ids with the task that owns each; a lane's closing note compares failures by id against it, and a failure not on the list is a new failure regardless of the total
- [x] #3 The SMTP baseline the lanes have been citing by count is captured in that file by id, with its owning task
- [x] #4 docs or CLAUDE.md name the ergonomic path for the human: how to see at a glance which armed PRs are red (gh pr list with mergeStateStatus, or the app's PR bar) so a blocked arm is visible without opening each PR
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add scripts/ci-failure-ids.mjs: a node:test custom reporter that writes one failing test id per line to the file named by APPROVAL_FAILURE_IDS. Id shape is <suite>::<full test name>, suite being the file path under dist/tests without the .test.js suffix, so an id is stable across shards, --only sets and machines. Parent tests that fail only because a subtest failed are skipped, so an id always names a leaf assertion.
2. Add scripts/ci-baseline.json: the committed known-failure list, each entry an id plus the task that owns it plus a one-line note. Seeded from a real full-suite run in this worktree.
3. Add scripts/ci-baseline.mjs: loadBaseline (fail closed on a malformed file), compareFailures (partition a run's ids into known and new, and report baseline entries that did not fire), formatComparison, and a CLI so an ids file can be compared on its own.
4. Teach scripts/run-tests.mjs a --baseline [path] flag: attach the reporter alongside the normal output reporter (spec on a tty, tap otherwise, which is exactly what node picks today), then print the comparison. It never turns a red run green; it only names which failures are new.
5. Add tests/ci-baseline.test.ts: the baseline file parses and every entry names a task id; compareFailures partitions correctly; a malformed baseline is refused; the runner with --baseline on a scratch suite prints a planted new failure by name and does not print a baselined one as new.
6. CLAUDE.md workflow item 7 gains the CI-verdict rule (AC1) and a pointer to the new doc. The edit classifies policy.edit; if it blocks, the hunk goes in the PR description for the orchestrator.
7. Add docs/ci-verdict.md: how a lane watches CI to a verdict, how it reads the baseline, and how the human sees every red armed PR at a glance (gh pr list with mergeStateStatus and autoMergeRequest piped through jq, plus the desktop app PR bar).
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Shipped four pieces, plus the rule.

RULE (AC1). CLAUDE.md gains workflow item 8: after pushing, the session watches its own PR to a verdict (the app CI monitor, or gh pr checks <n> --watch, which exits nonzero on red), reads a red shard with gh run view <id> --log-failed, and ends on green or on a named, filed failure, never on pending and never leaving a red PR armed and unattended. The edit classified policy.edit and was applied in-session; it was not blocked on the gate, so it enters the retrospective sample.

REPORTER (AC2). scripts/ci-failure-ids.mjs is a node:test custom reporter whose whole output is failing test ids, one per line. Id shape is <suite>::<ancestor> > <name>, suite being the file path under the built test directory without the suffix, which is exactly the name run-tests.mjs --only takes, so a baseline entry can be rerun on its own. Deterministic: no durations, no absolute paths, no ordering. Parents that failed only because a child did (failureType subtestsFailed) are dropped, so every id names an assertion that failed on its own account. Two facts about node:test were probed rather than assumed, and both bit: node opens a reporter destination LAZILY, so a run with nothing to report leaves no file at all (the runner now pre-creates it empty, which keeps 'no failure' and 'the reporter never ran' apart), and a spawned node --test inherits the test-context variable, believes it is inside a test file, and SKIPS every file it was given while exiting green (the suite scrubs it, which is also what reproduces an operator shell).

COMPARISON (AC2). scripts/ci-baseline.mjs loads the list, partitions a run's ids into new, known and not-seen, and formats the report. Loading fails closed on anything malformed: an empty list silently promotes every known failure to new, which is noisy and safe, but a typo in a path would then produce a report that looks authoritative and compared against nothing. An entry must name an APRV task; a known failure with nobody's name on it is an unknown failure somebody got tired of looking at. Usable standalone (node scripts/ci-baseline.mjs <ids-file>, exit 1 only when a failure is new) and through run-tests.mjs --baseline, which attaches the reporter beside the normal output reporter (spec on a tty, tap otherwise, which is what node itself picks, so a baselined run looks identical plus the comparison). It never turns a red run green, and it refuses to report success if the runner exits 0 while the reporter named failures.

BASELINE (AC3). scripts/ci-baseline.json carries 22 ids, all owned by APRV-416: 14 in adapter-email, 4 in smtp-probe, 4 in cli-setup. That is exactly the 22 the lanes have been citing as a count. The cause is one, confirmed in the run log: the SMTP path passes the mock listener address as the TLS servername and Node 26 refuses an IP literal there, so most cases fail as smtp-protocol-error where they expect smtp-535 or smtp-550.

DOC (AC4). docs/ci-verdict.md: the lane side (watch to a verdict, read a red shard, fix, watch again), the baseline commands, and the human side, a gh pr list query over number, mergeStateStatus and autoMergeRequest piped through jq that lists every open armed PR that cannot merge, with a table separating BLOCKED (red or pending) from DIRTY (conflict, which for a policy or records branch is APRV-420), plus the desktop PR bar.

NOT IN THE BASELINE, stated rather than swept in: a full run here also fails 6 cases that CI does not see, and they are environment-bound rather than debt. package-adapters (4) and codex-package (1) pack the tarball and npm install it into a scratch consumer, which cannot fetch ajv without registry access; live-draw (1) is a timing case. The committed list is about what CI sees, so none of them is in it and none is claimed as fixed.

Global invariants: none touched. Nothing here reads or writes the log, computes a verdict, or reaches an enforcement path; the baseline is developer tooling and changes no exit code.

CORRECTION after CI, from PR 540's own evidence. The notes above called the 22-entry list 'about what CI sees'. It is not, and the shard matrix said so: all three Node 22 shards passed green while a local run fails all 22. CI runs the floor on Node 20 and the matrix on Node 22, never Node 26, and every entry on the list is APRV-416, a Node 26 refusal of an IP literal as a TLS servername. So the list is a LOCAL baseline, which is the right thing for it to be: a lane's closing note comes from the lane's own run, and that is where a count was being cited. docs/ci-verdict.md and the baseline file's comment now state the asymmetry, because it is the fact that explains how CI green and a red local run coexist without either being wrong. The six excluded failures are excluded for the same kind of reason rather than the one I first gave: the packaging suites need registry access and a worktree with its own node_modules, which is environment rather than debt.

This is the correction the task's own tooling made possible: the baseline flag names failures, and a named set is what let CI's green shards be read against a local red instead of both being reported as a number.

One more thing CI's verdict surfaced, and it was a trap in this task's own test. The first draft of tests/ci-baseline.test.ts asserted the committed list was NON-EMPTY, reasoning that APRV-416's SMTP failures are why the file exists. That would have turned the day APRV-416 lands and its 22 entries are correctly deleted into a red suite: the test would have punished the fix. PR 536 was open with that exact fix while this was being written, so the trap was about a week from firing. An empty list is now legal and is the goal; what the case holds to is that every entry present is well formed and owned. How many there are is the debt, not the contract.

Also verified live rather than asserted on paper: both jq queries in docs/ci-verdict.md run as written against this repository, and the first one immediately found PR 523 armed and BLOCKED, which is the failure mode this task was filed about, sitting there right now. The runbook is not hypothetical.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
A lane now ends on a CI verdict, and a red is a name rather than a number. CLAUDE.md workflow item 8 makes the session watch its own PR (the app CI monitor or gh pr checks --watch) and end only on green or a named, filed failure. scripts/ci-failure-ids.mjs turns a node:test run into stable failing ids, scripts/ci-baseline.json lists the 22 known SMTP failures by id with APRV-416 owning each, scripts/ci-baseline.mjs partitions a run against the list and fails closed on a malformed one, and run-tests.mjs --baseline prints new failures by name without ever turning a red run green. docs/ci-verdict.md names the human path: a gh pr list query over mergeStateStatus and autoMergeRequest that shows every armed PR that cannot merge, and the desktop PR bar. Verified by 11 new cases in tests/ci-baseline.test.ts (all pass), which drive the reporter through a real spawned node --test rather than a synthetic event stream, plus build, typecheck and lint clean and ci-guard, docs-guard, cli-help, cli-long-help, classify-tier, command-class and protected-path-guard green.
<!-- SECTION:FINAL_SUMMARY:END -->
