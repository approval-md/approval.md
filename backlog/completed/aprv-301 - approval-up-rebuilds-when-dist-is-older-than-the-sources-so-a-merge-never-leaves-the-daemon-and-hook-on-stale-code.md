---
id: APRV-301
title: >-
  approval up rebuilds when dist is older than the sources, so a merge never
  leaves the daemon and hook on stale code
status: Done
assignee:
  - '@claude'
created_date: '2026-09-07 23:36'
updated_date: '2026-09-08 01:58'
labels:
  - dogfood
dependencies: []
ordinal: 221000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
After every merge to main the primary's daemon and hook keep running the previous build until someone runs npm run build; the symptom is always phone weirdness (reads routed, taps not landing). approval doctor already has a build-freshness row with the check.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 After a successful preflight fast-forward, approval up runs the build when dist is older than any source it is built from, using the same freshness predicate doctor uses, and prints that it did.
- [x] #2 --no-build opts out; a build failure is reported and up does not start on the stale build.
- [x] #3 Test coverage through the real preflight.
- [x] #4 docs/dogfood-cutover.md and docs/cli-reference.md updated.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read src/cli/preflight.ts (APRV-215 already extracted the doctor predicate as distStale and already fast-forwards + rebuilds + re-execs). The gaps are: no --no-build opt-out, the build failure does not report the child's exit code, npm run build's output is swallowed, no test through the real preflight for the at-the-tip-and-stale case, the build failure, or the opt-out, and neither doc mentions any of it.
2. preflight.ts: npmBuild reports the exit code and stops swallowing the compile (stdout routed to fd 2 so the --json event stream on stdout stays parseable, stderr inherited). PreflightInput/StartupPreflightInput gain build?: boolean (default true); when the build is opted out and dist is stale the action settles on the additive values build-skipped / fast-forward+build-skipped, the fast-forward still happens, no re-exec plan is made, and a preflight_warning states that the runtime is starting on a stale build.
3. up.ts and daemon.ts: --no-build flag, one spelling on both verbs exactly as --no-preflight is. help.ts: name it in both help texts.
4. tests/cli-up-preflight.test.ts, through the real preflight and the real npm: the fixture package's build script writes a sentinel, so a test can assert the build ran. Cases: already at the tip with a stale dist rebuilds (action rebuild); at the tip with a fresh dist runs nothing; --no-build over a stale dist starts anyway with the warning and no sentinel; a build script that exits non-zero refuses with up-preflight-failed, names the exit code, and does not start the daemon.
5. docs/cli-reference.md (the --no-build row, up-preflight-failed in the refusal table, the exit code), docs/dogfood-cutover.md (after a merge, approval up in the primary is what leaves the daemon and hook on fresh code), CHANGELOG under 0.1.0.
6. npm run build, the up and doctor suites, full npm test, npm run lint.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
APRV-215 had already built most of this: the preflight fast-forwards, dates dist against the sources with distStale, rebuilds, and re-execs. What was missing was the opt-out, the failure surface, and the coverage. Four things landed.

1. --no-build (src/cli/up.ts, src/cli/daemon.ts, src/cli/help.ts, one spelling on both verbs exactly as --no-preflight is). It opts out of the rebuild alone: the fetch and the fast-forward still happen, dist_stale still reports the truth, and a warning on stderr names the stale build in words. Two additive PreflightAction values carry it on the --json stream, build-skipped and fast-forward+build-skipped, so a supervisor cannot read that start as a clean one. No field was added to any shape that already existed; the frozen-fact-set test still passes unchanged.

2. The build failure is now readable. npmBuild reported three trimmed lines of captured output and no status; it now runs with the child's streams on the terminal and reports the exit code the build came back with. The child's stdout goes to fd 2 rather than being inherited outright, because under --json this process's stdout IS the event stream and one compiler line in it would break every consumer. up-preflight-failed grew a build-specific runbook (npm run build to see the whole error, approval up --no-build if you mean the stale one) and the refusal still starts nothing.

3. The predicate is single-sourced for real. checkBuildFreshness (doctor's row) and distStale (the boolean the preflight rebuilds on) each carried their own copy of the four paths cli.js, dist/src/cli/main.js, src/, tsconfig.json. They now both read one dateInstallation measurement and only interpret it differently, which is the part that has to differ: a missing bin loader is a fault doctor reports and is not a reason to compile anything. One behaviour change falls out of this: src/ is now walked eagerly, so an unreadable src/ in a tree with no dist/ is doctor exit 4 (could not inspect) where it used to be the unbuilt-checkout row. Exit 4 is the honest answer there, and it is what distStale already did.

4. Six cases in tests/cli-up-preflight.test.ts, through the real preflight, the real repository topology and the real package manager. The fixture package's build script now writes a sentinel as well as touching the marker, which is what lets a case assert the build did NOT run (a marker whose mtime moved is indistinguishable from one that was already fresh). At the tip with a stale dist rebuilds (action rebuild, sentinel present, HEAD unmoved); a fresh dist runs nothing; --no-build fast-forwards and keeps the stale build with the warning; --no-build at the tip prints the human line that admits it; a script that exits 7 refuses with up-preflight-failed naming exit 7 and no up_started; and its runbook names the build rather than the checkout's status. The ahead-refusal and fresh-build cases gained sentinel assertions too.

Touches no global invariant from SPEC section 11: nothing here reads or writes the log, no gate-typed event is involved, and the preflight's two writes (a --ff-only merge and the package build) are unchanged in kind. The help texts sit exactly on the 25-line cap, so --no-build is folded into existing lines rather than given its own; the failed-build detail lives in docs/cli-reference.md, which is where --long points.

Verification: npm run build clean; npm run lint clean; tests/cli-up-preflight.test.ts 27 pass 0 fail; cli-doctor plus up suites 85 pass 0 fail; help suites 34 pass 0 fail; full npm test 3875 tests, 3874 pass, 0 fail, 1 skipped, exit code 0.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
approval up and approval daemon run now run the package build when dist is older than the sources, using the very predicate approval doctor's build-freshness row reports (both now read one dateInstallation measurement, so the four dated paths cannot drift apart). Staleness alone is enough, with or without a fast-forward, and the startup line says what it did. --no-build opts out of the rebuild alone and says so on stderr and in the action (build-skipped / fast-forward+build-skipped) with dist_stale still true; a build that fails refuses with up-preflight-failed and the exit code the build returned, and nothing starts on the stale build. The compile is now visible on the terminal instead of swallowed, with the child's stdout routed to stderr so the --json event stream stays parseable. Verified through the real preflight in tests/cli-up-preflight.test.ts (27 pass, 0 fail: stale-at-the-tip, fresh, both --no-build shapes, and a build script exiting 7), plus full npm test at 3875 tests, 3874 pass, 0 fail, 1 skipped, exit code 0, with npm run build and npm run lint clean. Docs: docs/cli-reference.md (the --no-build paragraphs, up-preflight-failed in the refusal table, the extended action union), docs/dogfood-cutover.md (a new section on starting the runtime being the deploy), CHANGELOG under 0.1.0.
<!-- SECTION:FINAL_SUMMARY:END -->
