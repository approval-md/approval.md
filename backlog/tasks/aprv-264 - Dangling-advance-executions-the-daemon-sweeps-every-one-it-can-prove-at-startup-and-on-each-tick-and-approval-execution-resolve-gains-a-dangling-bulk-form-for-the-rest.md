---
id: APRV-264
title: >-
  Dangling advance executions: the daemon sweeps every one it can prove at
  startup and on each tick, and approval execution resolve gains a --dangling
  bulk form for the rest
status: In Progress
assignee:
  - 'agent:opus-lane-a'
created_date: '2026-09-05 10:04'
updated_date: '2026-09-05 11:42'
labels:
  - daemon
  - cli
  - dogfood
dependencies: []
priority: high
ordinal: 196000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Seen 2026-09-05 after the APRV-233 build went live: approval status listed five dangling daemon-log-advance executions left by the 2026-09-02 advance loop, the daemon refused one advance per tick naming one key each (advance-refused: an execution nobody closed, no further advance is started while it stands), and Carter resolved all five by hand with five near-identical approval execution resolve commands. APRV-233's reconcile rule closes only the current span's dangling execution and only when publishedState proves the push landed; the anchor regression filed today broke that proof (highest published seq 0), and older dangling advances from before a restart are never swept. Outcome: (1) at startup and on every tick before authorizing an advance, the daemon lists every dangling daemon-minted advance execution, and for each one the trunk or a records ref carries (the seq the execution named is at or below the highest published seq on origin/main or refs/approval/advance/*), appends execution.completed with a note naming the ref, through compare-and-append and the head-retry helper; what it cannot prove it reports once per key on the started line and the doctor cadence row, never once per tick; (2) approval execution resolve gains --dangling [--class <class>] which lists every dangling execution with what the runtime can prove for each, asks for one confirmation, and appends one outcome per key with the human as actor; keys it cannot prove are listed with the one-line manual command; (3) the refusal that blocks the advance names all outstanding keys and the bulk command. Why: five copy-pasted commands in a second terminal window is the manual step the cadence exists to remove.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A test with three dangling advance executions whose seqs the scratch trunk carries proves the daemon closes all three on its first tick with execution.completed records naming the ref, then advances
- [x] #2 A dangling execution the trunk does not carry is reported once (started line and doctor row), not on every tick, and the advance refusal names every outstanding key plus the bulk command
- [x] #3 approval execution resolve --dangling lists provable and unprovable keys, asks once, and appends one human-attested outcome per provable key; --json carries the list
- [ ] #4 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. core/advance-cycle.ts gains the shared, pure vocabulary of the sweep: spanEndOf (the seq an advance key names), danglingAdvanceKeys (dangling executions whose key carries the daemon's prefix), advanceSweepEntries (each key paired with the ref that proves its seq is published, or null), and RESOLVE_DANGLING_COMMAND spelled once. Pure over records plus a publishedSeq/publishedRev the caller supplies, so the daemon, the doctor row and the CLI all read one rule and a CLI module still never imports the daemon.
2. daemon/advance.ts: reconcileDanglingAdvance (one key, the last) becomes sweepDanglingAdvances (every key), one publishedState call for the whole sweep, one finishWithHeadMovedRetry per provable key with an execution.completed note naming the ref and saying the runtime observed it (ADVANCE_ACTOR, never human-attested). authorizeAdvance's advance-unreconciled refusal names every outstanding key and the bulk command.
3. daemon/daemon.ts: the startup listing (no appends) rides the started line as dangling_advances and seeds reportedDangling, which becomes a Set, so the first tick does not say it twice; each tick sweeps before any trigger, emits one advance line per settled key, and warns once per key-set change naming every outstanding key and the bulk command.
4. cli/doctor.ts: the log-advance-cadence row names the outstanding keys and the bulk command.
5. cli/execute.ts: approval execution resolve --dangling [--class <class>] [--yes] [--json], with a Prompter seam like gate-window's. Lists provable and unprovable keys, asks once on a TTY (refuses dangling-stdin-not-tty without one unless --yes), appends one human-attested resolveExecution per provable key with the generated note naming the ref, leaves unprovable keys alone with their one-line manual command. help.ts, verb-registry.ts (output becomes anyOf of the single and bulk shapes) and docs/cli-reference.md follow.
6. Tests: a sweep suite over the real git topology (three dangling advances the scratch trunk carries, closed on one tick, then advanced; one it does not carry, reported once and naming every key plus the bulk command in the refusal), and a CLI suite for --dangling (list, one confirmation, one outcome per provable key, --json, no TTY without --yes).
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## Progress (lane A, branch aprv-264-dangling-sweep)

Implementation and tests are in on commits 2115d9b, e9789c9, 10fb3fa, 3b2a1fe, 24b7150. Full `npm test` and the origin/main merge are still to run at the time of this note.

## What was built

Two halves, one rule between them.

**The rule lives in core.** `core/advance-cycle.ts` gained `danglingAdvances`
(every dangling execution whose key carries the daemon's prefix),
`advanceSpanEnd` (the seq a key names, or null for a key this runtime did not
mint the shape of), `proveDanglingAdvances` (each entry paired with the ref
that carries its seq, or null), and `RESOLVE_DANGLING_COMMAND`. It is pure over
records plus a published state the caller supplies, because `publishedState`
reads git and lives in `cli/log-advance.ts`, a CLI module may not import the
daemon, and the daemon, the doctor row and the CLI must not disagree about what
counts as proved. The proof itself is one comparison: `publishedState` counts
only a committed copy that is a PREFIX of the working log, so the ref carrying
the highest published seq carries every seq below it, and a span ending at or
below that seq is on that ref.

**The daemon sweeps.** `reconcileDanglingAdvance` (one key, the last) became
`sweepDanglingAdvances` (every key), with ONE `publishedState` for the whole
pass — appending an outcome cannot change the answer, since the committed copy
stays a prefix — and one `finishWithHeadMovedRetry` per provable key. The note
names the ref, the seq, and says in as many words that the RUNTIME observed it
from that ref and that it is not attested by a human, so no reader has to infer
that from the actor field. `already-finished` counts as settled: another writer
closing the books first is the outcome this wanted. What no ref proves is
written nowhere.

**Reported once, everywhere.** `Daemon.reportedDangling` became a Set (one slot
meant an operator learned about the second key only after closing the first).
The startup listing rides the `started` line as `dangling_advances` — it reads
and proves, appending nothing, because the first tick runs a moment later and
sweeps for real — and seeds the set, so the tick that follows does not repeat
it. A cycle that appears mid-run gets exactly one `advance-refused` warning
naming every outstanding key and the bulk command. `authorizeAdvance`'s
`advance-unreconciled` refusal names them all. The `log-advance-cadence` doctor
row names them too, with the bulk command as its `fix`: that row reports how
far behind the records branch is, and reporting it without saying that the thing
which publishes it is blocked reports the symptom and hides the cause.

**The bulk verb.** `approval execution resolve --dangling [--class <class>]
[--yes] [--json]`. It decides nothing the single form would not: human-only,
one `execution.completed` per key through `resolveExecution`'s own
compare-and-append, `exit_code: null`, `attested_by_human: true`, and a
mandatory non-empty note per record — generated rather than typed, because what
it has to say is the evidence the runtime showed and the operator agreed with.
Unprovable keys are listed with their own one-line command and left alone. The
prompter is injected exactly as `gate open`'s is, so "there is no terminal" is
a test rather than a claim. One refused append does not stop the rest; the keys
are independent.

**Global invariants touched.** Two: gate-typed events never accept caller
timestamps (every append here goes through `finishExecution` /
`resolveExecution`, which take the runtime's clock), and every check-then-append
passes through compare-and-append (both do, and the sweep re-runs the whole
operation on a moved head through `core/head-retry.ts`). Two new refusal codes,
`dangling-stdin-not-tty` and `dangling-declined`, distinct from each other and
from `actor-not-human`: "nobody could be asked", "the person said no" and
"the wrong kind of party is asking" are three facts with three next acts. The
conformance vectors were regenerated for the widened union.

**Two shapes the registry had to grow.** The output became an `anyOf` of the
single and bulk objects: collapsing them into one object with everything
optional would make an absent `action_key` mean two different things. The input
arity is a bounded list rather than a positional tuple, because "one action key,
or none with --dangling" is a dependency between a positional and a flag, and a
1-tuple whose `minItems` is 0 is not a tuple at all under the strict Ajv this
registry compiles with.

## For the human: a SPEC sentence, not applied

SPEC's custody section says of an open execution that "nothing repairs it
automatically, and a person closes it by recording what they observed".
APRV-233 already carved out one exception and never wrote it down; this widens
that carve-out, so the sentence is now owed. Draft, for Carter to apply or
amend:

> The runtime's daemon MAY close one class of dangling execution without a
> person: its own log-advance cycles, and only where a ref in its checkout
> demonstrably carries the seq the cycle's idempotency key named. It closes
> every such cycle it can prove, at startup and before each advance it
> authorizes, appending the completion under its own agent actor with a note
> naming the ref that proved it; the record carries no human attestation,
> because none was made. What no ref proves is written down nowhere: it stays
> open, it is reported once rather than once per tick, it blocks every further
> advance, and the refusal that blocks them names each outstanding key. Nothing
> else closes a dangling execution automatically, and no bulk repair may attest
> on a person's behalf: the bulk form of the resolve verb shows a person exactly
> what it can prove, asks once at a terminal, and refuses when there is no
> terminal to ask at.

## Also worth knowing

The branch carries a merge of origin/main taken after APRV-262 (PR #284) and
APRV-266 (PR #290) landed; the only conflict was the conformance manifest, which
both sides had regenerated, and it was resolved by regenerating on the merged
tree.
<!-- SECTION:NOTES:END -->
