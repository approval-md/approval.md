---
id: APRV-479
title: >-
  A hook killed by a default-disposition signal mid-append leaves
  events.jsonl.lock behind, and a lock that is never stolen wedges every writer
status: In Progress
assignee:
  - '@claude-edge-A2'
created_date: '2026-10-05 05:49'
updated_date: '2026-10-05 07:48'
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
- [x] #3 A lock-timeout refusal names the lockfile's holder and why its lock was kept; describeLogLock (core/log-lock.ts) describes a lockfile without touching it
- [x] #4 A lock whose holder is provably gone is reclaimed atomically by the next writer (once per wait), recorded as audit.lock_reclaimed before that writer's own record; compare-and-append is unchanged
- [x] #5 A lockfile with no holder record is reclaimed only once it is ten minutes old; a lock beside a log sync snapshot or an absent log is kept
- [x] #6 Writers racing to reclaim one stale lock: exactly one reclaims, every append lands, the chain verifies
- [x] #7 Docs (hermes-hook.md, claude-code-hook.md), CHANGELOG Unreleased, proposed SPEC hunks in notes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/core/log-lock.ts (new): the lockfile's holder record (v1 JSON: pid, host, boot, pidns/start on Linux, created, op, nonce), the liveness judgement per platform (Linux: same boot_id + pid namespace, /proc/<pid>/stat state + starttime; macOS/other: same host, kill(pid,0), boot from os.uptime; anything unverifiable is live), the atomic reclaim (exclusive link aside keyed by the stale lock's inode, verify identity by inode+content+mtime, rename the path aside, re-verify, restore on mismatch), refusal guards (a log sync snapshot beside the log, an absent log), and the termination-signal guard (defer SIGTERM/SIGINT/SIGHUP while a lock is held when no listener owns them, re-raise on the loop).
2. src/core/log.ts: acquireLock writes the holder record, tries the reclaim once per wait (first EEXIST), names the holder on lock-timeout; releaseLock unlinks only its own record; lockedRun appends audit.lock_reclaimed as the first write under a lock that followed a reclaim (fresh tail read, no head precondition), then runs the caller (whose compare-and-append sees the moved head).
3. Schema: audit.lock_reclaimed (system actor, payload lockfile/reason/holder/age_ms), fixtures, EventType union, conformance vectors regenerated (schema-validation minor bump).
4. Tests tests/log-lock-reclaim.test.ts: dead pid reclaimed + record; live pid times out; replaced pid (Linux real, decision unit test everywhere); legacy younger/older; sync snapshot refuses; SIGTERM mid-append releases (child process, stalled write layer); concurrent reclaimers (one record, all appends, chain verifies); mutation with liveness disabled.
5. Docs (hermes-hook.md, claude-code-hook.md residue paragraphs), CHANGELOG Unreleased, SPEC section 8 and 11.1 proposed hunks in notes. typecheck, lint, targeted tests.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Decision (orchestrator brief, wave 2 lane A2, overrides the description's "stealing stays out"): a lock is RECLAIMED, but only from a holder that is provably gone; a live holder, or one this process cannot check, is never taken. The description's other option (defer the default disposition while the lock is held) is also done, for SIGTERM/SIGINT/SIGHUP. AC #2 of the original list (doctor/status names a dead-owner lock without removing it) was replaced: a dead owner's lock is now removed by the next writer and recorded; a kept lock is named, with the reason, in every lock-timeout refusal, and core/log-lock.ts exports describeLogLock for a later doctor row (not wired; no doctor row added, to keep the doctor roster and README count untouched).

Approach.
- src/core/log-lock.ts (new). Holder record: one JSON line written into the lockfile right after the wx create, {v:1, pid, host, boot, pidns?, start?, created, op: append|hold, nonce}. Linux: boot = /proc/sys/kernel/random/boot_id, pidns = readlink /proc/self/ns/pid, start = field 22 of /proc/self/stat. Elsewhere: boot = "~<now - os.uptime()>" seconds. Read once per process.
- Liveness (judgeHolder, pure, probe injected). LINUX: needs our own boot+pidns and the holder's; holder boot differs: same hostname -> gone (holder-boot-ended), else live (another machine); pidns differs -> live (another container); /proc/<pid>/stat absent -> gone (holder-dead); state Z or X -> gone (holder-dead, a zombie holds nothing); start differs -> gone (holder-replaced); same start -> live; no start in the record -> live. macOS / OTHER: another host -> live; a record written under Linux -> live; boot moved by more than 600 s -> gone (holder-boot-ended); kill(pid,0) ESRCH -> gone (holder-dead); pid exists (EPERM counts) -> LIVE: macOS has no ps-free start-time read (verified: the sysctl CLI cannot read kern.proc.pid.N, "unknown oid"), so "cannot verify" is treated as live, as the brief allows. A reused pid on macOS therefore keeps the lock until that process exits.
- Unattributed lockfile (empty or unparseable: an older version, or a writer killed between create and write): reclaimed only when its mtime is >= LEGACY_LOCK_RECLAIM_AGE_MS (10 min), reason legacy-aged, no holder in the record. A record of an unknown version is never reclaimed.
- Refusals regardless of holder: <log>.sync-snapshot exists (a log sync killed part way can leave the working log at its committed bytes; appending there forks the chain), or the log file is absent.
- Atomic reclaim (tryReclaimLock). The brief's "rename aside, re-check" alone lets two reclaimers move each other's FRESH lock (ABA: R1 renames the stale X, takes Y; R2 then renames Y), and restoring Y can race a third writer. So step 1 is an exclusive claim: link(2) the lockfile to <lock>.reclaim-<ino>.lock, which fails EEXIST for every other reclaimer of the same file; step 2 re-reads the claimed file and requires the same inode, bytes (the nonce) and mtime as the one judged (inode alone is not enough: ext4 reuses a freed inode at once); step 3 renames the lockfile aside to <lock>.reclaim-<ino>.gone.lock and re-checks identity, putting it back with link(2) if it is not the judged file; step 4 unlinks both names. The writer then takes the lock with the same wx create as everyone. A claim name older than 10 s whose inode is still the judged file is an abandoned reclaim (reclaimer killed between link and rename): cleared, and the next wait reclaims. All names end in .lock so the daemon watcher's bookkeeping filter already ignores them. A filesystem without hard links refuses the claim: the lock is kept (fail closed, as before).
- src/core/log.ts. acquireLock: on the FIRST EEXIST of a wait (never per retry) calls tryReclaimLock; reclaimed or vanished -> the create again at once; kept -> the reason is appended to the lock-timeout message ("another writer holds ...; gave up after Nms (held by pid N on host is running ...)"). releaseLock unlinks only the lockfile this process created (same inode and bytes). lockedRun installs the signal guard before the lockfile exists, and after a reclaim appends audit.lock_reclaimed through appendUnderLock (the extracted body of appendEvent: fresh tail read, schema, fsync, daemon stamp; no head precondition, since it decides nothing from the log) as the first write under the new lock, before the caller's own read. If that record cannot be appended the caller's operation is refused with the writer's error (lock released). appendEvent and withAppendLock pass op append / hold.
- Signal guard (guardTerminationWhileLocked). For each of SIGTERM, SIGINT, SIGHUP with NO listener, a listener is registered while any lock is held. A lock is only ever held inside synchronous code, so a signal arriving then is dispatched after the release; the listener removes the guards and, if nobody else now listens, process.kill(self, signal) with the default disposition, so the process dies of the signal one append later and the lockfile is gone. Guards are removed two setImmediate hops after the last release (removing synchronously would drop a held signal, APRV-478's finding). Not installed when any listener exists: the approval bin's Hermes guard (cli.js), the Hermes early guard and every wait handler own the signal there, and they already deferred it. No-op on Windows.
- Schema: audit.lock_reclaimed (nineteenth addition, thirty-five types), actor ^system: (the writer uses system:log), payload {lockfile (base name, no path), reason (holder-dead | holder-replaced | holder-boot-ended | legacy-aged), age_ms, holder?: {pid, op, created}}, additionalProperties false. The holder's host is deliberately NOT recorded (logs get committed; a machine name is not the log's business). Five fixtures (2 valid, 3 invalid), conformance vectors regenerated, schema-validation 2.10.0 (minor: no expectation moved). Checked the audit family first: dark_session, decision_refused, gesture_refused, question_preempted are all about a human gesture, a question or a sweep; none fits, so a new type rather than a reused shape.

Invariants (SPEC 11.1). 5 compare-and-append: unchanged; the reclaim record moves the head under the lock, so a caller holding an older head is refused head-moved and re-reads (pinned). 8: unchanged; a refused reclaim record refuses the caller's operation, a kept lock still times out and denies. 1, 2 (ts of the reclaim record is assigned at the write boundary, never a caller's), 4 (the holder record is never read by any verdict; it only decides whether a lock may be taken, and every unverifiable case resolves to "keep"), 6 (no refusal code added or changed; lock-timeout message text only extended at its end, existing regex pins still match).

Stated trades and residue.
1. Ordering: the reclaim record is the first write under the RECLAIMER's lock. A writer whose own wx create wins the instant after the stale lockfile is removed is ordinary contention and may append before the reclaim record (seen in the race test); nothing is ever appended under the stale lock.
2. macOS pid reuse: a running pid is taken as the holder (no ps-free start time), so a stale lock whose pid was reused stays until that process exits. A reboot is detected by boot time (600 s tolerance).
3. Linux hostname: "earlier boot of this host" is inferred from the same hostname with a different boot id. Two machines sharing the log's filesystem under one hostname would break that inference.
4. Cross-container: a lock written in another pid namespace or on another machine is never reclaimed. A Railway/sandbox RECREATE that kills a hook mid-append with SIGKILL leaves a lock in a namespace the new container cannot inspect; that tenant stays wedged until a human removes the file, as before (the lock-timeout message now says why). DECISION FOR THE HUMAN: whether a hosted tenant whose log volume is single-attach should declare that (e.g. an env flag) so a foreign-namespace holder counts as gone.
5. Legacy: an older version's empty lockfile is reclaimed after 10 minutes. An older writer genuinely holding the lock that long (a stuck old log sync without the snapshot step) would lose it; an older writer's release also unlinks unconditionally, so it could remove a newer writer's lock. Both only during a mixed-version window.
6. Hook latency: the yielding spend (APRV-478) probes the lockfile with existsSync for its 2 s bound before its single try, so the first spend to meet a stale lock waits 2 s, then reclaims on its try. The synchronous writers reclaim at their first EEXIST.
7. The guard defers SIGTERM/SIGINT/SIGHUP, in a process with no listener, from the lock's acquisition until the event loop next turns (at most two immediates after the last release). A synchronous verb that keeps running after the append (a further read, an exit with its own code) runs on before the signal lands; one that calls process.exit before the loop turns exits with its own code rather than the signal. A signal arriving in the microseconds between the poll phase and the removal immediate is dropped. APRV-477 (pre-wait listeners on non-Hermes harnesses) remains its own scope.

Proposed SPEC.md hunks, PENDING SIGN-OFF (SPEC.md, APPROVAL.md and .approval/ untouched):
(a) Section 8, event types list: add `audit.lock_reclaimed` after `audit.question_preempted`, and a bullet: **A lock taken back from a writer that is gone.** `audit.lock_reclaimed` records that the log's writer removed an append lock whose holder is provably gone, and is appended as the first record under the lock that writer then took. The record carries a `system:` actor and its payload the lockfile's base name, a `reason` drawn from a closed set (`holder-dead`, `holder-replaced`, `holder-boot-ended`, `legacy-aged`), how long the lock had been held, and the holder's pid, kind and start of hold when the lockfile named one. It is AUDIT TIER on the strict terms `audit.decision_refused` set: it authorizes nothing and no enforcement path reads it. (APRV-479, pending sign-off.)
(b) Section 11.1 invariant 5, appended scope note: *Scope note:* the append lock that makes compare-and-append atomic MUST NOT be taken from a holder that may be alive. An implementation MAY reclaim a lock whose holder is provably gone (its process has exited or been replaced, judged in the holder's own boot and process namespace), and MUST then record the reclaim before anything else it appends under the new lock, and MUST re-read the head under that lock; a holder it cannot check MUST be treated as live, and a lock that names no holder MAY be reclaimed only after an age far beyond any holder's span. A process MUST NOT die of a catchable termination signal while it holds the lock (`tests/log-lock-reclaim.test.ts`). (Amended APRV-479, pending sign-off.)

Tests (tests/log-lock-reclaim.test.ts, 17):
| case | expected | result |
| dead pid holder (the refuter's repro) | reclaimed; log = registered, audit.lock_reclaimed (holder-dead, pid, op, created, age), granted; no residue; verify clean | pass |
| live pid holder (this process, record 24 h old) | lock-timeout after 80 ms, message names pid and "is running", log and lockfile byte-identical | pass |
| pid reused (this pid, start "1") | Linux: reclaimed holder-replaced; macOS: kept, lock-timeout "no way to read its start time without ps" | pass (darwin branch locally; Linux branch runs in CI) |
| unattributed lockfile 0 s old | kept, lock-timeout "names no holder" | pass |
| unattributed lockfile 11 min old | reclaimed legacy-aged, no holder, age_ms >= 600000 | pass |
| unknown record version | kept | pass |
| dead holder beside a sync snapshot / absent log | kept, named | pass |
| head read before the reclaim | head-moved, reclaim recorded, fresh read appends | pass |
| withAppendLock (hold) | reclaims, record precedes its work, op hold | pass |
| release | leaves a lockfile that is not its own | pass |
| claim held by another reclaimer / abandoned claim | kept "another writer is reclaiming"; at +60 s cleared; next wait reclaims; no residue | pass |
| describeLogLock | names a live and a dead holder, file untouched | pass |
| judgeHolder table (15 rows, Linux and other, stubbed OS) | as in Approach | pass |
| parseProcStat with spaces/parens in comm | fields from the last ')' | pass |
| this process judged by the real check | live | pass |
| liveness replaced by "gone" (in-suite mutation pin) | the live holder's lock IS taken | pass |
| SIGTERM to a child mid-append (write layer stalled 1.5 s inside the lock) | child dies of SIGTERM, lockfile gone, its append landed, chain clean, next writer not wedged | pass |
| 6 writers x 3 appends racing one dead-holder lock, 3 rounds | exactly one audit.lock_reclaimed per round, 18 grants, verify clean, no lockfile, no residue | pass |

Mutation checks (source edited, built, run, restored; grep shows no MUTATION left):
- judge() returning gone for every holder: tests/log-lock-reclaim exit 1, 3 of 17 fail (the live-holder test, the reused-pid test on its darwin branch, describeLogLock).
- guardTerminationWhileLocked a no-op: exit 1, 1 of 17 fails: the SIGTERM test, "and left no lockfile behind" (the original defect reproduced: child killed by SIGTERM mid-append, lockfile left).

Validation: npm run typecheck exit 0; npm run lint exit 0. Node 26.8.2: log-lock-reclaim 17/17 exit 0 (four runs); related set (audit cli-hook-hermes-rules cli-up-preflight concurrency conformance-regen conformance daemon-advance-finish daemon-drift-deferral daemon-git-evidence daemon event-schema evidence-append fixtures harness-spend-lock-wait harness-wait-interrupt hermes-bin-signal-guard hermes-wait-interrupt hook-module-graph log-advance-automerge log-advance-rebuild log-fsync log question-preempted reconcile-branch-deletion reindex serve-concurrency serve log-lock-reclaim) 746/746 exit 0; cli-hook harness-spend-lock-wait agent-sdk-hook release-notes site-version-guard docs-guard classify-tier 284/284 exit 0. Node 24.2.0: log-lock-reclaim + log 41/41 exit 0. No full suite run (lane rule); CI is the suite of record. npm ci ran without better-sqlite3's install script (no prebuilt native module in this worktree); none of the targeted files needed it.

Remaining: refuter round on the PR, CI verdict, merge (orchestrator). Resume point: gh pr view on lane/aprv-479 from /Users/carter/dev/approval-md-wt/aprv-479.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
A writer killed while holding events.jsonl.lock no longer wedges the gate. The lockfile names its holder; the next writer judges it once per wait and, only when the holder is provably gone (Linux: /proc start time in the same boot and pid namespace; macOS and elsewhere: kill(pid,0) on the same host, a running pid kept), reclaims it atomically (exclusive link claim, identity re-checked twice) and appends audit.lock_reclaimed (new audit-tier type, schema-validation 2.10.0) before its own record. Live and unverifiable holders are never taken; unattributed lockfiles age out at 10 min; a sync snapshot or absent log keeps the lock. A process holding the lock with no listener defers SIGTERM/SIGINT/SIGHUP to the release and re-raises. tests/log-lock-reclaim.test.ts 17/17; mutations: liveness disabled fails 3, guard disabled fails the SIGTERM test. Remaining: refuter, CI, merge; SPEC hunks pending sign-off; cross-container stale locks (sandbox recreate) still need a human (decision in notes).
<!-- SECTION:FINAL_SUMMARY:END -->
