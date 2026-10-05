---
id: APRV-479
title: >-
  A hook killed by a default-disposition signal mid-append leaves
  events.jsonl.lock behind, and a lock that is never stolen wedges every writer
status: In Progress
assignee:
  - '@claude-edge-A2'
  - '@claude-edge-A2-r3'
created_date: '2026-10-05 05:49'
updated_date: '2026-10-05 11:09'
labels:
  - security
dependencies: []
priority: medium
ordinal: 365000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From the APRV-478 refuter (PR #612, 2026-10-05). Pre-existing, not changed by APRV-478. On the non-Hermes harness hooks no SIGTERM/SIGINT listener is registered outside the wait (APRV-477 scope), so a signal that lands while the process holds <log>.lock (inside appendEvent's lockedRun, on the carried-grant spend or the unattended charge) kills it before releaseLock runs. core/log.ts never steals a lock (by design: stealing is how two writers share a seq), so every later writer, the daemon included, refuses lock-timeout until a human removes the file. Same for any CLI verb killed by SIGKILL mid-append. Decide: a guard that defers the default disposition while the lock is held (a listener that only records the signal and re-raises after release), an owner-pid in the lockfile plus a doctor/status line naming a lock whose owner is dead, or both; stealing stays out.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A repro (kill a hook or verb with SIGTERM while it holds the lock) is a test, and the chosen behaviour is pinned
- [x] #2 No path steals a live writer's lock
- [x] #3 A lock-timeout refusal names the lockfile's holder, why its lock was kept, and the human command (`approval log unlock --pid <n>`, or `rm -v` for a non-lockfile)
- [x] #4 A lock whose holder is provably gone (same pid namespace and boot) is taken by a writer only after its whole lock timeout, by one exclusive claim and one atomic take, and recorded as audit.lock_reclaimed before that writer's own record; compare-and-append is unchanged
- [x] #5 A lockfile with no holder record is taken only once it is ten minutes old; a lock beside a log sync snapshot or an absent log is kept
- [x] #6 Writers racing to reclaim one stale lock: exactly one reclaims, every append lands, the chain verifies
- [x] #7 Docs (hermes-hook.md, claude-code-hook.md, cli-reference.md), CHANGELOG Unreleased, proposed SPEC hunks in notes
- [x] #8 A lock no writer can judge (another container or boot) is cleared by a human-only verb that records who did it
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Round 3 (claude-edge/A2-r3): replace the round-1/2 mechanism with the orchestrator's smaller design. See notes.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Round 3, the smaller design (claude-edge/A2-r3, 2026-10-05, on bdd03eb6). Ruling: three refuter rounds each added states and each new state carried new defects; the remaining risk was structural (the lock directory is writable by the agent). Replace, do not extend.

What the code does now (src/core/log-lock.ts, src/core/log.ts):
- The lockfile names its holder (one JSON line: pid, host, boot, Linux pidns/start/timens, created, op, nonce). Kept from round 0.
- Strict reads: O_RDONLY|O_NONBLOCK|O_NOFOLLOW, regular file of at most 4 KiB, else "not ours to judge" (live; the refusal says `rm -v`). A lockfile is v1 only if every field parses strictly (pid 1..2^31-1, created round-trips through toISOString, op enum); empty is legacy; anything else (another version, malformed JSON, text, Feb 30, op "steal") is never judged.
- When: only inside a writer's own lock wait, after its full timeout (2 s default; a try-once caller's timeout is 0). A lock that moved or that another writer is reclaiming sends it back to wait again, at most 3 times.
- Gone, Linux: /proc is this pid namespace's (/proc/self == pid), the record's boot id and pidns equal ours, then kill(pid,0) ESRCH with /proc/<pid> absent or Z/X, or /proc/<pid>/stat names a process whose start time (same time namespace) differs. Gone, elsewhere: same hostname, boot readings within 60 s, kill(pid,0) ESRCH. Everything else is live: EPERM, a zombie kill still finds, another namespace/boot/host, /proc unreadable, a record without start whose pid exists. Reason set: holder-dead, legacy-aged.
- Legacy (empty) lockfile: taken only when its mtime is >= 10 minutes old.
- The reclaim, two atomic steps, nothing else written: (1) claim = link(2) of the lock's path to `<lock>.stale.<pid>.<created ms>` (legacy: `.stale.legacy.<mtime ns>`), EEXIST for every other reclaimer of the same lockfile, then read back and compared (inode, mtime ns, bytes) with the judged file; a mismatch means the lock changed hands, so the reclaimer unlinks its own link and waits again; (2) take = this writer's complete lockfile written to `<lock>.take.<pid>.<nonce>` and rename(2)d over the lock's path. Then the record (`audit.lock_reclaimed`, system:log, lockfile/reason/age_ms/holder{pid,op,created}) is the first append under the new lock, and only then is the stale name unlinked.
- Signal guard (SIGTERM/SIGINT/SIGHUP, only where no listener exists): installed BEFORE every create (normal wx and the reclaim's take file), released and settled at once on EEXIST (so the lock wait runs unguarded), held until the lockfile is removed. Closes R2-B3. Kept from round 2: `approval run` yields before spawning; amend, wait and the bridge settle the guard before a synchronous wait.
- Human verb: `approval log unlock --pid <n|none> --as human:<id>` (src/cli/log-unlock.ts, core/log.ts unlockAppendLock, core/log-lock.ts takeLockForUnlock). Refuses a pid that is not the record's, a holder it sees running (Linux same start time; elsewhere the pid on this host in this boot), a lock beside a sync snapshot, an absent log, and a non-lockfile (says rm -v). Takes the lock by the same claim and take (clearing a dead claimant's or planted stale name first, on the human's word that no writer runs) and records `audit.lock_reclaimed` under the human actor with reason `operator-cleared` (orchestrator, 11:2xZ: a human's word is not proof; the schema binds operator-cleared to a human: actor and holder-dead/legacy-aged to system:). Classified policy.core (rule approval-log-unlock), as `log checkpoint` is; not in the verb registry, as `log checkpoint` is not.

Deviations from the ruling, each for a reason the refuter should check:
- The ruling's step 4 was ONE rename of the judged lockfile to the stale name, then the normal wx take. That forks: R1 and R2 both judge dead lock L; R2 renames L aside and wx-creates L2; R1 (stalled between its judgement and its rename) then renames L2, R2's LIVE lock, aside and wx-creates L3; R1 and R2 append together. A post-rename check cannot repair it (L2 is already off the path; a third writer can create there before any put-back). So the claim is a link(2) (exclusive, moves nothing) and the take is a rename(2) of the taker's own file over the claimed path (the path is never empty). Same file count, same deterministic stale name.
- Consequence for "a planted file at the stale name is overwritten": with link, a file already at the stale name makes the claim fail. It is neither trusted nor removed (removing it could remove a live claimant's claim and admit a second taker); the lock is kept, the refusal names the stale file and `approval log unlock --pid <n>`, which clears both. Test pins this.
- A reclaimer SIGKILLed between its claim and its take leaves the stale name holding the judged file: every later writer sees another claimant and waits, then refuses naming unlock. A wedge, never a fork; tested.
- Linux zombie: the ruling's AND (ESRCH and Z/X) is kept literally, so a zombie that kill(pid,0) still finds is live until reaped (then ESRCH). Safe direction.

Removed, and why (each was a state a refuter round found a defect in):
- Claim generations and claimant-identity claim files (round 1): replaced by one deterministic link name; a dead claimant is a wedge for a human, not a generation chain.
- The pending rename and `events.jsonl.lock.d/{claims,pending,quarantine}` (rounds 1-2): no file is left to be recorded by "whichever writer comes next"; the reclaimer records its own reclaim under the lock it took. Planted-pending starvation (R2-B1), FIFO-in-pending hangs (RB1), cross-uid directory ownership (SN1), unlistable directories (RB3) and the scan bound (RS3) all go with it.
- `unverified` records, `reclaim_id`, last-line dedupe (round 2): nothing is recorded that the recorder did not itself judge; no duplicates path exists (SN2).
- The append code `reclaim-pending-unreadable` (round 2): gone, APPEND_ERROR_CODES and refusal-unions are back to main's (28.0.0, no change), resolving SN3.
- `holder-replaced` reason (a reused pid is `holder-dead`), `describeLogLock`, the put-back path, the claim/reclaim seams.
- Net: src/core/log-lock.ts 1462 -> 1003 lines (911 removed, 452 added, of which the human verb's take is about 75).

Residue (stated):
- A reclaimer killed after its take but before its record lands leaves the reclaim unrecorded; the stale file stays beside the lock as evidence (export-excluded). Same for a record the log refuses (torn tail, full disk); then nothing else is appended either.
- A signal that lands in a failed create attempt's microseconds is dropped when the guard is settled on EEXIST (Node drops a held signal whose last listener is removed before the loop turns). A signal during the wait itself kills at once.
- A synchronous run of appends holds signals until the loop turns (SN6, unchanged).
- macOS: a holder pid reused within the same boot is live until that process exits, and unlock refuses it (running).
- unlock asserts no writer is running; run during an in-flight reclaim of the same lock it could take alongside it.
- The SPEC.md commit bdd03eb6 (round-2 wording) is reverted by 70558d5a at the orchestrator's instruction: the branch's SPEC.md equals main's, and the hunks below are the proposal pending Carter's sign-off.

### Proposed SPEC.md hunks, PENDING SIGN-OFF (SPEC.md untouched by this round)

Section 8, event list: add `audit.lock_reclaimed` after `audit.question_preempted`, and the bullet: *`audit.lock_reclaimed`* (audit tier): the append lock was taken over from a holder that is gone; the first record under the lock that was taken. `system:log` when the writer proved the holder gone, `human:` when a person ran `approval log unlock`. Payload: `lockfile` (base name), `reason` (`holder-dead` | `legacy-aged` from the writer; `operator-cleared` from a human, and only from one), `age_ms`, and, when the lockfile carried one, the strictly parsed `holder` {pid, op, created}; nothing else is taken from the file.

Section 11.1 invariant 5, scope note: *Scope note:* the append lock MUST NOT be taken from a holder that may be alive. A writer MAY take a lock whose holder is provably gone in its own process namespace and boot, only after its full lock timeout, and only by an exclusive claim that never moves a file it did not judge; any holder it cannot see into MUST be treated as live, and is cleared only by a human. The reclaim MUST be the first record appended under the lock taken. (Amended APRV-479, pending sign-off.)

Section 11.2, `lock-timeout` row: "A stale lock is never stolen" becomes "A lock is taken from a holder only when it is provably gone (section 11.1 invariant 5); the message names the holder and the human command".

### Validation (round 3)

See the PR body "Round 3: smaller design" for the test table with exit codes. Mutations (dist edited, rebuilt after each): liveness always gone exit 1 (10 fail incl. the live-holder test); guard no-op exit 1 (4 fail: every SIGTERM test); claim EEXIST treated as claimed exit 1 (3 fail incl. the two-reclaimers test); guard installed after create exit 1 (1 fail: the create-window SIGTERM test).

Main (#614) merged in at 5801c282 (a merge, not a rebase: the branch was pushed and under review; new commits only); schema-validation regenerated at 3.1.0 on top of 3.0.0.

Remaining: refuter on the round-3 diff, CI, the owner's SPEC sign-off, merge. Not armed.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
A writer killed while holding events.jsonl.lock no longer wedges the gate when it died in the same pid namespace and boot as the next writer (the village's same-container restart; a Railway recreate gives a fresh filesystem). The lockfile names its holder; a writer that has waited out its whole lock timeout judges it once and, only when the holder is provably gone, claims it with one exclusive link(2) to a deterministic stale name and takes it with one rename(2) of its own lockfile, then appends audit.lock_reclaimed (new audit-tier type, schema-validation 3.1.0) as the first record. Everything it cannot judge is live and names `approval log unlock --pid <n>`, a new human-only verb that records the person. The signal guard is installed before any lockfile is created. Round 3 removed claim generations, pending/quarantine directories, unverified records, reclaim_id dedupe and the reclaim-pending-unreadable code.
<!-- SECTION:FINAL_SUMMARY:END -->
