# Incremental prefix proof for the verified-read cache (APRV-217)

Status: SIGNED OFF and BUILT (APRV-217). §12 records the decisions; the "as
built" note at the end records where the implementation differs from the text
above it.

## 1. The problem in one paragraph

`VerifiedReadCache` (`src/core/state.ts`) lets a long-lived process skip
re-parsing and re-validating a log it already walked. To trust its cached
prefix it re-hashes every byte of that prefix on every read and compares
the digest to the one it stored (`reusablePrefix`, the one load-bearing
check). That proof is correct and it is linear in log size on every read.
After APRV-212 a daemon tick on the live log (7.3 MB, 11k records) makes six
reads and spends about 90 of its 300 ms in that hash; hook processes pay one
such hash when they admit the daemon's snapshot (APRV-188); the Telegram
listener pays it between taps. Every one of those grows with the log for as
long as the log exists. This design changes what the cache re-proves on a
repeat read, keeps today's proof as the default-capable fallback, and makes
the choice a policy decision.

## 2. What each proof claims

**Today (`full`).** On every read: "the first `byteLength` bytes on disk
hash to the digest I computed when I walked them, therefore they are the
bytes I walked, therefore the records I hold for them are the records on
disk." Everything else in `reusablePrefix` (schema key equal, file not
shrunk, same-size-implies-same-mtime, head line byte-identical at its
recorded offset and still newline-terminated at the prefix end) exists only
to reject early. The tail after `byteLength` is then parsed, schema-checked
and chain-walked from the cached head (`verifyText` with a prefix:
`prevSeq`/`prevHash` come from the cached head).

**Proposed (`incremental`), between full re-proofs.** On a repeat read:

1. The cheap guards run exactly as today: schema key, not shrunk, same size
   implies same mtime, head line byte-identical at its offset and still the
   newline-terminated end of the prefix.
2. Instead of hashing `raw[0, byteLength)` again, the cache holds the
   **un-finalised SHA-256 state** at `byteLength` from the last full pass
   (`Hash.copy()` gives a digest without consuming the state). The read
   copies the state, feeds it the appended bytes `raw[byteLength, length)`,
   and stores the copy as the new state. The full-file digest is then
   available for the snapshot publisher and for `#remember` at zero extra
   cost.
3. The appended tail is parsed, validated and chain-walked onto the cached
   head, as today.

So the incremental claim is: "the head line is unchanged at its offset, the
file did not shrink, the bytes appended since the last read chain onto the
head I verified, and the running hash state I carry was last anchored to the
full digest at the most recent full re-proof." What it no longer claims on
every read is that the bytes *inside* the proved prefix, other than the head
line, are unchanged.

## 3. What that gives up, precisely, and who can exploit it

The only difference is an adversary who rewrites bytes strictly inside
`raw[0, headLineStart)` while keeping the file length, the head line, and
the mtime (when the size is unchanged) intact, between two full re-proofs.

- **Whose capability is that?** Someone with write access to
  `.approval/log/events.jsonl`. That party can already truncate the log and
  recompute a self-consistent forged chain that passes a COLD walk from
  genesis, because the chain is unkeyed (this is the same argument APRV-188
  made for the snapshot). The prefix hash never defended against that party;
  it defended the cache against *misreading a legitimately changed file*
  (log rotation, `approval log sync` rewriting the prefix, a restored
  backup, a same-size edit by a human).
- **Do the legitimate cases survive?** Each of them moves the head line or
  the length, or both, except one: an in-place edit that changes bytes but
  neither the length nor the last line. `log sync` (APRV-125) rewrites under
  the append lock and moves the head or the length; a restore changes the
  head. The remaining case (a same-length, same-tail edit inside the prefix)
  is caught by the periodic full re-proof, by the next process start (first
  read is always full), and by `approval log verify`, which never uses the
  cache. Between the edit and the next full re-proof the daemon would serve
  its cached records for the edited region. That window is the whole cost of
  this design, and its length is the configuration knob.
- **Does any enforcement decision depend on the prefix contents in that
  window?** Yes: `requestState`, budgets, loop escalation and the audit
  sampler all read the full record list. That is why the window is bounded
  by a wall-clock cadence AND a read count, why any write the daemon itself
  makes through `appendEvent` forces a full re-proof on its next read (an
  append moves the head, so the incremental path still re-proves only the
  tail; the FORCED full pass here is belt and braces for the writer that
  matters most), and why the hook keeps the full digest at admission.

## 4. Guards and the fallback ladder

Every check can only reject. Order per read on the incremental path:

| step | check | on failure |
|---|---|---|
| 1 | schema key equal | cold walk (as today) |
| 2 | `raw.length >= byteLength` | cold walk |
| 3 | same size implies same mtime | cold walk |
| 4 | head line at `headLineStart` byte-identical, newline at `byteLength-1` | cold walk |
| 5 | full re-proof due? (see §5) | run today's `sha256(raw[0,byteLength))` compare; mismatch = cold walk; success re-anchors the hash state |
| 6 | feed appended bytes to a copy of the hash state; walk the tail from the cached head | any chain/schema failure = today's verdict (torn/corrupt), entry dropped |

"Cold walk" means exactly what it means today: the entry is dropped, the
whole file is walked from genesis, and the result is remembered with a fresh
full digest and fresh hash state. There is no path from the incremental
proof to a *weaker* verdict than today's: the same walk produces the same
`clean` / `torn-tail` / `corrupt` results, and `expectedHead` anchoring in
`verifyText` is unchanged.

## 5. When a full re-proof runs regardless

- First read of a log in a process (no entry exists).
- Every `full_reproof_every` reads (count) or after `full_reproof_after`
  wall time since the last full pass, whichever comes first. Proposed
  defaults: 50 reads or 60 s. At the daemon's ~2 ticks per append that is a
  full re-proof roughly every minute under load and every read when idle
  (the 30 s interval tick alone would exceed the count only after 25 min, so
  the wall clock is the binding bound there).
- Immediately after this process appended to the log through `appendEvent`
  (a private hook on the cache: `appendEvent` already goes through
  `core/log.ts`, which can mark the cache entry stale-for-full).
- Whenever a guard in §4 fails (which is a cold walk, stronger than a full
  re-proof).
- On `approval log verify`, `approval doctor`, and every path that passes
  `cache: null` today: unchanged, they never touch the cache.

## 6. Who may use the incremental path

| reader | today | proposed |
|---|---|---|
| daemon tick (6 reads/tick) | full digest per read | incremental, cadence-bound full re-proof |
| Telegram / CLI / web listener (repeat reader in one process) | full digest per read | incremental, same cadence |
| hook process (`approval hook claude-code`) | admits the snapshot by full digest, then walks the tail | **unchanged**: full digest at admission. A one-shot process has no prior full pass of its own to anchor a hash state to, and the snapshot's `sha256` is the only thing that ties the daemon's endorsement to bytes the hook itself read. Incremental admission would mean trusting the daemon's word about bytes the hook never hashed. |
| `approval log verify`, `doctor`, any `cache: null` caller | cold walk | unchanged |
| CLI verbs in a one-shot process (`request`, `grant`, `run`) | first read cold or snapshot-admitted, later reads in the same process are cache hits with a full digest | incremental for the later reads in the same process (2 to 4 reads); small win, same rule |

The hook stays full because the postmortem's growth risk for hooks is the
cold walk, which APRV-188 already replaced by one hash, and because the hook
is the enforcement point an agent can most easily race. If the daemon-served
read of APRV-188's original plan ever lands (a socket answer), it inherits
this table's rule for the daemon, not for the hook.

## 7. Configuration surface

Policy (APPROVAL.md), a new top-level block. The schema is closed at every
level, so this is a schema change and lands as its own subtask with its own
fixtures:

```yaml
daemon:
  read_proof: full          # full | incremental; default: full
  full_reproof_every: 50    # reads; incremental only
  full_reproof_after: "60s" # duration; incremental only
```

CLI override on `approval daemon run` and `approval up`:
`--read-proof full|incremental`, `--full-reproof-every <n>`,
`--full-reproof-after <duration>`. The flag wins over the policy for that
run and the `started` line prints the mode in force. `approval doctor` gains
a row that names the mode and the last full re-proof age.

**Default: `full`.** The behaviour Carter has today, byte for byte, until a
policy amendment (through the ceremony, attested) turns the other one on.
The dogfood pin for the live policy moves in the same policy-amend PR, as
every other declared key does. A misspelt value fails policy load (the
schema is closed), which fails closed to every class `manual` exactly as any
other bad key does.

The `tick` line gains one more additive field, `reproof: "full" |
"incremental"`, so an operator can see which path a tick took, and the
read-cache `stats` gain `fullReproofs` beside `hits`, `misses`, `resumed`.

## 8. Implementation shape (for the build step, after sign-off)

- `CacheEntry` gains `hashState: Hash` (un-finalised, at `byteLength`),
  `lastFullReproofAt: number`, `readsSinceFullReproof: number`.
- `reusablePrefix` gains a `proof: "full" | "incremental"` argument and a
  `due` predicate; the digest comparison becomes step 5 above.
- `VerifiedReadCache.read` feeds the appended bytes to a copy of the state
  and hands the resulting digest to `#remember` and `publishSnapshot` (the
  APRV-206/212 "hash once" path becomes "hash the tail once").
- `core/log.ts` `appendEvent` marks the process cache entry for the log it
  wrote as "full re-proof next read".
- Reading: the incremental path may also read only the tail from disk
  (`fs.readSync` at `byteLength`) plus the head-line bytes at their offset,
  instead of `readFileSync` of the whole file. Two `pread`s instead of one
  7 MB read; worth doing in the same change because it is what makes the
  read O(tail) end to end, but it is separable if review prefers.
- Policy: `schema/policy.schema.json` `daemon` block, `policy-load.ts`
  parsing into `PolicyDurations`-style typed fields, `daemon.ts` options,
  `cli/daemon.ts` and `cli/up.ts` flags.

## 9. Tests

- Structural, not wall clock: a test double for `sha256` counting bytes
  hashed per read. Under `incremental`, ten appends of one record each hash
  only those records' bytes plus one full pass at the cadence boundary;
  under `full`, every read hashes `byteLength`.
- The guard matrix, per mode: rewritten byte inside the prefix (incremental
  serves cached until the cadence, then cold-walks and reports the corrupt
  chain exactly as today; full cold-walks at once), truncated log, same-size
  rewrite of the head line, torn tail, schema key change, file replaced by a
  longer forged chain with the same head line (caught at step 6 by the chain
  walk from the cached head, since the forged tail must chain onto it).
- Equivalence: for every fixture in `tests/verified-snapshot.test.ts` and
  `tests/telegram-tap-latency.test.ts`, the records and head returned by
  `incremental` deep-equal `full` deep-equal a cold walk, at every read.
- The append hook: a read right after this process's own `appendEvent` is a
  full re-proof.
- Hook path untouched: `tests/cli-hook.test.ts` cache-counter assertions
  unchanged; a test asserts `runHarnessHook` never selects `incremental`.
- Policy: schema fixtures for the block, a misspelt mode fails load, CLI
  flag beats policy, `started` line and `doctor` row name the mode.
- `approval log verify` on a log the daemon served incrementally reports
  the same verdict as a cold walk (it is one).

## 10. Measurement plan

`scratchpad/profile-tick.mjs` and `bench` on the synthetic 10k and a 100k
fixture (`build-fixture.mjs ./fx100k 100000 206`): reads per tick unchanged
(5 to 6), time inside reads from ~90 ms to single-digit ms at 10k and flat
at 100k under `incremental`; `full` numbers identical to APRV-212's after
column. Self-wake probe unchanged (1 tick in 45 s).

## 11. Out of scope, deliberately

- Changing what the hook admits (see §6).
- A keyed chain (HMAC over records) that would make prefix rewrites
  detectable without re-hashing. Bigger design, different task, and it
  changes the log format.
- `chainAnomalies` over the full array per read (~2 ms; cacheable per prefix
  if it ever matters).
- Rust. SHA-256 already runs in OpenSSL; the cost is the bytes fed to it.

## 12. The sign-off, as recorded

1. **Defaults: `full`.** As proposed, and for the reason proposed: it is the
   behaviour Carter has today, and the live policy flips only after a week of
   `tick` lines under `incremental` in the primary, through the ceremony like
   any other policy amendment.
2. **Cadence defaults: 50 reads / 60 s.** As proposed.
3. **The tail-only disk read: in the same change.** It is what makes an
   incremental read O(tail) end to end rather than O(file) in the read and
   O(tail) in the hash.

## 13. As built

Built as designed, with three notes a reader of §4 to §9 needs.

The proof is BOTH a per-read option and a process-wide default. §8 called for a
`DaemonOptions` field, and the daemon's own tick reads carry one; but the daemon
process makes reads the tick does not — the queue renderer and the pending-queue
builder read the same log through call paths that thread no options of their own
— and a mode that reached only the tick left a third of a tick's reads hashing
the whole file, and worse, dropped the carried hash state on every one of them.
So `core/state.ts` also has `useReadProof`, the process-wide switch
`useVerifiedSnapshots` already established for the same structural reason, set
once by `approval daemon run` and `approval up` from the mode they printed. No
other verb sets it, so a hook, a CLI verb, `approval log verify` and every test
read exactly as they did before. A cached entry now carries its hash state under
BOTH modes (a `full` read builds one from the single pass it already paid for,
and carries an existing one forward untouched), which is what keeps a mixed-mode
process from thrashing its own anchor; nothing else about a `full` read changed,
and the same bytes are hashed the same number of times.

The `tick` line's `reproof` is measured around the loop's OWN reads rather than
over the process cache's counters for the whole tick, so it answers for the
reads the line's `reads` field counts.

The design's §3 window is narrower in practice than §3 states, and the test
matrix says so: guard 3 (same size implies same mtime) rejects an in-place
same-length rewrite outright, in both modes, so the interior-rewrite window
requires an attacker who also restores the mtime. `tests/read-proof.test.ts`
pins the mtime on both sides to reach the case at all.
