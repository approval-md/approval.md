# APRV-452 — Chain continuity across a store recreate

**Status: design, pending human sign-off. Nothing here is wired, and this task
edited no SPEC.md sentence, no schema and no source file. Section 9 holds the
hunks a human has to decide on, each marked proposed and not applied. Every code
reference describes what the runtime does NOW.**

A hosted deployment can lose its store's process while keeping a copy of its
disk: a platform recreate forks the disk and not the processes. The safe response
is already practised. The forked store is moved aside, the daemon starts on a
fresh store, so the log begins a new genesis, credentials are rotated, and the
old chain is exported before the old box is destroyed. What core lacks is any
statement, inside the new log, that another chain preceded it. A follower that
was reading the old chain sees its cursor stop matching and can only quarantine
and wait for a person. This note designs the record that lets a follower or an
auditor treat the two chains as one history without taking the operator's word
for it.

---

## 1. What the runtime does today

**1.1 A log has exactly one genesis.** The first record has `seq` 1 and `prev`
`null` (`src/core/log.ts:96-99`, `GENESIS_PREV`). The verifier walks from that
start and nowhere else (`src/core/verify.ts:452-470`), reporting `not-genesis`
for a first record with a non-null `prev` and `seq-gap` for one that does not
start at 1 (`src/core/verify.ts:616-642`).

**1.2 A new genesis is indistinguishable from a first deployment.** Nothing in
the event vocabulary (SPEC.md §8) says "this log continues another". A fresh
store after a recreate and a store created on day one look the same.

**1.3 A follower sees only a mismatch.** A verified subscription binds an
exclusive `(seq, hash)` cursor (SPEC.md §8, "Verified subscription"). Against a
new chain the cursor either points past the head or at a record with another
hash, and both are refused as `cursor-mismatch` (`src/core/log-subscribe.ts:163-180`,
served page by page by `src/serve/follow.ts`). That refusal is correct, and it
is all a follower learns.

**1.4 The witnesses that exist are per chain.** Anchoring compares the working
log with a committed copy and reports `anchor-diverged` when the prefix differs
(SPEC.md §9, `src/cli/log-anchor.ts:63`). A `log.checkpoint` signs a `(seq,
hash)` below its own record in the same log, checked against keys the policy
declares (SPEC.md §9, `src/core/checkpoint.ts`). After a recreate the anchored
copy is the OLD chain, so the anchor check reports divergence at seq 1, and no
checkpoint can name a record in another log.

**1.5 Nothing crosses today, and that part is right.** A grant on the old chain
is not a grant on the new one: spending its token refuses `not-granted`
(`src/core/token.ts:178`), because the new chain holds no such record. This
design keeps that property and states it as a rule (section 6).

---

## 2. The decision

A dedicated event, `log.continued`, that may only be the first record of a log
(`seq` 1, `prev` `null`, enforced by the schema). It names the retired chain by
its genesis hash, its last `(seq, hash)` and a digest of its bytes up to that
head. A human writes it, through a human-only verb, on an empty log, and the
runtime computes every chain fact from a copy of the retired log it verified
itself. The record moves no verdict and imports no state. Verification gains a
continuity check beside the anchor and checkpoint checks, with its own refusal
codes, which passes only when the retired bytes are in hand and reports a
**claim** as a skip, never a pass. An optional `log.retired` record seals the old
chain when its store can still be written.

---

## 3. The record

```json
{"seq":1,"ts":"2026-10-20T04:12:09Z","event":"log.continued",
 "actor":"human:operator",
 "payload":{
   "retired":{"genesis_hash":"9c1e…","seq":4127,"hash":"b3c9…",
              "prefix_sha256":"5d0a…","basis":"verified","sealed":true,
              "open":{"pending":2,"obligations":0,"indeterminate":0,"executions_open":1}},
   "reason":"store-recreated","note":"platform recreate, old box exported"},
 "alg":"sha256/jcs","prev":null,"hash":"e7f2…"}
```

| field | meaning | computed or claimed |
|---|---|---|
| `retired.genesis_hash` | hash of the retired chain's seq-1 record: the chain's identity | computed from the verified copy |
| `retired.seq`, `retired.hash` | the retired chain's last record | computed |
| `retired.prefix_sha256` | SHA-256 of the retired log's bytes from its first byte through the newline ending record `seq` | computed |
| `retired.basis` | `verified` (the runtime walked a copy) or `claimed` (no copy existed; the three chain fields were typed in) | computed |
| `retired.sealed` | `true` iff the named head is a `log.retired` record | computed |
| `retired.open` | counts, in the retired chain, of pending requests, unsatisfied `reconciliation.required`, unreconciled `execution.indeterminate`, and starts with no outcome | computed; absent under `claimed` |
| `reason` | closed set: `store-recreated`, `store-lost`, `store-migrated` | claimed, by the human writing it |
| `note` | free text, bounded | claimed |

**3.1 Why a dedicated event at seq 1.** It is the one position at which nothing
in the new chain can precede the claim, so no record can be written under the
new chain and then retroactively placed after a predecessor. Schema-pinning `seq:
1` and `prev: null` for this type makes a misplaced one a write-boundary refusal
and a `schema-invalid` line to every verifier, with no new verify reason. A
dedicated type, and not a field on whatever record happens to come first, follows
the reasoning SPEC.md §5.2 gives for giving organ attestations their own type: no
reader of another record can mistake it for this one, or omit it by accident.

**3.2 Why `prefix_sha256` and not "the export's digest".** Whatever the copy is
(the moved-aside store, an `approval log export` stream, which writes stored lines
verbatim, or a committed copy), its bytes through the named head digest the same.
One hash therefore checks any verbatim copy a reader is later handed. The chain
is hashed over canonical content (APRV-141), so a copy re-serialized byte for
byte differently still verifies as a chain; the verifier reports that case
distinctly (section 5) rather than refusing it.

**3.3 Why the chain is named by its genesis hash.** It is the only identifier
the retired chain carried about itself, it needs no registry, and it lets a
follower know which chain it was reading before it sees any record of the new
one. Chains of chains need nothing more: each `log.continued` names its immediate
predecessor.

**3.4 `log.retired`, optional.** When the old store can still be written, the
same verb run against it appends `log.retired` (human actor, `reason` from the
same set) as that chain's last record, and the successor then names it with
`sealed: true`. A record after a `log.retired` is a finding on its face. It
cannot name the successor, because the successor's genesis does not exist yet,
and it is optional because the case that most needs continuity, a box that died,
is the case in which nobody can write to it.

---

## 4. Who writes it

**A human, through a human-only verb, on an empty log.** Proposed shape: `approval
log continue --retired <path> --reason <r> [--note <t>] --as human:<id>`.

- **The actor is `human:`.** "These two chains are one history" is an assertion
  about provenance, and the runtime can verify the bytes it is handed but not
  that they are the right bytes. That is the kind of claim this repository
  reserves to a person: `log.checkpoint`, `policy.updated` and `gate.opened` all
  carry a `human:` actor for the same reason (SPEC.md §8). An agent therefore
  cannot write one, in the schema or in the runtime, and the verb classifies
  `policy.core`, as `approval log checkpoint` does
  (`src/core/command-class.ts:2749`), so a hook denies it to an agent before it
  starts.
  Under headless provisioning the operator's configured identity writes it, which
  is the trust SPEC.md §11 already states: someone with local control, not proof
  of who.
- **The runtime computes the chain facts.** The verb verifies the retired copy
  from its genesis (refusing a corrupt copy), takes its genesis hash, its last
  `(seq, hash)` and the prefix digest itself, and counts `retired.open`. No chain
  fact is a parameter. A torn tail in the copy is named and excluded; the head is
  the last intact record, which `verify` already reports as `intactThroughSeq`.
- **`basis: claimed` is the honest escape hatch.** When no copy survives, the
  verb accepts `--retired-genesis <hash> --retired-head <seq>:<hash>`, writes
  `basis: claimed`, omits the digest and the counts, and every reader reports the
  record as a claim (section 5). A typed head is the operator's word, and the
  record says so on its face.
- **Empty log only.** On a log with any record the verb refuses
  (`continuity-log-not-empty`). Continuity is decided before the first attestation
  of the new chain; `log.continued` carries no policy and makes nothing
  operative, so the new chain stays unattested until a human attests it, exactly
  as a first deployment is.
- **Ordering the operator SHOULD follow:** stop the old writer, append
  `log.retired` if the store is writable, take the copy, then write the new
  genesis. A recreate that cannot stop the old box first still works, with
  `sealed: false`, and section 5 says what a later sighting of old records means.
- `ts` is stamped at the write boundary, as for `log.checkpoint`, since the
  record's moment is part of what it claims.

---

## 5. What a verifier checks

Proposed: `approval log verify --continuity [--retired <path>]`, a third check
beside `--anchor` and `--checkpoints`, with its own frozen union
(`continuity_refusal_codes`): `continuity-genesis-mismatch`,
`continuity-head-mismatch` and `continuity-retired-beyond-head`. The chain walk
itself is unchanged: a `log.continued` at seq 1 is a valid genesis.

**5.1 Holding both logs (or the new log and any verbatim copy of the old one).**

1. The new log verifies as today.
2. Its seq-1 record is `log.continued`; if not, the check reports `continuity:
   none`, which is neither a pass nor a refusal (a first deployment has no
   predecessor).
3. The copy verifies from its own genesis, and its seq-1 hash equals
   `retired.genesis_hash`; otherwise `continuity-genesis-mismatch` (this copy is
   of another chain).
4. The copy carries `retired.hash` at `retired.seq`; otherwise
   `continuity-head-mismatch`.
5. The copy holds no record past `retired.seq`; otherwise
   `continuity-retired-beyond-head`. Evidence cannot tell an old box that kept
   writing after the fork from an operator who named an earlier head to drop the
   tail, and the repair for both is a person, so they share one code.
6. The prefix digest matches. A mismatch with steps 3 to 5 passing is reported
   as `bytes-differ` beside a verified result: the chain is the one named, and
   the artifact is not the byte-identical copy that was digested.
7. If the copy's own seq 1 is a `log.continued`, the report names its
   predecessor and stops; walking further needs that copy too.

Outcome: `continuity: verified`, exit 0.

**5.2 Holding only the new log.** Steps 1 and 2, then `continuity: claimed`,
naming the retired `(genesis_hash, seq, hash)`, the `basis`, and that no retired
copy was supplied. It is a **skip that names what is missing**, on the rule
SPEC.md §9 sets for a missing anchor or a missing checkpoint key, and never a
pass. Three external witnesses can still refute the claim without the old log,
and each reports `continuity-retired-beyond-head` when it does:

- a **follower's retained cursor** on the retired chain past `retired.seq`
  (section 7);
- an **anchored copy** of the retired chain holding records past `retired.seq`
  (section 6.1);
- a **checkpoint** a human signed on the retired chain naming a seq past
  `retired.seq`, which anybody who saw it can present.

What none of them can catch, stated plainly: a forged retired chain whose genesis
and head nobody outside the operator ever saw. That is
`chain-verification/truncation-unanchored` one level up. A chain is unkeyed, and
only a copy the forger did not write survives the forger.

**5.3 What `approval status` and `approval doctor` say.** Status reports the
continuity line, including `retired.open` when it is non-zero ("the retired
chain left 1 open execution and 2 pending requests"). Doctor reports a claimed
or unverified continuity as a warning row, and an open obligation the retired
chain left as unhealthy, on SPEC.md §5.2's rule that an unreconciled denial MUST
NOT read as healthy. A recreate must not become the way an obligation
disappears.

---

## 6. Anchoring, checkpoints, and what never crosses

**6.1 Anchoring.** When the working log's seq 1 is `log.continued` and the
committed copy's genesis hash equals `retired.genesis_hash`, the anchor check
treats the committed copy as a copy of the retired chain and runs 5.1 steps 4 to
5 against it, in place of the byte-prefix comparison:

- head at `retired.seq` with the named hash: `anchor-continued`, which is a pass;
- head below `retired.seq`: `anchor-continued`, reported as "an earlier prefix of
  the retired chain; the link from its head to the named head is unverified
  without the retired log";
- a record past `retired.seq`: `continuity-retired-beyond-head`;
- the named seq carrying another hash: `anchor-diverged`, as today.

A committed copy whose genesis is neither chain's is `anchor-diverged`, as today.
Once the new chain is itself committed, the ordinary comparison resumes. The
check still MUST NOT fetch (SPEC.md §9).

**6.2 Checkpoints are unchanged, and already enough.** A `log.checkpoint` signs
a seq below its own in the same log, so it can never name a retired record, and
it does not need to. A human checkpoint on the new chain at any seq covers
`log.continued` by hash, so the existing ceremony is how a person endorses the
link after the fact, under the new chain's attested `audit.checkpoint_keys`. A
reader holding the retired chain's checkpoints can also compare `key_sha256`:
the same key signing on both sides shows the link was endorsed by the person who
signed the old history. No new signature field is proposed.

**6.3 What never crosses the boundary.** `log.continued` is never an input to a
verdict, a budget, a token, a sampling draw or an autonomy. Each item below
stays on the chain where it happened:

| item | across a recreate | why that is right, or what it costs |
|---|---|---|
| pending requests | gone; a tap on an old prompt refuses `not-requested` | a question on a chain nobody writes any more cannot be answered there |
| grants and tokens | gone; an old token refuses `not-granted` | importing a grant would let the new chain authorize on bytes it never verified |
| open window, loop streaks | gone; the new chain starts closed and with no streak | a window is a human ceremony on one log; a streak reset is visible as the recreate itself |
| budget consumption | NOT carried; rolling windows restart | **a cost.** A recreate forgives the window's consumption. Open question 2 |
| idempotency keys | NOT carried | **a cost.** An effect executed on the old chain can be executed again under the same key; provider-side idempotency is the only defence. Open question 3 |
| open obligations, indeterminate executions | counted in `retired.open` and reported unhealthy (5.3) | the count is diagnosis; resolving one still needs the retired record (open question 4) |

---

## 7. What an external follower reads to close its epoch

An external follower (the Agent Village research follower is the first) pages
`log/follow` with a `(seq, hash)` cursor per chain. On `cursor-mismatch` it
should:

1. **Read page 1 of the log from `(0, null)`** and take the seq-1 record.
2. **If its `event` is not `log.continued`**: today's path, quarantine and a
   manual reset.
3. **Otherwise read `payload.retired`** (`genesis_hash`, `seq`, `hash`,
   `basis`, `sealed`, `open`) and compare it with what the follower stored for
   the epoch it was reading: that epoch's genesis hash (which a follower SHOULD
   record on its first page from now on) and its cursor `(seq_c, hash_c)`.

| comparison | action |
|---|---|
| `genesis_hash` differs from the stored one | not this follower's predecessor: quarantine |
| `seq == seq_c` and `hash == hash_c` | **close the old epoch and open a new one at genesis, automatically** |
| `seq > seq_c` | the follower missed `seq_c+1 … seq`. With a retired copy (the export), verify the `prev` links from `hash_c` to `hash`, ingest them into the old epoch, then close. Without one, close the epoch flagged "gap of N records" |
| `seq < seq_c`, or `seq == seq_c` with another hash | `continuity-retired-beyond-head`: quarantine for a person |
| `basis == "claimed"` | close automatically only on the exact-match row; otherwise quarantine |
| a second successor names a retired head this follower already closed into a different successor | the store forked twice: quarantine both successors |

`retired.open` is copied into the epoch record, so the research record states
what the old chain left unfinished.

---

## 8. Alternatives considered

| alternative | verdict |
|---|---|
| The new seq 1 carries `prev` = the retired head, or `seq` continues from it | rejected: every existing verifier reports `not-genesis` or `seq-gap` (1.1), and the new file would claim records it does not hold |
| Keep writing on the forked copy | rejected: the old box may still append, so two writers share a prefix and diverge, which is the reason recreates start a fresh genesis. This design keeps the fresh genesis |
| A `continues` field on whatever the first record is | rejected: 3.1 |
| An external record only (an operator file, a control-plane row) | rejected as the record: it is the operator's word. Kept as a witness on the follower side |
| A record in the retired chain only | impossible in the common case (the old box is gone, and the successor does not exist yet when the old chain can be written). Kept as the optional `log.retired` |
| A new signature field on `log.continued` | not needed: 6.2 |
| A `system:` actor written by the daemon on first start | rejected: the daemon cannot know which copy is the right predecessor, and an automatic continuity claim is the operator's word with a runtime's stamp on it |

---

## 9. Proposed hunks, for a human to decide on

Proposed, not applied. All are additive: a log with no `log.continued` verifies,
anchors and checkpoints exactly as today.

**9.1 SPEC.md §8, the event-types bullet.** Add `log.continued` and `log.retired`
to the list, and after the `log.checkpoint` sentence:

> `log.continued` states that this log continues another whose store was
> retired. It MUST be the first record of a log, `seq` 1 with `prev` `null`, and
> appears nowhere else. It carries a `human:` actor and never any other, because
> whether two chains are one history is a person's assertion, and its `ts` is
> stamped at the write boundary. Its payload names the retired chain by
> `genesis_hash`, the hash of that chain's first record; its last record by `seq`
> and `hash`; the SHA-256 of that chain's bytes through the newline ending that
> record (`prefix_sha256`); a `basis`, `verified` when the runtime walked a copy
> of the retired chain and computed these fields itself, `claimed` when no copy
> existed and they were supplied, in which case the digest is absent; `sealed`,
> true iff the named record is a `log.retired`; optionally `open`, counts the
> runtime computed of what the retired chain left unfinished; a `reason` from a
> closed set; and an optional `note`. Under `verified` no chain field is a
> caller's parameter. An implementation MUST write it only to an empty log. It
> MUST NOT be read by any path that computes a verdict, a budget, a token, a
> sampling draw or an autonomy, and nothing recorded on the retired chain (a
> request, a grant, a token, an open window, a streak) has any effect on the new
> one. `log.retired` MAY be appended as a chain's last record when its store is
> retired and can still be written; it carries a `human:` actor and a `reason`
> from the same set, and any record after it is a finding. (Amended APRV-452,
> pending sign-off.)

**9.2 SPEC.md §9, a paragraph after "Checkpoints".**

> **Continuity.** A runtime that offers a continuity check MUST, for a log whose
> first record is `log.continued` and given a copy of the retired chain, verify
> that copy from its genesis and report a copy whose first record's hash is not
> the named `genesis_hash`, whose record at the named `seq` does not carry the
> named `hash`, or which holds any record past the named `seq`, each as a distinct
> refusal (`continuity-genesis-mismatch`, `continuity-head-mismatch` and
> `continuity-retired-beyond-head` in the reference runtime). A copy that passes
> those checks but whose bytes do not digest to `prefix_sha256` is reported as
> such beside the result and is not a refusal, because the chain is hashed over
> canonical content. Without a copy, the runtime MUST report the continuity as a
> claim naming the retired head and that no copy was supplied, and MUST NOT
> report it as a pass; a `basis` of `claimed` is reported as a claim in every
> case. Any witness to the retired chain beyond its named head, whether a
> follower's cursor, an anchored copy or a checkpoint signed on that chain,
> refutes the claim with `continuity-retired-beyond-head`. Anchoring composes
> with this: where the committed copy's first record is the named retired
> genesis, the anchor check compares it against the retired head in place of the
> byte prefix, and MUST NOT report the recreate itself as `anchor-diverged`.
> Checkpoints are unchanged, since a checkpoint on the continuing log covers its
> first record by hash. A runtime's health surfaces MUST report open obligations
> the retired chain left, as `open` counts them, as unhealthy, so that retiring a
> store is never a way for an obligation to disappear. (Amended APRV-452,
> pending sign-off.)

**9.3 SPEC.md §11.2.** A `continuity_refusal_codes` row group with the three
codes above and the verb's `continuity-log-not-empty`, beside the anchoring and
checkpoint unions, pinned by a test as §11.1 invariant 6 requires.

**9.4 `schema/event.schema.json`.** Both types join the event enum. A branch for
`log.continued` with `seq: {const: 1}`, `prev: {const: null}`, an actor matching
`^human:`, and a closed payload (`retired` with the fields of section 3,
`basis` an enum of two, `prefix_sha256` required iff `basis` is `verified`;
`reason` an enum of three; `note` bounded). A branch for `log.retired` with a
`^human:` actor and `reason`.

---

## 10. Conformance vectors needed

**chain-verification**: a log whose seq 1 is `log.continued` verifies clean; a
`log.continued` at seq 2 is `schema-invalid`; a `log.continued` with an `agent:`
actor is `schema-invalid`.

**continuity** (a new file; each vector ships the new log and, where named, a
retired copy): verified; genesis mismatch; head mismatch; a copy one record past
the head; a copy re-serialized with an intact chain (verified with
`bytes-differ`); no copy (claimed skip, exit 0); `basis: claimed` with a matching
copy (still reported as a claim); a sealed head followed by a record (beyond
head).

**gate-verdicts**: a token minted on the retired chain presented to the new chain
refuses `not-granted`; a decision on a request that only the retired chain holds
refuses `not-requested`.

---

## 11. Open questions

1. **Should `log/follow` carry the log's genesis hash on every page?** A
   follower would then notice a new chain without walking into a
   `cursor-mismatch` first. It is cheap, and it is an API change of its own.
2. **Budgets across a recreate.** Counting the retired chain's in-window
   consumption could only make budgets stricter, which §11.1 invariant 4 allows,
   but it would make `log.continued` (or the retired copy) an input to a budget
   verdict, which this design rules out. Leaning: keep it out, and have doctor
   say plainly that a recreate restarts every window.
3. **Idempotency across a recreate.** An executor could refuse keys the retired
   copy shows as executed, at the cost of requiring the copy at execution time.
   Leaning no; adapters with provider-side idempotency already carry it.
4. **Discharging an obligation the retired chain left.** `reconciliation.satisfied`
   must name an obligation in its own log. A new-chain record that names one by
   `(genesis_hash, seq)` would need its own rules. Until those exist, the health
   surface stays unhealthy, which is the honest answer.
5. **Who may write `claimed`.** It is the weakest record this design allows. A
   policy key could forbid it for a log that wants only verified continuity, but
   the policy does not exist yet when the record is written, which is why this
   note does not propose one.
