---
id: APRV-125
title: >-
  approval log sync / log advance: the log ritual as first-class verbs,
  replacing the stash dance
status: To Do
assignee: []
created_date: '2026-08-20 15:12'
labels:
  - log
  - cli
  - design
  - dogfood
milestone: m-12
dependencies: []
priority: high
ordinal: 117000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Born 2026-08-20 from the human approving a policy.edit prompt that was actually a git stash of the log, and asking whether protected-path touches should gate at all. The answer taken: reads stay free, mutating touches stay gated, and the routine rituals stop being raw shell. The stash-pull-pop dance is our own sanctioned runbook, yet every performance of it (a) mutates the working log through git in exactly the way that forked the chain on 2026-08-20 (APRV-104 notes, fork 2: a rewound working file under a live appender), (b) reaches the phone as an opaque protected-path mutation with a coarse label, and (c) has already produced a stash-pop conflict that corrupted the working log mid-ceremony. The precedent is approval policy amend after the seq 2 incident: when a hand-ritual proves dangerous, it becomes a deterministic verb the gate can read.

TWO VERBS, the two halves of the ritual.

1. approval log sync (the pull half). Deterministic sequence with integrity checks at every step:
   - Preconditions: primary checkout only (same primaryRoot scoping as the hook, APRV-101; refuses in a worktree). Takes the append lockfile for the WHOLE operation so the daemon and hook cannot append mid-sync; that interleaving is precisely what forks. Verifies the working chain clean before touching anything and records head (seq + hash).
   - Snapshot, not stash: copies events.jsonl aside inside .approval/ (atomic write). git stash is never used; the ritual must not route the log through git state mutation.
   - Pulls fast-forward only (git fetch + ff check + merge --ff-only, or refuses named non-ff).
   - Reconcile, the heart of it: after the pull, the committed log must be a PREFIX of the snapshot or equal to it. Prefix: restore the snapshot atomically (the working file keeps the longer chain; the pull only advanced the committed baseline). Equal: nothing to restore. Anything else is a fork: refuse loudly with a machine-readable code (log-diverged), print both heads and the first divergent seq, point at the fork runbook, restore the snapshot, and change nothing else. Chains never merge and the verb must never try (SPEC: re-chaining is fabrication).
   - Projections: QUEUE.md and the index are REBUILT from the reconciled log, never copied back from before the pull.
   - Post: verify the chain again, print head before/after and what the pull brought. The verb appends no event; it is plumbing on the log file, and the log records decisions, not its own housekeeping (decision to confirm at spec sign-off).
   - Failure guarantee: any error on any step restores the snapshot before exiting; the working log is never left in a half state. The snapshot is removed only after the post-verify passes.

2. approval log advance (the commit-and-push half, the APRV-92 flow as a verb):
   - Primary checkout only, append lockfile held while reading.
   - Verifies the chain, then stages EXACTLY .approval/log/events.jsonl, .approval/QUEUE.md, and .approval/payloads/ (nothing else; refuses if other paths are staged), commits on the current branch with a canonical message naming the seq range advanced, and pushes to a named records branch (--branch, default records-log-<date>), never to main directly. Optionally opens the PR (--pr) through the ordinary gated gh path.
   - Refuses on a branch switch being required; it never checks out anything (the checkout is the footgun).

CLASSIFICATION AND POLICY: the verbs get their own classes (proposal: log.sync and log.advance under a log.* namespace) so the policy can hold them at manual while trust builds and relax them independently later; unknown-class fail-close covers older policies. The classifier learns the invocations by name, so the phone prompt says log sync (fast-forward pull with chain reconcile) instead of policy.edit over a stash. Dogfood: start manual; the candidate end state is sync autonomous (it refuses all dangerous cases by construction) and advance supervised.

DOCTOR: a new log-drift check comparing working head against committed head and naming the relationship (ahead-by-N / equal / DIVERGED at seq N) — this is the doctor mitigation named in APRV-104's fork-2 notes, and sync's reconcile is the same comparison, so they share one implementation.

RELATIONSHIP TO OTHER TASKS: APRV-110 (ambient runtime): once these verbs exist, the daemon can run sync after every fetch and offer advance on a schedule; the verbs are the building blocks and 110 should consume rather than reimplement them. APRV-104 fork-2 mitigations: the doctor check lands here; the stronger cure (append path refusing on head mismatch with its last verified head) remains open there and is NOT this task. APRV-117/124: fewer, truthfully-labelled prompts are the shared goal.

INVARIANTS TOUCHED (implementation notes must say so): enforcement paths read only verified records (reconcile reads through verify); every check-then-append is compare-and-append (sync appends nothing, advance appends nothing; both must stay that way); the log is append-only and projections never write back (the rebuild direction is load-bearing); refusals machine-readable and distinct (log-diverged, log-sync-not-primary, log-advance-dirty-stage at minimum). SPEC amendment for section 10 (the two verbs, the reconcile rule, the no-event decision) drafted in the task and flagged for human sign-off before build.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval log sync performs snapshot, ff-only pull, prefix reconcile, projection rebuild, and post-verify under the append lockfile; the working log is byte-identical or strictly-extended afterward, never rewound
- [ ] #2 A diverged committed log refuses log-diverged with both heads and the first divergent seq named; the snapshot is restored; nothing is merged or re-chained
- [ ] #3 Any mid-sync failure restores the snapshot; a kill mid-pull leaves the working log as it started (test with an injected failure per step)
- [ ] #4 git stash appears nowhere in the implementation; the log never routes through git state mutation
- [ ] #5 approval log advance stages exactly the three .approval paths, commits with the seq range in the message, pushes to a records branch, and refuses any other staged path or any required checkout
- [ ] #6 Both verbs refuse outside the primary checkout with a distinct code
- [ ] #7 New classes log.sync and log.advance resolve from the policy; unknown-class fail-close covers policies that predate them; the classifier names the verbs so prompts stop reading policy.edit
- [ ] #8 doctor gains the log-drift check (ahead-by-N / equal / diverged), sharing the reconcile implementation
- [ ] #9 SPEC section 10 amendment drafted and flagged for sign-off before implementation; the no-event decision recorded
- [ ] #10 The dogfood runbook (docs/dogfood-cutover.md) rewritten to use the verbs; the stash dance removed from every doc
<!-- AC:END -->
