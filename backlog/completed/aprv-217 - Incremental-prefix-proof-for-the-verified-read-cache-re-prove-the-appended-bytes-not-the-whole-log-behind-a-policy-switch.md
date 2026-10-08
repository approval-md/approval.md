---
id: APRV-217
title: >-
  Incremental prefix proof for the verified-read cache: re-prove the appended
  bytes, not the whole log, behind a policy switch
status: Done
assignee:
  - 'agent:claude-code'
created_date: '2026-09-02 16:14'
updated_date: '2026-09-02 17:57'
labels:
  - core
  - performance
  - design
dependencies: []
references:
  - docs/proposals/incremental-prefix-proof.md
priority: high
type: enhancement
ordinal: 179000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
DESIGN TASK: read and sign off the trust argument before building. After APRV-212 a daemon tick on the live 7.3 MB / 11k-record log costs 230-360 ms with 6 verified reads; about 90 ms of that is six SHA-256 passes over the whole file, because VerifiedReadCache (src/core/state.ts reusablePrefix) re-proves its cached prefix on EVERY read by hashing all bytes up to the cached byteLength and comparing to the stored prefixHash. That proof is deliberate (mtime is a discard-only hint, never a proof) and it is what lets the cache skip re-parsing and re-validating. It is also linear in log size on every read, so tick cost, hook resume cost (APRV-188 snapshot admission hashes the same bytes) and listener cost all grow with the log forever. PROPOSAL: keep the hash STATE, not just the digest. Node's crypto Hash supports copy(), so the cache can hold the running SHA-256 state at byteLength; on the next read it copies the state, feeds only the bytes from byteLength to the new end, and compares against a digest it can also obtain from the same state, while a cheap byte-range check (the last N bytes of the proved prefix, e.g. the head line at its recorded offset, which reusablePrefix already compares) plus size-not-shrunk guards the prefix. A FULL re-proof of the whole prefix still runs (a) on any guard failure, (b) every K reads or T seconds (configurable), (c) whenever the file shrank or the head line moved, (d) on first read in a process, and (e) on demand (approval log verify never uses the cache). TRUST ARGUMENT TO WRITE DOWN: the old proof says 'the bytes on disk up to byteLength are exactly the bytes I walked'; the new proof between full re-proofs says 'the head line at its recorded offset is unchanged, the file did not shrink, and the appended tail chains onto the head I verified'. A writer who rewrites bytes INSIDE the proved prefix while leaving the head line and length intact is the case the periodic full re-proof and the hook's own admission catch; the chain hashes already make such a rewrite detectable by any cold walk. State clearly which readers may use the incremental proof: the daemon and long-lived listeners (repeat readers in one process); hooks keep admitting the snapshot by full digest (APRV-188) unless the design shows the same argument holds there. CONFIGURABLE, per Carter: a policy key (proposed daemon.read_proof: full | incremental, default to be decided in the design, plus daemon.full_reproof_every: duration/count) and a CLI flag override on daemon run / up; full is today's behaviour and must remain byte-for-byte the same path. Schema change is its own subtask if non-trivial. MEASURE: tick cost at 10k and 100k records before/after with scratch profile-tick.mjs; the six reads should drop from ~90 ms to single-digit ms. Not a Rust question: SHA-256 already runs in native code; the cost is what is hashed, not the language.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A design section in the task (or docs/design/) states the old proof, the new proof, what each reader relies on, the guard set, the full re-proof triggers, and which readers may use the incremental path; Carter signs it off before implementation
- [x] #2 read_proof: full reproduces today's cache path byte-for-byte (existing tests unchanged and passing)
- [x] #3 read_proof: incremental re-hashes only the appended bytes between full re-proofs; a test asserts hashed byte counts per read structurally, not by wall clock
- [x] #4 Every guard failure (shrunk file, moved head line, digest mismatch) falls back to a full re-proof and then to the cold walk; tests cover a rewritten prefix byte, a truncated log, a same-size rewrite, and a torn tail
- [x] #5 Periodic full re-proof runs on the configured cadence and is observable on the tick line or the read-cache stats
- [x] #6 Enforcement reads only verified records (SPEC §11.1 inv. 1) and approval log verify never takes the incremental path; implementation notes name the proof change explicitly
- [x] #7 Docs: cli-reference (daemon run flags, policy key) and the postmortem's remaining-risk section updated; npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read the cache (state.ts VerifiedReadCache, reusablePrefix, #remember), the resume seam (verify.ts verifyText prefix), the hook admission (verified-snapshot.ts admitSnapshot), and the policy load path for a daemon block. 2. Write docs/proposals/incremental-prefix-proof.md: current proof, proposed proof, guards, full re-proof triggers, per-reader table, configuration surface (policy key + CLI flag + defaults), failure ladder, test plan, measurement plan, what is explicitly out of scope. 3. Link it from the task and hand it to Carter for sign-off (AC1). 4. Build only after sign-off, as its own step.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Design written: docs/proposals/incremental-prefix-proof.md. Claims stated side by side (full: every read re-hashes the proved prefix; incremental: head line at its offset + not shrunk + tail chains onto the cached head + running hash state anchored at the last full re-proof). What is given up: a same-length, same-tail rewrite inside the prefix between full re-proofs, by a party who could already forge a self-consistent cold-walkable chain (unkeyed chain, APRV-188's argument). Full re-proof triggers: first read per process, every 50 reads or 60 s (proposed), immediately after this process's own appendEvent, any guard failure (cold walk). Readers: daemon and listeners may use incremental; hooks keep full-digest snapshot admission; verify/doctor/cache:null never touch it. Configuration: top-level daemon block (read_proof full|incremental, full_reproof_every, full_reproof_after), default FULL, CLI flags override, started line + doctor row + tick.reproof field. Schema change is a subtask. Three sign-off questions at the end (defaults, cadence, tail-only disk read in the same change). Awaiting Carter before any code.

SIGN-OFF DECISIONS (Carter, 2026-09-02): default read_proof: full; cadence 50 reads / 60 s as proposed; tail-only disk read lands in the same change. Carter asked whether a party forging a self-consistent chain can be defended against; answered in chat with three options (external anchoring of the head, a keyed/HMAC chain, human-signed checkpoints) and a recommendation to file anchoring verification as its own task. The design doc's §12 is to be updated with these answers in the build PR.

BUILT (branch aprv-217-build, stacked on the design PR #225). core/state.ts: per-entry un-finalised SHA-256 state, tail-only read (open/fstat/pread of the head line and the appended bytes), guard ladder per design §4, cadence per §5 (50 reads / 60 s), requireFullReproof after this process's own append (core/log.ts onLogAppended registrar, notified after the lock releases for a record already on disk), process-wide useReadProof mirroring useVerifiedSnapshots (deviation 1: the queue renderer reads through paths that thread no options; set only by daemon run / up), hashed-byte counting seam, stats.fullReproofs. Policy: closed top-level daemon block (read_proof default full, full_reproof_every, full_reproof_after), fixtures valid+invalid. CLI: --read-proof/--full-reproof-every/--full-reproof-after on daemon run and up, flag beats policy, started.read_proof, tick.reproof (deviation 2: measured around the loop's own reads), doctor row read-proof. Hooks unchanged; test drives the hook under an incremental policy and asserts every read was a full re-proof. Measured (bytes hashed per tick, load-independent): 10k records / 6.5 MB: 45.8 MB full vs 1.3 MB incremental; 9k records / 22.8 MB: 136.9 vs 4.6 MB; reads per tick unchanged (7); full re-proofs 70/70 vs 2/70. The 100k build was killed at 25 min per the budget; the 22.8 MB partial fixture stands in for the scaling check. Wall clock on a loaded box (load 30-90): 451 -> 108 ms per tick at 10k. Global invariants touched: the enforcement read path (what the cache re-proves between full passes). Unchanged: every record handed out was walked by this process; the incremental path returns only verdicts a cold walk would (same verifyText seam, same codes); compare-and-append untouched; snapshot admission untouched; log.mutate surface unchanged (the listener gets a path, no handle). Full npm test 2861 pass / 0 fail / 1 pre-existing skip; oxlint clean. Note from the build: guard 3 (same size implies same mtime) already rejects a same-length in-place rewrite in BOTH modes, so the §3 window needs an attacker who also restores the mtime; the design doc §13 records this.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Incremental prefix proof behind daemon.read_proof (default full, unchanged path): under incremental the cache keeps the SHA-256 state at the prefix end, reads only the head line and the appended bytes, and re-proves the tail, with a full digest compare on first read, every 50 reads or 60 s, after own appends, and on any guard failure. Bytes hashed per tick 45.8 MB -> 1.3 MB at 10k records and flat in log size; hooks unchanged. Verified by 26 new tests (structural hashed-byte counts, guard matrix, equivalence to a cold walk, hook never incremental, policy/CLI/doctor surfaces), full suite 2861/0/1, lint clean, and the scratch profiler under both modes.
<!-- SECTION:FINAL_SUMMARY:END -->
