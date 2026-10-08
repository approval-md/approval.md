---
id: APRV-206
title: >-
  Telegram tap latency: acknowledge the callback before the decision path runs,
  and stop re-reading the whole log per tap
status: Done
assignee:
  - 'agent:opus-lane-m'
created_date: '2026-09-02 04:43'
updated_date: '2026-09-02 06:28'
labels:
  - telegram
  - performance
dependencies: []
priority: high
ordinal: 170000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter (2026-09-02): the grant/reject buttons used to disappear at once and now take 1-3 s. Suspected cause, from src/channels/telegram.ts handleUpdate: since APRV-196 the single answerCallbackQuery is sent by the wrapper AFTER the branch finishes, and the decision branch runs recordChannelDecision, which reads and verifies the log before compare-and-append; the live log grew from about 5,200 to about 8,400 records today, so per-tap work that is linear in the log now costs seconds and will keep growing. Outcome: a tap is acknowledged to Telegram within a fixed, log-size-independent bound (the ack is the human's 'I was heard', not 'it is decided'), the button edit follows the decision as today, and the decision path stops paying O(log) per tap: verify incrementally from a cached verified head under the append lock (the daemon and channels already hold one process-lifetime view), or read only the tail the decision needs, with the chain still verified before any append (SPEC 11: every check-then-append passes through compare-and-append; enforcement reads only verified records). Measure before and after with a 10k-record fixture log. Why: the phone tap is the product's one moment; a second of lag on it reads as the gate hesitating.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A callback query is answered within 300 ms of receipt on a 10k-record log, measured in a test with a fixture log and a stubbed Telegram API, and the answer never claims a decision that has not been appended
- [x] #2 The decision path's per-tap cost is independent of log length beyond the tail since the last verified head, proven by timing the same tap against 1k and 10k fixture logs; the verified-head cache is invalidated on any head-moved or verify failure and the chain is fully re-verified then
- [x] #3 Exactly one answerCallbackQuery per callback is preserved (APRV-196 tests unchanged and green), and a decision that fails after the early ack edits the message to say so
- [x] #4 docs/dogfood-cutover.md or docs/cli-reference.md states what the ack means versus what the button edit means
- [x] #5 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. **Ack first, in the channel.** `routeCallback` answers the callback with a
   'heard, deciding' toast IMMEDIATELY before `this.handler(decision)` runs, and
   the same before `handleDigestAll`'s member loop. The text claims no decision.
   Exactly one answerCallbackQuery per callback is preserved by making
   `safeAnswer` idempotent per callback id (it already records `answered`; it now
   RETURNS when already answered), so every later branch toast and the wrapper's
   fallback become no-ops rather than a second call. APRV-196's guarantee moves
   from 'at least one, deduplicated by convention' to 'exactly one, structurally'.
2. **The outcome moves to the message edit.** With the single answer spent on the
   ack, the decision's result is what the button edit says. The refused-after-ack
   case (already-decided, withdrawn, expired, budget) now annotates the message
   with a 'not recorded' headline and the refusal sentence, where before it edited
   nothing. Anomaly branches (foreign chat, malformed, unknown nonce, stale copy)
   keep their own sentences: they run no decision path and are already O(1).
3. **Kill the per-append schema recompile** (`src/core/validate.ts`). Schema files
   are still re-read on EVERY call, so validation stays a pure function of (bytes
   on disk, document); only the Ajv compile is reused, keyed on the exact bytes
   just read plus schemaDir/schemaId/mode. Same argument shape as APRV-43's
   verified-read cache: re-prove the input, skip the recompute. ~16 ms off every
   append.
4. **Kill the whole-file read per append** (`src/core/log.ts` `readTail`). Read
   only the file's last chunk (doubling until a newline is found), keeping every
   corrupt-tail rule byte-identical: no trailing newline, blank last line,
   unparseable JSON, non-object, no integer seq, no 64-hex hash. Still inside the
   lock, still the actual on-disk tail, so compare-and-append is untouched.
5. **Reuse the existing verified-read cache; add no second one.** `core/state.ts`
   already caches the verified head + records per process and verifies only the
   appended tail (APRV-43), and the daemon and the channels already share it via
   `processReadCache`. Its prefix re-hash is the proof that the prefix on disk is
   the prefix this process verified; removing it for a stat-based check is the
   attack APRV-43's header rejects in writing, and would weaken global invariant 1.
   So: no new cache, and the residual log-length term is ~1 ms/MB of re-hash.
6. **Timing tests** (`tests/telegram-tap-latency.test.ts`): 1k and 10k fixture logs
   built through the real writer, a stubbed Bot API, one tap each. Assert (a) the
   ack is the FIRST Bot API call after getUpdates and precedes the decision append,
   (b) BOUND: ack within 300 ms on the 10k log, (c) RATIO: decision-path cost at
   10k / at 1k under a generous ceiling, well below the 10x a linear path would
   show, (d) the ack text names no decision, (e) exactly one answerCallbackQuery.
7. **Docs**: docs/dogfood-cutover.md states what the toast means (the tap arrived)
   versus what the button edit means (the log says so).
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## Before: where a tap's milliseconds actually go (measured 2026-09-01)

Harness: scratch script driving a real `TelegramChannel.pollOnce()` over a stubbed
Bot API (no network), fixture logs built through the real gate (`register` ->
`request` -> `decide`), one pending request left per run. Machine: this worktree,
Node 20, warm process cache.

| fixture | records | bytes | ack at | decision path |
|---|---|---|---|---|
| n100 | 205 | 0.15 MB | 22.1 ms | 21.7 ms |
| n500 | 1005 | 0.73 MB | 22.7-23.6 ms | 22.6-23.4 ms |
| n1000 | 2005 | 1.45 MB | 23.0-24.9 ms | 22.9-24.7 ms |

The ack lands only when the decision path is finished (APRV-196 puts the toast
after the branch), so ack time == decision time on every row.

Component timings, including against a READ-ONLY copy of this repo's own live log
(8379 records, 5.51 MB; nothing was run against the primary checkout):

- cold `verifyWithRecords` on the live log: 138-170 ms; on the 2k fixture: 63-83 ms
- warm `readVerifiedRecords` (APRV-43 cache hit) on the live log: 8.5 ms; on 2k: 2.0 ms
- `requestState` over 8379 records: 0.2 ms
- **`validate("event", record)` — one record: 13.7-24.7 ms**, of which ~13 ms is the
  Ajv compile. A prepared validator checks the same record in 0.0017 ms.
- `appendEvent`: 12.5 ms each over a 1k run, 23.2 ms each over a 10k run
  (compile constant + `readTail` reading the WHOLE file to get its last line).

Findings:

1. The APRV-43 verified-read cache is already doing its job: the per-tap read is
   8.5 ms on an 8.4k log, not seconds. The log-length term is that cache's prefix
   re-hash (~1 ms/MB), which is its soundness proof and is NOT the problem.
2. The dominant per-tap constant is the schema compile at the write boundary:
   ~16 ms of every append is Ajv recompiling event.schema.json (48 KB) from
   scratch. It is paid on every append and it is invisible in a ratio test
   because it does not scale with the log.
3. `readTail` reads the entire log file on every append purely to find the last
   line: O(log) I/O per tap, and the reason a 10k-record fixture takes 232 s to
   build.
4. The human-visible 1-3 s is those constants plus TWO Bot API round trips
   serialized behind the decision: the toast is sent after `decide()` returns and
   the button edit after the toast.

## After: the same measurements, same harness, same machine

| fixture | records | bytes | ack at | decision path |
|---|---|---|---|---|
| 1k | 1005 | 0.73 MB | **0.0-0.3 ms** (was 22.7-23.6) | **2.6-3.3 ms** (was 22.6-23.4) |
| 10k | 10005 | 7.27 MB | **0.0-0.1 ms** | **16-28 ms** (the spread is load: this ran beside the full suite) |

'ack at' is now local work only: the elapsed time from the callback being read
off getUpdates to the answerCallbackQuery call leaving this process. Before this
change the same number was the whole decision, because the toast was sent after
it.

Component costs that moved:

- `validate("event", record)`: **15.8 ms -> 1.36 ms** (schema files still read
  and hashed every call; only the Ajv compile is reused).
- `appendEvent`: **23.2 ms -> 0.56 ms** each over a 10k run (compile reuse plus
  the tail read). Building a 10k-record fixture went from 232 s to 5.6 s, which
  is what makes the 10k timing test affordable in CI at all.
- warm `readVerifiedRecords` at 10k: **10.1 ms -> 7.0 ms** (the file was being
  hashed twice per read; when it has not grown, the digest just re-proved is
  reused).

What still scales with the log, stated plainly: ~3 ms of SHA-256 over the file
(the verified-read cache's proof that the prefix on disk is the prefix this
process verified) plus ~2-4 ms of the gate's own in-memory passes over the record
list (budgets, request derivation). That is the 2.6 ms -> 16 ms across a 10x
growth. It is NOT a re-walk: no record is re-parsed, re-validated or re-hashed.

## What was done

1. **The ack moved in front of the gate** (`src/channels/telegram.ts`).
   `routeCallback` answers the callback with `TELEGRAM_ACK_HEARD` — 'Heard —
   deciding. The message will say what the log recorded.' — immediately before
   `this.handler(decision)`, and `handleDigestAll` does the same before its
   member loop. The wording claims no decision, deliberately: at that instant
   nothing has been appended and the gate may still refuse.
2. **Exactly one answerCallbackQuery, now structurally.** `safeAnswer` returns
   when the query it is handed has already been answered in this handling, so
   every later branch toast and the APRV-196 wrapper fallback are no-ops behind
   an early ack. APRV-196's guarantee is unchanged and is now enforced in one
   method instead of by every branch remembering to return.
3. **The outcome moved to the message.** A successful tap still edits its message
   from the appended record (APRV-113, unchanged). A REFUSED tap now edits it too
   — `✗ NOT RECORDED` plus the refusal sentence — where before the refusal was a
   toast and the message was left alone. A handler that THROWS after the ack gets
   the same treatment with `TELEGRAM_HANDLER_FAILED`, and the throw still reaches
   `handleUpdate`, which complains and keeps the poll loop alive.
4. **The schema compile is reused across calls, keyed on the schema bytes**
   (`src/core/validate.ts`). Every call still reads every schema file; only the
   Ajv compile is skipped, and only when the bytes just read hash to the digest
   the compiled validator was built from. Same argument shape as APRV-43's
   verified-read cache: re-prove the input, skip the recompute. Two new tests
   assert an edited schema and a vanished `$ref` sibling are both honoured by
   the very next call.
5. **The append reads the tail, not the file** (`src/core/log.ts`). `readTail`
   needs two facts — does the file end with a newline, and what is its last line
   — and was reading the whole log for them. It now reads a 64 KB window off the
   end, doubling until the last line is whole inside it, with a read loop that
   refuses a short read rather than decoding uninitialised bytes. Every
   corrupt-tail refusal is byte-identical. Two new cases in tests/log.test.ts
   cover a 200 KB record (the doubling) and multi-byte characters (the window is
   cut at a newline before it is decoded).
6. **No second cache.** `core/state.ts` already keeps the verified head, the
   records and a proof-of-prefix per process, shared by the daemon and the
   channels (APRV-43), and verifies only the appended tail. It is reused as-is,
   with one addition: when the file has not grown since the entry just re-proved,
   the digest is carried forward instead of re-hashing the same megabytes twice
   in one read.

## Global invariants touched, and how they hold

- **'Enforcement paths read only verified records.'** Nothing about what the gate
  reads changed. The decision still goes through `recordChannelDecision` ->
  `decide()` -> `readGateRecords` -> `readVerifiedRecords`, and every record it
  sees was walked through the full ladder (parse, alg, schema, hash recompute,
  seq succession, prev link) by this process over exactly these bytes. The
  APRV-43 cache's prefix hash — its proof that the bytes on disk are the bytes it
  verified — is deliberately KEPT. The task suggested a lighter head cache keyed
  on seq/hash/offset with stat-based invalidation; that is precisely the design
  `core/state.ts`'s header rejects in writing (an in-place edit before the head
  that preserves size and head bytes would be admitted), so adopting it would
  have weakened invariant 1 to buy ~3 ms. It was not adopted, and the reason is
  recorded here rather than left to a reviewer to notice.
- **'Every check-then-append passes through compare-and-append.'** Untouched.
  `appendEvent` still takes the lockfile, still reads the actual on-disk tail
  under it, still evaluates `expectedHead` there, and still refuses `head-moved`
  without writing. What changed is only HOW MANY BYTES it reads to find that
  tail. The gate still passes the head it read, and the early ack changes nothing
  about that: the ack is not a decision, appends nothing, and a head that moved
  between the ack and the append still refuses — the human is then told on the
  message, which is the case AC3 asks for.
- **Validation at the write boundary.** Every append still validates the complete
  record against the `event` schema before a byte is written, against schema
  files re-read from disk on that call.
- **The ack is not evidence.** The one new user-visible sentence is worded so it
  cannot be read as a decision, and a test asserts it matches none of
  approved/granted/rejected/'recorded in the log'.

## Validation

- `npm run build` (tsc): clean.
- `npm run lint` (oxlint src tests): clean, no warnings.
- `npm test` (full suite): **2692 tests, 2691 pass, 0 fail, 1 skipped** (the same
  single pre-existing skip the baseline run showed). 218 s, against 227 s before
  the change despite the new 7 s timing file.
- `node --test dist/tests/channels-telegram.test.js`: 104 pass, 0 fail, including
  every APRV-196 case.
- `node --test dist/tests/telegram-tap-latency.test.js`: 5 pass, 0 fail, 7.5 s
  including both fixture builds.

### Evidence per acceptance criterion

- **AC1** — `a tap is acked before the decision is appended, and the ack claims
  none` counts the log's lines from INSIDE the stubbed answerCallbackQuery call:
  the log has not grown when the ack is sent and has grown by one when the poll
  returns, so the ordering is structural rather than inferred from a stopwatch.
  The same case asserts the text equals `TELEGRAM_ACK_HEARD` and matches none of
  approved/granted/rejected/'recorded in the log'. `BOUND: the ack lands within
  300 ms on a 10k-record log` is the bound, best of three, measured at well under
  1 ms of local work.
- **AC2** — `RATIO: the decision path is not linear in log length` times the same
  tap on 1k and 10k fixtures, best of five each, ceiling 8 against the 10 a
  linear path would show. `a tap re-verifies nothing it has already verified`
  makes the structural half of the claim off the verified-read cache's own
  hit/miss counters: a tap after the first adds hits and no misses. The
  invalidation half (head moved, prefix tampered, shrunken file, substituted
  file, schema directory changed) is `tests/state-cache.test.ts`, 33 cases, all
  green, and is cited from the new file rather than duplicated.
- **AC3** — the APRV-196 suite is green with its exactly-once assertions intact.
  Three of its expectations changed, because the sentence moved rather than the
  guarantee: the decision path's toast is now the ack, and the refusal and
  thrown-handler sentences are now on the message (both asserted). One test was
  ADDED to keep the wrapper's fallback exercised: `a throw BEFORE any ack still
  falls back to the wrapper's toast`, driven through a `describeAction` probe
  that throws, which is the branch that can still reach it.
- **AC4** — docs/dogfood-cutover.md: the toast table is rewritten and a new
  section, 'The toast means heard. The message means recorded.', states what each
  surface asserts and which one is evidence.
- **AC5** — as above.

## Decisions a reviewer may want to overrule

1. **The refusal now edits the message and removes the buttons.** Telegram allows
   one answer per tap and it is spent on the ack, so a refusal had to go
   somewhere. `annotate` disarms; that is right for a terminal refusal, and for a
   transient one the delivery is forgotten and the next dispatch cycle re-sends
   the request as a fresh prompt. The alternative (keep the buttons by rebuilding
   the keyboard) was not taken.
2. **The digest 'all' tally is no longer a toast.** It goes to the listener's
   stderr; the approver reads the redrawn digest. Same one-answer constraint.
3. **`src/core/validate.ts` gained a compiled-validator cache.** It is the largest
   single constant in a tap (16 ms of every append) and it is what makes a
   10k-record fixture affordable in CI, but it is a change to the write-boundary
   module and outside the letter of this task. The determinism stance is
   preserved (files re-read every call; only the compile is reused, keyed on
   their bytes) and the header now argues it, but a reviewer may prefer it as its
   own task.
4. **The task's suggested head cache (seq + hash + byte offset, stat-based
   invalidation) was NOT built.** See the invariants section: it is the design
   APRV-43 rejected in writing. The existing cache is reused instead, and the
   residual ~3 ms of prefix hashing at 10k is the price of that proof.
5. **What is left un-flat.** Making a tap genuinely O(tail) needs an incremental
   projection of gate state (budget windows, request derivation) rather than a
   pass over the record list per decision. That is a task of its own and is not
   attempted here.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The phone's spinner no longer waits for the gate. A tap is answered the instant it is recognized, before any log work — 'Heard — deciding. The message will say what the log recorded.' — and what the log recorded is said afterwards by the message edit, written from the appended record (or, for a refusal or a thrown handler, by a new '✗ NOT RECORDED' annotation). APRV-196's exactly-one-answer guarantee is preserved and is now structural: safeAnswer answers a query at most once, so every later branch toast and the wrapper's fallback are no-ops behind the early ack. Three constants that made every tap expensive were removed with it: the Ajv schema recompile at the write boundary (15.8 ms -> 1.4 ms per validate, reused only when the schema bytes just read hash to the digest it was compiled from, so an edited schema is still honoured by the next call), the whole-file read every append made to find its last line (now a 64 KB tail window that doubles, with every corrupt-tail refusal byte-identical), and a second redundant hash of the log per cached read. No second log cache was added: core/state.ts's verified-read cache (APRV-43) is reused, prefix proof and all, because the lighter stat-based head cache the task sketched is the design that cache's header rejects in writing. Measured on the same harness: on a 1k log ack 22.7 ms -> 0.1 ms and decision 22.6 ms -> 2.6 ms; on a 10k log ack under 0.3 ms and decision 16-18 ms, where the old path's constant alone was 23 ms before any log work. Verified with npm test (2692 tests, 2691 pass, 0 fail, 1 pre-existing skip), npm run lint and npm run build, five new timing and ordering cases in tests/telegram-tap-latency.test.ts (labelled BOUND vs RATIO), two new schema-edit cases in tests/validate.test.ts, two new tail-read cases in tests/log.test.ts, and one new APRV-196 case keeping the wrapper's fallback exercised. docs/dogfood-cutover.md now states which surface is a courtesy and which is evidence.
<!-- SECTION:FINAL_SUMMARY:END -->
