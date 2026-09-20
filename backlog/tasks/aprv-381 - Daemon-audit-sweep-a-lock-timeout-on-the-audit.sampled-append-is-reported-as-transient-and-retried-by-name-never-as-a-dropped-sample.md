---
id: APRV-381
title: >-
  Daemon audit sweep: a lock-timeout on the audit.sampled append is reported as
  transient and retried by name, never as a dropped sample
status: Done
assignee:
  - '@opus-lane-381'
created_date: '2026-09-19 16:09'
updated_date: '2026-09-20 12:44'
labels:
  - daemon
  - audit
  - sampling
dependencies: []
priority: medium
ordinal: 295000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-09-19 ~16:00Z in the primary daemon (approval up) right after a lane hook append and a records advance were writing the same log: tick 7405 printed "append-refused audit sampling: append-failed: audit.sampled for hook:...:vcs.push.main was not appended (lock-timeout): another writer holds .approval/log/events.jsonl.lock; gave up after 2000ms". Reading src/core/audit.ts: pendingSamples re-derives eligible, selected, not-yet-sampled candidates from the log on every sweep, so the dropped sample is retried on the next tick and the log shows head moving 51446 to 51448 over the following ticks; nothing was lost. Two things are wrong anyway. (1) The message says the sample was not appended and nothing more, so an operator reading the daemon window (Carter did) takes it as a lost audit record; the sweep should classify a lock-timeout (and head-moved from src/core/log.ts) as transient, say it will retry on the next tick, and confirm by a follow-up line when the retry appends, with the action key. A refusal that is not transient (schema, chain, policy) keeps the current form. (2) DEFAULT_LOCK_TIMEOUT_MS is 2000 for every writer; the daemon own appends contend with hook appends from several lanes and with approval log advance, which holds the lock for the whole verify-and-commit. Decide whether the daemon sweep should wait longer (it is the one writer that can afford to) or back off and skip the sweep when the lock is held, and record the decision. Related: APRV-40 (sampling), APRV-57 (sample line), APRV-150 (append race), APRV-123 (unappendable verdict is a refusal; not touched here, a sample is not a verdict).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A lock-timeout or head-moved on the audit.sampled append is reported as transient with the action key and the words that it retries on the next tick; a later successful append of the same sample prints a line naming it as the retry
- [x] #2 A non-transient append refusal keeps the existing append-refused form, with a test for each of the two shapes built through the real append path (a held lock in the test process, then released)
- [x] #3 The daemon sweep lock wait is decided (longer wait or skip-and-retry) and documented in the sweep header and docs/cli-reference.md under up or daemon run
- [x] #4 build, typecheck, lint, daemon and audit suites pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. core/audit.ts: classify the append refusals a sampling sweep can retry. Add TRANSIENT_APPEND_CODES (lock-timeout, head-moved) plus a predicate, and split SampleSweepResult into refusals (unchanged meaning: schema, chain, policy, io) and a new deferred list whose entries carry the candidate (action key, subject seq, hash) and the AppendError. The loop still breaks after the first refusal of either kind, still re-reads the verified log before every append, and still passes expectedHead, so the sample append stays a compare-and-append.
2. daemon/audit.ts: report the two kinds on two sinks. warn keeps the existing "audit sampling: <code>: <message>" form for a non-transient refusal. A new defer sink gets a line naming the action key, the transient code and the words that the sweep retries it on the next tick; when the caller passes no defer sink the deferral falls back to warn, so no deferral can be silent. Add an output-only, process-lifetime memory of deferred subject hashes (same standing as the existing once-per-process notice set, bounded, never consulted by an append) so the sweep can tell the caller that a later successful append is the retry: sampled(sample, retry) gains the flag.
3. daemon/daemon.ts: add sample-deferred to DAEMON_WARNING_CODES (additive, as anchor-reread was), map the defer sink onto it, and grow the sampled DaemonEvent with an optional retry flag. cli/daemon.ts renders the retry in the human line.
4. AC3 decision: skip-and-retry at the existing 2000 ms; no longer wait and no lockfile pre-check. Recorded in the sweep header and in docs/cli-reference.md under daemon run and up, with the reasoning (the tick is serial so a blocking wait costs the queue, the write-back and the expiry lines; the contenders hold the lock across a whole verify-and-commit or a baseline move, spans no polite wait covers; the deferral is provably lossless because pendingSamples re-derives pendency from the verified log; a lockfile peek would be a check that can be wrong in both directions, so the append lock stays the only authority).
5. Tests. tests/audit.test.ts: hold the append lock in the test process around a sweep (the underHeldLock pattern from evidence-append), assert the deferred line, that nothing was appended and that the elapsed wait shows the sweep paid the default and no more; release, sweep again, assert the retry-marked sample; a second case with a schema directory that rejects audit.sampled for the non-transient shape; a case with no defer sink to prove the warn fallback. tests/daemon.test.ts: one end-to-end pass with the lock held, asserting the warning code and message an operator reads, and that a fresh process which did not defer claims no retry.
6. Verify build, typecheck, lint, the audit and daemon suites, then a full test run against the baseline; write the implementation notes naming the SPEC 11.1 invariants touched.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
WHAT CHANGED. A lock-timeout or head-moved on the audit.sampled append is now a DEFERRAL rather than a refusal, everywhere the two words differ. core/audit.ts gained TRANSIENT_APPEND_CODES (lock-timeout, head-moved) with a predicate, and SampleSweepResult gained a deferred list beside refusals; the sweep routes a transient failure there carrying the whole candidate, so the reporting layer has the action key without parsing a sentence. The list is closed in the fail-closed direction: an append error code added to core/log.ts later is a refusal until somebody decides otherwise. daemon/audit.ts reports a deferral on a new defer sink, in a line that names the action key, the transient code and the words that the sweep retries it on the next tick, and states that the sample is not lost because it is still pending in the terms the log itself carries. A caller passing no defer sink gets the same text on warn: a deferral nobody prints is, to the person who has to trust this log, the same thing as a dropped sample. Every other refusal keeps the pre-existing form, byte for byte.

THE RETRY NAMES ITSELF, without the log learning anything. pendingSamples already re-derives pendency, so the retry HAPPENS with no memory; only the claim to be a retry needs one. daemon/audit.ts keeps a process-lifetime set of deferred subject hashes with exactly the standing of the existing once-per-process notice set: output bookkeeping, consulted by no append, gating nothing, suppressing no line, bounded at 256 with the oldest evicted, and reset alongside the notices for tests. Losing it costs the word retry on one line. The sampled sink now takes (sample, retry), the daemon puts retry: true on its sampled event only when true (additive, so the shape supervisors parse is unchanged otherwise), and cli/daemon.ts renders it. A restarted daemon still makes the append and claims no retry, because the loop says only what it witnessed; the daemon end-to-end test pins exactly that.

AC3 DECISION: SKIP AND RETRY, AT THE EXISTING 2000 MS. No longer wait, no lockfile pre-check, and no flag. Recorded in the sweep header in full and in docs/cli-reference.md under daemon run. Four reasons. A tick is serial, so every millisecond this sweep blocks is a millisecond the expiry lines, the state write-back and QUEUE.md wait, and that is latency a person notices spent on a record that costs nothing to postpone. The writers it contends with hold the lock across spans no polite wait covers: approval log advance across a whole verify-and-commit, approval log sync across a baseline move, so a wait long enough to win those reliably stalls the loop for seconds and would still time out sometimes, which means the transient path has to exist either way. Deferring is provably lossless, since pendency is a property of the log and the retry bound is the tick interval, usually the next debounce because any append wakes the log watcher. And the appends this sweep would be muscling in front of are the ones somebody is waiting on: a hook gate verdict, a lane execution record, an advance commit; the writer with nobody blocked on it is the one that should yield. Skip here means letting the append refuse and classifying it, never peeking at the lockfile, which is a read that can be wrong in both directions while appendEvent acquisition under the lock is the only authority.

SPEC 11.1 INVARIANTS TOUCHED. Every check-then-append still passes through compare-and-append: appendSample is unchanged, still re-reads the verified log before each append and still passes expectedHead, and nothing here retries in place or re-appends blindly; a retry is a whole new sweep with a new read, a new derivation and a new head. Refusals stay machine-readable and distinct, which is the point of the change: sample-deferred is its own code in the closed DAEMON_WARNING_CODES union rather than a different sentence under append-refused. Enforcement paths read only verified records (readVerifiedRecords, untouched). Gate-typed events never accept caller timestamps: audit.sampled still takes the injected clock and no ts. Nothing self-reported reduces scrutiny, since the only new input is an append error code the writer produced.

OBSERVED IN PASSING, NOT FIXED, AND WORTH A TASK A HUMAN OPENS. The daemon end-to-end case holds the lockfile for a whole tick, and the DRIFT scan hits it too: the tick prints append-refused with envelope.drift for task-042 was not appended (lock-timeout). That is the same ambiguity this task removed for the sample, in a different sweep, and the fix would be the same shape. The test asserts only that nothing about the SAMPLE reads as a refusal, and says in a comment why the other line is left standing. Not expanded into this diff, and no follow-up task created, because the finalization guide reserves that for the human.

VERIFICATION. build, typecheck and lint each exit 0. Suites: audit 41 tests 41 pass exit 0; daemon 38 tests 38 pass exit 0; the two together 79 pass 0 fail; the neighbours (audit-index, daemon-advance, daemon-advance-sweep, daemon-projection, daemon-tick-cost, concurrency, head-retry, evidence-append, log, log-anchor) 166 tests 166 pass 0 fail. Full npm test: 4932 tests, 4909 pass, 22 fail, 1 skipped, exit 1; all 22 are the pre-existing SMTP and email failures of this environment (adapter-email, cli-setup email probe, smtp-probe), every one of them the TLS servername-on-an-IP error, which matches the stated baseline of about 22 and touches nothing in this diff. The two held-lock tests each pay the real 2000 ms wait rather than injecting a shorter one, so the elapsed time is itself the evidence for the AC3 decision: a longer wait would show up as a slower test.

Orchestrator review (Fable, 2026-09-20): accepted as built, skip-and-retry at the existing 2000 ms. The drift scan follow-up the lane named is filed as the task created just before this note.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The audit sweep now distinguishes contention from failure. A lock-timeout or head-moved on the audit.sampled append is classified transient in core/audit.ts and reported by daemon/audit.ts on its own defer sink, naming the action key and saying that it retries it on the next tick, which the daemon prints under a new sample-deferred warning code; the append that follows carries retry so the pair closes in the window an operator reads. Every other refusal keeps the append-refused form. The lock wait decision is skip-and-retry at the existing 2000 ms, no longer wait and no lockfile pre-check, written out in the sweep header and in docs/cli-reference.md under daemon run. Verified by tests that hold the real lockfile in the test process and then release it, with logs built only through the real append path: audit 41 pass, daemon 38 pass, neighbours 166 pass, build, typecheck and lint exit 0, full suite 4909 pass with only the 22 pre-existing SMTP and email failures of this environment.
<!-- SECTION:FINAL_SUMMARY:END -->
