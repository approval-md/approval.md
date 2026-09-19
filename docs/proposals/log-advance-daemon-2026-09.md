# Policy proposal, 2026-09: `log.advance` is the daemon's to make

One line added, no line loosened: the daemon's own cadence advance gets its own
class and that class is `autonomous`. `log.advance` stays exactly as it is, so a
session in a worktree, an orchestrator running `approval log advance --pr` and a
human at a terminal all keep the line they have had since seq 513.

Apply with:

```bash
cd /Users/carter/dev/approval-md && approval policy apply docs/proposals/log-advance-daemon-2026-09.md
```

## The cost seen

Three advances on 2026-09-19 each drew the one-in-a-hundred live sample while
Carter was away from the phone. Each one stopped the cadence, put a question in
the queue, and left the committed log behind the working log until somebody came
back to tap. The tap decided nothing: every one of those advances was the same
act it always is, and the answer was always going to be yes.

That is the argument that the rate is wrong for this class, and it is not an
argument for turning the rate down. The rate that is right for `vcs.push.main`
is right there because the sample reviews a decision. An advance carries no
decision to review.

## Why the advance is different in kind

Files are the interface, the log is the truth, the database is a cache. A
records advance is a write to the CACHE: it takes records the log already holds,
commits them to a records branch, and opens a pull request. It appends nothing.
It decides nothing. It cannot change what any later verification reads, because
what that reads is the chain, and the chain is already written.

Nor does the timing of an advance buy any actor anything. CI's protected-path
guard reads grants that exist whether or not an advance has run; an unpublished
grant is as real as a published one, and a session that wanted to hide a record
could not, because withholding an advance withholds nothing (the working log is
the one the daemon, the doctor and every verb read).

The class was declared `manual` at seq 513, before the daemon existed, when any
checkout could advance and two of them could advance at once. What is left of
that risk today is mechanical (a queue collision, a duplicate records branch),
and the `--pr` path handles both: one branch per day, one pull request it grows,
and the arm withheld whenever the branch carries a path an advance may not carry.

## Why the daemon and nobody else

The daemon is the committed log's single writer in the primary checkout
(CLAUDE.md, "The committed log has one writer"). It is the one actor whose
advance is bookkeeping rather than an act with a choice in it.

A lane is not. A lane holds a branch it wants merged, and publishing the log is
the one thing standing between its own commits and the guard that reads them. It
still cannot publish: `approval log advance` classifies `log.advance` whoever
types it, so the looser line below is unreachable from any shell command. The
only way to it is from inside the daemon process, and starting a daemon is
`gate.self`, which this policy leaves at the fail-closed manual default.

The runtime carries the same rule a second time, in code, so that a policy
loosened past this decision does not quietly grant it: a cycle that is not the
daemon's and whose class resolves `autonomous` is refused
`advance-actor-not-daemon` before anything is appended (APRV-382,
`src/core/advance-cycle.ts`).

## The line

Current:

```yaml
  log.advance:               { autonomy: supervised-live, live_rate: 0.01 }       # records commit to a records branch; APRV-125
```

Replace with:

```yaml
  log.advance:               { autonomy: supervised-live, live_rate: 0.01 }       # records commit to a records branch; APRV-125
  log.advance.daemon:        { autonomy: autonomous }       # the daemon's own cadence advance: publishes records the log already holds, appends nothing, decides nothing (APRV-382)
```

## Before applying

The build in the primary checkout has to carry APRV-382, because the class is
one this RUNTIME emits and no command spells: `src/core/command-class.ts`
answers the reachability question for it, and a build without that answer
refuses the amendment `policy-suite-failed` (the declared class would be a line
nothing can fire).

```bash
cd /Users/carter/dev/approval-md && approval log sync && npm ci && npm run build
```

Either order is safe after that. A daemon on the new build with the old policy
sees no rule on `log.advance.daemon` and asks under `log.advance`, exactly as
before; a daemon on the old build with the new policy never asks for the new
class at all. What gets the benefit is a daemon on the new build, restarted
after this page is applied.

## After applying

- `approval policy check log.advance.daemon` ends in `autonomous`, by rule.
- `approval policy check log.advance` is unchanged: `supervised`, `live`, 0.01.
- `approval hook classify -- "approval log advance --pr"` still prints
  `log.advance`. Nothing an agent can type reaches the new class.
- Restart the daemon (`approval up`), and the next cadence advance runs with no
  question in the queue. `approval doctor`'s `log-advance-cadence` row reports
  it as completed rather than awaiting.
