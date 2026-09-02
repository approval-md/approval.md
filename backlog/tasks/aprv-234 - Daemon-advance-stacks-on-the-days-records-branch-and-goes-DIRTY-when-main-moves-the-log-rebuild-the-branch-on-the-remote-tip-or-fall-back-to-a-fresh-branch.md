---
id: APRV-234
title: >-
  Daemon advance stacks on the day's records branch and goes DIRTY when main
  moves the log: rebuild the branch on the remote tip, or fall back to a fresh
  branch
status: In Progress
assignee:
  - 'agent:opus-lane-r'
created_date: '2026-09-02 20:19'
updated_date: '2026-09-02 22:09'
labels:
  - daemon
  - bug
dependencies: []
priority: high
ordinal: 189000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Seen 2026-09-02: PR #240 (records-log-2026-09-02, opened by the daemon's cadence advance) went DIRTY after the seq 13704 ceremony commit landed on main with its own copy of the log; the daemon kept stacking new advance commits (13986, 13990, 13994, 13997, 14002, 14006) on the branch tip, each built on the branch rather than on origin/main, so the conflict persisted and the PR could not merge without a hand merge (done by the orchestrator with git merge -X ours origin/main; note that -X theirs truncates the log, since git's theirs is the branch being merged in). APRV-203 made the ceremony verbs build their commit on the remote tip through a scratch index; the daemon's same-day reuse of an existing branch bypasses that. Outcome: when the day's branch exists and origin/main has moved the log or QUEUE.md since the branch's base, the advance rebuilds the branch's commit on the current origin/main (the working log is a superset of main's by the log-advance preconditions, so the rebuilt commit is main plus the appended tail; if it is not a superset, refuse with the existing remote-diverged code) and pushes by refspec; when the branch has a queued or dirty PR, either update it in place or open a fresh branch (records-log-<date>-<n>) and say which. The daemon never merges (APRV-204), unchanged. Why: a records PR the daemon cannot land on its own is a tap it promised to remove.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A test with a bare remote where main gains a commit touching the log after the day's branch was pushed proves the next advance produces a branch that merges cleanly into main and whose log is byte-identical to the working log
- [ ] #2 A working log that is not a superset of main's committed log refuses with a distinct machine-readable code and pushes nothing
- [ ] #3 The daemon's advance DaemonEvent and the log-advance-cadence doctor row say whether the branch was rebuilt and on which base
- [ ] #4 npm test passes; lint clean
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What was built (APRV-234)

**The question the verb now asks before it stacks.** `cli/log-advance.ts`'s
one-branch-per-day reuse (APRV-204) parented every advance after the first on
the day's records branch, unconditionally. It now asks first whether that branch
still CONTAINS the base (`git merge-base --is-ancestor`, whose exit status is
the answer; anything that is not a clean yes reads as no, which is the direction
that rebuilds rather than the direction that stacks on a base nobody checked).

- Branch contains the base: stack, exactly as before. `reusedRecordsBranch`,
  the parent, the fast-forward push, the one pull request per day: unchanged.
- Branch does NOT contain the base: build the commit on the CURRENT trunk
  through the same scratch index APRV-203 gave the ceremony verbs, and push it
  over the branch with a `+` refspec.

**Why replacing the branch's history is sound here and would not be
elsewhere.** The only paths an advance carries are the append-only log, its
queue projection and the content-addressed payload store, and the trunk check
above the rebuild has already refused unless the working log is a SUPERSET of
the trunk's: `log-advance-behind-remote` when the trunk carries records this
checkout does not, `log-advance-remote-diverged` when the two are separate
chains. So a rebuilt commit is the trunk's own log plus the tail it lacks, and
can never revert anything the trunk merged. The branch is also a proposal nobody
has merged, and every record it carried is in the new commit, so this is not the
history rewrite the shared-branch rule forbids. The alternative is what actually
happened: a pull request only a person could land.

The queue projection IS one of the three paths, so a rebuilt commit lays the
working projection over the trunk's. That is what publishing it means, and a
test pins that everything OUTSIDE the three paths (the ceremony's own files)
survives the rebuild untouched.

**When the branch will not take it.** A protected-branch ruleset (GH006) or a
pull request the merge queue has already taken will refuse the forced update.
The records still have to reach a branch somebody can merge, so the verb opens
`records-log-<date>-<n>` (2 through 9), anchors the commit there too, and the
report carries `fallbackFrom` naming the branch it could not update. The
progress narration says the same thing to a human watching. `gh pr create` then
opens the day's second pull request on the new head.

**Never merges.** Untouched. There is still no `gh pr merge` anywhere in the
daemon or the verb, and the daemon-advance test that asserts the string's
absence and stubs a `gh` whose merge branch exits non-zero still passes.

**Three surfaces say it happened** (AC 3):

1. `LogAdvanceReport` gained `rebuilt`, `rebuiltOn {ref, sha}` and
   `fallbackFrom`, additive, nothing repurposed.
2. The daemon's `advance` DaemonEvent gained `rebuilt` and `rebuilt_on`.
3. The log itself, and therefore `approval doctor`'s `log-advance-cadence` row.
   `core/execute.ts` gained `FinishOptions.note`, the mirror of APRV-211's
   `reason`: the same closed `{code, message}` shape, recorded on
   `execution.completed` only and only when the caller supplies it. The advance
   supplies `advance-rebuilt` with the ref and sha it rebuilt on, `lastAdvance`
   already reads code and message off the cycle's last record, and the doctor
   row already prints them, so a different process reading the committed log a
   day later gets the same answer.

## The 2026-09-02 note the transcript adds

The branch had just been merged (#240) and the daemon's next advance opened a
NEW pull request, #245, on the same branch name. That is correct and expected:
one records branch per day, and `gh pr list --head <branch> --state open` finds
nothing open once the previous one has merged, so the day's second pull request
is opened rather than a merged one being reused. Recorded here so nobody reads
#245 as a second symptom.

## Global invariants touched (SPEC section 11.1)

- (7) self-reported fields never reduce scrutiny: `FinishOptions.note` is a
  report and nothing else. No gate path reads it, no decision turns on it, and
  like `FailureReason` it is written by this runtime's own code rather than
  forwarded from a child, so it cannot carry a credential into a permanent log.
- The append-only rule and the "hash chains do not merge" rule are what the
  superset precondition enforces: no rebuild can publish a chain the trunk's is
  not a prefix of, in either direction, each with its own machine-readable code.
- No enforcement path changed what it reads, no gate-typed event gained a caller
  timestamp, and no frozen refusal union grew: `LOG_ADVANCE_REFUSAL_CODES` is
  unchanged, and the superset refusal reuses the codes APRV-203 minted.

## SPEC draft, pending sign-off (NOT applied)

For the paragraph describing `log advance`:

  "A day's records go to one records branch, and later advances of that day
  update it in place by parenting on the branch rather than on the trunk, WHILE
  the branch still contains the trunk. When the trunk has moved under it, the
  advance rebuilds the commit on the current trunk instead and replaces the
  branch with it: the only paths an advance carries are the log, its projection
  and its payloads, and the working log is already required to be a superset of
  the trunk's, so the rebuilt commit is the trunk plus the tail it lacks and
  reverts nothing. Where the branch cannot be updated, a fresh numbered records
  branch is opened and named in the report. A records branch the daemon cannot
  land on its own is a tap the cadence promised to remove."

## Tests

`tests/log-advance-rebuild.test.ts`, five cases, real git over a bare remote,
`gh` stubbed, no log line written by hand. The ceremony that moves the trunk is
made in a SECOND clone, never in the working checkout, for the reason the verb
exists: a log-touching commit made where the live log lives is how
`events.jsonl` gets rewound under its own appender.

- main gains a ceremony commit carrying its own copy of the log after the day's
  branch was pushed; the next advance rebuilds, the branch then contains main, a
  clone merges it with no conflict, and main's log after the merge is
  byte-identical to the working log (the AC-1 property, stated as the AC states
  it) while the ceremony's own non-advance files survive;
- a branch that still contains the trunk is stacked on, two commits on one
  branch, the second parented on the first: APRV-204's property is unchanged;
- a remote `update` hook that refuses that one ref (the GH006 shape) sends the
  advance to `records-log-<date>-2`, whose log is the working log and which
  contains main, with `fallbackFrom` naming the branch it could not update;
- a trunk carrying records this checkout does not have refuses
  `log-advance-behind-remote` and the records branch does not move (AC 2);
- and one daemon tick over the rebuilt case asserts the advance DaemonEvent
  carries `rebuilt: true` / `rebuilt_on: "origin/main"`, that the log's own
  `lastAdvance` reads back `advance-rebuilt`, and that `approval doctor --json`
  prints it and the base in the `log-advance-cadence` row (AC 3).

## Verification

`npm run build` clean, `npm run lint` clean. Full-suite counts are in the lane
report. Commit f050e43.
<!-- SECTION:NOTES:END -->
