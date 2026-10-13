---
id: APRV-403
title: >-
  Daemon drift scan: a lock-timeout or head-moved on the envelope.drift append
  is reported as deferred and retried, the way APRV-381 made the audit sweep
  report it
status: Done
assignee:
  - '@claude'
created_date: '2026-09-20 12:44'
updated_date: '2026-09-22 01:24'
labels:
  - daemon
  - audit
dependencies: []
priority: medium
ordinal: 311000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found while landing APRV-381 (2026-09-20). The end-to-end daemon test that holds the append lockfile for a whole tick shows the drift scan printing append-refused for envelope.drift with a lock-timeout, the same ambiguous line the audit sweep used to print: an operator reads it as a lost record when the scan re-derives and retries on the next tick. Apply the APRV-381 shape to the drift scan: classify lock-timeout and head-moved as transient through the shared isTransientAppendError, report the deferral with the task key and the words that it retries on the next tick, name the retry when it lands, and keep the append-refused form for every non-transient refusal. Tests built through the real append path with a held lock, as in tests/audit.test.ts for APRV-381.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A lock-timeout or head-moved on the envelope.drift append is reported as deferred with the task key and retried on the next tick, and the retry names itself
- [x] #2 Non-transient refusals keep the append-refused form; both shapes tested through the real append path
- [x] #3 docs/cli-reference.md daemon lines updated; build, typecheck, lint, daemon and audit suites pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Reuse APRV-381's classifier rather than copying it. core/audit.ts already exports isTransientAppendError over the closed TRANSIENT_APPEND_CODES list (lock-timeout, head-moved); the drift scan imports it. A closed list means a new append error code is a refusal until somebody decides otherwise, which is the fail-closed reading, and one list means the two sweeps cannot drift apart on what 'transient' means.

2. daemon/daemon.ts gains a 'drift-deferred' warning code, appended to DAEMON_WARNING_CODES so no existing member changes meaning. Distinct from append-refused for the reason APRV-381 gave for sample-deferred: append-refused on a drift record is a fact about the record or the file and wants a person, and this is contention between writers that the next tick resolves by re-deriving.

3. Both envelope.drift append sites take the split: the state-mismatch path in checkOneFile and the envelope-missing path in reportEnvelopeLoss. Transient goes to the deferral line with the TASK KEY and the words that it retries on the next tick; everything else keeps the append-refused form byte for byte.

4. The retry names itself. A process-lifetime set on the Daemon INSTANCE (not a module-level set as in daemon/audit.ts, because a Daemon is already per-run and a fresh instance should claim no retry) remembers which task keys THIS run deferred; the drift event carries retry?: true when the append it deferred lands. It is output bookkeeping: nothing consults it before an append, it gates nothing, it suppresses no line, and it is bounded.

5. Invariant 5 is untouched and the notes say why. The deferral is a REPORTING change: the append still goes through appendEvent with the expectedHead read immediately before it, the decision is still re-derived against that fresh read, and a head-moved is exactly compare-and-append doing its job. Deferring is lossless because scanForDrift re-derives the whole question from the verified log every tick and driftAlreadyLogged keeps it idempotent.

6. docs/cli-reference.md daemon lines get the new warning code beside sample-deferred.

7. Tests in tests/daemon.test.ts, built through the real append path with the real lockfile held in the test process and then released, as tests/audit.test.ts does for APRV-381: the deferral line and its wording, the retry-marked drift on the next tick, and a non-transient refusal keeping the append-refused form.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What was done

APRV-381's shape, applied to the drift scan, with APRV-381's own classifier
rather than a copy of it.

**The split.** `core/audit.ts` exports `isTransientAppendError` over the closed
`TRANSIENT_APPEND_CODES` list (`lock-timeout`, `head-moved`); `daemon/daemon.ts`
imports it. Both `envelope.drift` append sites take the split: the state-mismatch
path in `checkOneFile` and the envelope-missing path in `reportEnvelopeLoss`.
Contention does not care which reason a record carries, and an operator reading a
deferral for one and a refusal for the other would be reading two answers to one
question. One shared list, so the sampling sweep and the drift scan cannot come to
disagree about which failures a retry fixes, and a code added to `core/log.ts`
later is a refusal until somebody decides otherwise.

**The new code is `drift-deferred`**, appended to `DAEMON_WARNING_CODES` so no
existing member changed meaning. The line names the task key, gives the append
error's own code and message, and says the record is NOT lost and the scan
re-derives and retries on the next tick. Every non-transient refusal keeps the
`append-refused` form byte for byte.

**The retry names itself.** A process-lifetime set keyed by (log path, task,
reason), the same standing `daemon/audit.ts` gives its own deferral memory:
memory-only, bounded at 256, output bookkeeping. The `drift` event carries
`retry?: true` only when THIS process deferred the record, and `cli/daemon.ts`
renders it on the line. Keyed by log path as well as task because one process can
be pointed at more than one gate and a task id is unique only inside one.
`resetDriftDeferrals()` is exported for tests, as `resetAuditSweepNotices()` is.

## A defect found while landing this, and fixed with it

Write-back would have erased the evidence the retry needs. `writeBack` runs later
in the same tick and independently rewrites any file whose `state:` disagrees
with the log, with no check that the drift record was actually appended. Under
contention that repaired the file while the record was deferred, so the next tick
found the file agreeing with the log, the retry had nothing to re-derive, and the
deferral an operator had been told about resolved into silence — a correction made
off the record, which is the one thing SPEC 6.3's fixed order ('the event is
appended first and the file is updated second, never the reverse') exists to
prevent. So write-back now skips a file whose drift record this tick deferred.
That is rule 5 of its list, and it is the only place the deferral memory is
consulted for anything other than wording; losing the memory there costs a repair
one tick and never a record. Pinned in both suites: the file is asserted
unchanged after the deferred tick and repaired after the tick that lands the
record.

## Invariant 5 (every check-then-append passes through compare-and-append)

Touched in the sense that this task is entirely about what happens when
compare-and-append refuses, and NOT weakened. Nothing about the append changed:
the record is still placed by `appendEvent` against the `expectedHead` of a read
taken immediately before it, and the whole drift decision is still remade against
that fresh read (the pre-existing APRV-211 re-derivation). A `head-moved` here IS
compare-and-append working — another writer landed a record between this scan's
read and its append — and deferring is the only answer that neither writes
against a head the scan never saw nor loses the observation. What changed is one
warning code and one sentence. Deferring is provably lossless for the same reason
APRV-381's was: `scanForDrift` carries nothing between ticks, re-reads the folder,
re-derives the state from the verified log, and `driftAlreadyLogged` keeps a
repeat idempotent.

Also touched, and reinforced rather than weakened: SPEC 6.3's append-then-write
order, by the write-back fix above.

## Evidence per criterion

- **AC1** (lock-timeout or head-moved reported as deferred with the task key and
  retried on the next tick, the retry naming itself).
  tests/daemon-drift-deferral.test.ts 'a held lock defers the drift record by
  name and promises the retry' holds the REAL lockfile while an in-process tick
  runs: one drift-deferred warning, matching /task-042/, /lock-timeout/,
  /retries on the next tick/ and /NOT lost/, zero append-refused, zero drift
  lines, log length unchanged, and the task file unrepaired. 'the retry lands on
  the next tick of the same run and says so' then asserts retry === true on the
  drift event, exactly one envelope.drift record, one deferral line across both
  ticks, the file repaired after the record, and a third tick doing nothing.
  tests/daemon.test.ts 'drift: a held lock is one drift-deferred warning, and the
  record lands next tick' establishes the same out of a real
  `daemon run --once` process, on the JSON a supervisor reads.
- **AC2** (non-transient refusals keep the append-refused form; both shapes
  tested through the real append path). 'a refusal a retry cannot fix keeps the
  append-refused form' runs the tick against a copy of schema/ with
  envelope.drift struck from the event enum, so the refusal is the real write
  boundary's own `validation`: one append-refused matching
  /^envelope\.drift for task-042 was not appended \(validation\)/, no deferral,
  no 'retries' wording, nothing written, and the file repaired as before (a
  refusal is not a deferral, so it does not hold write-back back). Both shapes
  are the real append path: a held lockfile and a real schema refusal, no stubs
  and no injected errors. 'the envelope-missing reason takes the same split'
  covers APRV-63's other reason, and 'a run that never deferred claims no retry'
  and 'a restarted daemon makes the append and claims nothing' pin the marker's
  scope.
- **AC3** (docs updated; build, typecheck, lint, daemon and audit suites pass).
  docs/cli-reference.md lists drift-deferred in the daemon warning-code set and
  gains 'A drift record that met another writer is deferred too (APRV-403)' with
  the two-line worked example beside APRV-381's.

## Validation

- npm run build: exit 0. npm run typecheck: exit 0. npm run lint: exit 0, no
  output.
- node scripts/run-tests.mjs --only daemon-drift-deferral: 6 tests, 6 pass, 0
  fail.
- node scripts/run-tests.mjs --only daemon: 44 tests, 44 pass, 0 fail (43 before
  this task, 1 added).
- node scripts/run-tests.mjs --only audit cli-status: 66 tests, 66 pass, 0 fail.
  APRV-381's own contention case still passes; its comment about the drift scan
  reporting append-refused in the same tick was stale after this change and was
  rewritten rather than left to mislead.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
A lock-timeout or head-moved on an envelope.drift append is now a drift-deferred warning naming the task and saying the scan retries on the next tick, and the drift line that lands carries retry so the pair closes; every other append refusal keeps the append-refused form. The classifier is APRV-381's own isTransientAppendError over its closed list, imported rather than copied, so the drift scan and the sampling sweep cannot disagree about which failures a retry fixes. Both drift reasons take the split. Landing it surfaced a real defect and fixed it: write-back repaired the file while the record was deferred, correcting the disagreement off the record and erasing what the retry re-derives, so write-back now skips a file whose drift record this tick could not append (SPEC 6.3's append-then-write order, enforced rather than assumed under contention). Nothing about the append changed, so invariant 5 is untouched: the expectedHead is still the head of a read taken immediately before, and a head-moved is compare-and-append doing its job. Verified with build, typecheck and lint at exit 0, tests/daemon-drift-deferral.test.ts 6/6 against the real lockfile and a real schema refusal, tests/daemon.test.ts 44/44 including a new end-to-end case out of a real daemon run --once, and audit + cli-status 66/66. The merge is NOT armed: the gate daemon is down for this session.
<!-- SECTION:FINAL_SUMMARY:END -->
