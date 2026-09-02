---
id: APRV-215
title: >-
  approval up preflight: fetch, fast-forward when the log is untouched upstream,
  rebuild when dist is stale, refuse with the next command otherwise
status: In Progress
assignee:
  - 'agent:opus-lane-y'
created_date: '2026-09-02 15:57'
updated_date: '2026-09-02 20:05'
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
- [x] #1 approval up on a checkout behind origin whose upstream range does not touch the log fast-forwards, rebuilds when dist is stale, and starts; the started line names the commit now running
- [x] #2 When upstream touched events.jsonl while the working copy is dirty, or local main is ahead, it refuses with a machine-readable code and the one command to run next, and changes nothing
- [x] #3 A fetch that fails on the network is a warning, not a refusal: it starts on the current build and says so
- [x] #4 --no-preflight skips the preflight; --json carries the preflight facts (behind_by, ahead_by, log_touched, dist_stale, action taken)
- [x] #5 approval doctor row main-behind-origin reports behind-by, whether upstream touched the log, and the same next command
- [x] #6 Tests run the real CLI against a scratch remote for each branch of the decision; docs/cli-reference.md up and doctor sections updated; npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. New module src/cli/preflight.ts. Move installationRoot/ScanError/newestMtime/checkBuildFreshness there from doctor.ts (doctor imports them back; DoctorCheck stays in doctor.ts and is imported type-only, so no runtime cycle). Add inspectPreflight(): git read-only judgment over a checkout — behind_by/ahead_by via rev-list --left-right --count, log_touched via diff --name-only over the upstream range restricted to .approval/log/events.jsonl and .approval/QUEUE.md, dirty set via status --porcelain -uno, dist_stale from checkBuildFreshness. Optional fetch through git-scope's fetchBase (FETCH_HEAD, no remote-tracking ref needed); fetch failure is a warning, never a refusal.
2. Three refusal codes, ordered and exhaustive: up-preflight-behind-ahead (origin/main..HEAD non-empty), up-preflight-log-diverged (upstream range touches the log or QUEUE.md while they are dirty locally), up-preflight-dirty-protected (some other path the upstream range changes is locally modified, so --ff-only would clobber it). Rendered through style.ts runbook() in the APRV-129 shape, one runnable command per line; never reset --hard.
3. runPreflight(): on a safe judgment, git merge --ff-only <sha> when behind, npm run build when dist is stale, then report the action taken. Never resets, never stashes, never touches the working log.
4. Wire into src/cli/up.ts before the daemon starts, so approval daemon run --with-channels shares it. --no-preflight opts out on both spellings. Two additive UpEvent members: preflight (behind_by, ahead_by, log_touched, dist_stale, action) and preflight_warning. Refusal exits EXIT_IO with the runbook on stderr, the machine-readable error object under --json, and nothing touched.
5. doctor gains row 21, main-behind-origin, from inspectPreflight with fetch:false (doctor makes no network call); fix strings stay inside FIX_COMMAND_PREFIXES so they are approval verbs, not git. Bump the pinned row count 20 -> 21 in tests/cli-doctor.test.ts.
6. tests/cli-up-preflight.test.ts: a real bare remote plus a working clone per case, driving the built CLI — fast-forward+rebuild, refuse ahead, refuse dirty log touched upstream, fetch failure warning, --no-preflight, --json fact shape, doctor row. No daemon reaches the network or the live log: every case is --once against scratch paths.
7. docs/cli-reference.md up and doctor sections; help.ts UP_HELP and DAEMON_RUN_HELP; full npm test and oxlint.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## Implementation

**New module src/cli/preflight.ts.** It owns the judgment, the two event shapes, the APRV-129 refusal rendering and the shared startup wiring. A module rather than a block inside cli/up.ts for two reasons that both had to hold: cli/daemon.ts cannot import up.ts (the ESM cycle APRV-110 already routes around with a dynamic import) and it needs the same preflight, and doctor needs the same judgment as a pure report. Three callers, one answer.

**Moved, unchanged: installationRoot, ScanError, newestMtime, checkBuildFreshness** from doctor.ts into preflight.ts, because the preflight needs the same build-freshness answer before it decides whether to rebuild. doctor.ts imports them back; the DoctorCheck type travels the other way as a type-only import, so nothing is a runtime cycle. Behaviour and detail strings are identical, and doctor's five build-freshness tests pass untouched.

**distStale(root) is a three-way answer, not a boolean.** null means the question does not apply: no src/ (a published install), or neither loader nor build (not an installation at all). A preflight that read "cannot tell" as "stale" would run npm run build in a directory nobody asked it to compile. The first version did exactly that against a scratch fixture, which is how the distinction was found.

**What it is allowed to do:** read git, plus at most git merge --ff-only <sha> and npm run build. It never resets, never stashes, never checks anything out, and never writes the log. The build is spawned in the INSTALLATION root (the tree whose dist was dated), not the repository root; they are one directory in the primary checkout, and conflating them anywhere else would be the preflight lying about its own work.

**Safety, as implemented.** Safe means: not ahead of the remote, and no path the upstream range changes is locally modified. Evaluated in that order, exhaustively:

1. up-preflight-behind-ahead: origin/<branch>..HEAD is non-empty. Runbook: look at the commits, push them, or git reset --keep third and last, with a note saying it drops them.
2. up-preflight-log-diverged: the upstream range rewrites .approval/log/events.jsonl or .approval/QUEUE.md AND that path is dirty locally. Next command: approval log sync.
3. up-preflight-dirty-protected: any other upstream-changed path is locally modified, so --ff-only would refuse rather than clobber. Next: look at the diff, or --no-preflight.

Plus up-preflight-failed for a write the preflight started and could not finish. PREFLIGHT_REFUSAL_CODES is exported, frozen, and pinned by a test.

**"reset --hard" appears on no path**, and two tests assert it over the real stderr. One drafting casualty: the behind-ahead footer originally read "no reset --hard is ever printed here", which the canary caught, correctly.

**Exit code 1, not 4.** "The runtime decided", the same reading the vault help gives it. Nothing failed to read or write, and a supervisor that read a refusal as an I/O fault would retry a checkout state only a human can resolve.

**Silent where there is no question to ask.** action: skipped emits no line at all, and it covers two states: no git repository, and a repository with no origin configured. The second was found by the full suite. --git-evidence makes the log home a repository of its own with no remote, and daemon run there opened with a warning that it could not reach a remote nobody had configured. A configured remote that cannot be reached still warns and still starts on the build it has, which is what AC3 asks for. Being silent on skip also restores "started" as the daemon's first --json line, which tests/read-proof-cli.test.ts pins.

**doctor gains row 21, main-behind-origin,** appended and never inserted, like the twelve rows before it. It passes fetch: false. Doctor is a report, and a report that reached the network to be more accurate would be acting on its own account, so the answer is as fresh as the operator's last fetch and the detail says so. Its fix strings are approval verbs, never git, because FIX_COMMAND_PREFIXES is right that a repair line telling an operator to reset a branch would be doctor making the decision this project keeps human. Three pins bumped 20 to 21 in tests/cli-doctor.test.ts: the JSON shape count, the ordered name list, and the human line count.

**The short helps are at a hard 25-line cap**, and UP_HELP and DAEMON_RUN_HELP were both already at 25, so the preflight was paid for rather than appended. UP_HELP lost its --restart-backoff usage continuation (the flag stays in the flag list), folded the credentials paragraph into the preflight one, and dropped the "JSON shape:" pointer because why("up") already names that anchor. DAEMON_RUN_HELP documents --no-preflight on its --once / --json line and nothing more. --preflight-remote and --preflight-base are documented only in docs/cli-reference.md; there was no line to spend on them.

**docs/cli-reference.md** (not protected, edited): the preflight under "up" with the three-row refusal table, both event shapes, the exit code, the two silent-skip states, and the honest caveat that a rebuild replaces dist/ under a process that has already loaded it, so this run keeps executing the code it started with and the new build takes effect on the next start (a restart-on-exit service unit picks it up on its own); a pointer under "daemon run"; the main-behind-origin row; and --root noted test-only on both verbs.

## SPEC section 11 global invariants touched

None weakened. Two are adjacent and want the orchestrator's eye:

- **Invariant 6 (refusals machine-readable and distinct).** Three new codes, distinct by repair, frozen as PREFLIGHT_REFUSAL_CODES and pinned by a test. They are a CLI verb's refusals, not gate refusals, so they do not join one of section 11.2's six frozen unions. DRAFT SENTENCE for SPEC, if the orchestrator wants it: "Section 11.2's registry covers the six gate-facing unions. A verb-local refusal union outside them is still bound by invariant 6: it is exported, frozen, and pinned by a test in the verb's own suite."
- **The log is append-only and is never rewound.** The preflight never writes the log. It can MOVE it, in exactly one case: upstream changed events.jsonl and the working copy is CLEAN, where --ff-only writes committed bytes over a path whose content already matches HEAD. That is the case the brief calls safe, and the dirty case refuses to approval log sync. Residual risk worth naming: the preflight runs before THIS process starts its daemon, so no appender in this process holds the log, but it cannot see an appender in another process. In the primary checkout that is the state approval up is being started FROM, so it is empty by construction, and a deployment with two writers was already outside the single-writer rule. DRAFT SENTENCE for CLAUDE.md, if wanted: "the preflight may fast-forward the committed log only when the working copy is clean; a dirty working log plus an upstream change is approval log sync's, always."

## Test coverage

tests/cli-up-preflight.test.ts, 17 cases, a real bare remote plus a working clone per case, driving the built CLI: fast-forward plus rebuild naming the commit now running, the safe upstream change to a protected path, the up-to-date no-op, all three refusals (each pinning that HEAD did not move and the working log is byte-identical), the runbook shape, two "reset --hard" canaries, the fetch-failure warning, the no-origin silence, --no-preflight, the frozen --json fact set, daemon run sharing the preflight and its own --no-preflight, the frozen code union, and doctor's row in three states. Nothing reaches the network or the live log: local bare remotes, explicit --log / --out / --dir under a scratch directory, and --once with both channels off.

Two notes for whoever runs this branch. The worktree had no node_modules, which made tests/ci-guard.test.ts's engines check fail on a package it could not open before anything of mine ran; npm ci fixed it, and it was not a regression. And daemon.test.ts's live TTL sweep failed once under a 645s full-suite run and passes on its own and on a rerun of the file: a load flake, not this change.

## Validation

Final run on 0729bd9 (before the task-file commit): npm test — 3004 tests, 3003 pass, 0 fail, 1 skipped, 663s. npx oxlint src tests — clean, exit 0. tests/cli-up-preflight.test.ts contributes 17 of those, and tests/cli-doctor.test.ts's three bumped pins pass.

One environment note the orchestrator should know about: the harness hook refused two commits mid-session with policy-not-attested against the PRIMARY checkout's policy (once 'never attested', once 'changed since it was attested at seq 7413'), and both succeeded on an immediate retry. Nothing in this lane touches APPROVAL.md or .approval/; it looks like the primary's policy file was being edited underneath, so the hook was reading a moving target. Worth a glance if other lanes saw it too.
<!-- SECTION:NOTES:END -->
