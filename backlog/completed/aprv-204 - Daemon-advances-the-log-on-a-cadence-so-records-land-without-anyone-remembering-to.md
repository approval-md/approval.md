---
id: APRV-204
title: >-
  Daemon advances the log on a cadence, so records land without anyone
  remembering to
status: Done
assignee:
  - 'agent:opus-lane-i'
created_date: '2026-09-02 00:30'
updated_date: '2026-09-02 04:00'
labels:
  - dogfood
  - daemon
dependencies: []
priority: medium
ordinal: 168000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Advancing the log is bookkeeping: it commits the record of decisions that were already made, verifies the chain, and opens a records PR. Since the seq 7413 ceremony log.advance is supervised-live 0.1, so the class no longer needs a hand on the keyboard, yet the verb is still only ever run when a session or the human remembers to. Outcome: the daemon, which is already the log's sole writer in the primary checkout, advances the log itself on a cadence (a configurable interval, and/or after N new events, and at graceful shutdown), running the same code path as the CLI verb through the gate as agent:daemon so the action is classified log.advance, sampled like any other supervised action, and refused cleanly when the gate says so. A failed or refused advance is reported on the daemon's status surface and retried on the next tick; the daemon never merges the records PR (vcs.push.main stays a session's supervised act, or the human's). Why: the committed log is the project's truth and its freshness should not depend on a person's memory; the APRV-125 sign-off named this end state and today's seq 7413 amend made it reachable.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The daemon advances the log on a configurable cadence and at graceful shutdown when there are unpushed records, through the same verified append-lock path as log advance, and opens or updates one records PR per day rather than one per tick
- [x] #2 The advance is gated as log.advance for agent:daemon: a supervised sample or a refusal is honored, recorded, and retried on the next tick; the daemon never runs gh pr merge
- [x] #3 approval daemon status (and doctor) report the last advance attempt, its outcome, and the count of records not yet on a records branch
- [x] #4 A records PR opened by the daemon passes the records-tier guards unchanged; tests cover the cadence trigger, the shutdown flush, and the refusal path against a scratch repo
- [x] #5 SPEC.md section 10.1 gains the daemon-cadence sentence, flagged pending sign-off, drafted in the task notes for the orchestrator to apply
- [x] #6 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/cli/log-advance.ts (the shared path, extended in place rather than duplicated): the advance keeps its append lock, chain verify, staged-set refusal and trunk fetch, and gains ONE-BRANCH-PER-DAY reuse. After fetching the base branch it also fetches the records branch; when that branch exists on the remote and its log blob is a prefix of the working log, the commit is parented on the RECORDS BRANCH tip instead of on the trunk, so the second advance of a day fast-forwards the branch a pull request is already open on (parenting every advance on the trunk makes the second push a non-fast-forward). A records branch whose log the working log is not a prefix of is refused with the existing behind/diverged codes, naming the branch. ghPullRequest asks 'gh pr list --head <branch> --state open --json url' first and creates only when that list is empty, so a day gets one PR that later ticks update. Report gains parent {ref, sha}, reused_records_branch and pr_created.
2. src/daemon/advance.ts (new): the cadence, the gate and the reporting, with no git or log logic of its own. publishedSeq(root, logPath) reads the log blob at every local advance anchor (refs/approval/advance/*), at refs/remotes/<remote>/<base> and at HEAD, and takes the highest verified head seq: 'what is already on a records branch or the trunk', computed with no network. unpublishedRecords() is that count against the working head, and lastAdvanceAttempt(records) reads the daemon's own cycle records back out of the log. Both are exported for doctor.
3. The gated attempt, in that module: register({task: 'daemon-advance-<toSeq>', envelope with one action, class log.advance, idempotency_key daemon-log-advance-<toSeq>, payload_hash of {command, cwd}}) as actor agent:daemon, then request() with the same class and payload material, then startExecution / logAdvance / finishExecution. proceed:false (the supervised-live draw selected it, or the class resolves manual) is honoured: nothing is advanced, the outcome is reported, and the next tick retries. startExecution is called on every proceeding attempt, so a grant that lands later is spent through the ordinary sealed-token path and a pending question refuses token-required rather than being bypassed. No gh pr merge exists anywhere in the module.
4. The trigger: pending >= afterRecords, or intervalMs elapsed since the last attempt, and in both cases only when at least one pending record is NOT the daemon's own advance bookkeeping (a cycle appends task.registered + execution.started + execution.completed, so counting its own records would make the cadence self-perpetuating). A refused or failed attempt sets the last-attempt clock exactly as a successful one does, which is what keeps a refusal off the hot path.
5. src/daemon/daemon.ts: DaemonOptions.advance (opt-in, like gitEvidence), a new additive DaemonEvent 'advance' carrying outcome, records_pending, records_branch, commit, pr_url and the seq range, two new warning codes, the tick-time attempt after the render, and the graceful-shutdown flush inside finish() before the 'stopped' line is emitted (synchronous, because the advance is spawnSync throughout).
6. src/cli/daemon.ts: --advance, --advance-interval (default 15m), --advance-after (default 20 records), --advance-remote, --advance-base; the human rendering of the new event; DAEMON_RUN_HELP text.
7. src/cli/doctor.ts: a ninth appended check, 'log-advance-cadence', reporting the count of records not yet on a records branch and the last daemon advance attempt with its outcome, both read from the log and the local refs (doctor still fetches nothing and writes nothing).
8. tests/daemon-advance.test.ts: scratch repo with a bare remote and a stubbed gh on PATH, covering the cadence trigger (count and interval), the shutdown flush, the refusal path (a policy where log.advance is manual: nothing is committed, nothing is pushed, the outcome is reported, the next tick tries again), one PR per day over two advances, and the commit's changed paths all falling inside protected-path-guard's EXEMPT_PREFIXES so the records PR passes the CI guards unchanged.
9. npm run lint, npm run build, npm test; SPEC 10.1 cadence sentence drafted in the notes (SPEC.md is not edited).
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What was built (APRV-204)

**The shared path is the verb itself.** `cli/log-advance.ts`'s `logAdvance` is the function the daemon calls: same append lock, same chain verify, same staged-set refusal, same commit-on-the-remote-without-a-checkout. Nothing was copied into the daemon, and the two changes the cadence needed were made INSIDE the verb, so the CLI gets them too:

1. *One records branch per day, updated rather than re-created.* After fetching the base branch the verb now also fetches the day's records branch; when that branch exists and its log is a prefix of the working log, the commit is parented on THAT branch instead of the trunk. Parenting every advance on the trunk makes the second push of a day a non-fast-forward of the branch a pull request is already open on, which is the failure a cadence would hit within one interval. A records branch the working log is not a prefix of is refused with the same behind/diverged codes the trunk uses, naming the branch. The report gained `parent {ref, sha}`, `reusedRecordsBranch` and `prCreated` (additive; the `--json` shape grew and nothing was repurposed).
2. *One pull request per day.* `--pr` runs `gh pr list --head <branch> --state open --json url` first and `gh pr create` only when nothing is open, so later advances update the day's PR. Unparseable `gh` output reads as 'no open PR', which fails toward trying to create one (and being told loudly) rather than toward silently never opening one.

**The cadence and the gate: `src/daemon/advance.ts` (new).** `attemptAdvance` does register -> request -> startExecution -> logAdvance -> finishExecution, in that order, as actor **agent:daemon** (not `system:daemon`: the gate's proposing side is a principal, and this is an action on the world rather than an observation the runtime made about itself). Everything above the verb is authorization and everything below is reporting. `execution.started` lands BEFORE the advance, so the commit carries the record of its own authorization; `execution.completed` lands after and is published by the next advance.

The gate's answer is honoured exactly as it comes: `proceed: false` (a supervised-live draw that selected this advance, or a class that resolves manual) commits nothing, leaves the question in the queue as a real `approval.requested` a human can answer, reports `gated`, and the next tick retries. A refusal from register/request/startExecution reports `refused`. `startExecution` is called on every proceeding attempt rather than bypassed, so a grant that lands later is spent through the ordinary (sealed-token) path and a pending question refuses `token-required` instead of being run around. There is no `gh pr merge` anywhere in the module, and a test asserts the string is absent as well as stubbing a `gh` that fails loudly if merge is ever asked for.

**The trigger.** Advance when `--advance-after` substantive records are owed (default 20), or when `--advance-interval` has elapsed since the last ATTEMPT (default 15m; the clock starts at daemon start, so a restart loop cannot open a pull request per restart), and at a clean shutdown when records are still owed. The last-attempt clock is set by refusals as well as successes, which is what keeps a refused advance off the hot path: the cadence interval IS the backoff. The shutdown flush does not re-ask a question the same process just asked (it skips when the last attempt was not `advanced` and no new substantive record has arrived), so a gated tick followed a second later by a flush does not put two identical questions in front of the same human.

**Substantive vs reported counts.** One cycle appends three records of its own; the last of them lands after the commit, so every successful advance leaves the log one record ahead of the records branch. A trigger counting that would advance an idle repository forever, so the TRIGGER counts only records whose task is not `daemon-advance-*`, while the count reported to an operator is the raw one. Both are in the doctor row.

**The payload the authorization binds to** is `{argv, cwd, seq: {from, to}}`. The seq span is in the hash deliberately: a payload identical across cycles would give the supervised-live draw the same verdict forever, so a selected advance would stay selected on every later tick and the cadence would stop for good. A different span is a different set of records, which is a different action rather than a re-roll (SPEC 5.2's no-re-roll property is about identical bytes).

**The status surface.** There is no `approval daemon status` subcommand and no status file, and I did not add either: the daemon's own `--json` stream is gone the moment nobody is tailing it, and a status file would be a second copy of facts the log already carries. So there are two surfaces. (a) A new additive `DaemonEvent` variant, `advance`, emitted for EVERY attempt including the refused ones, carrying outcome, records_pending, records_branch, range, commit, pr_url, pr_created, code, message, flush; plus a new warning code `advance-refused`. (b) A ninth doctor row, `log-advance-cadence`, which reports the records not yet on a records branch (raw and substantive), the published head, and the last daemon advance attempt with how it ended - all read from the LOG and from local git refs, so a different process answers it and the answer outlives the daemon. `publishedState` consults the local advance anchors (`refs/approval/advance/*`), the remote-tracking refs and HEAD, and never the network: a status question asked every tick must not depend on a remote being reachable.

**Wiring.** `approval daemon run` gained `--advance`, `--advance-interval`, `--advance-after`, `--advance-remote`, `--advance-base`, `--no-advance-pr`, all judged before the first tick; `approval up` accepts the identical flags through the same exported `advanceFlags` parser. Off unless asked for, like `--git-evidence`, because it pushes to a remote and opens pull requests. docs/cli-reference.md documents the cadence, the new JSON line, the new warning code, and the verb's one-PR-per-day rule.

**Records-tier CI.** Nothing in `.github/` was touched and `ADVANCE_PATHS` was not widened, so a daemon records PR carries exactly the three evidence paths `core/protected-path-guard.ts` exempts. A test asserts that over a real pushed commit: every changed path is one of `EXEMPT_PREFIXES`, so the always-on protected-path job needs no grant for it. (Note for the reader: `.approval/**` is not in `RECORDS_ALLOWLIST`, so such a PR classifies `full`, exactly as today's hand-run advances do. That is unchanged by this task.)

## Global invariants touched (SPEC 11)

- *The log is append-only.* Nothing here writes `events.jsonl` except through `core/gate.ts` / `core/execute.ts`; the advance still only commits the file.
- *Every check-then-append through compare-and-append.* Untouched: every append the cycle makes is register/request/startExecution/finishExecution's own, each carrying the head it decided against.
- *Gate-typed events never accept caller timestamps.* The module takes a `clock` in options and passes it through; it never authors a `ts`.
- *Fail closed.* An unloadable or unattested policy refuses the advance rather than publishing it; an unreadable log skips the attempt; a candidate git rev that is not a prefix of this chain is ignored when counting what is published, which can only make the daemon advance LESS eagerly.
- *Refusals are machine-readable and distinct.* The `advance` line carries the underlying gate/verb code verbatim rather than flattening it; `advance-refused` joins the closed warning-code union.
- *Self-reported fields never reduce scrutiny.* The daemon declares its own action, and every declaration it makes is checked by the same gate that checks a session's: the class is resolved from policy, the payload hash is re-presented at execution and compared to the registration's.

## SPEC.md text drafted (NOT applied; SPEC.md is a protected path)

*Section 10.1, appended to the `log advance` paragraph:*

> The advance need not be run by a person. Where the runtime's daemon is configured for it, the daemon advances the log on a cadence: when a configured number of records is owed, when a configured interval has elapsed since its last attempt, and at a clean shutdown while records are still owed. It runs the same verb through the gate as an agent principal, so the class is resolved and enforced exactly as it is for a session: an advance the policy sends to a human commits nothing, leaves its request in the queue, and is retried on the next tick, with the cadence interval as the retry bound. Each day's records go to one records branch and one pull request, which later advances of that day update in place by parenting on the branch rather than on the trunk. The daemon MUST NOT merge that pull request: reaching the trunk is a separate class and stays a human's act or a session's. (Amended APRV-204, pending sign-off.)

## Layering correction during implementation

`tests/layering.test.ts` forbids a CLI module importing `src/daemon/`, and the doctor row needed the same two readers the daemon uses. So the shared parts moved out of `src/daemon/advance.ts`:

- `src/core/advance-cycle.ts` (new, pure over records): the cycle's vocabulary — `ADVANCE_ACTOR` (agent:daemon), `ADVANCE_CLASS`, the task-id and action-key shapes, `isAdvanceBookkeeping`, and `lastAdvance` (the last cycle and how it ended, read back out of the log).
- `publishedState` (the git side: which local refs already carry this chain, and how much is owed) lives in `src/cli/log-advance.ts`, beside the verb whose anchors it reads.
- `src/daemon/advance.ts` keeps only the cadence defaults and the gated attempt.

Also updated by this task, all of them frozen-shape lists that grow by review: `tests/daemon.test.ts` (the DaemonEvent union), `tests/cli-doctor.test.ts` (the check-name list, the status list, and the two row counts 16 -> 17). `DAEMON_RUN_HELP` is capped at 25 lines by `tests/cli-long-help.test.ts`, so the cadence flags share one line with `--git-evidence` and the detail lives in docs/cli-reference.md, reachable with `--long`.

## Verification

`npm run lint` clean. `npm run build` clean. `npm test`: **2643 tests, 2642 pass, 1 fail**. The single failure is `every production dependency's engines.node admits the Node floor` (tests/ci-guard.test.ts), which reads `<repo root>/node_modules/<dep>/package.json`; this agent worktree has no node_modules of its own, so the read is ENOENT. It is the known worktree artifact (APRV-203 hit the same one) and passes in the primary checkout and in CI, where `npm ci` runs. No other test failed and none was skipped.

The new suite is `tests/daemon-advance.test.ts` (7 cases, real git topology with a bare remote, a stubbed `gh` on PATH whose `pr merge` branch exits non-zero so any merge attempt fails the case): the count trigger advances on a tick and writes the three-record cycle as agent:daemon; the daemon's own bookkeeping does NOT trigger a second advance; a clean shutdown with records owed flushes before the `stopped` line; a manual log.advance is gated with nothing committed, nothing pushed, one approval.requested in the log, an advance-refused warning, and a retry on the next run; two advances in a day put two commits on one branch (the second parented on the first) and run `gh pr create` exactly once; and every path a daemon advance commits falls inside protected-path-guard's EXEMPT_PREFIXES.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The daemon now advances the log itself: on a configurable cadence (--advance-after 20 records, --advance-interval 15m) and at a clean shutdown, through the same verified append-lock path as `approval log advance` and through the gate as agent:daemon, so a supervised-live draw or a refusal stops it with nothing committed and the next tick retries. One records branch and one pull request per day: `log advance` now parents a second advance on the day's records branch (a fast-forward of the branch the PR is open on) and asks `gh pr list` before `gh pr create`. Status lives on a new additive daemon `advance` event plus a ninth doctor row, `log-advance-cadence`, which reports the records not yet on a records branch and the last attempt's outcome from the log, so the answer outlives the daemon's process. The daemon never merges. Verified by tests/daemon-advance.test.ts against a scratch repo with a bare remote and a stubbed gh (7 cases: count trigger, shutdown flush, refusal and retry, one PR per day, exempt commit paths), plus the full suite: 2643 tests, 2642 pass, the one failure being the known node_modules-less worktree artifact in ci-guard.
<!-- SECTION:FINAL_SUMMARY:END -->
