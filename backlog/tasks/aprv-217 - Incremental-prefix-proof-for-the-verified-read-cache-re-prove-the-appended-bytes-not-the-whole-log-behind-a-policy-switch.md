---
id: APRV-217
title: >-
  Incremental prefix proof for the verified-read cache: re-prove the appended
  bytes, not the whole log, behind a policy switch
status: To Do
assignee: []
created_date: '2026-09-02 16:14'
labels:
  - core
  - performance
  - design
dependencies: []
references:
  - APRV-212
  - APRV-213
  - APRV-43
  - APRV-188
  - APRV-206
  - docs/postmortem-2026-09-02-daemon-tick-cpu.md
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
- [ ] #1 A design section in the task (or docs/design/) states the old proof, the new proof, what each reader relies on, the guard set, the full re-proof triggers, and which readers may use the incremental path; Carter signs it off before implementation
- [ ] #2 read_proof: full reproduces today's cache path byte-for-byte (existing tests unchanged and passing)
- [ ] #3 read_proof: incremental re-hashes only the appended bytes between full re-proofs; a test asserts hashed byte counts per read structurally, not by wall clock
- [ ] #4 Every guard failure (shrunk file, moved head line, digest mismatch) falls back to a full re-proof and then to the cold walk; tests cover a rewritten prefix byte, a truncated log, a same-size rewrite, and a torn tail
- [ ] #5 Periodic full re-proof runs on the configured cadence and is observable on the tick line or the read-cache stats
- [ ] #6 Enforcement reads only verified records (SPEC §11.1 inv. 1) and approval log verify never takes the incremental path; implementation notes name the proof change explicitly
- [ ] #7 Docs: cli-reference (daemon run flags, policy key) and the postmortem's remaining-risk section updated; npm test passes; lint clean
<!-- AC:END -->
