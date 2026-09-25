# CLI reference — the reasoning behind each verb

`approval <verb> --help` is the interface: the usage forms, the flags, the
`--json` shape, the refusal codes. This file is the other half — the design
rationale, the threat models, the points that surprise people on first reading,
and the alternatives that were rejected. It was moved here from the help texts
in APRV-91, mostly verbatim: an operator at a terminal wants the next thing to
type, and the reader who wants to know *why* is a different reader, at a
different moment.

The frozen exit-code table lives in `approval --help` and in `README.md`. The
cross-cutting stances every verb inherits — identity is declared and not proved,
a gate refusal is exit 1 and not 2, approval events are exclusive to the manual
path, the raw token is shown once, a channel is transport — are stated once at
the top of `approval --help` and are not repeated here.

`approval --version`, `approval -v`, and `approval version` print the package
version and exit 0. These aliases apply only at the top level; a version-looking
flag after a verb remains that verb's argument.

Each section below is what the corresponding `--help` points at with its
`why: docs/cli-reference.md#…` footer.

---

## instructions

One source for two surfaces. SPEC.md §10.5's optional MCP server exposes the
same verbs as tools and shares the CLI's code paths, so it derives its tool
descriptions and input schemas from what `--schemas` prints rather than from a
second list that would drift from this one. The verb table at the end of the
guide is generated from the registry, so a verb that exists in the CLI and not
in the guide is a test failure rather than a documentation lapse. Verbs marked
`[HUMAN-ONLY]` record or establish a human's authority: an agent must not call
them, and a wrapper must not publish them as tools.

The output is a pure function of this build: no log is read, no policy is
resolved, and nothing is written.

## log

Four subcommands open the log for reading only. `verify` walks the hash chain
end to end and reports clean | torn-tail | corrupt, `tail` prints the last N
records (default 10), `export` streams every stored line to stdout byte for
byte, and `follow` emits verified records after an exclusive cursor before
waiting for appends. The default log path is `.approval/log/events.jsonl`,
relative to the working directory.

## log verify

Anomalies do not change the verdict. SPEC.md §8 stamps the timestamps of
gate-typed events (`approval.*`, `execution.*`, `budget.*`, `audit.*`,
`policy.updated`) at the write boundary, so a backwards step of more than 2s
between two of them means either a clock that stepped backwards or a timestamp
that was authored rather than stamped. A clean log with anomalies is clean and
still exits 0. Chain integrity is a proof; skew is a judgment. Folding the
judgment into the proof would turn this verb into a check people learn to pass a
flag to silence.

An unreadable log is exit 4, not 1: a permission bit is not evidence of
tampering.

**`--json`** (one object on stdout):

```
clean      {"status":"clean","records":3,"head":{"seq":3,"hash":"<64 hex>"}}
torn-tail  {"status":"torn-tail","records":3,"head":null,
            "intactThroughSeq":3,"message":"..."}
corrupt    {"status":"corrupt","records":null,"head":null,
            "firstBadSeq":2,"reason":"hash-mismatch","message":"..."}
```

`head` is null for an empty log. `reason` is one of `malformed-line`,
`schema-invalid`, `bad-alg`, `hash-mismatch`, `prev-mismatch`, `seq-gap`,
`seq-duplicate`, `not-genesis`, `head-mismatch`. `anomalies` is ADDITIVE and
appears only when there is something to report:

```
[{"kind":"gate-ts-regression","seq":9,"ts":"...","event":"execution.started",
  "previousSeq":8,"previousTs":"...","skewMs":45000,"message":"..."}]
```

Human output: the status and head on stdout; reason, first bad seq, anomalies,
and the full message on stderr.

### `--anchor`: the check the file cannot make about itself (APRV-219)

Everything above is a claim about one file's internal consistency, and the
chain is unkeyed. A process with write access to `.approval/log/events.jsonl`
can truncate it and recompute a chain that walks clean from genesis; nothing
inside the file contradicts that, which is why the conformance suite's
`chain-verification/truncation-unanchored` vector says an implementation
reporting corruption there is wrong. The word doing the work in that vector's
name is *unanchored*.

The anchor is the copy of the log somebody else already holds: a records branch
pushed by the advance cadence, a log sync's fast-forward, the trunk behind a
protected branch. `--anchor` reads the newest committed copy this checkout can
see and checks two things about the working file:

1. its first N bytes hash to the anchored copy's digest, where N is the
   anchored copy's byte length; and
2. its record at the anchored head's `seq` carries the anchored head's hash.

The byte check is the stricter of the two: a rewrite that preserves every
record's own hash while changing the bytes around them still fails it.

Which revs are consulted, in order: `refs/approval/advance/*` (what a previous
`approval log advance` left behind), `refs/remotes/<remote>/<base>`,
`refs/remotes/<remote>/records-log-<today>`, then `HEAD`. The one that reaches
the highest `seq` wins. `--anchor-rev <rev>` names one instead, and implies
`--anchor`.

Git is READ — `git rev-parse <rev>:<path>` and `git show` — and never fetched:
a verification path that went to the network would be a verification path that
fails when the network does. Nothing is written: not the log, not a ref, not a
cache file.

Four outcomes:

| outcome | exit | meaning |
|---|---|---|
| `pass` | 0 | the working log carries the anchored prefix byte for byte |
| `behind` | 0 | the working log is a strict prefix of the anchored copy; `approval log sync` fast-forwards it |
| `skip` | 0 | no committed copy was found; the reason is printed on stderr |
| `anchor-diverged` | 1 | the two contradict each other |

A skip is never a pass. A repository with no committed copy of the log has not
established that the working log is honest; it has failed to say anything about
it, and the reason names every rev that was tried.

`--json` adds an `anchor` object, and a divergence replaces the verdict rather
than qualifying it:

```
pass       {"status":"clean","records":9,"head":{...},
            "anchor":{"status":"pass","rev":"refs/remotes/origin/main",
                      "seq":7,"hash":"<64 hex>","bytes":2412}}
skip       {"status":"clean",...,"anchor":{"status":"skip","reason":"..."}}
diverged   {"status":"anchor-diverged","records":9,"head":{...},
            "anchor":{"status":"diverged","rev":"...","seq":7,
                      "hash":"<64 hex>","bytes":2412,"message":"..."},
            "message":"..."}
```

`anchor-diverged` is its own frozen refusal union
(`conformance/vectors/refusal-unions.v1.json`, `anchor_refusal_codes`).
`approval doctor`'s `log-drift` row is this same check, and `approval daemon
run` makes it at startup and on every full prefix re-proof — see
[git evidence](git-evidence.md).

### `--checkpoints`: the second witness (APRV-220)

The anchor asks whether anybody else holds a copy of these bytes, and answers
from git, so it is exactly as fresh as the last push and says nothing at all on
a machine with no remote. `--checkpoints` asks a different question: did a key
that no agent process holds sign this head? It answers from the log plus the
policy, so it works offline and covers the window nobody has pushed yet. The
design behind the mechanism, including why an unknown key is a refusal and why
the signing key is not the attestation identity, is
[checkpoints](checkpoints.md).

The two are independent and neither may be weakened to let the other pass. A
forger who truncates the log and recomputes the chain defeats neither: the
anchor sees bytes nobody else has, and every checkpoint inside the rewritten
range now names a hash the rewritten chain does not carry.

Every `log.checkpoint` record in the walked range must clear four things:

1. its payload reads (`seq`, `hash`, `alg: ed25519`, `key_sha256`, `signature`);
2. the seq it signs is below its own (a checkpoint signs the past);
3. its `key_sha256` names one of `audit.checkpoint_keys` in the policy;
4. the signature verifies over `"approval.md/log-checkpoint/v1\n"` followed by
   the RFC 8785 canonicalization of `{alg, hash, seq}`, AND the log's record at
   that seq carries that hash.

The first failure refuses, with its own frozen union
(`conformance/vectors/refusal-unions.v1.json`, `checkpoint_refusal_codes`):
`checkpoint-key-unknown`, `checkpoint-signature-invalid`,
`checkpoint-hash-mismatch`, `checkpoint-out-of-order`, `checkpoint-malformed`.
The third of those is the one this whole check exists for.

`checkpoint-key-unknown` is a refusal rather than a shrug, deliberately. If a
record naming an unlisted key were merely skipped, a forger could neutralize the
whole mechanism by rewriting each checkpoint's `key_sha256`. The cost is that
retiring a key out of `audit.checkpoint_keys` de-verifies every checkpoint it
signed, which is why that field is a list and why retired keys stay in it.

| outcome | exit | meaning |
|---|---|---|
| `pass` | 0 | every checkpoint in range validates (possibly none, which is not a failure) |
| `skip` | 0 | no usable key is configured; the reason is printed on stderr |
| `checkpoint-invalid` | 1 | a checkpoint in range does not validate |

A log with no checkpoints at all is a pass, not a refusal: a human who has been
away is not a forger. When `audit.checkpoint_every` is set and the newest
checkpoint is older than it, the pass carries a `warning` — report-only, at
every layer, with no path anywhere in this runtime from due to refused.

A missing key is a skip and never a pass, the same rule the anchor follows.

```
pass    {"status":"clean",...,"checkpoints":{"status":"pass","verified":3,
          "keys":1,"unchecked":0,"newest":{"at":41,"seq":40,"hash":"<64 hex>"}}}
skip    {"status":"clean",...,"checkpoints":{"status":"skip","reason":"..."}}
bad     {"status":"checkpoint-invalid","records":9,"head":{...},
         "checkpoints":{"status":"refused","code":"checkpoint-hash-mismatch",
                        "at":41,"verified":2,"message":"..."},"message":"..."}
```

## log checkpoint

The human half of the mechanism `log verify --checkpoints` reads. It signs the
log's CURRENT head with an Ed25519 key and appends one `log.checkpoint` record
carrying `(seq, hash)` and the signature.

```
approval log checkpoint --as human:<id> [--key-file <path>] [--log <path>] [--json]
```

Human-only in three independent places, because this is the one record an agent
must not be able to author: `core/checkpoint.ts` refuses a non-`human:` actor,
`schema/event.schema.json` refuses one at the write boundary, and
`core/command-class.ts` classifies the invocation `policy.core`, which the
reference policy holds human-only, so the harness hook denies an agent that
tries to run it.

**Where the key comes from.** The private half lives in the credential vault
under `approval.checkpoint.key`: encrypted at rest under the passphrase
`vault.passphrase_env` names, which `core/child-env.ts` strips from every child
this runtime spawns, in a file whose reading classifies `account.credential`.
`--key-file <path>` reads it from a file instead, for a key kept outside the
vault. There is no `--key` flag and no environment variable holding the key
itself: a key on a command line is a key in the shell history, and a key in the
session environment is a key every child inherits.

**Where the public half goes.** `audit.checkpoint_keys` in `APPROVAL.md`, base64
DER SPKI, which only the human may edit. It is written in the policy rather than
carried by the record because a record that carried its own public key would
invite a reader to verify the signature against it, which any forger could
satisfy. The record names only a fingerprint; the policy is the authority.

The head is read, then signed, then written with that head as the
compare-and-append precondition, so a concurrent append is `head-moved` and the
repair is to run the verb again. Nothing partial is left behind.

```
{"ok":true,"seq":41,"signed":{"seq":40,"hash":"<64 hex>"},
 "key_sha256":"<64 hex>","actor":"human:carter","ts":"..."}
{"ok":false,"error":{"code":"checkpoint-key-unreadable","message":"..."}}
```

Refusals: `actor-not-human`, `checkpoint-key-unreadable`,
`checkpoint-key-unusable`, `checkpoint-head-unknown`, `log-empty`,
`log-unreadable`, `log-torn-tail`, `log-corrupt`, `append-failed`. A torn or
corrupt log is exit 1; everything else here is exit 4, because an operator
without a key does not have a broken log.

### The tap: being asked instead of remembering (APRV-257)

This verb is the terminal form, and it requires you to remember. With
`audit.checkpoint_every` set in the policy, you do not have to.

When the cadence has lapsed, the listener puts one prompt in the chat:

```
CHECKPOINT DUE — sign the log head at seq 14892?
head  seq 14892  <64 hex>
The newest checkpoint is at seq 14310.
audit.checkpoint_every is 24.0h and the newest checkpoint … is 31.2h old …
[ Sign ]  [ Not now ]
```

`approval channel cli` asks the same question in a terminal, with `s` and `n`
instead of buttons, before it walks the queue.

Four properties, and each one is a decision rather than an accident.

**What you are shown is what gets signed.** The prompt carries a `(seq, hash)`,
and the signature covers exactly that, however long the phone stays in a pocket
and however far the head has moved by the time you tap. This is why APRV-220's
verify rule asks only that a checkpoint signs a seq *below* its own rather than
its immediate predecessor. If the chain no longer carries those bytes at that
seq, the tap is refused (`checkpoint-head-unknown`) and nothing is signed:
signing there would mint a record that `checkpoint-hash-mismatch` refuses
forever after.

**The signing happens where the listener runs.** That process holds the vault
passphrase because a human exported it into the shell they started it from, and
`core/child-env.ts` strips that variable from every child an agent's session
spawns. Nothing an agent can do produces a process that reaches the key.

**At most one outstanding, and never a nag.** A lapsed cadence would otherwise
produce an offer on every dispatch cycle. The listener asks once per lapse, and
asks again only after a checkpoint actually lands (which is also when the
cadence resets). A restart re-asks once, which is the same direction every other
piece of a channel's bookkeeping degrades in.

**Declining costs nothing.** There is no path in this runtime from a checkpoint
that is due to a refusal of anything: it is a warning on `log verify`, a
`checkpoint-due` warning on the daemon's tick, and a `fix` line on `approval
doctor`'s `checkpoint` row. A gate that held up an action for want of a tap is a
gate whose operator turns the check off.

## log follow

`approval log follow --from <seq> --json` is the channel-independent decision
listener. `--from` is exclusive and defaults to zero, so a new consumer first
receives the entire verified log. Output is JSON Lines: one complete stored
event object per line. It emits every event type in chain order; a refund or
queue consumer selects the decisions relevant to its own work. The command then
remains in the foreground and exits 0 on SIGINT, SIGTERM, or a closed downstream
pipe. Signal cancellation may interrupt the final native stdout write. Consumers
must process only newline-terminated JSON records, discard any incomplete final
fragment, and reconnect from the cursor of the last complete record they
processed.

Filesystem notifications only prompt another read. On every notification wake
and every bounded 500ms fallback poll, the runtime rereads and verifies the
complete chain from genesis through the observed head, even when the log has not
changed. It emits nothing from a corrupt, torn, unreadable, truncated, or
cursor-mismatched snapshot. Pull backpressure means a slow consumer holds one
verified snapshot and no growing notification or event queue. Each check costs
O(N) verification time and O(N) snapshot memory for a log of N records. This
bounded initial implementation is not an incremental, low-overhead tail.

`--cursor-hash <64hex>` supplies the hash of record `--from`. Store both the
sequence and hash outside the log and pass both on reconnect. That binding
detects a truncated or replaced prefix. A sequence alone is a weaker bootstrap:
an internally valid rewritten prefix with the same sequence numbers cannot be
distinguished from the original, for the same reason an unanchored hash chain
cannot detect a fully recomputed forgery.

Delivery across reconnects is at least once. Apply the external effect first,
then persist the emitted event's `seq` and `hash`; a crash between those steps
replays the event. Consumers that require exactly-once external effects must
make their own effect idempotent or transact it with cursor storage. Persisting
the cursor before the effect instead risks silently losing that effect.

The stream uses the existing exit classes: 1 for corrupt or mismatched cursor,
2 for usage, 3 for a torn tail, and 4 for I/O. Its error object is written to
stderr and no event from the refused batch is written to stdout. `log follow`
is deliberately absent from MCP because one unbounded call would occupy the
finite MCP call queue; run it as a separate CLI process.

## log tail

The chain is verified first. On a torn tail the intact records are printed and the
tear is a warning on stderr; on a corrupt log no records are printed at all. An
empty or absent log prints nothing and succeeds, and nothing is repaired.

Two human shapes, by whether colour is on. **In a pipe (and under `NO_COLOR`) the
fields are tab-separated**, one record per line — `seq`, `ts`, `event`, `actor`,
`task` — which is the shape `cut -f2` and every script that reads this verb rely
on, and it is not going to change. On a terminal the same fields are printed as
an aligned table, the seq right-aligned and the actor coloured by kind (human,
agent, system); the timestamp and the seq stay undressed because they are values
an operator copies.

```
{"status":"ok","records":[<event objects, oldest first>]}
{"status":"torn-tail","records":[...],"warning":"..."}
```

## log export

Without `--json` the stored lines are written verbatim, byte for byte: piping
export to a file yields a copy of the log. The chain is verified first; a torn
tail prints the intact lines with a stderr warning and exits 0, a corrupt log
prints nothing and fails. The log is never modified.

```
{"records":[<every event object, oldest first>]}
{"records":[...],"warning":"..."}   on a torn tail
```

## log sync

The pull half of the log ritual, and the verb that retired the stash dance.

Bringing the committed log up to date used to be run by hand: stash
`events.jsonl`, pull, pop the stash. It was our own sanctioned runbook and it
was dangerous three ways. It rewound the working log through git while a daemon
held that file open for append, which is fork 2 of 2026-08-20 (a rewound file
under a live appender, and two chains where there was one). It reached the
approver's phone as `policy.edit` over a protected path, a label that is true
and tells nobody anything. And `git stash pop` can conflict, which on the day it
did left conflict markers inside the log mid-ceremony.

So the ritual became deterministic code, on the `policy amend` precedent: when a
hand-ritual proves dangerous, it becomes a verb the gate can read.

**You rarely type it any more (APRV-346).** `approval up`'s preflight calls this
function itself whenever the working log is a byte-for-byte extension of the
committed one, which is the state every records advance leaves behind. What is
left for a hand-run `approval log sync` is the fork: two chains that share a
prefix and then carry different records at the same `seq`. See
[up](#up) for what the preflight checks before it delegates.

Everything runs inside ONE hold of the append lockfile. The lock is normally
taken per append; here it spans the whole operation, because an append landing
between the snapshot and the restore is exactly the interleaving that forks a
chain.

1. **Primary checkout only.** The committed log has one home, and a worktree is
   not it: `log-sync-not-primary`.
2. **Verify before touching anything**, and record the head. Nothing is decided
   from a log that does not verify.
3. **Snapshot, not stash.** The working log is copied aside, atomically, inside
   `.approval/`. `git stash` appears nowhere in the implementation, and the log
   never routes through git state mutation.
4. **Baseline.** The working LOG is set to the bytes git already has at `HEAD`,
   so the path is clean and a fast-forward can move over it. That is a plain
   write of bytes we are holding, not a checkout. The log can be baselined this
   early because nothing can dirty it in between: sync holds the append lock,
   and appending is the only thing that writes it. The projections cannot, and
   are handled at the merge instead (see below).
5. **Fetch, a fast-forward CHECK, the projections are discarded, then the
   merge.** A non-fast-forward is named and refused
   (`log-sync-not-fast-forward`): a merge commit over the log would be a merge
   of two hash chains, and chains do not merge.
6. **Untracked payload files, between the check and the merge.** `git merge
   --ff-only` refuses to write over an untracked working-tree file, and a records
   advance commits the payload store, so a checkout that already held those
   payloads untracked used to stop the fast-forward with `log-sync-git-failed`
   and a hand step (seen 2026-09-02, after the advance to seq 11361 merged: 33
   files, every one identical). Sync lists the untracked, non-ignored files under
   `.approval/payloads/` that the incoming commit also carries, and proves each
   one twice before a single byte moves: SHA-256 of its bytes is its own
   filename (the store writes canonical bytes, so a payload file is
   self-addressed), and its bytes equal the incoming blob. The comparison is over
   bytes read with `git show`, never git's blob id, which is SHA-1 over a header
   plus the content and is a different hash of a different thing. Only once every
   file has passed are the local copies removed, and the count is reported. A
   file that fails either test refuses `log-sync-payload-mismatch`, naming it: a
   payload is the material evidence an approval bound to, and two versions of one
   is a question about which bytes a human said yes to rather than a merge
   conflict. Nothing is pulled, nothing is appended, and the working tree is left
   as it was found. A local payload the incoming commit does **not** carry blocks
   nothing and is not touched.
   **The queue projection is discarded, as the last statement before the
   merge** (APRV-292). A records commit carries `.approval/QUEUE.md` as well as
   the log, and the daemon re-renders that file every tick under no lock at all
   (its TTL countdowns move even when the log does not), so a projection cleaned
   up any earlier can be dirty again by the time `git merge --ff-only` looks at
   it. That is the refusal of 2026-09-07:
   "local changes to .approval/QUEUE.md would be overwritten", twice, the second
   time straight after a hand-run `git checkout` of exactly that file. A
   projection is a rendering of the log, rebuilt at step 8 from the reconciled
   log, so sync throws the working copy away rather than reconciling it: no
   proof, no comparison, nothing to weigh. Discarding late is what makes it
   stick, and a merge that still fails with a projection dirty again is retried
   exactly once before it refuses. A projection git neither has at `HEAD` nor
   carries in the incoming tree can stop no merge and is left alone, which is
   why the gitignored `.approval/index.sqlite` is never cleared here.
7. **Reconcile.** The committed chain must be a prefix of the snapshot, equal to
   it, or an extension of it. Prefix: the snapshot goes back, because the longer
   chain contains the shorter one whole. Extension: the pulled file stays, for
   the same reason in the other direction. Anything else is a fork:
   `log-diverged`, both heads, the first divergent seq, snapshot restored,
   nothing else touched. Re-chaining is fabrication and this verb will not do it.
8. **Projections are REBUILT, never copied back.** `QUEUE.md` is re-rendered from
   the reconciled log and the index is reindexed from it. The direction is
   load-bearing: a projection restored from before the pull would be a
   screenshot asserting something the log no longer says. `QUEUE.md` is
   snapshotted at step 3 all the same, for the refusal path alone, so a sync
   that refuses leaves the whole working tree as it found it.
9. **Post-verify**, and only then is the snapshot removed.

Any failure at any step restores the snapshot before exiting, so the working log
is never left in a half state, and a restore that itself fails is its own loud
refusal (`log-sync-restore-failed`) which leaves the snapshot on disk.

**It appends no event.** The log records decisions with real-world consequence.
A fast-forward pull of the file the log lives in is housekeeping on the
container, and an event for it would be the log narrating its own filesystem.

```
{"ok":true,"root":"…","log":"…","remote":"origin","branch":"main",
 "commit":{"before":"…","after":"…","pulled":2},
 "head":{"before":{"seq":41,"hash":"…"},"after":{"seq":41,"hash":"…"}},
 "relation":"ahead","ahead":3,"behind":0,"restored":true,
 "payloads":{"reconciled":33},
 "queue":{"path":"…","bytes":1180},"index":"rebuilt"}
```

## log advance

The commit-and-push half, and the APRV-92 flow written down. The records the
remote does not have yet are gathered into a commit whose message names the seq
range they cover, and pushed to a short-lived records branch that exists for
exactly that commit. Main is protected here, so the commit reaches it through a
pull request; `--pr` opens that pull request through the ordinary `gh` path.

This verb carries the class `log.advance` for everyone who runs it, in a
session, in an orchestrator, or at a human terminal. The daemon's cadence
advance is the one that may carry `log.advance.daemon` instead, and only from
inside the daemon process: see the `--advance` paragraph under `daemon run`
(APRV-382).

An advance publishes the WHOLE log, so while its branch is open on origin it is
the log's publisher and `policy amend` stands aside: an amendment opened in that
window carries only the policy bytes and cannot conflict with the records. See
"Who publishes the log" under `policy amend` (APRV-420).

`--co-author "Name <email>"` adds one validated `Co-authored-by` trailer to the
generated records commit and to the pull request body. When the day's pull
request already exists, the verb preserves its body and adds the trailer once.
This is display credit only. It does not set an event actor, name an approver,
grant authority, or derive an identity from the log. Omitting the flag preserves
the existing commit message, pull request body, and merge command byte for byte.

The merge queue ignored the custom auto-merge commit body observed on PR 378.
For a queued merge commit to retain this credit, the repository must use GitHub's
PR-body merge-message setting (`merge_commit_message=PR_BODY`); the package does
not change repository settings. The PR body is therefore the durable source the
queue can copy, rather than a claim that `gh pr merge --body` controls the final
queued merge.

**You do not fetch or reset first (APRV-203).** The verb owns its own git
preconditions: it fetches the base branch (the one you are standing on, or
`--base <name>`), builds the commit on `origin/<base>` in a scratch index rather
than on your branch's tip, and pushes it by refspec. Your checkout ends the verb
exactly as it started it: same branch, same index, same working tree. A local
branch that is AHEAD of origin with commits the verb did not make is not a
refusal; the advance is based on origin either way and those commits are simply
not part of it.

**One records branch and one pull request per day (APRV-204).** The branch is
`records-log-<YYYY-MM-DD>` unless `--branch` names another. The first advance of
a day is parented on `origin/<base>` and opens the pull request; every later
advance that day fetches the records branch, parents its commit on THAT, and
fast-forwards the branch the open pull request is already on — so a second
advance updates the day's pull request rather than being rejected as a
non-fast-forward or opening a second one. `--pr` asks `gh pr list --head <branch>
--state open` first and runs `gh pr create` only when nothing is open. A records
branch whose log the working log is not a prefix of is refused with the same two
codes the trunk is, naming the branch.

**`--pr` also arms the merge (APRV-284).** After the pull request is open or
updated, the verb runs `gh pr merge <records branch> --merge --auto`, so the day's
records land as a merge commit the moment CI and the branch rules allow it and
never before. A records pull request is the one shape here that never needed a
reviewer (it carries exactly the log, `QUEUE.md` and `.approval/payloads/`, the
three paths CI's protected-path guard exempts), so what it was waiting for at
CLEAN was a click and not a judgement. The arm is the same command with the same
class a session's own arm has, `vcs.push.main`, and it runs inside whatever
authorized the advance; nothing here asks a second question.

Two things it will not do. It WITHHOLDS the arm when the pushed branch carries a
path outside those three (a commit this verb did not make, sitting on a shared
branch), naming what it saw — the reasoning that makes a records pull request
safe to auto-merge is a claim about the diff, so it is checked rather than
assumed, and anything unreadable withholds too. And an arm `gh` refuses (auto-merge
disabled on the repository, a merge queue, a pull request already mergeable) is
reported and never fatal: the records are committed, pushed and open either way.
`--no-auto-merge` skips the whole step. The outcome is the `auto-merge` row in the
table and `autoMerge` (`armed` | `withheld` | `refused` | `off` | `null`) plus
`autoMergeNote` in `--json`.

Five refusals are the point of the verb.

`log-advance-fetch-failed`: the base branch could not be fetched, so there is no
base to build on. Nothing is committed.

`log-advance-behind-remote`: `origin/<base>` carries log records this working log
does not, so there is nothing here to publish and an advance would propose the
shorter chain. Run `approval log sync` first.

`log-advance-remote-diverged`: the working log and the remote's log are two
chains rather than one. Hash chains do not merge, so which of them is the log is
a human decision; `approval doctor` names the first divergent seq.

`log-advance-dirty-stage`: the staged set must be EXACTLY the log, `QUEUE.md`,
and `.approval/payloads/`. What this prevents is a log commit riding a branch
that carries other work. A verb that ran `git add -A` and hoped would be a worse
version of the hand-ritual it replaces, so anything else already staged is
refused rather than unstaged — unstaging someone's work is not this verb's
decision to make.

`log-advance-checkout-required`: this verb checks out nothing. The checkout is
the footgun, because a branch switch with an uncommitted working log rewinds
`events.jsonl` under whatever holds it open. It assembles the commit in a scratch
index (`GIT_INDEX_FILE`, `read-tree`, `write-tree`, `commit-tree`) and pushes
that commit by refspec, which moves no local ref and touches no file.

`log-advance-not-primary`: sync's rule, unchanged.

**It appends no event**, for the reason sync appends none. The commit is already
the record of itself, in git, where a reader can see exactly which bytes moved.

```
{"ok":true,"root":"…","branch":"main","recordsBranch":"records-log-2026-08-26",
 "remote":"origin","base":{"branch":"main","sha":"…"},"range":{"from":39,"to":41},
 "head":{"committed":{"seq":38,"hash":"…"},"working":{"seq":41,"hash":"…"}},
 "staged":[".approval/log/events.jsonl",".approval/QUEUE.md",".approval/payloads"],
 "message":"Log advance: seq 39..41 (main)","commit":"…","pushed":true,
 "prUrl":null,"prCreated":false,"autoMerge":null,"autoMergeNote":null,
 "dryRun":false}
```

## policy

`policy check` answers the question "what would policy do with this class", and
a policy too broken to load has a perfectly good answer — manual, everything,
always. That is why a load failure is exit 0 with a `manualBecause` of
`load-failure`, and why callers branch on `manualBecause` / `provenance` rather
than on the exit code.

`manualBecause` says why a manual answer is manual, and is null when the answer
is not manual:

- `matched-rule` — a classes rule, or `defaults.autonomy`, says manual. The
  policy was read and understood, and it says ask.
- `irreversibility-floor` — policy granted autonomous or supervised and SPEC §7's
  floor overrode it because `--reversible false` was given. `overridden` records
  what policy actually said. The floor remains the default when a class rule
  omits `allow_irreversible` or writes `false`.
- `load-failure` — the policy could not be loaded at all, so every class is
  manual. `loadFailure` carries a code and a message.

The exit codes, at length. `policy check|test` uses only 0, 2 and 4:

- **0** the question was answered, INCLUDING the fail-closed answer. A missing,
  unparseable or schema-invalid policy is not an error here: a broken policy IS a
  manual-everything policy, and "manual, because the policy failed to load:
  `<code>`" is the answer, delivered on stdout with exit 0.
- **2** usage: a missing `<class>`, an unknown flag, or a class that is not a
  valid action class (lowercase dotted segments; wildcards are patterns, not
  actions, and are rejected).
- **4** I/O: a policy path that exists but cannot be read (a permission bit).
  Never used for a parse or schema failure; those are the answer above.

1 and 3 are never returned by this command.

## policy check

`policy check` and `policy test` are the same command; SPEC.md §10.1 names both.
`<class>` is a concrete action class, never a pattern: `*` is something a policy
key may contain, never something an agent can do.

`--reversible` takes an explicit value because "unstated", "reversible" and
"irreversible" are three different questions. Explicit `false` asks for the
effective irreversible answer. It resolves to `manual` by default. A nonmanual
class retains its autonomy only when every equally most-specific matching rule
sets `allow_irreversible: true`. Lower-specificity rules do not vote, defaults
cannot opt in, and neither this flag nor any other action metadata can create
the permission. Manual remains manual and human-only remains human-only.

For an allowed `supervised-live` class, the existing live sampler decides
whether this action prompts before execution. Allowed `supervised` and
`supervised-retro` actions execute first and remain eligible for retrospective
review. Allowed autonomous actions proceed without either review path. Telegram
appears only when the effective path actually requests approval through that
channel; policy-authorized execution is never represented as a human grant.

**`--json`** (one object on stdout):

```
{"class":"vcs.push.main","reversible":null,
 "outcome":{"autonomy":"supervised","approvers":null,"limits":null,
            "allowIrreversible":false},
 "provenance":"rule"|"default"|"inherited"|"fail-closed"|"floor",
 "manualBecause":null|"matched-rule"|"irreversibility-floor"|"load-failure",
 "loadFailure":null|{"code":"file-missing"|"no-block"|"multiple-blocks"|
                     "yaml-error"|"schema-invalid"|"protected-route-floor",
                     "message":"..."},
 "matched":null|{"pattern":"vcs.push.main","rule":{"autonomy":"supervised"}},
 "overridden":null|{"pattern":"read.web"|null,"autonomy":"autonomous"},
 "irreversibility":"not-applicable"|"policy-allowed"|"floor-applied"|
                   "already-manual"|"human-only",
 "irreversiblePatterns":["read.*"],
 "candidates":[{"pattern":"read.*","specificity":[1,1,2],
                "autonomy":"autonomous","winner":true,
                "tieBreak":"specificity"|"strictest-autonomy"|
                           "lexicographic"|"tied-specificity"}],
 "decisionPath":["...","..."]}
```

`specificity` is [literalSegments, wildcardSegments, totalSegments] (SPEC §5.2).
`overridden.pattern` is null when the floor overrode `defaults.autonomy` rather
than a rule.

`provenance: "inherited"` is the APRV-266 case: a `policy.edit` sub-class that
no rule matched, decided by the `policy.edit` line it is a sub-class of.
`matched` names that line, and `candidates` is empty, because the line decided
without matching the class being asked about — which is exactly why this is not
`"rule"`. It is not `"default"` either: `defaults.autonomy` was not consulted.
The `decisionPath` says so in as many words. Inheritance is the `policy.edit`
namespace and nothing else; every other class with no matching rule still takes
`defaults.autonomy`, and `read` under a `read.*` rule is still `manual` for
exactly the reason §5.2 gives.

`loadFailure.code` gained `protected-route-floor` in the same change: a
`protected_paths` entry routed a built-in protected path to a sub-class that
resolves more loosely than the `policy.edit` line itself, which would narrow the
protected surface without removing a path from any list. The policy does not
load, so every class answers `manual` with `manualBecause: "load-failure"`, and
the message names the offending entry.

Human output: the `decisionPath` lines, then a final line `-> <autonomy>`
carrying "(fail-closed: `<code>`)" or "(floor applied over `<pattern>`:
`<autonomy>`)" when either applies. stderr stays empty on a successful answer.

## policy attest

Appending a `policy.updated` event records the SHA-256 of the policy file's
exact bytes. Gate operations refuse whenever the live file's hash differs from
the latest attestation or no attestation exists, with the distinct
machine-readable reason `policy-not-attested`. An edited policy is inoperative
until a human re-attests it.

Identity is config-declared: it comes from `--as` or `APPROVAL_HUMAN`, and
nothing here authenticates it. The trust boundary is the local machine — anyone
who can set that variable and write to the log is inside it. An attestation
therefore proves that someone with local control signed off, not who;
cryptographic identity is future work, not a v0.1 claim.

Bytes, not parse: the file is hashed as it sits on disk and does not have to be
loadable. Attesting a schema-invalid policy is allowed and records exactly what
it says — a human saw these bytes. It does not make a broken policy work; a
policy that fails to load is still manual-everything.

**`--json`** (one object on stdout):

```
success  {"ok":true,"seq":7,"sha256":"<64 hex>","path":"/abs/APPROVAL.md"}
refusal  {"ok":false,"error":{"code":"...","message":"..."}}  on stderr
```

`path` is the file that was hashed; the logged payload carries its basename only,
so an exported log leaks no home directory. The event's payload is
`{"policy_path":"APPROVAL.md","sha256":"<64 hex>","payload_hash":"<64 hex>"}`.

**`payload_hash`: the attested bytes, recoverable (APRV-356).** The verb also
writes the attested text to the payload store beside the log and binds that
file's hash on the record, so the policy IN FORCE can be produced rather than
only named. A digest cannot produce the file it names, and the privileged-gesture
rule (`policy.core` gestures from a channel, SPEC.md §10.3) has to be decided
against the policy in force rather than against the one being proposed. A reader
re-hashes the recovered text against `sha256` from the verified log, so the store
is checked rather than trusted, and a store that cannot be written REFUSES the
attestation: nothing is appended, because a record claiming a binding whose bytes
are absent is a worse artifact than no record. Records written before this
existed still validate and verify; a reader treats the absent field as the
pre-amendment state, where the in-force bytes are unrecoverable and the
fail-closed fallback applies.

### `--organ <path>`: the gate's organs (APRV-272)

The ORGANS are the harness files that install the hook: `.claude/settings*`,
`.cursor/hooks.json`, `.cursor/hooks/` and `.cursor/agents/`. They classify
`policy.core`, and `policy.core` is human-only in this repository's policy, so
the gate mints **no** record for a change to one: no request, no grant, no
token. That is deliberate, and it left a hole. The CI-side protected-path guard
requires evidence in the committed log for every protected path a pull request
touches, and for an organ there was no evidence it could ever accept, so a human
who hand-edited the settings file could not get the change through review. This
flag closes it.

```
approval policy attest --organ .claude/settings.json --as human:<id>
```

One path per call, repository-relative (an absolute path under `--dir` is
accepted and recorded relative). The runtime hashes the bytes on disk; there is
no flag for the digest. The record is a **`gate.organ.attested`** event, never a
`policy.updated`:

```
{"event":"gate.organ.attested","actor":"human:<id>",
 "payload":{"organ_path":".claude/settings.json","sha256":"<64 hex>"}}
```

Nothing in the gate reads it. An organ attestation does not make an unattested
policy operative and does not change the `policy_sha256` a request or a grant is
decided under; a separate event type is what makes that true by construction
rather than by a filter every reader has to remember. What reads it is the
guard, which passes a guarded organ when the blob at the head commit hashes to a
digest a human attested **for that same path**. A digest attested for another
path is not evidence, and bytes edited after the attestation are not attested.

Two refusals are specific to this flag, both exit 2:

```
path-is-policy   the policy file: use `approval policy attest` with no --organ
path-not-organ   not one of the gate's organs (an ordinary file, or the
                 approval home, which is the human's own ceremony surface)
```

`--policy` and `--organ` together are a usage error rather than a precedence
puzzle. `--json` adds `organ_path` to the success object:

```
success  {"ok":true,"seq":7,"sha256":"<64 hex>","path":"/abs/.claude/settings.json",
          "organ_path":".claude/settings.json"}
```

`approval doctor`'s `gate-organs` row lists the organ files in a checkout whose
current bytes carry no attestation. It never moves doctor's exit code: an
unattested organ breaks nothing on this machine, and the enforcement for one is
the guard in CI.

### `--path <path>`: signing off a protected file (APRV-338)

SPEC.md's amendment-provenance rule says text that reached a protected file
without a grant carries `(Amended APRV-n, pending sign-off.)` and holds no more
authority than a proposal until a human ratifies it. Nothing recorded the
ratification: no event, no verb, and no way for CI or doctor to tell a ratified
amendment from a pending one. This flag is that record.

```
approval policy attest --path SPEC.md --as human:carter
```

One path per call, repository-relative (an absolute path under `--dir` is
accepted and recorded relative). The runtime hashes the bytes on disk; there is
no flag for the digest. The record is a **`gate.path.signed_off`** event:

```
{"event":"gate.path.signed_off","actor":"human:<id>",
 "payload":{"path":"SPEC.md","sha256":"<64 hex>"}}
```

**Which paths.** Exactly those whose edits classify `policy.edit` or a
`policy.edit.*` sub-class: the built-in prose set (`CLAUDE.md`, `AGENTS.md`,
`.npmrc`, `.github/workflows/`) plus everything the live policy's
`protected_paths` widens to, including a path routed to a sub-class such as
`policy.edit.design`. The policy is loaded to answer that, and a policy that
does not load contributes nothing, which narrows what may be signed rather than
widening it.

Three refusals are specific to this flag, all exit 2:

```
path-is-policy       the policy file: use `approval policy attest` with no flag
path-is-core         a gate organ (use --organ), the approval home, or the log
                     directory, which no verb ratifies
path-not-protected   an ordinary file, or a path that is not repository-relative
```

`--organ` and `--path` together are a usage error, as are `--policy` and
`--path`: each pair names two different claims and guessing which one was meant
is how the wrong record gets written. `--json` adds `signed_path`:

```
success  {"ok":true,"seq":7,"sha256":"<64 hex>","path":"/abs/SPEC.md",
          "signed_path":"SPEC.md"}
```

**Weaker than a grant, and read last.** A grant binds the exact hunk a human saw
in a prompt; a sign-off stands for the whole file. So the protected-path guard
asks about a sign-off only after its search for a grant covering the change has
come up empty, and the finding it prints says so in words. A change that a grant
does cover still passes on the grant and still names it. Signing off is for the
case the pending-sign-off suffix was invented for: text a human has read at that
commit and agrees with, for which no grant was ever taken.

**Signing off bytes that are on a branch.** The digest the guard checks is the
file's blob at the commit under review, and that is usually a pull request's
head rather than anything on disk in the primary checkout. `--dir` and `--log`
are separate flags for exactly this: `--dir` is the checkout whose bytes are
hashed and which the recorded path is relative to, `--log` is the log the record
is appended to. So a human ratifying an open pull request reads the change,
puts a checkout at that commit somewhere (a `git worktree`, or the branch
checked out in a scratch clone), and runs:

```
approval policy attest --path SPEC.md \
  --dir /path/to/checkout-at-that-commit \
  --log /path/to/primary/.approval/log/events.jsonl \
  --as human:<id>
```

The record lands in the primary checkout's log, where a log advance carries it
to a records branch, and the guard then finds it for that path at that digest.
The verb never writes a log inside the worktree it hashed. If the digest it
prints is not the one the guard's failure named, the checkout is at the wrong
commit or the file has been edited since: the two must agree exactly, and a
mismatch is a sign-off on bytes nobody reviewed.

The verb classifies `policy.core` when `--path` is present (without it the verb
attests the gate's own configuration and stays pass-through), so under this
repository's policy the harness hook denies it to an agent with
`hook-class-human-only` before the verb's own `actor-not-human` refusal is
reached. `approval doctor`'s `pending-sign-off` row lists the protected files
that still carry the marker with no record over their current bytes; like
`gate-organs` it never moves doctor's exit code.

## policy amend

**Progress, on stderr.** The verb re-verifies the whole chain and recovers the
attested baseline before it can print anything, and on a few-thousand-record log
that is half a minute in which it used to say nothing at all. It reads as a
hang, and a ceremony abandoned midway leaves the gate fail-closed for every
session until someone runs it again. So it narrates: the phase it is on, and a
record count for the verification, on stderr.

```
verifying the log chain before anything is read from it
  250/3184 records
  1750/3184 records
  3184/3184 records
recovering the attested baseline and diffing it against the live policy
fetching origin/main: the amendment is based on the remote, not on this checkout
verifying that origin/main 4c1d90ab2f77 is this edit's base
running the policy suite against the amended file (26 pinned resolutions)
running the dogfood suite against the amended file (tests/dogfood.test.ts)
building the amendment commit on origin/main 4c1d90ab2f77 (nothing is checked out)
pushing 9b31c0de51aa to origin policy-amend-7413
opening the pull request for policy-amend-7413
```

A terminal gets the counts repainted onto one line under the phase name, erased
when the phase closes. A pipe gets the lines above, newline-terminated, with no
carriage return in them. `--json` gets NOTHING on either stream but its report:
a `--json` refusal emits its error object on stderr and callers parse that
stream whole, so narration there would break every machine consumer of a
refusal.

**The ceremony is self-syncing (APRV-203).** Your part is: edit the line, run the
verb, tap. There is no `git fetch` and no `git reset` to run first, and running
one is not expected of you. `--commit` fetches the remote itself, bases the
amendment commit on `origin/<default branch>` rather than on your branch's tip,
and pushes it by refspec. It checks nothing out: on the branch flow your checkout
stays on the branch it was on and the commit is held on `policy-amend-<seq>`; on
the direct flow the branch moves only when it was already sitting on the base, so
a checkout that had fallen behind is left where it is and told so. A local branch
AHEAD of the remote is not a refusal — the commit is parented on the remote
either way — but three things are, all of them before the attestation:
`fetch-failed`, `base-policy-diverged` (the remote's policy is not the attested
text this edit was written against, so committing would revert somebody else's
amendment) and `base-log-diverged` (the remote's log is not a prefix of yours).

**The policy suite runs before the push.** Where the policy being amended is
this repository's own, `--commit` resolves every pinned class against the AMENDED
file and refuses `policy-suite-failed` when any of them moved, printing the
expectation diff and each pin's note. Nothing is attested, committed or pushed on
that path. The pins live in `src/core/policy-expectations.ts`, which the dogfood
suite imports too, so the check on the laptop and the check in CI are one list.

The pins are a SAFETY FLOOR, not an inventory (APRV-296). They name the classes
whose loosening would be a regression (the `human-only` classes, the `manual`
classes whose effects leave this repository or cannot be undone, and the
fail-closed default reached through classes the policy deliberately does not
declare), and each pin's note says what a loosening would cost. A class the
policy declares and no pin names is ACCEPTED: declaring a new `supervised` or
`autonomous` class is a policy amendment and not also a code change, and the
resolution still prints in the semantic diff below for the human who attests it.
Until APRV-296 every declared class had to be pinned, in both directions, and a
one-line TTL amendment on 2026-09-07 took three runs to land because of it.

The one check every declared class still faces is REACHABILITY: a class nothing
can emit is a line that will never fire, and the ceremony refuses it rather than
leaving an operator believing in it for a year. Three ways to be reachable: the
command classifier's fixed table, a `protected_paths` entry routing a path
family to a `policy.edit` sub-class, and `RUNTIME_CLASSES` in
`src/core/command-class.ts`, which names the classes a runtime cycle asks the
gate for directly and no command spells (`log.advance.daemon` is the first,
APRV-382). A new class of that third kind needs its line there in the SAME build
the ceremony runs, or the amendment refuses `policy-suite-failed`.

**And then the whole dogfood suite, still before the attestation.** The pin check
is a subset of `tests/dogfood.test.ts`, and the seq 23351 ceremony passed the pins
and went red on CI over a dogfood test about the values block. So `--commit` also
RUNS the built suite (`node --test dist/tests/dogfood.test.js`, from the repo
root) and refuses `dogfood-suite-failed` naming the failing test. The suite is run
rather than reimplemented: it reads the live `APPROVAL.md` off disk and imports the
pins out of `dist/`, so it asks CI's question of this ceremony's own bytes. Three
things fail closed under that one code, because an unrun suite is not a green one:
a red suite, a suite present in `tests/` and absent from `dist/` (a stale build,
whose pins are the previous edit's), and a suite that could not be spawned or ran
past its five-minute limit. A repository with no `tests/dogfood.test.ts` in source
skips the whole step, which is what keeps the shipped CLI from running this
project's tests inside somebody else's checkout.

**Branch protection (the two flows).** A protected default branch rejects the
push that would land the amendment, so this verb detects one and offers the flow
that works. DIRECT assembles the commit and pushes it at `origin/<branch>`.
BRANCH holds the same one commit on `<name>`, pushes it there, then runs `gh pr
create` with a title naming the seq and a body stating the one-commit rule. Merge
that PR with a merge commit, so the policy edit and its attestation stay one
commit on main.

Detection reads two endpoints, because GitHub protects a branch two ways and
answers each from its own place (APRV-232). The classic probe is `gh api
repos/{owner}/{repo}/branches/<default>/protection`: exit 0 is protected, and
that ends the lookup. On a 404 (or any other refusal) the rulesets probe runs:
`gh api repos/{owner}/{repo}/rules/branches/<default>` lists the rules that
govern the branch, and a non-empty list (a merge queue, required status checks,
whatever the ruleset carries) is protected; an empty list, or a 404, is no
rules. Resolution: either probe protected is protected; classic 404 AND no
rules is unprotected; anything else (no `gh`, no GitHub remote, a token that
cannot read either endpoint, a body that is not JSON) is UNKNOWN. The classic
endpoint alone answered 404 for this project's own main, which a ruleset
governs, so the pre-APRV-232 probe called it unprotected and every ceremony
printed the remote's GH013 rejection before recovering onto the branch flow.
Both probes are read-only and neither ever fails the command: a probe that
could not answer leaves an attestation that already happened exactly where it
was. When the direct flow is about to push a protected default branch, the
report prints a one-line warning before the push command rather than letting
GitHub deliver the news. Detection is a probe, not a guarantee: `git push
--dry-run` never reaches the remote's pre-receive hook, so a push it cannot
foresee is caught where it actually happens, by `push-rejected` below.

**The semantic diff** has five sections: class resolutions, approvers, defaults,
limits, and the policy KEYS. The keys section walks both documents' own dotted
paths (`protected_paths`, `audit.skew_tolerance`, `channels.telegram.token_env`,
`vault.passphrase_env`, `payload_retention`, `version`) and renders each change
as `before -> after`, so a spec key added tomorrow is covered without an edit
here. A top-level key the schema does not know is listed as an UNKNOWN KEY
whether or not its value moved, because it is what makes the policy fail closed.
Which keys the schema knows is READ FROM `schema/policy.schema.json` (APRV-296),
so a key the schema admits never reads as unknown: the list used to be a second,
hand-written copy, and it warned three times about the `daemon.*` block over a
policy that loaded cleanly.
`no semantic change` is printed only when the probed classes AND every key
compared equal; when a side's YAML did not parse there are no keys to walk, and
the report says the document was not compared instead.

**Baseline** (a stated limitation, flagged for human review): an attestation
records only the SHA-256 of the policy bytes, so the attested TEXT is not
recoverable from the log. When the policy lives in a git repository this verb
recovers `HEAD:<path>` and uses it as the baseline only if that blob's hash
equals the attested hash — proving the text being diffed is the text that was
signed for. Otherwise it drops to hash-only mode: it says so loudly, the
semantic diff is unavailable, and only the load advisory and the attestation
run. There is no `--baseline` flag, because a baseline supplied by hand is a
baseline nobody can verify.

`--commit` carries exactly these files: the policy, the log, and (APRV-274) the
pins in `src/core/policy-expectations.ts` when they moved. The pins are part of
an amendment's contract (CI's dogfood suite resolves the amended policy against
them, and it reads both out of the same commit), so a rule that took the policy
and the log and refused the pins was a rule that split one amendment across a
commit, a hand-run cherry-pick and a second red CI run. "Moved" is measured against the
commit the amendment is BUILT ON (`origin/<default branch>`, or `HEAD` where
there is no remote), so a pins file the base already carries stays exactly as the
base carries it, and a pins edit somebody else landed is not reverted by this
ceremony. The pin deltas print in the semantic diff beside the class deltas, ride
in the commit subject, and appear in `--json` as `pins`.

**Who publishes the log (APRV-420).** The log is in that file set only when this
amendment is the thing publishing it. On 2026-09-21 it always was, and PR 530
paid for it: two records advances merged first carrying the same records (the
attestation at seq 65736 and its payload reached main through PR 531), and git
does not care that one side's appended lines are a prefix of the other's, so the
amendment went DIRTY, lost its arm, and the repair was a hand merge of
`events.jsonl` in a throwaway worktree.

The cause was two publishers carrying the same bytes, so the ceremony now leaves
one of them holding it. It asks two questions of the base it is about to commit
on, in this order:

1. does the base's log already carry every record this attestation added? Then
   the log is published and the amendment has nothing to add to it.
2. is a records advance live, meaning origin carries a `records-log-*` branch?
   That advance publishes the log, so the amendment has nothing to add to it
   either. Whether the branch already carries THIS attestation is checked
   rather than assumed: the ceremony fetches the branch and compares chains.
   An advance pushed before the human signed does not carry it, which is the
   ordinary order; the ceremony then says so, the next advance publishes the
   record, and the pull request's protected-path guard holds the policy
   change until a records branch or main carries it.

Either way the commit is the policy bytes, the attested text and the pins, and a
commit that does not touch `events.jsonl` cannot conflict on `events.jsonl`,
whichever side lands first. Otherwise the amendment is the only publisher and
carries the log, exactly as it always has. The ceremony prints which of the three
happened, so the pull request's file list is never a surprise.

The question is asked with `git ls-remote`, not `gh`, so it answers the same on a
box with no GitHub CLI and no token. And it fails toward CARRYING: anything the
check cannot establish leaves the amendment holding the log. A dirty pull request
is a nuisance; an attestation that reaches `main` in nobody's commit is a policy
in force that the committed log does not record.

**A re-run repairs the pull request it finds (APRV-420).** A second run used to
stop at `nothing to amend`, which is true and useless: the live policy does match
its attestation, and the pull request carrying that attestation is open,
unmergeable and unarmed. So when `--commit` or `--pr` is asked for and origin
already carries the amendment branch, the re-run fetches the default branch and
computes what it still LACKS — the policy bytes, the attested text, the pins, and
the log under the rule above — and then:

- nothing lacking: the amendment landed in full. It says so and prints `gh pr
  close <branch> --delete-branch`.
- something lacking: it rebuilds that commit on the CURRENT default branch and
  force-updates the branch, then re-arms `gh pr merge <branch> --merge --auto`.
  The trunk's log is a superset of the amendment's by construction, so rebuilding
  on it is the re-merge without a merge.

The rebuild is `commitOnBase`'s scratch index like every other commit this verb
makes, so nothing is checked out and no live appender has the log moved
underneath it. The force-push is the one in this codebase, and it is bounded: the
remote branch must be a single commit on top of a commit the base already
contains, which is the shape this ceremony creates and nothing else. A branch
carrying anything more is reported with `git log --oneline <base>..<tip>` and
left alone. `--dry-run` and `--no-publish` compute the repair, print the
commands and run none of it. `--json` carries a `repair` object (`branch`,
`state` of `landed`/`repaired`/`owed`/`failed`, `base`, `carried`, `commit`,
`pushed`, `autoMerge`, `commands`, `message`), additively and always present:
`null` on every run that had an amendment to make and on every no-op that found
no branch standing. Only `failed` is a nonzero exit.

It refuses outside a git repository (`commit-preconditions`), and refuses
`staged-unrelated` when the index holds staged changes to anything beyond those
three: a commit that swept in an unrelated staged edit would make "this commit is
the amendment" false. It refuses `dirty-tree` when one of those three is staged
in one state and modified again in the working tree, because the commit is
assembled from the WORKING TREE and would otherwise carry bytes the operator's
`git diff --cached` never showed. An unrelated *unstaged* path is deliberately
not a refusal: the scratch index lays exactly the ceremony's paths over the
remote's tree, so nothing else can reach the commit, and refusing over one would
stop the ceremony in the checkout it is written for, where the daemon's envelope
write-backs leave task files modified as a matter of course. On the branch flow
it also refuses when there is no `origin` remote, and when a `--branch` name
already exists. Every one of those refusals happens BEFORE the attestation, so a
refused `--commit` never leaves an attested policy without its commit. The same
holds for the fetch, the two base checks, the policy suite and the dogfood suite
above.

**`--pr`: the ceremony finishes its own job (APRV-341).** `--pr` is `--commit`
plus "and publish it": it forces the BRANCH flow whatever the protection probe
answered, so the amendment is committed on `origin/<default branch>` in a scratch
index, pushed to `policy-amend-<seq>`, carried by a pull request, and armed with
`gh pr merge <branch> --merge --auto`. The merge queue picks the strategy from
there. `--pr --direct` and `--pr --no-publish` are usage errors: each pair asks
for opposite ceremonies.

The pull request is OPENED or UPDATED. `gh pr list --head <branch> --state open`
is asked first, and when one is already standing its title and body are edited
rather than a second being opened, so a re-run of a ceremony that stopped
half-way finishes rather than failing at `gh pr create`. A `gh` that cannot
answer the question falls through to `create`, which is the path that was there
before.

**The verb never switches branches.** On 2026-09-16 an agent-written runbook for
the primary checkout ended with `git checkout main` after the amend commit, which
rewound `APPROVAL.md` and `events.jsonl` under a live appender; the hook then
appended 204 records on the stale chain and the log forked. `--pr` exists so that
runbook does not: the commit is assembled with `git read-tree` into a scratch
index and pushed by sha, the checkout ends the verb on the branch it started on,
with the same HEAD, the same index and the same working tree, and the only file
that moved is the log, which gained the attestation. A test compares all four
before and after.

Without `--pr` (and on a box with no `gh`) the printed runbook does the same
thing by hand, and it does not switch branches either (APRV-360): `approval log
sync`, `git add`, `git commit`, `git push origin HEAD:refs/heads/policy-amend-<seq>`,
`gh pr create --head`, `gh pr merge --auto --merge`. A fixture test pins the six
commands and asserts that no printed line contains a `git checkout`, because a
fallback nobody checks is where the branch switch came back.

The form printed before APRV-360 opened with `git checkout -b policy-amend-<seq>
origin/main`. On 2026-09-18 the primary's main was fourteen commits behind, the
switch refused rather than overwrite `QUEUE.md`, the working log and six
payloads, and the ceremony stalled with an edited, attested, unpublished policy.
`approval log sync` is the first line now for that reason: it brings the checkout
current, and it refuses `log-diverged` rather than fast-forwarding over a fork.

`--commit` also pushes, on both flows. When there is no `origin` to push to, the
direct flow reports the push as still to run rather than listing it among the
commands it ran. `--no-publish` stops the ceremony at the commit: nothing is
pushed, no pull request is opened, and the push (with the pull request, on the
branch flow) is printed as still to run. That is the behaviour `--commit` had
before the publishing half existed, kept for operators who want it.

**`--as agent:<id>`: attest from the phone (APRV-109).** The verb runs
identically up to the attestation, which an agent must not perform. Instead of
attesting it appends a `policy.proposed` record carrying the policy SHA-256, the
semantic diff and the load advisory, all three COMPUTED by the runtime from the
bytes: there is no flag for any of them, so a proposal cannot show an approver
one story and attest a different file. Channels render it as an ordinary manual
prompt, the approver taps, and the tap appends the attestation under the human
identity the listener holds, exactly as a grant lands. The git ceremony then
proceeds agent-side and the commit cites the attestation seq, as it always has.
`--wait` (default 15m) is how long the process holds the ceremony open,
`--interval` (default 2s) how often it re-reads the log, and `--note` is the
proposer's own words, rendered CLAIMED. `--json` gains a `proposal` object,
which is `null` on every run that attested at the terminal.

Fail closed, in the ceremony's own vocabulary: `no-channel` when the policy
configures no channel (a proposal nobody could be asked about), `propose-failed`
carrying the core code (`diff-too-large` for a diff bigger than a prompt can show
whole), `attestation-declined` when the approver says no, and
`attestation-timeout` when `--wait` elapses or a later amendment supersedes the
prompt. Every one of them attests nothing and commits nothing: the policy edit
stays in the working tree, and a lapsed prompt leaves every channel queue by
derivation, so no stale question is left in front of the approver.

**Success first.** The attestation is the ceremony: it is the act only a human
can perform, and everything after it is logistics. So the first line printed
after the confirmation is the achievement, and the publishing status prints
beneath it.

```
✓ attested seq 2 — the policy is operative
  file    APPROVAL.md
  sha256  8acbd01cda98

Committed
  ✓ committed the policy, the log and the attested policy text together:

    git add APPROVAL.md .approval/log/events.jsonl .approval/payloads/8acbd01cda98….json
    git commit -m "Policy: amend APPROVAL.md: 1 class resolution(s) (attested seq 2)"

Publishing
  main is protected: the direct push was refused, so this amendment publishes through branch policy-amend-2
      remote: Changes must be made through a pull request.
      ! [remote rejected] main -> main (pre-receive hook declined)
  ✓ branch policy-amend-2 created — your checkout stays on main
  ✓ pushed policy-amend-2 to origin
  ✓ PR #7 opened: https://github.test/o/r/pull/7
  ✓ auto-merge armed: PR #7 lands on main as a merge commit when CI is green
```

A failure word may headline a SUB-STEP; it never headlines a ceremony whose
attestation landed. `--json` carries the same split additively: `ceremony` is
`{"attested":true,"seq":N}` and `publishing` reports what the publishing half
did. The report's existing top-level `attested` is unchanged and still means the
attestation this amendment moved FROM, which is why the new boolean has a key of
its own.

**The ceremony finishes its own job.** A direct push the remote REJECTS (branch
protection the detection probe did not see, a stale ref, a hook) used to end the
verb with four commands for the operator to type. Those four commands are
non-destructive and mechanical, so the verb runs them: `git branch
policy-amend-<seq>`, `git push -u origin policy-amend-<seq>`, `gh pr create` with
the one-commit body, then `gh pr merge --auto`. Each is reported as it lands.
`git branch` copies a ref, so the constraint above holds unchanged: the
operator's checked-out branch never moves off the commit they signed for. An
auto-merge the repository refuses (a merge queue, auto-merge disabled) is not a
failure of the ceremony, since the pull request is open either way: the output
names the PR, says to merge it when CI is green, and exits 0.

Attested and published (or a pull request opened) exits 0. Attested with
publishing incomplete keeps the nonzero I/O exit, which is the split the two
audiences need: the exit code speaks to scripts, the rendering to people.

The publishing half's `gh` calls are classified like any other command this
runtime sees (`vcs.pr.*`, `vcs.push.*`), so under some policies the tail of the
ceremony may itself prompt for approval.

A refusal that has to be READ AND ACTED ON is printed as a runbook: a headline,
the remote's own output indented under it, the state in short lines, and the
recovery numbered with ONE runnable command per line. It renders when the
AUTOMATIC path itself runs out, and it begins at the step that failed: a runbook
is what automation degrades into, not the default reward. Below, the direct push
was refused, the recovery branch was created, and the remote refused that push
too, so the runbook owes the three steps that are left.

```
✗ push-rejected  the remote REJECTED `git push -u origin policy-amend-2`
    remote: Changes must be made through a pull request.
    To .../origin.git
    ! [remote rejected] policy-amend-2 -> policy-amend-2 (pre-receive hook declined)
    error: failed to push some refs to '.../origin.git'

  YOUR STATE
    attestation appended at seq 2: it is in the log, on disk
    committed LOCALLY on main, one commit ahead of origin
    main is protected, whatever the probe reported: the remote just refused
    NOT on origin: origin still carries the previous policy

  NEXT STEPS
    1. git push -u origin policy-amend-2
    2. gh pr create --title "Policy: …(attested seq 2)" --body "…" --head policy-amend-2
    3. gh pr merge policy-amend-2 --merge  # or merge it in the web UI

  why a MERGE COMMIT: the policy edit and its attestation stay one commit on main …
  then `approval log sync` rather than a pull: it holds the append lock, snapshots the log …
```

(Step 2's `--title` and `--body` are shown elided here; the CLI prints them in
full, so the line can be copied and run as it stands.) `gh` that is absent or
that fails degrades to this same runbook, sliced from the pull-request step: the
branch is on origin, so only the PR and the merge are owed. The recovery does not
end
on a hard reset onto `origin/main`, as it once did: with an uncommitted working
log a hard reset rewinds `events.jsonl` underneath the daemon appending to it,
which is a fork, so the last line names `approval log sync` instead (APRV-125,
which turned that pointer from a runbook reference into a verb). The
same shape carries `git-failed` (what broke, and the commands still owed) and
`pr-failed` (the branch is on origin; the pull request is not). The refusal
codes, the exit codes and the `--json` shapes are unchanged by any of this: it
is the human rendering only.

**What it does, in this order.**

1. resolves the live policy file and hashes its bytes;
2. compares that hash to the latest attestation. EQUAL means nothing to amend,
   reported on stdout at exit 0;
3. recovers the last-attested policy TEXT if it can (see Baseline above) and
   prints the SEMANTIC diff, computed by the real engine on both versions;
4. runs the load advisory;
5. asks for confirmation (skipped by `--yes` and `--dry-run`);
6. attests: one `policy.updated` event, identical to `approval policy attest`,
   which since APRV-356 also stores the attested bytes in the payload store and
   binds their hash on the record;
7. prints, or with `--commit` runs, the git ceremony — `git add <policy> <log>
   <attested bytes>` (plus the pins when they moved), a `git commit` citing the
   attestation seq, and the push (and, on the branch flow, the branch and the
   pull request). The store file rides in the same commit because a committed
   log carrying a binding whose bytes were never committed leaves the policy in
   force unrecoverable for everyone reading that copy, the CI protected-path
   guard included;
8. publishes, unless `--no-publish`: a push the remote refuses is answered by
   the branch, push, pull request and auto-merge above, each reported as it
   lands, and a step that fails drops to the runbook from there.

**Flow precedence, highest first:** `--branch <name>` (with `--direct` it is a
usage error), then `--direct`, then detection — the branch flow when the default
branch is protected and checked out, the direct flow otherwise and when detection
is UNKNOWN.

**Confirmation** is interactive y/N by default. With stdin not a terminal (or
`--json`) and no `--yes` it refuses at exit 2 rather than assuming an answer.

**`--require-load`** refuses to attest a policy that does not load (exit 1,
nothing appended). Without it a load failure is a loud advisory and the
attestation may still proceed.

**`--json`** (one object on stdout; keys always present):

```
{"ok":true,"noop":false,"dryRun":false,"aborted":false,
 "policy":"/abs/APPROVAL.md","liveSha256":"<64 hex>",
 "attested":null|{"sha256":"<64 hex>","seq":2},
 "baseline":{"mode":"git-head"|"unavailable","reason":null|"..."},
 "diff":null|{"beforeFailure":null|{"code","message"},
              "afterFailure":null|{"code","message"},
              "structuralComparable":true,"probes":["..."],
              "classes":[{"class":"...","before":{"autonomy","provenance",
                "pattern"},"after":{...}}],
              "approvers":[{"approver":"...","change":"added"|"removed"|
                "channels-changed","beforeChannels":[...]|null,
                "afterChannels":[...]|null,"danglingRules":["..."]}],
              "defaults":[{"field":"autonomy"|"channel"|"approval_ttl"|
                "on_expiry","before":null|"...","after":null|"..."}],
              "budgets":[{"scope":"global"|"classes.<pattern>",
                "limit":"daily_usd","before":null|N,"after":null|N}],
              "vocabulary":[{"key":"protected_paths","recognised":true,
                "before":null|"...","after":null|"[\\"SPEC.md\\"]"}],
              "vocabularyComparable":true,
              "unchanged":false},
 "load":null|{"ok":true|false,"code":null|"...","message":null|"..."},
 "attestation":null|{"seq":3,"sha256":"<64 hex>"},
 "git":null|{"repo":true,
             "protection":"protected"|"unprotected"|"unknown",
             "protectionReason":"...","defaultBranch":null|"main",
             "currentBranch":null|"main","flow":"direct"|"branch",
             "branch":null|"policy-amend-7","warning":null|"...",
             "commands":["git add ...","git commit -m ...","git push ..."],
             "committed":false,"pushed":false,"prUrl":null|"https://...",
             "output":null|"..."},
 "pins":null|{"module":"src/core/policy-expectations.ts",
             "changes":[{"actionClass":"log.sync","before":null|"autonomous/rule",
               "after":null|"manual/rule"}]},
 "ceremony":{"attested":true|false,"seq":null|2},
 "publishing":null|{"attempted":true,"complete":true,
             "via":"direct"|"branch"|"recovery"|"none",
             "branch":null|"policy-amend-2","pushed":true,
             "prUrl":null|"https://...","prUpdated":false,
             "autoMerge":"armed"|"refused"|"not-attempted",
             "steps":[{"command":"git push origin main","ok":false}],
             "stoppedAt":null|"git push -u origin policy-amend-2",
             "reason":null|"..."}}
```

`diff` is null in hash-only mode; `attestation` is null for a no-op, a dry run,
and an abort. In a dry run the commands carry the literal placeholder `<seq>`.
`ceremony` and `publishing` are additive (they were added without changing any
key beside them): `ceremony.attested` is whether THIS run attested, while the
top-level `attested` remains the attestation it moved from, and `publishing` is
null until a ceremony reaches its publishing half. `publishing.steps` lists the
commands the verb RAN, in order, the refused direct push included.
`pins` (additive, always present) is null when the pins are no part of the
ceremony, for any of its three reasons: these pins do not govern this policy,
there is no pins module, the file is what the base carries. Inside `changes`, a
null `before` or `after` means the class was NOT PINNED on that side, and it is
the only thing it means: an entry whose resolution the reader could not make out
reads `"unreadable"` there instead.
A refusal is `{"ok":false,"error":{"code":"...","message":"..."}}` on stderr,
and after the attestation it carries `ceremony` and `publishing` alongside
`error`, so a machine caller reads "attested, not published" without parsing
the message.

**Refusal codes** (`error.code` with `--json`; frozen public API):

- `usage` — no identity, a non-human `--as`, an unknown flag, or a confirmation
  that could not be asked for.
- `io` — the policy file or the log could not be read or written.
- `load-failed` — `--require-load` and the policy does not load. Nothing was
  appended.
- `commit-preconditions` — `--commit` outside a git repository, with the policy
  and the log in different repositories, or (branch flow) with no origin remote
  or a `--branch` name already taken. Checked before the attestation; nothing
  was appended.
- `staged-unrelated` — the index carries staged changes beyond the policy, the
  log and the pins (APRV-341). Its own code because its repair is its own: one
  `git restore --staged <path>`. Checked before the attestation; nothing was
  appended.
- `dirty-tree` — one of those three is staged in one state and modified again in
  the working tree (APRV-341). The commit is assembled from the working tree, so
  it would carry bytes `git diff --cached` does not show. An unrelated *unstaged*
  path is not this refusal and never was. Checked before the attestation;
  nothing was appended.
- `fetch-failed` / `base-policy-diverged` / `base-log-diverged` — the remote the
  amendment would be based on could not be fetched, carries a policy this edit
  was not written against, or carries a log this working log does not contain.
  All three are checked before the attestation; nothing was appended.
- `policy-suite-failed` — a pinned class resolves differently under the amended
  policy. Every pin is a class whose loosening would be a regression, so the
  message carries the expectation diff and the pin's note saying what that
  loosening would cost. A declared class no pin names is not this refusal
  (APRV-296). Checked before the attestation; nothing was appended.
- `dogfood-suite-failed` — the built dogfood suite is red against the amended
  policy (the message names the failing test), is absent from `dist/` while
  present in `tests/`, or could not be run at all. Checked before the
  attestation; nothing was appended.
- `git-failed` — the attestation WAS appended and git then failed; the message
  names the seq and what to run by hand.
- `push-rejected` — the attestation was appended and committed, and the remote
  refused the push AND the automatic recovery could not get the commit onto
  origin either. The message carries git's own output, the branch, the fact that
  origin still carries the previous policy, and the commands that are left. On a
  terminal the same facts are printed as the runbook above; `error.message` is
  one line and unchanged.
- `pr-failed` — the attestation was appended, committed and pushed (on the
  recovery path, pushed as `policy-amend-<seq>`), and `gh pr create` then failed
  or `gh` was not available.
- `append-failed` — the attestation append itself failed.
- `log-unreadable` / `log-torn-tail` / `log-corrupt` — nothing is amended from a
  log that does not verify.

## policy apply

**The hand-paste this replaces (APRV-343).** Agents may not write `APPROVAL.md`:
it is `policy.core`, and this project's policy holds that class human-only. So a
policy change an agent proposes travels as a document under `docs/proposals/`
that quotes each current line byte for byte beside its replacement, and the
human pastes. Two things go wrong with a paste, and both have:

- **a whole-file copy reverts what it did not know about.** The prepared file was
  written against the policy as it stood when the proposal was drafted, so
  anything landed in between is silently undone. That is the failure
  `base-policy-diverged` catches for the commit, one step too late to help;
- **a paste carries its wrapper.** One paste of a proposal page took the page's
  own fence with it, which hid a block from the loader (APRV-273).

`approval policy apply <proposal.md>` answers both by construction. It writes no
byte that is not anchored to a byte it proved present in the live file, and it
reads fences by their backtick run, so a four-backtick wrapper around a
three-backtick block is the wrapper it is rather than part of the content.

### The proposal format

A proposal is ordinary markdown. Anywhere in it, a fenced block **with a
declared language** whose immediately preceding non-blank line is a label is a
member of a pair:

| label | means |
|---|---|
| `Current:` | the bytes as they stand in the live policy |
| `Replace with:` | what they become |
| `Supersedes:` | optional: an earlier section's RESULT, to match instead |

A fence with no info string is skipped, which is APRV-273's hazard turned into a
rule. A block whose label names no role is skipped too, so a proposal page can
carry a `bash` block of commands to run afterwards without the applier mistaking
it for policy text. Pairs apply in document order.

**Supersession is declared, never inferred from position.** A later section that
rewrites a line an earlier section already rewrote quotes the earlier section's
*result* under a `Supersedes:` label; the applier looks for that text when the
section's own `Current` block is no longer in the file, which is exactly the
state the earlier section left behind. Position could not carry this: two
sections that touch one line are not in general in the order the file needs, and
a rule inferred from order is a rule nobody can read off the page. A pair whose
`Current` **and** `Supersedes` blocks both occur in the file is
`proposal-ambiguous`: two spellings of one line is a question about which the
file means, and no verb here will pick.

**Whole-file replacement is not accepted**, and that is the decision rather than
an omission. The verb's whole value is that every byte it writes is anchored to
a byte it proved present, which is what makes a stale proposal a refusal instead
of a silent revert. A whole-file blob has no anchor. `approval policy amend`
over a hand-edited file is already the supported way to replace the file
deliberately.

**The values block is treated exactly as the policy block is**, by knowing
nothing about either. The applier is a byte-level replacement over the whole
file: it does not parse the policy, does not locate blocks, and does not care
which fence a pair lands in. The values block is inert (SPEC §11.1 invariant
10), so applying one changes no verdict, and the attestation the amendment
appends covers the whole file's bytes either way (SPEC §5.2, §5.3).

`docs/proposals/README.md` is the contract as a page for proposal authors, and
`docs/proposals/approval-md-2026-09.md` is a worked example of every part of it.

### What it does, in order

1. Refuses an agent identity (`apply-agent-actor`) before reading anything.
2. Parses the proposal into ordered pairs.
3. Resolves every pair against an **in-memory** copy of the policy. A proposal
   whose third pair is stale writes nothing at all, so "a stale proposal cannot
   half-apply" is a property of the code rather than of the order somebody wrote
   the sections in.
4. Prints the replacements, each as its matched block and its replacement.
5. Asks for confirmation (`--yes` skips it, `--dry-run` stops here).
6. Writes the policy, then runs `approval policy amend --pr` in this process —
   which asks its OWN question about the semantic diff, because "are these the
   bytes" and "is this the policy" are different questions.

**It publishes by default (APRV-360).** The amendment runs with `--pr`, so the
branch is created on the remote by refspec, the pull request is opened, the
merge is armed, and the checkout ends where it started. Before this the amend
ran with no flag: the policy was written and attested, and the operator was
handed a procedure that began with a branch switch. On 2026-09-18 the primary
refused that switch and the ceremony stalled with an edited, attested,
unpublished policy, which is the one state in which every gated operation on the
box refuses. `--no-publish` stops at the commit and is passed through to the
amend; `--pr` is accepted and does nothing, because runbooks already say it, and
`--pr` with `--no-publish` is a usage error.

`--no-amend` writes and stops, and says loudly that the policy is now edited and
unattested. A run where every pair resolves and no byte moves is a success and a
no-op: the proposal has already been applied.

**Refusal codes** (`error.code` with `--json`; frozen public API): `usage`,
`io`, `apply-agent-actor`, `proposal-empty`, `proposal-malformed` (a `Current`
with no `Replace with`, or the reverse), `proposal-stale` (a quoted current text
is not in the file), `proposal-ambiguous` (it occurs more than once, or both it
and its superseded text occur). Every one of them writes nothing.

Two outcomes are deliberately not in that union. Answering no at the
confirmation is exit 0 with `aborted:` on stdout, exactly as `policy amend`
answers it: nothing failed, and an error object at exit 0 would be a
contradiction the caller has to resolve. An amendment that refuses has already
printed its own code from its own frozen union, so this verb adds a sentence
naming the state that leaves behind — the replacements written, the policy
unattested — and returns the amendment's exit code unchanged.

## register

The task file is read only. Nothing is rewritten, so unknown frontmatter keys
are preserved trivially. The task id comes from the frontmatter's `id` — a
Backlog.md board key, not part of the envelope.

Registering the same task id twice is refused: two declarations of one id would
leave every later "what class is this key?" lookup guessing. An envelope that
changed after registration is `envelope.drift`, not a second registration. An
envelope that vanished after registration is `envelope-missing`: re-registering
a stripped file would narrow the record to what survives in it, so the runtime
refuses and a human restores the block from the log.

**`--json`** (one object on stdout):

```
success  {"ok":true,"seq":1,"task":"task-042","actions":1}
refusal  {"ok":false,"error":{"code":"...","message":"...","errors"?:[...]}}
```

The refusal goes to stderr, and `errors` carries the schema failures.

## request

The action's class, cost, reversibility and summary are read from the
`task.registered` record in the log — there are no `--class` or `--cost` flags.
An agent that could name its own class at request time could declare `read.web`
for an action registered as `financial.spend`, and SPEC.md §7's "the class MUST
be declared before a token can be requested" would mean nothing. Register once
from the file; request against what was registered.

Amended SPEC.md §6.3: `approval.*` events are exclusive to the manual path. An
action whose class resolves to supervised or autonomous emits no
`approval.requested` and no `approval.granted` — `approval request` appends
nothing and reports `proceed:true`. Its authorization is the `execution.started`
event, which is also where its budget is charged. Do not wait for a grant that
will never come.

**Order of checks**, each with its own refusal code: identity, attestation, class
resolution (including SPEC §7's irreversibility floor), then, on the manual path
only, the content binding (`payload-hash-required`, `payload-mismatch`), request
legality, budgets, the payload store write, and the append of
`approval.requested`. A refused request stores nothing.

`--payload` takes the action's concrete payload as JSON, and `-` reads stdin. Its
hash must equal the declared `payload_hash` and it is filed in
`.approval/payloads/<hash>.json`, which is where render and every channel read the
bytes from. Supply it here once and no channel needs `--payload-dir` or
`--payloads` at all.

For an action `approval run` will execute, produce those bytes with `approval
payload run -- <cmd…>` rather than by hand. Since APRV-401 the payload carries
the size and digest of the script the argv names, and a hand-written
`{"argv":…,"cwd":…}` for a command that names a script is a declaration the
execution will refuse `payload-mismatch`, correctly, because it describes bytes
nobody bound:

```
approval payload run --hash -- bash scripts/install.sh   # the declaration
approval payload run       -- bash scripts/install.sh \
  | approval request <task> --action <key> --as agent:<id> --payload -
```

Material supplied here is checked against the declared hash and never against
the filesystem: this verb does not know where the run will happen, and the
guarantee is that `approval run` recomputes the same value from the tree it is
about to spawn into and refuses on any difference.

When the policy permits an unattended action, supplied material is still checked
against the registered action's task, class and payload hash and retained before
`proceed:true` is returned. This creates no approval event and does not require
an extra human grant. The retained bytes let later audits match the execution
record to the actual edit. Missing bindings, mismatched material or a storage
failure refuse the request; an existing valid payload is preserved.

**`--json`** (one object on stdout):

```
manual      {"ok":true,"task":"task-042","action_key":"...","class":"...",
             "autonomy":"manual","proceed":false,"requested":true,"seq":3}
non-manual  {"ok":true,...,"autonomy":"autonomous","proceed":true,
             "requested":false,"seq":null}
refusal     {"ok":false,"error":{"code":"...","message":"...",
             "verdicts"?:[...],"detail"?:"...","state"?:"...","seq"?:N}}
```

The refusal goes to stderr, and `seq` is the `budget.exceeded` record that WAS
appended.

## grant

Legal only on a request that is awaiting a decision. A second decision is
refused (`already-decided`): the log is append-only and a human's answer is not
overwritten.

Attestation is required: granting is the authorizing decision, so an unverified
policy cannot produce one.

Budgets are re-evaluated at grant time — the request may have aged in the queue
while other actions consumed the window, and the moment that matters for a
commitment is the moment the human commits. A failure appends `budget.exceeded`
and refuses. The appended `approval.granted` carries payload
`{"class","est_cost_usd"}` copied from the request: the budgets evaluator meters
authorization from exactly those two fields.

Tokens: a grant mints the single-use execution token for the action and prints
it once. The log records only its SHA-256 (payload `token_sha256`), so this
print is the only time the raw value exists outside the caller's memory and
nothing can recover it: not `approval token`, not the log, not the index.

TTL: a decision after the request's TTL is refused with `expired`, judged from the
request's OWN timestamp plus `defaults.approval_ttl`. When the gate discovers a
lapse it appends `approval.expired` (actor `system:gate`) and then refuses.

The raw token is printed once, on stdout, in a rule-boxed panel whose middle
line is the 64-hex value alone and undressed (so a triple-click copies exactly
the token), or as the `token` key with `--json`. Capture it, or revoke and
request again. Spend it with `approval run`.

`--reaction disliked|indifferent|liked|loved` records what the approver thought
of the action, as `payload.reaction` on `approval.granted`. A human answering the
gate is already forming an opinion; this is where they can say it in one word
rather than in prose nothing can read back. It is GUIDANCE and never enforcement:
the grant record itself is the authorization, it widens and narrows nothing, and
a `disliked` grant is exactly as much of a grant as a `loved` one (SPEC.md §11.1
invariant 10). Read them back with `approval feedback`.

Written only when given, so an omitted reaction leaves no key and is never read
as `indifferent`. `loved` and `disliked` with no non-blank note refuse
`reaction-note-required`, evaluated with the other checks that read nothing and
appending nothing; the request stays pending and the fix is `--note`.

`reject` and `revoke` refuse `--reaction` as a usage error (exit 2) naming
`--note`. Their reason IS their note, and a grade beside a refusal is a second
answer to a question that has one. The core writes the field under the grant's
own branch, so a value passed to either of them is structurally unable to reach a
record whatever the CLI in front of it does.

**`--json`** (one object on stdout):

```
success  {"ok":true,"decision":"grant","state":"granted","action_key":"...",
          "seq":5,"token":"<64 hex>"}   (the token is shown once)
refusal  {"ok":false,"error":{"code":"...","message":"...","state"?:"...",
          "verdicts"?:[...],"detail"?:"...","seq"?:N}}  on stderr
```

## reject

Legal only on a request that is awaiting a decision. Attestation is NOT required
for this verb: it withdraws authority rather than granting it, and refusing it
because a policy file changed would leave a live authorization standing. No
budget is charged — an authorization that was refused was never a commitment.

TTL applies exactly as it does to [grant](#grant): a decision after the request's
TTL is refused with `expired`.

**`--json`** (one object on stdout):

```
success  {"ok":true,"decision":"reject","state":"rejected","action_key":"...",
          "seq":5}
refusal  {"ok":false,"error":{"code":"...","message":"...","state"?:"...",
          "detail"?:"...","seq"?:N}}  on stderr
```

## revoke

Legal only on a granted request that has not executed: an unexecuted grant can
be withdrawn, an executed one cannot be un-sent (`not-granted` /
`already-executed`). Attestation is not required, and no budget is charged, for
the reasons under [reject](#reject).

**`--json`** (one object on stdout):

```
success  {"ok":true,"decision":"revoke","state":"revoked","action_key":"...",
          "seq":5}
refusal  {"ok":false,"error":{"code":"...","message":"...","state"?:"...",
          "detail"?:"...","seq"?:N}}  on stderr
```

## withdraw

The requester takes its own pending question back (SPEC.md §6.3, amended
APRV-106). It is the only terminal gate verb that is not human-only, because the
party that asked is usually an agent and the whole point is that the asker can
stop asking.

**Why it exists.** On 2026-08-19 a builder ran `git commit --amend` through the
Claude Code hook. The hook classified it manual, appended `approval.requested`,
waited its nine minutes, got nothing, denied the tool call and moved on. The
request stayed pending for the policy's 24-hour TTL. Half an hour later the
human was pinged on their phone and approved it, and the grant authorized
nothing at all: the hook had answered long before, and a retried tool call is a
new request with a new key. A person spent attention on a question whose asker
had left. SPEC.md §11 makes human attention the audit budget, and a decision
nobody can consume must not be solicited.

**Requester-only.** The actor must equal the actor on the matching
`approval.requested`; anything else is `not-requester`. If any actor could
withdraw, the approver's queue would be clearable by whoever reached the log
first — which is the one property the gate exists to deny. A human who wants a
pending request gone **rejects** it, on the record, as themselves.

**Pending-only, and terminal.** `not-requested` when there is nothing to
withdraw, `already-decided` when a human has answered, `request-withdrawn` for a
second withdrawal, `expired` when the TTL has lapsed — judged from the request's
own timestamp exactly as a decision is judged, with the same lazy materialisation
of the `approval.expired` record. Once appended, a grant, rejection or revocation
is refused `request-withdrawn`. A withdrawn action that is still wanted is
requested again; that is a new request, and it gets its own decision.

**No attestation, no budget.** Withdrawal removes a question. It authorizes
nothing and commits nothing, so refusing it on an unattested policy would leave
requests standing in a human's queue because a file changed.

`--reason` is closed to `timeout`, `cancelled` and `superseded`, and an
unrecognized value is exit 2 rather than a silent default: an append-only log
should not put a word in the requester's mouth. `timeout` is what
`approval wait --withdraw-on-timeout` and the Claude Code hook write.

Channels drop a withdrawn request from the queue immediately (it is no longer
`requested`, and every channel derives its queue from that one predicate), and
the Telegram listener edits the message it already sent to say so and removes
the buttons.

**`--json`** (one object on stdout):

```
success  {"ok":true,"task":"...","action_key":"...","state":"withdrawn",
          "reason":"timeout","seq":7}
refusal  {"ok":false,"error":{"code":"...","message":"...","state"?:"..."}}
```

## expire

No identity is accepted or resolved: no human decides an expiry, the clock does,
and SPEC.md §8 names expiry as the example of a `system:`-originated event. This
is the verb the daemon's sweep calls; it exists in the CLI so the sweep is
testable and so an operator can run it by hand.

`defaults.on_expiry` is recorded in the payload. Its only v0.1 value, `reject`,
does not change the mechanics — an expired request is terminal either way — it
tells the projection layer to render the envelope state as rejected. Late
decisions are refused with `expired` whether or not this verb has ever run, and
`not-expired` also covers a policy that declares no `defaults.approval_ttl`: no
TTL means no lapse, and expiring a request the policy never bounded would be the
runtime inventing a deadline.

Refused when the request is not live (`not-requested`, `already-decided`) or when
the TTL has not lapsed (`not-expired`, which also covers a policy declaring no
`defaults.approval_ttl`).

**`--json`** (one object on stdout):

```
success  {"ok":true,"action_key":"...","actor":"system:gate","seq":6}
refusal  {"ok":false,"error":{"code":"...","message":"...","state"?:"..."}}
```

## gate refusal codes

The vocabulary every gate verb (register, request, grant, reject, revoke,
withdraw, expire) returns in `error.code` with `--json`. Frozen public API: an agent branches on it
to decide whether to fix itself, stop retrying, or ask a human.

- `policy-not-attested` — policy unattested or its bytes changed since
  attestation (detail: `not-attested` | `hash-mismatch` | `unreadable`). Run
  `approval policy attest`.
- `envelope-invalid` — the envelope failed `envelope.schema.json`, or the task
  file has no frontmatter or no `approval:` key.
- `task-file-unreadable` — the task file could not be read (exit 4).
- `task-already-registered` — this task id already has a `task.registered` record.
- `envelope-missing` — the file carries no `approval:` envelope AND the log holds
  a `task.registered` for its task: the envelope was LOST after registration.
  Nothing is appended; restore the block by hand from the log.
- `not-registered` — the task has no `task.registered` record.
- `action-not-registered` — the task declares no action with that idempotency key.
- `duplicate-request` — a live `approval.requested` already awaits a decision.
- `already-executed` — the action key already has an `execution.started`.
- `budget-exceeded` — budget verdicts failed; a `budget.exceeded` event WAS
  appended and `error.verdicts` lists the failures.
- `queue-full` — the approver's queue is at the ceiling the policy declared
  (SPEC.md §5.2's `limits.max_pending`, per class or on a `budgets` scope), so
  the request was not added to it. `error.limits` lists the failing verdicts
  (`limit`, `scope`, `observed`, `ceiling`). **Nothing is appended**, unlike
  `budget-exceeded`: a log line per refused request would hand a queue-flooder
  the log growth it was refused the queue for. Retrying at once gets the same
  answer; the queue drains when a human decides, a requester withdraws, or a
  TTL lapses. `.approval/QUEUE.md` shows each declared ceiling and how close the
  queue is to it, which is where a human sees the standing condition.
- `rate-limited` — this origin created more requests in the last hour than
  `limits.requests_per_hour` allows. Origin is the requesting actor, which the
  runtime assigns rather than the caller, so re-labelling does not buy a fresh
  hour. Counted over request CREATION, so a request answered a minute after it
  was made still spent the origin's share. Nothing is appended, and the window
  is rolling: the oldest request in it ages out on its own. Distinct from
  `queue-full`, and the distinction is the repair — that one says wait for an
  approver, this one says slow down. Where both ceilings are met the answer is
  `queue-full`, because an agent that backs off for a minute and retries into a
  full queue was told the smaller of the two facts.
- `class-human-only` — the action's class resolves to `human-only`: the policy
  reserves it to human hands, and a person performs it outside agent execution.
  Distinct from every rejection, and the distinction is the whole of the code:
  nobody decided anything, so asking again with a better summary gets the same
  answer. `request` refuses and writes no `approval.requested`; `grant`, `reject`
  and `revoke` all refuse, because a decision record of any kind about such a
  class would read afterwards as a class this gate transacts in; a harness-grant
  spend refuses too. Evaluated immediately after the check that establishes a
  request exists, before every question about who may decide it, under which
  policy hash, or against which budget. `withdraw` and `expire` are deliberately
  NOT refused: they are the exits for a request whose class a policy amendment
  raised after it was opened.
- `loop-escalated` — three consecutive failed SIDE-EFFECTING executions escalated
  the task to manual, or a harness session or actor scope reached the same count
  (amended SPEC.md §10.2, APRV-280). A failed `read.*` action accrues nothing and
  a successful one clears nothing. Its MANUAL actions are unaffected; the streak
  clears on a side-effecting completion, and the refusal names the scope and that
  clearing action.
- `not-requested` — there is no request to decide or expire.
- `already-decided` — the request is already granted, rejected, revoked or
  expired.
- `not-granted` — revoke was attempted on a request that is not granted.
- `request-withdrawn` — the requester withdrew the request before anyone decided
  it, or is withdrawing one it already withdrew. Distinct from `already-decided`:
  nobody answered, and nobody can now. Request the action again.
- `not-requester` — a withdrawal was attempted by an actor other than the one
  that opened the request. Only the party that asked may take the question back;
  anyone else who wants it gone rejects it.
- `expired` — the TTL lapsed, judged from the request's own `ts`.
- `not-expired` — expire was called before the TTL lapsed, or the policy declares
  no `defaults.approval_ttl`.
- `actor-invalid` — the actor is not a well-formed `human:` / `agent:` identity.
- `actor-not-human` — a human-only verb was attempted by another actor.
- `actor-not-approver` — a grant was recorded by a person the resolved class
  rule's `approvers` list does not name. Distinct from `actor-not-human`, and
  the repair is what separates them: that one says run the verb as a person,
  this one says ask a person the policy put in front of this class. Grant only;
  reject and revoke withdraw authority and stay open to any human. A rule that
  declares no `approvers` restricts nobody. Note for anyone upgrading: the list
  was parsed and enforced nowhere before, so a policy naming approvers starts
  binding here, and `approval init`'s scaffolded policy names `alice`.
- `diff-too-large` — the semantic diff of a proposed policy amendment renders
  larger than a channel prompt can show whole. A refusal, never a truncation: a
  prompt showing two thirds of a policy change would collect a signature for the
  third it did not show. Read the diff at a terminal and attest there, or split
  the amendment into changes a phone can hold.
- `proposal-not-found` — no `policy.proposed` record at the named seq, so there
  is no attestation prompt to answer.
- `proposal-stale` — the policy bytes changed after the prompt was rendered, so
  the hash on the approver's screen is not the hash on disk. Distinct from
  `policy-drift`, which is about a pending approval routed under superseded
  rules. Nothing is attested; propose the amendment again.
- `policy-already-attested` — an attestation was proposed for a policy file that
  already matches its attestation. There is no amendment to sign.
- `reaction-note-required` — a grant carrying `reaction: loved` or
  `reaction: disliked` and no non-blank note. Grant only, evaluated with the
  other checks that read nothing, and nothing is appended: the request is still
  pending and `--note "<text>"` is the whole of the fix. Its own code rather than
  the audit path's `note-required` because a caller branching on a gate refusal
  is branching on this union, and the two verbs are answered by two different
  modules. `reject` and `revoke` carry no reaction at all, which is a usage error
  at the verb (exit 2) rather than a member of this union.
- `log-unreadable` (exit 4) / `log-torn-tail` (exit 3) / `log-corrupt` (exit 1):
  nothing is authorized from a log that does not verify.
- `append-failed` — the append itself failed; the exit code follows the cause.
  `head-moved` means the log grew between this command's read and its write, so
  nothing was written. Since APRV-236 you see it only after the command has
  re-read the log, re-run its checks against the fresh head and tried again, up
  to three times, and the message says how many attempts were made. One lost race
  no longer surfaces at all, and a request something else settled in the window
  is refused for that (`already-decided`, `request-withdrawn`, `expired`,
  `policy-drift`) rather than for the race.

## token

The raw token is shown once, by `approval grant`, and is recoverable from
nothing. The log records only its SHA-256, which is the entire point: an
exported, copied, audited log grants its reader no power to execute.

So this command does not print the token — it cannot, and no future version can
without storing the secret the design exists to avoid storing. SPEC.md §10.1
lists "approval token `<action-key>`  # print single-use execution token if
granted"; the honest reading under the settled hash-only design is that the
token is printed BY grant and that this verb reports status. (Flagged for human
review.)

Exit 0 means granted, unrevoked, unexpired, unconsumed. Every other answer names
which of the three deaths applied: execution (`token-consumed`), revocation
(`token-revoked`), or the parent request's TTL (`token-expired`).

**`--json`** (one object on stdout):

```
live     {"ok":true,"action_key":"...","state":"granted","live":true,
          "token_sha256":"<64 hex>","grant_seq":4,"class":"...",
          "est_cost_usd":"0.02","payload_hash":"<64 hex>"|null,
          "task":"task-042"}
refusal  {"ok":false,"error":{"code":"...","message":"...","state"?:"...",
          "seq"?:N}}  on stderr
```

`payload_hash` is the binding the grant carried, or null for a grant that bound to
no bytes.

## token refusal codes

The vocabulary `approval token` and `approval consume` return in `error.code`.
Frozen public API in the same sense the gate's codes are.

- `not-granted` — no grant governs this action key: never requested, still
  awaiting a decision, or rejected. Ask a human, do not retry.
- `token-mismatch` — a grant exists but the presented token is not its preimage,
  or the grant predates tokens and carries no hash.
- `token-consumed` — already spent: an `execution.started` for this action key is
  in the log. A token is single-use; retrying cannot help.
- `token-expired` — the PARENT REQUEST's TTL lapsed. There is no separate token
  TTL; re-request the action.
- `token-revoked` — a human withdrew the grant (`approval.revoked`).
- `harness-executed` — the grant was for a request the requester declared
  `execution: "harness"` (the Claude Code hook), so no token was minted. Nothing
  is wrong and nothing is recoverable: the grant is complete, and it authorized
  a process that runs the command itself rather than through `approval run`.
  Distinct from `token-mismatch`, which would send an agent hunting for a token
  that deliberately never existed.
- `class-human-only` — the class the grant authorizes resolves to `human-only`,
  so the token may not be spent and `approval token` reports it unspendable
  rather than live. The gate refuses the request that would mint such a token,
  so a grant under this class means a policy amendment raised the class after
  the grant; the token dies at that moment, which is the direction the amendment
  chose. Not a member of the verification union: verification is pure over the
  log, and this is a fact about the policy.
- `log-unreadable` (exit 4) / `log-torn-tail` (exit 3) / `log-corrupt` (exit 1):
  no token is spendable from a log that does not verify.
- `append-failed` — the append itself failed; the exit code follows the cause.
  `head-moved` means another writer got there first, which with one token is a
  refused double-spend, and nothing was written.

## consume

Internal. This is the plumbing verb `approval run` wraps; it exists in the CLI
so the token boundary is testable and so an adapter integration can be driven by
hand. It is the only sanctioned appender of `execution.started` on the manual
path: a manual action's start event cannot exist without a verified token behind
it.

Budgets are not charged twice: the evaluator counts an `execution.started` only
when the window holds no `approval.granted` with the same action key, so a
manual action costs its window exactly one charge — the grant.

Supervised and autonomous actions have no grant and therefore no token (amended
SPEC.md §6.3); this verb correctly refuses them with `not-granted`. Their
`execution.started` belongs to `approval run`.

`--payload-hash` is SHA-256 over the RFC 8785 canonical serialization of the
payload about to be executed. It is REQUIRED whenever the grant bound to bytes,
which under amended SPEC.md §6.2 is every manual grant this runtime mints. A
different hash, or none, is refused `payload-mismatch`, nothing is appended, and
the token stays live.

The appended `execution.started` carries
`{"class","est_cost_usd","token_sha256"}`.

**`--json`** (one object on stdout):

```
success  {"ok":true,"action_key":"...","event":"execution.started","seq":5,
          "token_sha256":"<64 hex>","grant_seq":4,"class":"...",
          "est_cost_usd":"0.02"}
refusal  {"ok":false,"error":{"code":"...","message":"...","state"?:"...",
          "seq"?:N}}  on stderr
```

## run

`run` is transparent: it exits with the child's exit code, because a wrapper
that swallowed the code would break every `&&` and every CI step that wrapped
it. A child killed by a signal is recorded and reported as 128 + signal number
(SIGKILL 137, SIGTERM 143), the shell convention. A command that could not be
spawned at all is recorded as exit_code 127.

A crash between `started` and its outcome leaves a **dangling execution**: the
log says truthfully that the action began and that nobody knows how it ended.
`approval status` reports it distinctly; `approval queue` does not (it is not a
pending decision). Nothing repairs it automatically — a second run for the same
key refuses rather than reconciling, because reconciliation would mean guessing
whether the side effect happened, and a guess in an append-only log is
indistinguishable from a fact. Recovery is a human recording the outcome they
actually observed, with `approval execution resolve`, which appends
`execution.completed` or `execution.failed` with `exit_code` null and
`attested_by_human` true, so no reader mistakes an observation for a
measurement.

Content binding (amended SPEC.md §6.2, §10.4): run computes the hash of the argv
and cwd it is about to spawn, always, and presents that. The command IS the
action here, and an executor that had to be told what it was running could be
told wrong.

Since APRV-401 that computation includes THE SCRIPT THE ARGV NAMES. A known
interpreter followed by a path operand, or a path at `argv[0]`, carries that
file's size and SHA-256 inside the hashed payload, so a grant over `bash
install.sh` binds the script's bytes rather than its path: a script edited
between the declaration and the run hashes differently and is refused
`payload-mismatch`, with nothing appended and the grant still live for the
approved bytes. An argv naming no script hashes exactly as it always did.
`approval payload run` prints the same value, which is how a requester obtains
the declaration in the first place; `docs/run-payload-binding.md` states the
rule and the six things it does not reach.

`--payload-hash` is consequently a CHECK and never a substitute
(APRV-140): a value differing from the recomputed one is refused
`payload-mismatch` before the child exists and before anything is appended, and
the refusal names the script it bound so the repair is visible. An
action whose payload is content rather than an argv (an email body, a record
write, a message and its recipients) is executed through the adapter contract of
§10.4, `approval adapter email`, which hashes those bytes itself; a token for
such a grant is spent with `approval consume`, never by spawning a command that
is not the approved bytes.

The binding is required off the manual path too. A supervised or autonomous
action has no grant, so its registered declaration is the whole of what
authorizes it: run presents the recomputed hash, `execution.started` records it,
and a declaration carrying no `payload_hash` (or an executor whose bytes differ
from it) is refused `payload-mismatch` with the log untouched.

**`--token` is optional under sealed delivery** (APRV-105). With policy
`defaults.token_delivery: sealed` and no `--token`, run opens the grant's
`token_sealed` with the private key `approval request` wrote beside the log and
spends what it finds; the key file is unlinked once the token is spent. A pasted
`--token` still wins where one is given. Under the default `manual` delivery
nothing was sealed, the lookup finds nothing, and a missing token refuses
`token-required` exactly as it always did.

Exit 5 is an addition to the frozen table, emitted by this verb alone, and it is
distinct from 1 because the repair is distinct: request the action, have a human
grant it, and pass the token that grant printed once.

**The child's environment is built, never inherited** (APRV-205). `run` used to
hand the child a copy of the whole session environment, which meant the gate
held the Telegram token and gave it to every command it launched. It now
constructs the child's environment instead:

- **Withheld**: every variable under the credential-bearing prefixes
  (`APPROVAL_*`, `TELEGRAM_*`, `VAULT_*`), and the variable the policy's
  `vault.passphrase_env` names, wherever that name falls. These are the same
  prefixes the command classifier uses (APRV-194), read from the same list.
- **Kept**: the runtime's own non-secret names under those prefixes
  (`APPROVAL_HUMAN`, `APPROVAL_AGENT`, `APPROVAL_ASCII`, `APPROVAL_MD`,
  `APPROVAL_HOME`, `APPROVAL_DIR`), and any credential the adapter serving this
  action's class declared in `requiredCredentials` (APRV-169). That declaration
  is the adapter's own static code; there is no flag that names a variable to
  keep, because a flag like that hands the token back to whoever passes it.
- **Untouched**: everything else. `PATH`, `HOME`, `TMPDIR`, locale, proxy
  settings and the rest of a working environment pass through as they are.

`execution.started` records `env_stripped`, the COUNT of what was withheld, and
never a name and never a value: a variable's name is half of a credential. The
count is informational, and nothing in the gate reads it back.

The scrub is not the sandbox, and since APRV-193 the sandbox is here too. A
child spawned WITHOUT a token runs with outbound network denied by the operating
system (macOS `sandbox-exec`), and the credential material beside the log
(`vault.enc`, the `env` source map, the sealing keys) is unreadable to it. A
child spawned WITH a token keeps the network: the manual path is a human's grant
over these exact bytes, and `approval run` on a grant is the one door to the
world: the registry for `deps.add`, the API host for `network.call`. Reading
the token rather than re-resolving the class keeps the decision on the near side
of the append, and it widens nothing an agent can reach alone, because a token
that does not verify runs no command at all.

`execution.started` records which room the child ran in, as `sandbox`:

- `egress-denied`: the child ran with no outbound network.
- `granted-egress`: a token was presented, so a human approved these bytes.
- `opted-out`: `--no-sandbox` was passed. Recorded precisely because an opt-out
  nobody can see afterwards is an opt-out that costs nothing to take.
- `unsupported`: this platform has no mechanism in this build (anything but
  macOS today; Linux is the follow-up). The execution proceeded UNPROTECTED, and
  the field is how an auditor finds every run that did.

On macOS, a sandbox that is present and broken is a refusal: the command is not
run, nothing is appended, and the same token still spends once it works. See
`docs/sandboxed-exec.md` for the profile, the survey of what egress denial
costs, and the carve-outs.

**What it does, in this order.**

1. appends `execution.started` BEFORE the child is spawned, never after,
   carrying `env_stripped`;
2. spawns the command with inherited stdio (the child owns the terminal) and a
   built environment (the child owns no credential);
3. appends `execution.completed` (child exit 0) or `execution.failed` (anything
   else), carrying `payload.exit_code`, the real number, unmapped;
4. exits with THE CHILD'S EXIT CODE.

Everything after the first `--` is the child's argv, passed through untouched.
Authorization: manual actions spend a token; supervised and autonomous actions
have no grant and no token, and for them run enforces attestation, loop
escalation, single-use idempotency, and budgets, which are charged here.

Recovery from a dangling execution:

```
approval execution resolve <action-key> --outcome completed|failed \
                           --note "<what you saw>" [--as human:<id>]
```

**`--json`** goes ON STDERR, because stdout belongs to the child:

```
success  {"ok":true,"action_key":"...","task":"...","class":"...",
          "autonomy":"manual","started_seq":5,"outcome":"execution.completed",
          "outcome_seq":6,"exit_code":0}
refusal  {"ok":false,"error":{"code":"...","message":"...","detail"?:"...",
          "verdicts"?:[...],"seq"?:N,"event_seq"?:N}}
```

**Refusal codes** (`error.code` with `--json`; frozen public API):

- `token-required` — the class resolves to manual and no token was given. Nothing
  was appended. EXIT 5.
- `action-not-registered` — no `task.registered` record declares this action key.
- `class-human-only` — the class resolves to `human-only`: a person performs
  this action outside agent execution. Refused on both paths, before either is
  chosen, and nothing is appended. Distinct from `token-required`, which is a
  redirection: here there is no token to get and no grant that could mint one.
- `loop-escalated` — three consecutive failed SIDE-EFFECTING executions escalated
  the task to manual (amended SPEC.md §10.2, APRV-280); route it through a human
  grant instead. Failed `read.*` actions accrue nothing.
- `policy-not-attested` — policy unattested or its bytes changed (detail:
  `not-attested` | `hash-mismatch` | `unreadable`).
- `already-executed` — an `execution.started` already exists for this key.
- `budget-exceeded` — budgets refused the start; a `budget.exceeded` event WAS
  appended and `error.verdicts` lists the failures.
- `not-granted` — manual action with a token but no grant behind it.
- `token-mismatch` — the presented token is not the grant's preimage.
- `token-consumed` — the token was already spent, including by a dangling
  execution, which run will NOT reconcile.
- `token-expired` — the parent request's TTL lapsed.
- `token-revoked` — a human withdrew the grant.
- `not-started` / `already-finished` — (finish path) no `execution.started` to
  close, or that execution already has an outcome.
- `log-unreadable` (exit 4) / `log-torn-tail` (exit 3) / `log-corrupt` (exit 1).
- `append-failed` — the append itself failed; the exit code follows the cause.

## sandbox

```
approval sandbox [--allow-loopback] [--read-jail] [--log <path>] -- <cmd> [args…]
```

Runs a command with outbound network denied by the operating system. It appends
nothing, authorizes nothing, and exits with the child's own exit code.

**Why it exists.** `approval run` covers the actions the gate SEES. It does not
cover the commands a harness runs on its own (`npm test`, `node
scripts/whatever.mjs`), which the hook classifies `files.write.workspace`, allows, and then
never touches again, because the hook decides and the harness executes. Those
are exactly the commands that run code an agent wrote a minute ago, so the
command's NAME has stopped describing its effect, and no classifier over shell
text can fix that. This verb is where such a command runs when its effects
cannot leave.

The hook cannot apply the sandbox itself: a `PreToolUse` verdict is allow or
deny, and it cannot rewrite a command into a wrapper. Two things make the
wrapper more than a convention:

1. the classifier reads `approval sandbox -- <cmd>` as the class of `<cmd>`, so
   wrapping neither hides a command from the gate nor is punished by it (before
   APRV-193, `sandbox-exec …` was `hook-unclassified` and denied, while the bare
   command was allowed: the hook actively penalised the safe spelling);
2. `APPROVAL_HOOK_REQUIRE_SANDBOX=1` makes the hook DENY an allowed-class exec
   that is not written this way, naming the spelling that works. Off by default,
   and turning it on can only ever refuse more.

**What the child gets.** No outbound network, including loopback (the gate needs
none: its IPC is a file). No credential-bearing environment variable
(`core/child-env.ts`, APRV-205). No read of the vault, the `.approval/env`
source map, or the sealing keys. Everything else (the filesystem, the working
tree, `PATH`) is untouched, because a sandbox that broke ordinary development
is a sandbox somebody turns off.

**`--allow-loopback`** carves loopback back in, for a suite that starts its own
server. It is a real widening: a port is a port, and anything listening on one is
reachable from inside.

**`--read-jail`** (APRV-347) goes the other way and makes the room smaller: file
reads become deny-default, with the gate root, the scratch roots and a fixed
runtime set opened by `subpath`. It is already on, without the flag, whenever
the policy declares a `read_scope` block, which is the spelling an operator
commits and attests; the flag is for trying it on one command first. There is no
flag that turns the jail OFF where a policy asked for it, because a flag an agent
can pass must only ever narrow what it can do. See
[docs/sandboxed-exec.md](./sandboxed-exec.md) for the profile and its limits.

**Exit 127** means the command was NOT run: this machine has no working sandbox
primitive, or the command is not on `PATH`. Unlike `approval run`, this verb
fails closed on both: it makes one promise and has nothing else to offer.

**An agent harness cannot run under this.** `claude` and `cursor-agent` talk to
a model over the network, which is exactly what is denied, so
`approval sandbox -- claude` is a session that cannot think. A whole-session
sandbox needs an egress allowlist reaching one host, which Seatbelt cannot
express by hostname and which the prior art solves with a local proxy. Until
that exists the unit this verb protects is the command.

See `docs/sandboxed-exec.md` for the profile, the survey of what egress denial
costs, and the carve-outs.

## wait

Polls the log and writes nothing — not even the `approval.expired` event it may
derive: expiry is judged lazily from the request's own timestamp, and
materialising it is `approval expire`'s job, not a reader's. The one exception is
`--withdraw-on-timeout`, below.

For `approval wait` the exit code IS the decision (SPEC.md §10.1). The
overloading of 1 (integrity / rejected) and 3 (torn tail / expired) is
deliberate: wait appends nothing and cannot fail a chain verification of its
own, and `--json` names the outcome exactly (`granted | rejected | withdrawn |
expired | nothing-to-wait-for | timeout`) for callers that need more than a
number. Flagged for human review.

**Nothing to wait for, and nothing registered** (APRV-428). Exit 0 has always
answered at once for a task with no requests, because only the manual path
produces requests and the supervised path tells an agent its `proceed: true`
needs no wait. Its `status` is `nothing-to-wait-for`, never `granted`: a
registered task with no `approval.requested` at all (no action declared, none
reached the manual path, or none requested yet), or one whose every granted
action has already started executing, so every grant is spent. `granted` means
at least one granted action has not executed yet, and only that. The per-action
rows are unchanged; an executed grant still reads `granted` there.

A task with no `task.registered` record is refused before anything is derived:
`not-registered`, the gate union's code for exactly that condition (SPEC.md
§11.2), at exit 1, the code `approval request` exits for the same refusal.
Before APRV-428 such a wait answered `{"ok":true,"status":"granted","actions":[]}`,
so a typo read as a grant. Through `approval serve` the verb's refusal passes
through unchanged: the body's `stderr` carries the same object and `exit_code`
is 1.

`withdrawn` (APRV-106) reuses exit **1** rather than claiming a new number. The
exit table in `src/cli/exit-codes.ts` is frozen public API and agents already
branch on its seven values; the fact a caller needs — this action is not
authorized and no retry of this request will change that — is exactly what 1
already carries. The distinction lives where one can be added without breaking
anyone: `status` in the `--json` object, and the state printed beside the action
in the human render.

Exit 6 is an addition to the frozen table, emitted by this verb alone: the wait
elapsed with request(s) still undecided, nothing was appended, the requests are
still live, and waiting again is legitimate.

**`--withdraw-on-timeout`** (APRV-106) changes only that last sentence. On
timeout, every request this actor opened and that is still pending is withdrawn
(`reason: "timeout"`), so nobody is asked a question the waiting process can no
longer answer to. It is OFF by default, because a caller that stopped waiting
has not necessarily stopped wanting an answer — a supervisor may wait again. It
needs `--as` (or `APPROVAL_HUMAN`), checked up front rather than after the wait,
since only the actor that opened a request may withdraw it. A withdrawal that
itself fails is reported on stderr and leaves the request live; the exit code is
6 either way.

**`--json`** (one object on stdout; a timeout goes to stderr):

```
decided  {"ok":true,"task":"task-042",
          "status":"granted"|"rejected"|"withdrawn"|"expired"|"nothing-to-wait-for",
          "actions":[{"action_key":"...","state":"granted","seq":4}]}
timeout  {"ok":false,"task":"task-042","status":"timeout",
          "actions":[{"action_key":"...","state":"requested","seq":3}]}
refused  {"ok":false,"error":{"code":"not-registered","message":"..."}}   (stderr, exit 1)
```

**Sealed token delivery** (APRV-105). Under policy `defaults.token_delivery:
sealed`, a granted action's entry additionally carries `token`, the raw
execution token:

```
{"action_key":"...","state":"granted","seq":4,"token":"<64 hex>"}
```

It is present only in `--json`, only on a `granted` action, only when this
machine holds the private key `approval request` wrote when it opened the
request, and only until the token is spent — the key file is unlinked at consume,
at expiry and at revocation. The human render never prints it: that render goes
to a terminal, and a token on a terminal is the paste this exists to remove.

`approval run` reads the same seal, so the ordinary flow needs no token in any
argv at all: request, wait, run. A pasted `--token` still wins where one is
given, because a caller naming a token is making a claim the runtime then checks
against the grant's digest, and silently substituting a different one would
answer a question nobody asked.

What this does NOT change: the token exists only because a human granted it, it
binds to the exact payload bytes, and it is single-use. The keypair addresses; it
does not authorize. The raw token is still printed once on the granting surface,
so the paste path is preserved rather than replaced.

`withdrawn` is added to the timeout object only when `--withdraw-on-timeout` was
passed, listing the keys actually retracted; the default shape is unchanged.

`state` is the per-action derived state; `status` is the whole task's outcome,
with rejected/revoked outranking withdrawn, withdrawn outranking expired,
expired outranking granted, and granted outranking nothing-to-wait-for. `--timeout` and `--interval` take the SPEC.md §5.2
duration grammar, `<positive integer><ms|s|m|h|d|w>`.

## queue

What it deliberately does not show — all of it lives in `approval status`:
dangling executions, attestation state, budget headroom, chain verification,
loop escalations. A decided, expired, revoked or executed action leaves the
queue and does not come back; operational debris never enters it. An inbox that
accumulates things nobody can act on is an inbox that stops being read, and this
one is the whole mechanism by which a human's attention is spent.

Exit 0 always when the log could be read: an empty inbox is a healthy inbox, not
an error.

What it lists: the action key, the task, the class, the declared cost, when it was
requested, and how much of the TTL is left.

**`--json`** (one object on stdout):

```
{"ok":true,"pending":[{"action_key":"task-042:chaser","task":"task-042",
 "class":"communicate.email.external","est_cost_usd":"0.02",
 "requested_ts":"2026-08-06T10:00:00.000Z","seq":3,
 "ttl_remaining_ms":3599000,"ttl_ms":3600000}]}
```

`pending` is `[]` for an empty inbox. Both TTL fields are measured against the
window the gate judges the request by (APRV-423): the policy's
`defaults.approval_ttl`, narrowed by the harness ceiling the requesting hook
declared, if any. `ttl_ms` is that whole window and `ttl_remaining_ms` is what is
left of it; both are null only when nothing bounds the request (no TTL and no
cap means no lapse). A hook-opened request under a policy with no TTL therefore
shows its real remaining window here rather than `null`.

## gate

The open window (APRV-214, amended SPEC.md §5.2). The harness hook fails closed
on every axis, which is right, and which means that when the gate itself is
broken (an unattested policy, a drifted attestation, a hung daemon, a dark
channel) every command a session issues dies, including the ones a person would
use to repair it. Before this the only escape was hand-editing the hook out of
`.claude/settings.json`: an ungated session nobody records, which is the failure
this project exists to prevent.

**The state lives in the log and nowhere else.** `gate.opened` starts a window,
`gate.closed` ends one, and nothing at all is appended when one lapses; a reader
derives the window from the latest `gate.opened`, its `ts`, its `duration`, and
the absence of a close naming its seq. A file the runtime read on its own
authority would let anything able to write that file act as the human, which is
the `.approval/env` precedent. The consequence is deliberate: a log the hook
cannot read or verify yields no window, and the hook denies exactly as it always
did. The window suspends the POLICY; it never suspends the log.

**What it reaches.** Every hook-gated shell command and file edit under the
root, ahead of the policy load, the attestation check, the loop floor, the
unattended guard and the human gate. Each allowed call appends one
`gate.bypassed` naming the window's seq, the tool, the classes, a summary and
the payload hash, and the record lands BEFORE the allow is printed: an append
failure is a deny. Bypassed calls are charged to no budget and enter no
retrospective sample, because nothing authorized them; they were recorded.

**What it never reaches.** Writes aimed at `.approval/log/` (`log.mutate`),
refused with no policy consulted because a bypass able to rewrite the log could
rewrite its own authorization; every class the policy reserves to human hands;
a command the classifier cannot read (`hook-opaque`, `hook-unclassified`,
`hook-unparseable`), since nothing can establish that an opaque string does not
write into the log; and a log that cannot be read or verified.

**Usage.**

```
approval gate open   [--for <duration>] --reason "<text>" [--as human:<id>]
                     [--log <path>]                     (terminal; no --json)
approval gate close  [--note "<text>"] [--as human:<id>] [--log <path>] [--json]
approval gate status [--log <path>] [--json]
```

`--reason` is required, and it is recorded on the `gate.opened` record the
window derives from: a bypass nobody stated a reason for is a bypass nobody can
review. An absent flag is a usage error and an empty one is refused
`gate-reason-required`; there is no minimum length beyond that, since the
reason is for the person reading the log later. `--for` takes `5m`, `30m`,
`2h` and the like (default 30m, cap 24h). `--as` names the human opening it and
falls back to `APPROVAL_HUMAN`, the variable `eval "$(approval env)"` exports.
`--note` on `close` records what the window was used to learn.

A typical open, from a terminal in the primary checkout, with the confirmation
typed at the prompt that follows:

```sh
cd /Users/carter/dev/approval-md
approval gate open --for 2h --reason "hook denies every command: attestation drifted after the seq 7355 amend"
understood                      # typed at the prompt the verb prints, not a command
approval gate status --json     # the window, its reason, and what has bypassed it so far
approval gate close --note "re-attested; hook answering again"
```

**The ceremony.** `open` needs a terminal and the word `understood`, typed in
full and matched exactly after trimming. There is no `--yes` and no `--force`,
and `--json` is refused: an answer shaped for a machine implies a machine asking
a question only a person answers. `approval gate open` also classifies
`policy.core`, so a policy holding that class human-only makes the hook refuse
an agent that tries the verb at all. Default 30m, cap 24h; a record claiming an
expiry beyond its own `ts + duration` reads as the shorter of the two, and a
duration over the cap is clamped at read time as well as refused at write time.

`approval status` reports `healthy: false` while a window is open, and adds a
`gate_window` key. That is intended: a CI check or a `doctor` run keyed on
`healthy` should go red while a bypass stands.

**`--json`** (`close` and `status`; `open` has no JSON form):

```
close    {"ok":true,"seq":9,"opened_seq":7,"actor":"human:carter","bypassed":3}
status   {"ok":true,"open":true,"window":{"seq":7,"opened_at":"...","opened_by":"...",
          "reason":"...","expires_at":"...","remaining_ms":123456,"bypassed":3,"scope":"hook"}}
refusal  {"ok":false,"error":{"code":"...","message":"..."}}
```

`error.code` is one of the frozen `GATE_WINDOW_REFUSAL_CODES`:
`actor-not-human`, `gate-reason-required`, `gate-duration-too-long`,
`gate-already-open`, `gate-not-open`, `gate-stdin-not-tty`,
`gate-confirmation-mismatch`, `log-unreadable`, `log-torn-tail`, `log-corrupt`,
`append-failed`. Every one of them appends nothing.

## status

`queue` is what a human must answer; `status` is what an operator must fix.
Neither shows the other's content, and a dangling execution is the clearest
case: it appears in status, never in the queue, because nobody is being asked to
decide it.

**dangling** is the state a crash between `execution.started` and its outcome
leaves. Nothing repairs it automatically; it clears only when a human records
the real outcome with `approval execution resolve`, which demands a mandatory
note, a human actor, and records `exit_code` null rather than inventing one.
Recording an outcome nobody observed is exactly the write this design refuses to
make casual.

It is executions the runtime MEANT to watch, and never harness executions. A
harness execution records that the agent's harness ran the command and this
runtime never sees an exit status, so no outcome will ever follow and the record
is complete as written (SPEC.md §6.3 calls the state `delegated`). Listing those
as debris is how a list an operator is supposed to act on becomes a list they
scroll past — the reference repository's own log carried dozens of them.

**indeterminate** is the other kind of debris, and it is reported separately
because it asks a person for something different. A dangling execution asks them
to look at what this runtime did. An indeterminate one — the side effect was
attempted and nobody knows whether the far side committed — asks them to
establish it from the provider's own evidence, and the verb for that is
`approval execution reconcile`. Both make `healthy` false. The field is additive
and appears only when there is at least one.

**budgets** come from a zero-cost probe evaluated now: the numbers are what the
evaluator would say about a hypothetical next action declaring $0. Consequently
`remaining` for `daily_actions` already has that one action subtracted, because
every authorization counts as one. Class limits are absent by design — they need
a matched rule, and therefore a specific action, which status does not have.

**payload_store** carries the warning it exists to keep in front of an operator:
the store holds the bytes approvals bind to, and it is the one cache that cannot
be rebuilt from the log. QUEUE.md regenerates and index.sqlite reindexes; the
store does not, because the log records the hash a request bound to and never
the material. Deleting it loses those bytes for good, and the surviving binding
makes the loss visible: every manual request whose material went with it renders
`payload-unavailable`. `pruned` counts distinct hashes named by a
`payload.pruned` event — retention removes bytes and leaves that record behind on
purpose — and `orphans` counts store files no record binds. All of it is
informational: it moves neither the health verdict nor the exit code. An empty
store is the normal state of a repo that has never made a request carrying
`--payload`. (`approval doctor` is where an unwritable store is a failure.)

**anomalies** are informational for the same reason `approval log verify`
declined to refuse on them: status does not get to overrule that.

**refusals** is the two refusal families, counted, with the newest five of each
(APRV-376). `decision` counts `audit.decision_refused`: a human decided and the
gate would not take it, which is APRV-235's record. `gesture` counts
`audit.gesture_refused`: a human made a gesture that is not a decision (a
checkpoint signature, a review, a review note) and the surface refused it before
any verb ran, which is APRV-355's. Until this field existed neither was reported
anywhere, and an operator could reach them only through `approval log tail` and
`approval log export`. The question the field answers is small enough that the
chain was a poor place to answer it: told that taps from an account they did not
map are being refused, an operator wants to know how many and from which account.

Each entry carries the `seq`, the surface's own refusal code verbatim, and the
observed `sender` when the record carries one, in the form the record carries it
(`hashed: true` marks APRV-370's keyed digest rather than a raw account id). The
count is every record of that family in the log; the listing is the newest five,
newest first, because a row that grew with the log would push the rest of the
report off a terminal for a fact that decides nothing.

It is informational, exactly as `coverage` and `anomalies` are: it moves neither
`healthy` nor the exit code. A refusal is the gate having worked, and a report
that went red because the gate turned away a stranger's tap would teach an
operator to stop reading it. It reads only verified records (SPEC.md §11.1
invariant 1), which is also why a log that does not verify reports no refusals
rather than reporting some it cannot stand behind. A family with no records is
absent rather than zero, and the whole field is absent when both families are, so
a repository where nothing has been refused emits the object it always emitted.

**coverage** is one line of `approval coverage` (APRV-245): the commits git
recorded on THIS branch, counted against the verified log. The range is the
merge base with `origin/main` to `HEAD`, so what it measures is what this branch
added. Two states replace the numbers rather than faking them, because in
neither would a count mean anything: `not a git checkout`, and `origin/main
absent`, which is a checkout with no trunk ref to take a merge base from.
Informational, exactly as `harness_outcomes` is: it moves neither `healthy` nor
the exit code, because a coverage measurement is not an integrity verdict and a
gap is a question for a person rather than a failure. The whole report, `gh` and
the adapters included, is the `coverage` verb below.

**`--verbose`** prints the rationale sentences under the rows they explain — at
v0.1 that is the payload-store paragraph above, which is the one row whose three
numbers a first-time reader cannot interpret unaided. It adds lines and moves
none: the rows themselves are byte-identical with and without it, and `--json`
does not know the flag exists.

**What it reports**, in one object:

- `attestation` — attested | hash-mismatch | not-attested | unreadable, with the
  seq of the governing `policy.updated` record.
- `verification` — the latest chain verdict, and the record count (null when
  corrupt).
- `dangling` — executions the runtime meant to watch and never closed. Not
  harness executions, which are terminal by design.
- `indeterminate` — additive and present only when non-empty: side effects that
  were attempted and whose fate nobody has established, with the closed `reason`
  each was recorded under.
- `budgets` — headroom per configured GLOBAL limit, from a zero-cost probe.
- `loop_escalations` — tasks, harness sessions and harness actors with three
  consecutive failed side-effecting executions. Each row carries `scope`, the
  derivation that produced the key, and `clears`, the sentence naming what ends
  the streak (APRV-280).
- `coverage` — `{available, reason, observed, covered}` for this branch's own
  commits, as git recorded them. Informational.
- `reconciliation` — obligations opened by a retrospective denial and not yet
  discharged by a person. Counts toward `healthy`, exactly as `dangling` does: an
  unreconciled denial is a "no" that has so far changed nothing, and a "no"
  nobody can see is the failure the retrospective path exists to prevent.
- `payload_store` — whether `.approval/payloads/` exists, how many files it holds,
  how many the log records as pruned, and how many are unbound. Informational.
- `anomalies` — additive and present only when non-empty: gate-typed events whose
  `ts` steps backwards by more than 2s. Informational.
- `refusals` — additive and present only when the log carries a refused decision
  or a refused gesture: `{count, recent}` per family, each recent entry naming the
  `seq`, the refusal `code` and the observed `sender` where there was one.
  Informational.
- `daemon` — `{id, source, allowed}`, always present (APRV-383): the daemon
  instance id a daemon run against THIS log would write onto every record it
  appends, whether it came from `APPROVAL_DAEMON_ID` (`source: "environment"`) or
  was derived from the instance (`source: "derived"`), and the `daemons` allowlist
  the attested policy puts in force. `id: null` means `APPROVAL_DAEMON_ID` holds
  something that is not a usable id, so a daemon started here would be refused
  every append. `allowed: null` means no restriction, which is not the same fact as
  an empty list. Informational: nothing here moves `healthy` or the exit code, and
  being listed grants a daemon nothing beyond the ability to write.

**`--json`** (one object on stdout):

```
{"ok":true,"healthy":false,
 "attestation":{"state":"attested","seq":1},
 "verification":{"status":"clean","records":6},
 "dangling":[{"action_key":"...","task":"...","ts":"...","seq":5}],
 "budgets":[{"limit":"global.daily_usd","scope":"global",
   "window":"rolling-24h","consumed":0.02,"requested":0,"remaining":9.98,
   "pass":true}],
 "loop_escalations":[{"task":"task-042","scope":"task","consecutive_failures":3,
   "escalated":true,"clears":"an execution.completed for task task-042 …"}],
 "coverage":{"available":true,"reason":null,"observed":4,"covered":3},
 "reconciliation":[{"seq":18,"ts":"...","action_key":"...","task":"...",
   "class":"records.write","obligation":"gated-revert","review_seq":17}],
 "payload_store":{"present":true,"files":2,"pruned":0,"orphans":0,
   "note":"..."},
 "refusals":{"decision":{"count":2,"recent":[{"seq":21,"code":"policy-drift"}]},
   "gesture":{"count":1,"recent":[{"seq":24,"code":"sender-unmapped",
     "sender":{"channel":"telegram","id":"5551234567"}}]}},
 "daemon":{"id":"daemon-3f2a9c11","source":"derived","allowed":null}}
```

`ok` is true whenever status ran; `healthy` is the verdict. `attestation.seq` is
null for not-attested and unreadable. `note` carries the unrebuildable warning
verbatim.

## coverage

MCP use is voluntary. An agent connected to `approval mcp serve --http` can call
`request`, `wait` and `run`, or it can simply act, and nothing in this runtime
observes the act, because the runtime is not in the path. A gate an agent may
route around reports only on the actions routed through it, and a report that
counts only its own inputs is a report that cannot go down.

What makes the arrangement honest is that side effects leave witnesses THIS
PROJECT DOES NOT WRITE. Git history records commits, merges and tags. `gh`
records pull requests. AgentMail records the messages an inbox actually sent.
None of those is appended by approval.md, none is reachable by an agent editing
its own log, and each can be read back and joined against the verified records
to ask one question per effect: does the log say a human, or a policy, ever saw
this? That join is what this verb reports, and nothing else.

**What it reports.** Per effect: the source that witnessed it, the witness's own
id (a commit sha, a PR number, a message id), the class it would have been
declared under, and the evidence in the log, or `none`. Then a coverage line per
source, and the reason for any source that could not be reached. `gh is not on
PATH` and `gh saw no pull requests` are different facts, and a source that could
not be asked reports itself unavailable rather than contributing an empty list:
collapsing the two would let a broken tool read as a clean bill of health.

**It is informational, and exits 0 with gaps.** The rule is SPEC.md §10.1's, the
same one the APRV-145 harness-start coverage in `status` follows: a coverage
measurement is not an integrity verdict, and a control an operator learns to
silence is worse than one that reports beside the verdict. A gap is a question
("was this effect ever declared?"), and questions with legitimate answers must
not fail a build. The codes it can still emit are the filesystem's: 2 for a usage
error, 3 for a torn tail and 4 for a log it could not read, because a log it
could not read is a report it did not make. It reads only verified records
(SPEC.md §11.1 invariant 1) and writes nothing anywhere.

### The id rule, which outranks the window

An `execution.completed` may carry `payload.provider_ref`, the identifier the
provider filed the effect under, written by the adapter contract at the moment
the execution closed (SPEC.md §8, APRV-251). An observed effect whose source and
id match one is covered by that record and reported as `match: "provider-ref"`,
printed in the evidence column as `seq <n> execution.completed (id)`. No window
is applied to it: an id names one effect, and a class inside a span of time names
a period.

That is the whole difference the reference buys. Under the window rule below, a
gated send covers an ungated one of the same class sitting beside it in the same
day; under this rule, the log answers about the message actually in front of the
reader, and a message the provider recorded that no record names is a gap no
window can close.

Absence is not a gap. A send whose adapter names no reference, a send made
before the amendment, and every effect from `git` and `gh` fall through to the
class-and-window rule below, which is the same answer this verb has always
given and is labelled as such.

### The window rule, stated exactly

For one observed effect with no id-level match above, evidence is the EARLIEST
record that is all three of:

1. one of `task.registered`, `approval.granted`, `execution.started`,
   `execution.completed` — the four records that mean "this runtime was told
   about an action of this class", from the declaration through the human's
   decision to the spend;
2. of a matching class: EXACT first, and only if nothing matches exactly, a
   FAMILY match on the first two dotted segments, reported distinctly as
   `family` so a reader is never shown a weaker match dressed as a strong one;
3. inside the window `[at - 24h, at + 5m]`.

The window is asymmetric on purpose and both halves are arguable, so both are
written down. **24 hours back**, because the ordinary shape is register →
request → grant → act, and the gap between the human's tap and the effect is a
working day at worst; a week back would let one grant carry every later effect
of its class, which is the laundering hole APRV-202 closed in the protected-path
guard. **5 minutes forward**, because that is clock skew between git's author
date (or a provider's timestamp) and this log, and not an ordering allowance: a
record appended an hour after an effect is a record about some other action,
whatever its class.

The one place the rule is not used is a protected FILE path. Those already have
a stronger answer: the protected-path guard matches a change's BYTES against the
material a grant bound, and its `attested` and `granted-file` verdicts are
content-level rather than time-level. An effect carrying a `path` takes the
guard's verdict when the caller supplies a report covering it, reported as
`match: "protected-path"`; the class-and-window rule is what everything else
gets. The guard's third verdict, `granted-command`, is deliberately not
surfaced: it is a run attributed by time rather than by bytes, and printing it
beside `attested` would flatten the distinction the guard exists to draw.

**The AgentMail join is by message id where the log carries one** (APRV-251). A
send that went through the adapter records the provider's `message_id` on its
`execution.completed` as `provider_ref`, and the same id comes back from the
inbox when this verb asks what was sent, so the two join exactly. A message this
inbox sent that no record names by id takes the class-and-window rule like a
commit does: that covers a send made before the amendment, and it covers a send
made with a credential outside the adapter that happens to sit inside a gated
send's window. The id stays printed either way, because a person pastes it into
the provider's own console.

### The three tiers

A green coverage line is a statement about the middle row and nothing else.

| Tier | What holds | What this verb says |
| --- | --- | --- |
| Prevented by custody | Adapter-held credentials answer only to a token (SPEC.md §10.4). An agent holding the connector and not the key cannot act around the gate at all, because it has nothing to act with. | Nothing. There is no effect to witness, which is the point. |
| Witnessed by a log we do not write | Git, `gh` and a provider's own records. The effect happened whether or not anyone routed it through the gate, and the witness is outside this runtime's reach. | This verb: per effect, the evidence seq or `none`. |
| Not covered | Effects made with credentials the AGENT itself holds — an API key pasted into Grok Bot, a token in a shell profile. No witness this verb can read is guaranteed to exist. | Nothing, and it cannot say so. The remedy is custody, not a bigger report. |

The third row is why the second is never over-read. Moving an effect out of it
means moving the credential into an adapter, so that the key answers to a token
and the first row applies. A report cannot be made to cover what a report cannot
see.

**`--json`** (one object on stdout):

```
{"ok":true,
 "window":{"base":"origin/main","head":"HEAD",
   "since":"2026-08-28T00:00:00.000Z","until":"2026-09-04T00:00:00.000Z"},
 "sources":[
  {"name":"git","available":true,"reason":null,
   "effects":[{"id":"3f2a466ad9cc...","class":"vcs.push.main",
     "at":"2026-09-02T18:04:11Z","actor_hint":"carter@example.com",
     "detail":"merge commit 3f2a466ad9cc Merge pull request #245",
     "path":null,"match":"exact",
     "evidence":{"seq":7094,"event":"task.registered","verdict":null}}],
   "covered":1,"observed":1},
  {"name":"gh","available":false,"reason":"gh is not on PATH",
   "effects":[],"covered":0,"observed":0}]}
```

`evidence` is null for a gap, and its three keys carry two kinds of proof: a
record `seq` a reader can paste into `approval log tail`, or the protected-path
guard's `verdict` about bytes, with the unused half null. `match` says which rule
found it: `exact`, `family`, `protected-path`, or `none`.

**Flags.** `--base` / `--head` bound the commit range, defaulting to the merge
base with `origin/main` through `HEAD`; a checkout where that ref does not
resolve falls back to the last twenty commits and SAYS SO in the source's
reason, because a reader has to be able to see that the answer came from a guess.
`--since` (default `7d`) and `--until` bound the window the adapter and `gh`
sources are asked about. `--source` picks from `git`, `gh` and `agentmail`,
defaulting to `git,gh`; `agentmail` is opt-in because it opens a vault. That
source builds its credential provider the way `approval setup adapter agentmail`
builds its probe's — the passphrase comes from the shell environment under the
policy's name, and NEVER from the `.approval/env` fallback, which is defensible
only inside a consumed-token window. A vault that will not open makes the source
unavailable with the reason; it is never an exit code, because the other sources
still have answers.

## doctor

status reports the health of the SYSTEM recorded in the log — attestation,
dangling executions, budgets, escalations. doctor reports whether this MACHINE
can run the system: the right build, a declared identity, a reachable channel. A
stale binary is invisible to status and is exactly what doctor exists to name.

**One line per check**, with its `fix` on one indented line under it, so a failed
run is counted rather than read. A detail is abbreviated with `…` only when a
terminal width is known and the row would overflow it; a pipe has no width and is
never abbreviated, `--verbose` turns the abbreviation off everywhere, and a
`fix:` line is never abbreviated on any path — repair instructions cut off
mid-command are worse than a wide line.

**Every fix begins with a command.** A `fix:` line opens with something you can
paste — `approval …`, `chmod …`, `echo …`, `export …`, `mv …`, `node …`,
`npm …` — and the prose explaining it comes after. An operator scanning a failed
run is looking for the next thing to type, and a line that opens with "check
that…" makes them read a sentence to find out there is nothing to type. Nothing
in that list deletes or commits: doctor repairs nothing, and a fix that told you
to `rm` or to `git commit` would be making the decision this project keeps human.

**Appends nothing.** Not an event, not a marker. An operator reaching for a
diagnostic while the log is in a state they do not understand must not have that
state changed by looking at it.

The checks, at length:

- **build-freshness** — `dist/src/cli/main.js`, the exact file the bin loader
  runs, is present and not older than the newest file under `src/` or
  `tsconfig.json`. Two shapes have their own message because both cost real time
  in a real ceremony: a STALE BUILD, where verbs that exist in the source are
  absent from the binary, and an UNBUILT CHECKOUT, where `cli.js` exists with no
  `dist/` behind it. A published install carries no `src/`, so freshness is
  unanswerable there and the check skips rather than passing.
- **identity** — `APPROVAL_HUMAN` names a `human:<id>`. Environment only, no
  `--as`: this reports what the next command will find.
- **attestation** — anything other than "the live bytes match" makes every gated
  operation refuse, and that refusal reads like "the policy says no" when it
  means "the policy is unverified".
- **log** — a torn tail and a corrupt log are both failures here; neither is
  repaired, and doctor never truncates a torn line.
- **telegram** — `getMe` against `--api-base`, when both variables are set;
  otherwise SKIP, because a runtime driven by `channel cli` is healthy without
  Telegram. Which variables those are comes from the policy this run resolved.
  getMe and nothing else: never `sendMessage`, which would buzz a human's phone
  for a diagnostic, and never `getUpdates`, whose offset a running listener owns
  — a decision tap consumed here would never reach the listener waiting for it.
- **web-port** — a port already HELD is a PASS with a note; the likeliest holder
  is this runtime's own `approval channel web`, and a doctor that cried broken at
  a working channel would train people to ignore it. Only a bind error meaning
  the config itself is wrong (EACCES on a privileged port) fails.
- **payload-store** — a store that does not exist yet passes (the first
  `--payload` request creates it); an existing directory this process cannot
  write FAILS, because a request already accepted by the gate would refuse
  `payload-store-failed` mid ceremony. The probe creates and removes one empty
  file and reads no payload.
- **audit-sampling** — sampling fails open by design (SPEC.md §5.2), so an
  unconfigured sampler silently audits nothing; this states the disabled reason
  out loud. A sampler nobody configured skips; a half-configured one fails,
  because someone intended sampling and is not getting it. On ONE disabled
  reason, `secret-unset`, the row asks the running daemon over the APRV-208 draw
  socket instead of answering from its own environment (APRV-271), and names the
  process that answered: "enabled per the running daemon (pid N, `<socket>`)".
  That reason is the only one that is a fact about a PROCESS rather than about
  the policy file, and doctor's process is almost never the right one — the
  secret lives in the single terminal the operator ran `eval "$(approval env)"`
  in, and `APPROVAL_*` is stripped from every child, so the row was red on
  machines where sampling had been running for a fortnight. Every other reason
  (`rate-absent`, `rate-invalid`, `rate-zero`, `secret-env-unnamed`,
  `policy-unreadable`) is read from the file here and no daemon's answer softens
  it. With nothing listening the row keeps its old wording and adds that no
  daemon answered and that the daemon's shell is what decides. The answer is
  unauthenticated by construction, since doctor holds no secret to check a MAC
  with; what bounds who may make the claim is the socket, which must be owned by
  this user and unreachable by group or other, and what bounds the damage is
  that a diagnostic authorizes nothing. The secret's VALUE appears on no path:
  what crosses the socket is the variable's name and the rate, both of which the
  policy file already states in the open.
- **envelope-integrity** — every task file whose task the log registered still
  carries an `approval:` envelope. The loss this names was observed live
  (APRV-60): a task-file rewrite by a tool that did not know the key dropped it,
  and nothing refused. Nothing here rewrites a task file: the log holds the
  actions, and re-emitting the envelope from it would turn a projection into a
  source.
- **vault** — the gitignore check runs FIRST, because a vault about to be
  committed is the worse fault and stays wrong after every other problem is
  fixed. A wrong passphrase and an altered file are reported as one verdict on
  purpose, since telling them apart would confirm a guessed passphrase against a
  file someone had modified. Passes naming the credential COUNT and never a name
  or a value.
- **environment** — resolves exactly what `approval env --check` resolves, with
  one deliberate difference: a `keychain:` / `secret-service:` source is reported
  as DECLARED and is not looked up, because those helpers can block on an unlock
  or ACL prompt, and a diagnostic must never hang or ask a human for a password.
  Value-free by construction: it reads each variable's status and source and
  never its value, on any path.
- **log-drift** — how the working log stands against the committed one
  (APRV-125). Since APRV-219 the row IS `approval log verify --anchor`'s check
  (`cli/log-anchor.ts`), rather than a second comparison written beside it: two
  implementations of "has this repository forked" were two chances to disagree
  about the one question where disagreement is intolerable, and the
  disagreement duly arrived (APRV-210). SKIP where no committed copy resolves at
  any rev, with no `fix`, because a check that could not look has nothing to
  prescribe. PASS when the working file extends the committed one, keeping a
  `fix` while records are still waiting to be published, and PASS when the
  committed copy is instead ahead, whose fix is `approval log sync`. The one
  FAIL is a real divergence: hash chains do not merge, nothing in this runtime
  will re-chain them, and which of the two is the log is a human decision. Reads
  only, and never fetches or pulls: the committed side comes out of the object
  store.
- **reconciliation** — is any retrospective denial still unreconciled
  (APRV-127)? A denial cannot undo the action it denies. What it opens is an
  obligation, and an obligation nobody is told about is worth nothing, so doctor
  FAILS while one is open, in the same voice it uses for a half-configured
  sampler. It repairs nothing: satisfaction is human-only in the code and in the
  event schema, and a doctor that could close an obligation would be the runtime
  closing its own homework. The `fix` is the command a person runs after they
  have actually done the thing.
- **harness-hook-outcomes** — whether `.claude/settings.json` registers the
  harness for the event that reports OUTCOMES (APRV-145), and not only for the
  one that asks permission. The configuration this exists to name is the one in
  which loop escalation cannot accrue AT ALL: the pre-execution hook registered
  and the post-execution one not, so every tool call opens a delegated
  `execution.started` that nothing ever closes, the harness streaks of amended
  SPEC.md §10.2 hold at zero, and the guard reads as passing because there is
  nothing for it to see. A silent control is worse than an absent one. Doctor
  READS that file and never writes it: a file that configures the gate is part
  of the gate, so the repair is a line for a human to commit, printed by
  `approval instructions hook`.
- **harness-hook-wiring** — whether THIS checkout's `.claude/settings.json`
  registers `approval hook claude-code` for PreToolUse over every gated tool.
  The roster is read from the adapter that answers the calls (Bash, Edit, Write,
  MultiEdit, NotebookEdit since APRV-408, where it was a hand list that had
  drifted behind them). SKIP, named, when the file is absent, unreadable, or
  registers the hook for only some tools: a spawned-agent worktree without the
  entry is how the APRV-151 bypasses happened, and a session started elsewhere
  may still be hooked, so this row can only speak for the checkout it runs in.
  PASS means the entry is present on disk, and says so plainly: it is not proof
  the running session loaded it. The one FAIL is a handler whose `--dir` names a
  checkout other than this one, which answers from another policy, another log
  and another open window. Two informational lines never decide anything: the
  adapter read tools the matcher leaves out (Read, Glob, Grep) are named as the
  documented default they are, and a matcher tool the adapter handles as none of
  its own is named as the unclassified `allow` it will actually receive. The
  check that trusts no session is the CI-side grant cross-check
  (`scripts/protected-path-guard.mjs`) over the committed log, which since
  APRV-202 requires every added and removed line of a protected path to trace to
  the bound material of a grant, rather than only that the path was granted at
  some point in the week.
- **keychain-scope** — whose keystore items this instance's `.approval/env`
  names, answered from the NAMES alone so that it too can never block on an
  unlock dialog. FAIL for an item whose eight-hex scope suffix belongs to
  another instance: two gates pointed at one credential is how a demo instance
  ended up sending through the production bot and eating its approval taps.
  SKIP, named, for the unscoped pre-APRV-178 item every gate on the machine
  resolves alike, and for a value inherited from the shell while the file names
  a source of its own — both are correct configurations that become somebody
  else's problem the moment a second instance exists.
- **log-advance-cadence** — how far the log has run ahead of any records branch,
  and how the daemon's last cadence advance ended (APRV-204). There is no
  `approval daemon status` subcommand and no status file: the daemon reports
  live on its own event stream, which is gone the moment nobody is tailing it,
  and a status file would be a second copy of facts the log already carries. So
  the answer is read from the log itself (the `daemon-advance-*` cycles the
  daemon registers) plus local refs, which is why a DIFFERENT process can answer
  it, and why an operator gets the same answer whether or not a daemon is
  running at all. Advisory rather than failing: records waiting to be published
  is the normal state of a checkout that has been recording decisions, and only
  the reader knows how long is too long. Reads only, and never fetches, which is
  the rule `log-drift` holds itself to.
- **dark-sessions** — does the activity in this checkout have log records beside
  it (APRV-192)? The detective complement to `harness-hook-wiring` above. That
  row asks this checkout's settings file whether the hook is registered and says
  plainly that this is not proof a session loaded it; this one asks what
  happened and asks a session nothing at all. It DOES fail the run, which is
  where the two part company: a configuration this runtime cannot verify from
  disk is not a health verdict, while a dark session is an EVENT, work done in
  this repository that the log was never told about, and a row reporting one in
  the pass column would be tolerating it quietly in the one place an operator
  goes to ask whether anything is wrong. An `undetermined` subject is a SKIP and
  never a fail, named in the detail rather than folded into a pass: what the
  detector could not see is a gap in the instrument, and a red row for it would
  train an operator to ignore red rows. Doctor appends nothing, so a subject
  found here is reported and not recorded; the record is the daemon's, written
  by the sweep it runs on its own cadence
  (`approval daemon run --dark-sessions`).
- **verified-snapshot** — whether the daemon's verified-head snapshot
  (`.approval/log/verified-head.json`, APRV-188) is in place and still covers
  the live log, so a hook re-proves one SHA-256 instead of re-walking the chain
  per gated tool call. SKIP when there is none: the daemon has not run here, and
  every hook verifies the log from genesis, which is correct and slower. PASS
  when it applies, naming how much of the log it endorses; PASS, with the
  reason, when it no longer applies, because a snapshot a reader refuses is a
  snapshot that never existed. The one FAIL is a snapshot every reader would
  refuse for a reason an operator should act on — a foreign owner, or a mode
  that lets somebody else write it — and the fix is to delete it and let the
  daemon republish. This row can never report a correctness fault: the file
  endorses bytes, the reader re-proves them, and nothing is authorized on its
  word.
- **read-proof** — which prefix proof this policy configures for its long-lived
  readers (`daemon.read_proof`, APRV-217). SKIP when the policy declares no
  `daemon` block: nobody wrote a mode, and every reader re-hashes the whole
  verified prefix on every read, which is the default and the strictest setting.
  PASS naming the mode when one is declared, with the cadence when it is
  `incremental`. It reads the POLICY and never a running daemon's memory: a
  process may have been launched with a flag that beat the policy, and its own
  `started` line is where that is visible. It can never FAIL — both modes are
  correct, and they differ in what a repeat read re-proves and how often.
- **main-behind-origin** — the report half of `approval up`'s startup preflight
  (APRV-215), from the same module, so the two can never disagree about what a
  checkout is in. It answers three things: how far behind `origin/<branch>` this
  checkout is, whether the upstream range rewrites `.approval/log/events.jsonl`
  or `.approval/QUEUE.md`, and what to run next. **It fetches nothing.** Doctor
  is a report, and a report that reached the network to be more accurate would
  be acting on its own account; the answer is as fresh as your last fetch and
  the detail says so. SKIP outside a git checkout, or where there is no
  remote-tracking ref to compare `HEAD` against. FAIL when the preflight would
  refuse, naming the refusal code. The `fix` is an `approval` verb — `approval
  log sync` for a diverged log, `approval up` otherwise — never a `git` command:
  a repair line telling an operator to reset a branch would be doctor making the
  decision this project keeps human.
- **attested-policy-on-main** — whether the policy the log vouches for is the
  policy `origin/<branch>` carries (APRV-342). `attestation` above asks whether
  the LOCAL file is attested; between a `policy amend` and its pull request
  merging that answer is yes while a fresh checkout of main carries the old
  policy with no attestation covering it, so every gate operation there refuses
  `policy-not-attested`. Nothing said so until this row: on 2026-09-16 `approval
  up` ran in exactly that state and reported "already at the remote tip". PASS
  when the attested hash equals the SHA-256 of `APPROVAL.md` at the remote tip.
  FAIL with `attested at seq N, not yet on main`, naming
  `policy-amend-<seq>` when this checkout has already seen that branch on the
  remote, and fixing with `approval policy amend --pr` — which opens the pull
  request or updates the open one, so the same command is right either way.
  SKIP with no attestation, outside a git checkout, and where there is no
  remote-tracking ref. **It fetches nothing**, for the reason
  `main-behind-origin` fetches nothing, and it looks for the amend branch among
  the remote-tracking refs rather than asking GitHub. `approval up`'s preflight
  prints the same sentence on stderr and never refuses on it.
- **harness-version-unverified** — whether the harness binary hosting the
  PreToolUse hook changed since the log last saw a record from it (APRV-227).
  The only row that asks anything about a program outside this repository, and
  it asks the one way a log can: `<binary> --version` now, against the
  `harness_version` on the newest hook-written `task.registered` or
  `gate.bypassed`. Which harnesses to ask comes from the `approval hook <kind>`
  commands this checkout's `.claude/settings.json` and `.cursor/hooks.json`
  register. SKIP, named, for each of the three things that make a comparison
  impossible: no hook registered here, no record naming a version yet, or no
  such binary on `PATH`. FAIL when they differ, because an unverified change is
  precisely the state in which nobody has checked whether the gate still fires;
  the `fix` is the promptless self-test in `docs/claude-code-hook.md`, one
  supervised-class tool call, after which the row is green. PASS says only that
  the versions match — the field is self-reported (SPEC.md §11.1 invariant 4)
  and reduces nothing anywhere, so a match is not proof the hook fired. Since
  APRV-415 the row carries a second finding for one harness: a Hermes below the
  **fail-closed version floor** (a build at or after `main` `118984d7` of
  2026-09-20) FAILS, because `v0.21.3` ignores `fail_closed` silently and every
  broken hook on it proceeds. That half is read from `hermes --version` rather than
  from a record — Hermes prints its build stamp behind a non-ASCII separator the
  write boundary refuses, so no record can carry it — and it compares the build
  date and the upstream commit, because the two builds report the same semver.
- **live-draw** — whether a daemon is answering `supervised-live` draws for this
  log (APRV-208). SKIP when the policy declares no live class: no draw is ever
  made, and a missing socket is nothing. It FAILS in three shapes, all of them
  the operator's control not being in force — every action of that class gates
  to a human at 100% rather than at the declared rate, and the two are
  indistinguishable from inside the policy file. No socket at all; a socket
  every asker would refuse on sight (a foreign owner, or a mode that lets
  somebody else bind it); and, since APRV-282, a socket file that is there and
  REFUSES CONNECTIONS. That last one is why the row opens a connection and
  closes it again rather than stopping at a `stat`: a socket file is made by a
  bind and removed by an orderly shutdown, so the one state its presence cannot
  report is a daemon that died, which is exactly the state seen on 2026-09-05
  with a green row and a phone full of unconsumed taps. The detail names the
  file's mtime, because a leftover socket's last write is when its daemon was
  last alive, and the fix is `approval up`. PASS means the socket answered a
  connection, and it still asks the daemon NOTHING: no question is sent and no
  answer is waited for, so what the row reports is what an asker would conclude
  before it had said a word.
- **values-block** — whether the optional `approval-values` block of the policy
  file parses (APRV-238). Nothing else would ever report a broken one: a values
  block is guidance and not policy (SPEC.md §5.3, §11.1 invariant 10), so a
  malformed one changes nothing about what the policy says and deliberately does
  not appear in `approval policy check`, whose answer is the enforcement trace.
  Left there, a typo would silently mean the operator's stated values reach no
  agent while every gate keeps working perfectly. Absence is a PASS, in the
  words SPEC.md §5.3 fixes: a file with no block is an operator who has declared
  no values, which is a state and not a fault. The only FAIL is a block that is
  present and unreadable, and its fix names the code rather than proposing a
  repair, because what the block should say is the human's to write. The one
  exception is the block APRV-336 replaced (`version: 1` with a `wants` list):
  that is a correct document of the wrong vintage rather than a broken one, so
  the row's detail carries the loader's migration message and its fix names the
  three edits (fold `wants:` into `like:`, rename `responds:` to
  `communication:`, quote `version: "0.2"`) plus the re-attestation that the
  whole-file digest requires. The pass detail lists what the block declares,
  which are `love`, `like`, `dislike` and `communication` and nothing else.
- **checkpoint** — how this log stands against its own human-signed checkpoints
  (APRV-257), running the same check as `approval log verify --checkpoints`, so
  two implementations of "does this log's own signature contradict it" cannot
  come to different conclusions. SKIP when the policy declares no readable key:
  nothing was verified, and a check that could not look must never report a
  pass. FAIL on any refusal, because a signature that does not verify, or one
  naming a hash that is not the hash at that seq, is a human's key vouching for
  a chain this file does not carry, and that is the finding the whole mechanism
  exists to produce. PASS otherwise, INCLUDING when a checkpoint is due: the
  cadence carries a `fix` rather than a status, since a person who has not
  signed recently is not evidence of tampering, and a doctor that went red
  because somebody was on holiday is a doctor whose red people stop reading.
- **gate-organs** — which gate organs in this checkout carry no attestation of
  their CURRENT bytes (APRV-272). It never moves the exit code, by design. The
  enforcement for that fact is the CI-side protected-path guard, which fails the
  pull request; doctor's job here is to make the state visible BEFORE a pull
  request fails on it, so a human who has just hand-edited the settings file is
  told they owe an attestation while they are still at the terminal. A failing
  row would also be wrong on its own terms: an unattested organ breaks nothing
  on this machine, unlike an unattested policy, which makes every gated
  operation refuse. A checkout with no organ files at all is a SKIP, exactly as
  `harness-hook-wiring` treats the same absence.
- **sealed-keys** — whether a sealed-delivery private key is one `git add` away
  from publication, or already past it (APRV-285). `.approval/keys/` holds the
  X25519 private halves of sealed token delivery, one per request, 0600 in a
  0700 directory; the log is committed and carries only the ciphertext, so a
  committed key opens that action's `token_sealed` for anyone holding the
  history while the token is unspent and inside its TTL. Two questions, worst
  first, the same reading the vault and environment rows use. A key git already
  TRACKS is a FAIL, asked of `git ls-files` rather than of the working tree, so
  a key consumed and unlinked is still reported while it sits in the index. A
  key present in a store no `.gitignore` line covers is a FAIL naming the line;
  an empty or absent store with no line covering it is a SKIP that still names
  it, because the entry an operator needs is the one already there on the day
  they turn the `token_delivery: sealed` knob. SKIP outside a git checkout,
  where there is nothing to commit a key to. Neither fix deletes nor commits:
  `git rm --cached` for a key already in the index is named in the prose and
  left to you, along with revoking every action whose token is still unspent.
- **codex-hook-wiring** — whether this checkout's `.codex/hooks.json` carries
  the reviewed approval.md profile for both `PreToolUse` and `PostToolUse`: the
  exact `Bash|apply_patch` matcher, a direct synchronous `approval hook codex`
  command, and a `600` second outer timeout. A PASS establishes only those JSON
  bytes on disk. Codex trust, loading, and observed execution remain separate
  facts checked through `/hooks` and the bounded smoke test. TOML-only hook
  configuration, or JSON combined with `.codex/config.toml`, SKIPS because
  doctor does not interpret or merge the TOML hook tables. Malformed JSON
  FAILS; a different valid Codex hook profile SKIPS as undetermined rather than
  being called broken.
- **autonomy-alias** — which rules of this policy still write the deprecated
  bare `supervised` (APRV-335). The spelling parses as `supervised-retro` and
  every gate enforces it as one, so the row is never a FAIL and never moves the
  exit code: a red line over a spelling would be doctor going red over prose.
  The two PASS shapes are the whole row. Where some rule uses it, the detail
  names each one, in the order the loader's own notes name them, and the `fix`
  is `approval policy amend`, which owns the edit and the re-attestation that
  edit costs. Where none does, the detail says so plainly, which is the answer
  an operator wants before a future schema version drops the alias. A policy
  that did not load is a SKIP: it names no level at all, and its own failure is
  reported by the attestation row and by `approval policy check`.
- **pending-sign-off** — which protected files carry SPEC.md's
  `(Amended APRV-n, pending sign-off.)` marker with no `gate.path.signed_off`
  record over their current bytes (APRV-338). Informational and never a FAIL,
  for the two reasons `gate-organs` is: nothing on this machine is broken by
  unratified prose, and the enforcement that does bite is the CI-side
  protected-path guard. What the row buys is that the debt is visible at the
  terminal rather than discovered when a pull request fails. It reads the
  enumerated directories (`.`, `.github/workflows/`, `docs/`, `design/`) plus
  every path the policy's `protected_paths` names, keeps only what classifies
  `policy.edit` or a `policy.edit.*` sub-class, and reports a file whose current
  bytes ARE signed off as ratified rather than pending. The `fix` is
  `approval policy attest --path <p> --as human:<id>`, to be run after reading
  the file; a marker whose text was later granted through the gate should lose
  the suffix instead.
- **sender-mapping** — which approvers a channel whose senders the policy maps
  can still recognize (APRV-324). A SKIP where no approver declares a `senders`
  block, which is every installation before the key existed: decisions are
  recorded against the identity the deciding process was launched with, no
  channel enforces a mapping, and nothing is wrong. A FAIL where the policy
  maps senders for a channel and lists an approver on that channel with no id
  of their own there — that person's next tap is refused `sender-unmapped` and
  nothing is recorded, so the file says they may decide on a surface where they
  cannot. A PASS where every approver a mapped channel reaches carries an id
  there. The `fix` is `approval policy amend`, which owns the edit and the
  re-attestation it costs. The row reads the policy and nothing else: no log,
  no network, no credential, and it prints nobody's account id — the mapping is
  in a file the operator can open, and a health row is read over shoulders.
- **codex-auto-reviewer** — has anything other than this gate answered a
  question this gate exists to ask (APRV-378)? It reads
  `audit.question_preempted` and nothing else. A FAIL where one landed in the
  last 24 hours, naming the source, the question in the other party's terms and
  their verdict; a PASS where none did, mentioning any older ones; a SKIP where
  the chain did not verify. A PASS says the log holds no such record and NOT
  that a harness auto-reviewer is off: whether it runs is configuration this
  runtime cannot read, and a row written against a guessed configuration key
  would find nothing and report green, which is the worst direction a health
  check can fail in. The `fix` points at the harness's own configuration,
  because nothing here can turn another system's reviewer off.
- **daemon-identity** — which daemon id a daemon run against this log would
  write onto every record it appends, and whether the attested policy admits it
  (APRV-383). The id is `APPROVAL_DAEMON_ID` from this shell where it is set and
  otherwise `daemon-` plus the instance id the `keychain-scope` row names, so the
  two rows describe one gate. A FAIL where `APPROVAL_DAEMON_ID` is set to
  something that is not an id: a daemon started from this shell would be refused
  `daemon-id-invalid` on every append, so it would read, render and report while
  writing nothing, and the `fix` is that one variable. A loud SKIP where the
  attested policy's `daemons` list does not admit the id, naming what the list
  does admit — expected where the daemon for this log runs on another machine,
  which is the hosted case the key exists for, and wrong if that daemon is meant
  to be this one. A PASS where the list admits it, and where there is no list at
  all, which is every installation that never adopts the key. Being listed grants
  nothing beyond the ability to write: no verdict, budget, floor, draw or token
  reads the id. The row reads the policy and one variable's SHAPE, prints no
  value on any path, and asks no running daemon anything.



**`--json`** (one object on stdout):

```
{"ok":false,"checks":[
  {"check":"build-freshness","status":"pass","detail":"..."},
  {"check":"identity","status":"fail","detail":"...","fix":"..."}, …]}
```

`status` is `pass` | `fail` | `skip`. `fix` is present only when there is
something to do, and it always begins with a runnable command. `ok` is true when
no check failed; a skip does not make it false. Every check always appears, in
the order listed above.

`--root <path>` is TEST-ONLY: it points the build-freshness check at another tree
and moves no other check. Real invocations never pass it, because freshness is
judged against the installation this binary was loaded from, not against the
working directory. `approval up` and `approval daemon run` accept the same flag
for the same test-only reason, where it points the preflight's build-freshness
half at another tree.

## audit

Since APRV-127 the policy grammar splits `supervised` in two, and only one half
reaches this backlog. A `supervised-live` class puts a declared `live_rate`
fraction of its actions through the human gate BEFORE they run; those are
ordinary manual requests with ordinary grants and tokens, a person has already
answered them, and they are not drawn a second time for retrospective review. A
`supervised-retro` class — and the bare `supervised`, which is now a deprecated
alias for it, still parsed and removed in a future schema version (APRV-335) —
is what this page is about. `approval policy check` names the mode in its
final line and in `outcome.supervision`.

Supervised actions execute immediately and are audited afterwards. The daemon
samples a fraction of them (`audit.supervised_sample_rate`) into a backlog a
person works through; SPEC.md §12 calls the human's attention the audit budget,
and this is where it is spent retrospectively rather than before the fact.

There is no `approval audit sample`. Selection is the runtime's, derived as
HMAC-SHA-256 over the event hash with an operator-held secret named by
`audit.sampling_secret_env` and kept outside this repository. A verb that let a
caller sample — or decline to sample — an action of its choosing would hand the
party under oversight the control that exists to oversee it. Seeding from event
content alone is forbidden by SPEC.md §5.2 for the same reason: the agent
authoring the event controls that content and could search it until its action
falls outside the sample.

If no secret is configured, sampling is off and this backlog stays empty.
`approval audit list` reports that beside the backlog, because an empty backlog
means one thing when sampling is running and quite another when it is not.

## audit list

A review closes a sample only when it comes AFTER it in the chain and names the
same action. An earlier `audit.reviewed` is a review of an earlier sample, and
treating it as covering this one would silently empty the backlog — which is
exactly the failure a sampled-audit backlog exists to prevent.

The secret itself is never printed, never logged, and never returned by any code
path; `sampling.secret_env` is the variable's NAME, which the policy file already
carries in the open.

**`--json`** (one object on stdout):

```
{"ok":true,
 "sampling":{"enabled":false,"rate":0.1,"secret_env":"APPROVAL_SAMPLE_SECRET",
             "reason":"secret-unset"},
 "open":2,
 "samples":[{"seq":9,"ts":"...","action_key":"...","task":"...",
             "subject_seq":7,"reviewed_seq":null}]}
```

`sampling.reason` is null when sampling is running, and otherwise one of
`policy-unreadable`, `rate-absent`, `rate-zero`, `rate-invalid`,
`secret-env-unnamed`, `secret-unset`.

## audit review

`--note` is optional — unlike `execution resolve`, this event records only that a
person looked, and the runtime is not relying on the note for a fact it does not
otherwise have. Human-only: a runtime that could mark its own samples reviewed
would be a supervision backlog that empties itself.

No attestation is required, for the reason `execution resolve` states: review
records an observation, exercises no policy authority, authorizes nothing, and
spends no budget. A review blocked because a policy file was edited afterwards
would be a supervision backlog held open by an unrelated fact.

What it appends is `audit.reviewed`, naming the sample's action key and task, with
payload `{"subject_seq":<seq of the audit.sampled>,"reviewed":true,"note"?:"...",
"reaction"?:"disliked"|"indifferent"|"liked"|"loved"}`.
An action key with several open samples refuses `ambiguous-subject`.

**`--json`** (one object on stdout):

```
success  {"ok":true,"seq":11,"sample_seq":9,"action_key":"...","task":"...",
          "verdict":"ok","reaction":null,"obligation_seq":null,
          "actor":"human:alice"}
refusal  {"ok":false,"error":{"code":"...","message":"...","seq"?:N}}
```

`reaction` is always present in the JSON and is `null` when the reviewer gave
none, so a consumer can tell "no reaction" from "this build predates the field".
In the LOG the key is written only when it was given: an omitted reaction leaves
no key at all, and no reader substitutes `indifferent` for a person who said
nothing. `indifferent` is a thing somebody had to actually say.

`--reaction` is GUIDANCE and `--deny` is enforcement. Nothing in the runtime
reads a reaction: not routing, class matching, the sampler, budgets, token
minting, the gate window or execution (SPEC.md §11.1 invariant 10, pinned by
`tests/values-inert.test.ts`). It is recorded so a person's reading of an action
survives past the moment they had it, and so an agent can read back what the
operator thought with `approval feedback`.

Two rules keep the pair honest, both settled after the actor check and BEFORE the
log is read, and neither appends anything:

- `reaction-conflicts-verdict` — `--deny` with `liked` or `loved`. The two fields
  point opposite ways and only one of them is enforcement. A record carrying both
  reads afterwards as evidence of whichever half suits the reader, and reads to
  an agent as a denial being survivable when the operator is pleased. Say which
  one you meant.
- `note-required` — `loved` or `disliked` with a blank note. These are the grades
  an agent is most likely to act on and least able to interpret alone: "disliked"
  with no words says something happened and nothing about what. Blank is not a
  note. `liked` and `indifferent` demand none, because a one-tap signal that
  opens a form is a signal that gets switched off. The schema enforces the same
  rule at the write boundary, which is what makes it true of every record
  whatever surface wrote it; the verb refuses it too so the message names the fix.

A misspelled word is a usage error (exit 2) rather than a refusal or a default: a
`--reaction love` that silently became `indifferent` would put a word in the
reviewer's mouth in an append-only log.

`--deny` says the action should not have happened. It cannot undo it — the action
already ran, and a runtime that pretended otherwise would be lying to the person
who denied it — so what it does is oblige and record: a second event,
`reconciliation.required`, authored by `system:audit` and naming the action, its
class, this review, and the obligation the denial creates. `obligation_seq` is
that record's seq.

Which obligation is the runtime's derivation from the action's DECLARED
`reversible`, never the reviewer's choice: `true` obliges a revert THROUGH THE
GATE (`gated-revert`), and `false` or unstated records a policy-was-wrong finding
whose sanctioned response is tightening the class (`policy-finding`). Unstated
takes the second shape deliberately — obliging a revert of something nobody said
could be reverted would record an obligation that may be impossible to discharge,
and an impossible obligation is one that gets closed dishonestly.

`reversible` is self-reported, so it is worth being explicit about what it can
and cannot do. It selects the SHAPE of an obligation that exists either way; it
cannot remove one, delay one, or decide whether the denial happened. The only
thing a false `reversible: true` buys is the shape whose discharge this runtime
checks against the chain, which makes the claimant's own exit harder rather than
easier. The same reading applies to the irreversibility floor. By default it
keeps a `reversible: false` action out of `supervised-retro`; an attested class
rule may explicitly accept that consequence with `allow_irreversible: true`.
The field acts on the acting party's own claim, so it catches the honest
declaration and never the lie. What answers the lie is writing `manual` for the
class, which no declaration can loosen.

## audit obligations

The open reconciliation backlog: `reconciliation.required` records with no
`reconciliation.satisfied` after them. Reads a verified log and writes nothing.
The same projection `approval status` and `approval doctor` read, so the three
cannot disagree about what is outstanding — an unreconciled denial that nobody
can see is a "no" that changed nothing.

A satisfaction closes an obligation only when it comes AFTER it in the chain and
names its seq, by the same rule that governs a review closing a sample.

**`--json`** (one object on stdout):

```
{"ok":true,
 "open":1,
 "obligations":[{"seq":18,"ts":"...","action_key":"...","task":"...",
                 "class":"records.write","review_seq":17,
                 "obligation":"gated-revert","reversible":true,
                 "satisfied_seq":null}]}
```

## audit reconcile

Human-only, in code and in the event schema. A runtime that could close its own
obligations would be a reconciliation backlog that empties itself, which is
precisely the silence an unreconciled denial exists to break.

`--note` is required — unlike `audit review`, whose whole content may be "a
person looked", this record asserts that something was DONE, and a discharge
nobody described is one no auditor can check.

A `gated-revert` obligation additionally requires `--revert <action-key>`, and
the log must carry an `execution.completed` for that key. The runtime checks the
CHAIN rather than the claim: without it the verb refuses `revert-required` and
appends nothing. That is what closes the loop inside the log — the revert is
itself a side-effecting action, so it went through the gate too. A
`policy-finding` obligation has no such artifact (the sanctioned response is a
policy amendment, its own human ceremony with its own `policy.updated` record),
so there the note is the discharge.

No attestation is required, for the reason `audit review` and `execution resolve`
state: this record exercises no policy authority, authorizes nothing, spends no
budget, and mints no token.

**`--json`** (one object on stdout):

```
success  {"ok":true,"seq":24,"obligation_seq":18,"action_key":"...",
          "task":"...","class":"records.write","obligation":"gated-revert",
          "actor":"human:alice"}
refusal  {"ok":false,"error":{"code":"...","message":"...","seq"?:N}}
```

Refusals: `not-obliged` (no such obligation), `already-satisfied`,
`note-required`, `revert-required`, `actor-not-human`.

## execution

Two subcommands, for two states a human has to close by hand, and they are not
interchangeable.

A dangling execution is what a crash between `execution.started` and its outcome
leaves behind: the log says truthfully that the action began and that nobody
knows how it ended. `execution resolve` closes it.

An indeterminate execution is one whose side effect was ATTEMPTED and whose
outcome nobody knows (SPEC.md §10.4). `execution reconcile` resolves it, from the
relying party's evidence rather than from this machine's log.

Nothing in this codebase closes either automatically — an automatic
reconciliation would have to guess whether the email went out, and a guess
written into an append-only log is indistinguishable from a fact.

## execution resolve

`exit_code` is NULL, not 0 and not 127. Nobody ran anything and there is no code
to report; a fabricated exit code would read exactly like an observed one.
`attested_by_human` marks the difference for every reader and every projection.

`--note` is mandatory and non-empty: the event's entire value is the observation
behind it, and an unexplained human-attested outcome cannot be told apart from a
guess. Human-only — an agent closing its own dangling execution is the executing
party reporting on itself, which is the one thing the log exists not to accept.

No attestation is required: resolve records a fact a human observed, exercises no
policy authority, authorizes nothing, spends no budget, mints no token and
consumes nothing — the commitment was charged at authorization time, long before
the crash. A dangling execution left unclosable because a policy file was edited
afterwards would be a repair blocked by an unrelated fact.

**`--json`** (one object on stdout):

```
success  {"ok":true,"action_key":"...","task":"...",
          "event":"execution.completed","outcome":"completed","seq":7,
          "attested_by_human":true,"actor":"human:alice"}
refusal  {"ok":false,"error":{"code":"...","message":"...","seq"?:N}}
```

### execution resolve --dangling

The bulk form, for the pile rather than the one. It exists because of what a
pile costs: on 2026-09-05 `approval status` listed five dangling daemon advance
executions, the daemon refused one advance per tick naming one key each, and
they were closed by hand with five near-identical commands in a second terminal
window.

It decides nothing the single form would not. Human-only, one
`execution.completed` per key through the same compare-and-append,
`exit_code: null`, `attested_by_human: true`, and a mandatory non-empty note on
every record, generated rather than typed: what the note has to say is the
evidence the runtime showed and the operator agreed with, which is a sentence
retyping only makes less exact.

**What counts as proof.** A key is provable when it is one of the daemon's own
`daemon-log-advance-<from>-<to>` keys and a ref in this checkout carries the seq
that key names: a records branch, the trunk's remote-tracking ref, or a local
`refs/approval/advance/*` anchor, read through the same `publishedState` the
cadence and the `log-advance-cadence` doctor row read. Every other dangling
execution is UNPROVABLE, is listed with its own one-line command, and is left
exactly alone. An outcome nobody can demonstrate is a person's to go and look
at, and a bulk verb that guessed would write many guesses instead of one.

**One confirmation.** The list is printed, then a single `[y/N]`. Without a
terminal it refuses `dangling-stdin-not-tty` unless `--yes` is passed, the flag
a runbook uses after it has read the same list with `--json`. A declined answer
is `dangling-declined`, and neither refusal appends anything. `--class <class>`
narrows the list to executions whose `task.registered` declaration names that
class, so an operator can sweep `log.advance` without touching anything else.

Exit 0 when every provable key was closed, including when there were none to
close; exit 1 when an append was refused. A refused key does not stop the rest,
and each is reported under its own code.

**`--json`** (one object on stdout):

```
success  {"ok":true,
          "dangling":[{"action_key":"daemon-log-advance-1-13984","task":"...",
                       "class":"log.advance","seq":13980,"ts":"...",
                       "provable":true,
                       "proven_by":"refs/remotes/origin/records-log-2026-09-02",
                       "proven_seq":13984}],
          "resolved":[{"action_key":"daemon-log-advance-1-13984","seq":14903,
                       "proven_by":"refs/remotes/origin/records-log-2026-09-02"}],
          "unresolved":[],"attested_by_human":true,"actor":"human:alice"}
refusal  {"ok":false,"error":{"code":"...","message":"..."}}
```

An unprovable entry carries `"provable":false`, `"proven_by":null` and a `"fix"`
naming its own single-form command, and its key appears in `unresolved`. A key
whose append was refused appears in `unresolved` and in `failed` with the
refusal's own code, and `ok` is `false`.

## execution reconcile

Three things a log can say about an execution that did not simply complete, and
the whole of why this verb exists apart from `execution resolve`:

- **failed** — the attempt provably did not commit. The provider answered no, or
  the runtime never reached it. Retrying is safe.
- **dangling** — the runtime meant to watch an outcome and died first. Nobody
  knows what happened *here*, and looking at this machine settles it.
  `execution resolve` records what the looker saw.
- **indeterminate** — the side effect was ATTEMPTED and nobody knows whether the
  far side committed. Looking at this machine settles nothing: the evidence is
  the provider's console, inbox or ledger. This verb records what it showed.

An email adapter that times out mid-send used to be written down as `failed`,
which is the sentence that makes a retry look safe, and a retry against a send
that did happen is a second email. Idempotency keys only partly cover it: a
second request under a new key is perfectly legal.

INDETERMINATE IS A CUSTODY STATE. The token stays spent, the idempotency key
stays burned, the budget stays charged, and a re-run is refused
(`execution-indeterminate`). Refunding an attempt whose outcome is unknown would
be the runtime deciding the effect did not happen, which is the one thing nobody
here knows.

`--resolution executed|not-executed`, and nothing is inferred. The two are
separate closed values in the log rather than two readings of one sentence,
because everything downstream turns on which. `--note` is mandatory and non-empty
and is the EVIDENCE — which console, which message id — because an unexplained
resolution of an unknown outcome cannot be told apart from a guess. Human-only,
and the daemon never auto-resolves: an automatic reconciliation would have to
*guess* whether the email went out, and a guess written into an append-only log
is indistinguishable from a fact.

The appended `execution.reconciled` NAMES the `execution.indeterminate` record by
seq and never rewrites it. The original observation survives its own resolution,
so an auditor sees both the doubt and its answer.

Resolving `not-executed` re-opens the EFFECT, not this action. An
`idempotency_key` is the global identity of one side effect (SPEC.md §6.2) and a
used one is used, so the repair is to declare a fresh action and request that —
a new question with a new answer, which the reconciliation is what makes honest.
Recovery is never evidence that the provider did not execute.

**`--json`** (one object on stdout):

```
success  {"ok":true,"action_key":"...","task":"...",
          "event":"execution.reconciled","resolution":"executed",
          "indeterminate_seq":7,"seq":9,
          "attested_by_human":true,"actor":"human:alice"}
refusal  {"ok":false,"error":{"code":"...","message":"...","seq"?:N}}
```

Refusals: `not-indeterminate` (there is no unknown outcome here — a started
execution with no outcome at all is dangling, and `execution resolve` closes it),
`already-reconciled` (a person already answered, and neither record is
rewritten).

## channel

A channel is transport. It renders what the runtime derived and reports the
gesture a human made; it decides nothing, holds no state, writes no log line and
never sees an execution token. Every decision collected through a channel is
recorded by the same human-only gate `approval grant` and `approval reject`
call, with every rule — TTL, budgets, attestation, idempotency — applied
unchanged.

### Which rows a prompt shows is a policy decision (APRV-218)

Each channel ships a default set of rows. Telegram's is deliberately slim: the
`waiting … expires HH:MM UTC` line carries the TTL, so there is no separate
`ttl` row (APRV-143), six bookkeeping rows are off (`task`, `state`,
`provenance`, `requested_ts`, `payload_hash`, `chain`) and three health rows
render only when abnormal (`autonomy`, `budgets`, `attestation`, APRV-163). The
terminal and the page show everything, because they have the room.

That default fits one operator. `channels.<name>.prompt` in `APPROVAL.md`
replaces it, per channel, for `telegram`, `web` and `cli`:

```yaml
channels:
  telegram:
    prompt:
      rows: [class, command_breakdown, task, waiting]
      always: [budgets, task, chain]
      hide: [provenance, requested_ts]
```

Three keys, each doing one thing. `rows` is ORDER ONLY: the rows it names
render in that order ahead of every row it does not name, which keep their
default relative order behind them. It is never a whitelist, so a field added
by a later version cannot be lost to a list written before that field existed.
`always` raises a row's visibility, so a row that is abnormal-only or off by
default renders on every prompt. `hide` removes a row entirely.

The row names are the `ChannelRequest` member names: `action_key`, `task`,
`class`, `command_breakdown`, `protected_path`, `policy_diff`, `policy_load`,
`autonomy`, `provenance`, `state`, `requested_ts`, `waiting`,
`ttl_remaining_ms`, `payload_hash`, `attestation`, `budgets`, `chain`,
`token_delivery`, `est_cost_usd`, `gloss`, `summary`, `rationale`,
`confidence`.

**A layout chooses among rows the approver READS; it cannot touch what the
approver SIGNS.** Three things are out of its reach entirely. The canonical
payload block (SPEC.md §9) is not a row: it is rendered verbatim, and it states
the payload bytes, the renderer version, the class, the kind and the bound
`payload sha256` whatever the layout says. The buttons are not a row, because a
prompt with no way to answer it is not a prompt. And the computed/claimed split
is a property of the field rather than of the layout: `rows` decides the order
rows are considered in, a channel partitions by `TaggedField.kind` afterwards,
so a claimed line reordered to the front is first among the CLAIMED lines and
never above the computed heading.

Six rows are required for a decision and may be reordered but not hidden:
`action_key`, `class`, `command_breakdown`, `protected_path`, `policy_diff` and
`policy_load`. `payload_hash` is not among them, because the bound hash is
stated inside the canonical block on every channel, so hiding the row removes a
duplicate rather than the binding — which is exactly what Telegram's default
already does.

The anomaly mark (`!! `) stays a statement about the VALUE. A row forced on
with `always` carries it only when the value is in fact the reason to look, so
`always: [budgets]` gets a quiet budget line on an ordinary request and a
shouted one when a ceiling is in play.

Fail soft on absence, closed on invalidity, the split every other policy key
keeps. No `prompt` block — and a policy that failed to load at all — means the
rows the channel ships, because a layout is not a permission and an unrelated
typo in a class rule must not silently redecorate a phone screen. An unknown
row name, a required row in `hide`, a row named by both `always` and `hide`, or
a key the block does not define fails the WHOLE policy at load with a
machine-readable keyword (`prompt-row-unknown`, `prompt-row-required`,
`prompt-row-conflict`, `prompt-key-unknown`, `prompt-block-shape`), and every
class resolves to `manual` until the file is repaired. The check runs for every
channel name, including the unknown ones the schema admits as free-form
objects, so a layout is validated wherever it is written.

Nothing here teaches a channel anything about the log. Every row a layout can
turn on was already on the `ChannelRequest`, and `--json`, `approval queue` and
the web page carried it all along; rendering stays a pure function of
(request, layout).

## channel cli

**The rendering convention (SPEC.md §9).** Every displayed field carries a
marker in the first column, and the marker is the whole point:

```
[computed] class            communicate.email.external      (log)
[claimed]  summary          chase invoice 41                (agent:drafter)
```

`[computed]` means the RUNTIME derived it — from the verified log, the attested
policy, the budget evaluator, the payload bytes, or arithmetic on the display
instant — and the parenthetical names which derivation. `[claimed]` means the
PARTY UNDER OVERSIGHT wrote it, and the parenthetical names the author. Claimed
fields are indented under their own heading. A claim may raise your scrutiny; it
is never evidence, and rendering one with the visual authority of a computed
field is a conformance failure for a channel, not a styling preference.

**The full payload (SPEC.md §10.4).** For a manual action the exact bytes the
approval binds to are printed verbatim inside delimiters, never mixed with the
agent's summary. The material comes from the payload store or `--payload-dir`,
and is hash-checked against the recorded binding before it is shown, so what is
inside the delimiters is what the execution token will spend. A manual request
with no material is skipped and reported on stderr — visibly, because a request
missing from a queue is a request nobody will approve.

**Two reading aids, and they are not the same kind of thing (APRV-197).** The
first is `command_breakdown`: for a multi-segment command the classifier's own
parse of the bound bytes, rendered `[computed] … (classifier)`, always present
and costing nothing. The second is the model gloss, one sentence from an
operator-selected local CLI, rendered in the CLAIMED block and labelled with
its provider and requested model as unverified. Claude with model `haiku` is
the compatible default. Select Codex with an explicit model; the runtime never
falls back to another provider or model:

```sh
approval channel cli --gloss --gloss-provider codex --gloss-model gpt-5.4-mini
approval channel telegram listen --gloss-provider codex --gloss-model gpt-5.4-mini
approval up --gloss-provider codex --gloss-model gpt-5.4-mini
```

On `channel cli` the gloss remains opt-in behind `--gloss`, because inference
was measured at 10 to 15 seconds per request on the machine it was built on
and here that is spent while a person waits at a prompt. Provider and model
selection alone does not enable it on this surface.

The push channel makes the opposite choice, and for the same reason read the
other way: on `channel telegram listen` and `up` the gloss is ON by default,
with `--no-gloss` to drop it. The phone is where an approver meets a request
they did not watch being made, and the seconds are spent inside a dispatch cycle
that is already waiting on the network, blocking nobody.

Every provider subprocess receives the APRV-207 scrubbed environment, removing
credential-bearing `APPROVAL_*`, `TELEGRAM_*` and `VAULT_*` variables and the
vault passphrase. Nonsecret runtime variables and each CLI's authentication
remain.

The Codex runner invokes `codex exec` with the active saved CLI authentication;
it does not choose or enforce a billing method. A ChatGPT login uses the Codex
allowance included with that ChatGPT plan. An API-key login is billed through
the OpenAI Platform account at standard API rates. See the official Codex
[authentication](https://learn.chatgpt.com/docs/auth) and
[non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
documentation. `codex login status` reports the active authentication method.

The Codex runner uses verified controls in the installed CLI: an empty temporary
working directory, read-only workspace permissions, command network disabled,
ephemeral history, ignored user configuration and project rules, version-specific
host skill-discovery suppression, and selected known tool and integration
features disabled. Codex does not expose a universal empty-tool switch.
Host-managed tools and global base instructions may still exist, and the CLI
may maintain its saved authentication state. This Codex path is unavailable on
Windows because its bounded process-group termination cannot be guaranteed
there. The integration targets Codex CLI 0.152.1; later CLIs must continue to
accept these isolation controls.

All providers share a 20-second timeout, an 8,192-character input cap and a
200-character rendered-output cap. The Codex supervisor also drops stdout above
64 KiB. It suppresses the known startup warning caused by the version-specific
host skill control, while an emitted error event, unsafe or malformed output,
non-zero exit or timeout still drops the gloss.

The gloss is never load-bearing: it is attached at render time to a request the
tagger has finished building, the payload hash does not cover it, the log never
records it, and no code path branches on what it says. Every failure of the
subprocess — missing binary, non-zero exit, empty output, exceeding the timeout —
resolves to the line simply being absent. Absences are COUNTED and reported on
stderr at the end of the walk, so a chronically broken subprocess reads as a
broken subprocess rather than as a feature that was never built.

**Identity is declared, not proved.** `--as`, else `APPROVAL_HUMAN`. The trust
boundary is the local machine: a decision recorded here proves that someone with
local control answered, not who. Missing or non-human identity on the deciding
path is a usage error, refused before anything is rendered.

Without a TTY, and always with `--json`, the queue is printed and the command
exits 0 without reading stdin. It cannot hang a pipeline, and it records nothing.

The full payload is printed verbatim inside delimiters:

```
--- BEGIN FULL PAYLOAD (bound sha256 <64hex>) ---
{ … }
--- END FULL PAYLOAD ---
```

A manual request whose material nobody holds is SKIPPED and reported on stderr. A
reject demands a note, and a grant prints its single-use execution token once.
`--payload-dir` takes one JSON file per action key, `<key>.json` or its
percent-encoded name; unset, the bytes come from `.approval/payloads/`. Either way
they are hashed and checked against the request's recorded `payload_hash`, and
material that does not match is refused rather than rendered.

**Which rows this walk shows** comes from `channels.cli.prompt` in the policy;
absent, the terminal shows every row the request carries, computed identity and
authority first, claimed persuasion last. See "Which rows a prompt shows is a
policy decision" above. `--json` is unaffected: it holds the tagged queue
verbatim whatever the layout says.

**`--json`** (one object on stdout):

```
{"ok":true,"channel":"cli","interactive":false,
 "pending":[{"action_key":{"kind":"computed","value":"task-042:chaser",
   "source":"log"},
   "summary":{"kind":"claimed","value":"chase invoice 41",
     "author":"agent:drafter"}, …}],
 "skipped":[{"action_key":"...","code":"payload-unavailable",
   "message":"..."}]}
```

`pending` holds the TAGGED requests verbatim, so a machine reader sees the same
computed/claimed split a human does, and is `[]` for an empty queue.

## channel web

**Binds 127.0.0.1 and nothing else.** The loopback host is hard-coded, and there
is no flag, option or environment variable that widens it. That is not an
oversight: this server has NO AUTHENTICATION, so the loopback interface IS the
access control. A `--host 0.0.0.0` would turn "anyone with local access can
approve" into "anyone on this network can approve", from a flag that reads like
a convenience.

**No auth in v0.1 — the trust boundary (SPEC.md §11).** This page authenticates
nobody. Every decision is recorded against the actor from `--as` /
`APPROVAL_HUMAN`, so what it proves is "someone with access to this machine
answered", never "that specific person answered". The same caveat is printed in
a banner on the page, because the page is where the human is looking. CSRF:
there is no token in v0.1 — there is no session to protect, and anything that
can open a socket to the port can POST directly. A best-effort same-origin check
refuses clearly cross-origin POSTs (403); it is a speed bump, not a control, and
is flagged for review in the source.

Every value — claimed fields and payload bytes especially — is HTML-escaped:
they are agent-authored, and they are this page's entire injection surface.

**Batching (SPEC.md §10.3, B7).** The log never batches: each member gets its own
`approval.granted` / `approval.rejected` carrying the batch's delivery id. A
selection that would hide one member's full payload behind another is refused
(`batch-forbidden-mix`) with nothing recorded. A reject needs a note, batch or
not, and the requirement is enforced on the server (422).

**The execution token is shown on the page, once.** It is never written to the
log (which holds only its SHA-256), never put in a URL, and never shown again.
This differs from the Telegram channel, which refuses to put a token in a chat:
that transcript lives on someone else's servers, this page is served over
loopback to the person deciding, right now, and is persisted nowhere.

**Which rows the page shows** comes from `channels.web.prompt` in the policy;
absent, the page shows every row the request carries. See "Which rows a prompt
shows is a policy decision" above. The canonical payload region and the
CLAIMED/computed split are beyond a layout's reach here as everywhere.

`--port` precedence is `--port`, then `channels.web.port` in the policy, then
4680. `--as` is required at startup: this page exists to record decisions, so a
server whose buttons could not record one is refused before the socket is bound
(exit 2). No JavaScript is required, and batching is one gesture over a ticked
set while the log still records one event per member.

**`--json`** (one object per line on stdout):

```
{"event":"listening","channel":"web","url":"http://127.0.0.1:4680/",
 "host":"127.0.0.1","port":4680,"actor":"human:alice"}
{"event":"stopped","notified":3,"views":7,"decisions":2,"refused":1}
```

## channel telegram

Identity is config-declared (SPEC.md §11). This channel does not authenticate
the person who taps a button: it checks that the callback came from the
configured chat, and records the decision against the human actor this process
was started with (`--as` / `APPROVAL_HUMAN`). The guarantee is "someone with
access to that chat, on a runtime configured by someone with local control,
approved" — not "that specific person approved". Anyone in the chat can approve
as the configured actor, so the chat's membership is part of your trust
boundary. Use a private chat with the bot. Cryptographic identity is future work.

Configuration is environment-only (SPEC.md §5.1): `APPROVAL.md` carries the
variable NAMES, never a token and never a secret, and there is no flag that
would put a bot token into a shell history or a process listing.

## channel telegram listen

This starts the standalone Telegram component. For normal operation, use
[`approval up`](#up), which also runs the daemon. Do not run this listener beside
`up` or another listener polling the same bot, even for a different policy
project: competing `getUpdates` calls produce Telegram HTTP 409.

A bot whose updates go to a webhook cannot be long-polled at all, so this verb
and `approval up` refuse `webhook-registered` in the same preflight that asks
`getMe`, naming the origin that holds it. That preflight also takes this gate's
transport lease (`.approval/daemon/telegram-transport.lock`), so a second
listener or a webhook runner started in the same project refuses
`telegram-poller-running` naming the pid that holds it, rather than both
processes putting every request on the phone under their own nonce. See
[`channel telegram webhook`](#channel-telegram-webhook), which is the other
transport and removes both its registration and its lease when it exits.

**Delivery is per cycle, not only at startup.** Before every `getUpdates` the
listener re-derives the pending queue from the verified log and sends whatever
it has not already sent, so a request appended while this listener is running
reaches the phone on the next cycle without a restart. Decided and TTL-lapsed
requests fall out of that derivation and are never sent. A send that fails
leaves the request undelivered and is retried on every later cycle, with no
attempt limit — an unreachable Bot API must not turn into a pending request
nobody sees — though the stderr warnings thin out after a few consecutive
failures for the same request. A failure during the STARTUP send still exits
non-zero, so a mistyped token or chat id is immediate.

**One question at a time, by default** (`channels.telegram.delivery: paced`). A
start with several requests pending sends one summary line — how many are
waiting, how long the oldest has waited, which classes they are — and then the
OLDEST request with its buttons. Nothing else. The next request goes out on the
first cycle after the shown one is decided (at any surface: a button here, the
terminal channel, a withdrawal, an expiry), skipped, or passed over. The summary
is sent again whenever the pending set has grown while nothing was in front of
you, so a queue that fills up while you are away still says so.

Three bot commands drive it. Type them in the approver chat; a message from any
other chat is ignored, and an unrecognised `/command` is counted and not replied
to.

| Command  | What it does |
| -------- | ------------ |
| `/queue` | Replies with the summary and a numbered list of every pending request (action key, task, class, age), marking the one this listener has selected. Derived from the verified log at reply time, and it works while a request is selected. |
| `/skip`  | Selects the next request; the skipped one goes to the BACK of this process's order and comes round again after the rest, with a fresh card when it does. |
| `/next`  | Selects the next request; this process does not offer the passed-over one again, and sends no further card for it. |

**None of the three decides anything.** They have no path to the gate: a
decision is a button, because a button carries the nonce and action reference
that bind an answer to the bytes you were shown, and a typed word carries
neither. `/skip` and `/next` leave the message already in the chat live, its
buttons still deciding the same request, so passing over a question never takes
it away from you.

**`/queue` is a list, and it says so** (APRV-256). The reply carries no decision
buttons of its own, and it names no position for the ones it points at: a
request is decided on its own approval card, wherever that card has ended up in
the chat. The marker on the selected line reads `selected — card sent earlier`,
because that is the whole of what the listener knows. Delivery bookkeeping
records that a send returned success; the Bot API never reports that a message
is still there, and a card can be deleted, buried, or lost with the chat
history. So the reply states prior delivery and stops, rather than telling you
to tap something it cannot see.

**When you cannot find the card, `/skip` is the recovery.** It puts the request
at the back of the order and lets the next one through. Typing it decides
nothing, the request stays pending in the log, and a fresh card goes out on a
later listener cycle once the requests ahead of it have had their turn (a cycle
can run a little long while a gloss is being written; see `--no-gloss`).
`/next` is the opposite trade and not a resend: this process moves past the
request, stops offering it, and sends no new card for it, though the copy
already in the chat keeps its buttons. With nothing selected at all (before the
first dispatch, or right after a decision), the reply says so and promises the
next card on an upcoming cycle, and an empty queue says only that it is empty.

Pacing withholds attention, never the queue: every request stays pending in the
log whether or not it has been shown, `approval queue` and `/queue` list them
all, and nothing expires sooner for having waited its turn. Digest grouping
still applies to the request being shown, so a set of similar requests is one
thing to read.

**The prompt is slim on purpose, and `channels.telegram.prompt` changes it.**
No `ttl` row (the `waiting … expires HH:MM UTC` line is the TTL, stated as the
instant a reader acts on), no `resolved by`, `payload sha256`, `requested`,
`chain`, `task` or `state` row, and `autonomy`, `budgets` and `policy` only
when they are abnormal. An operator who wants the budget line on every prompt,
or the task id always visible, writes `always: [budgets, task]` under
`channels.telegram.prompt`; `hide` drops rows and `rows` reorders them. Every
one of those fields stayed on the request all along, so `--json`, `approval
queue` and the web page always showed them. See "Which rows a prompt shows is a
policy decision" above for what a layout may not touch.

`channels.telegram.delivery: burst` restores the pre-APRV-216 behaviour: every
pending request this process has not sent yet, on every cycle, behind the
re-delivery banner. Bot commands are not read in that mode. The listener still
asks Telegram for `message` updates, because a review card's note prompt (below)
collects the human's words as a reply; a message that is not such a reply is
ignored under `burst`, exactly as an unrecognised `/command` is. As
`setup channel telegram` already says, stop the listener before running it —
two processes long-polling one bot compete for the same updates.

A callback from any chat other than the configured one is ignored: counted as an
anomaly, answered with a refusal, never turned into a decision and never written
to the log. A second tap on an already-decided request is refused
`already-decided` by the gate.

**Delivery bookkeeping is in memory only** (channels hold no state, §10.3), and
so are the paced order and the request currently shown. A restarted listener
re-derives the pending set from the verified log and shows the oldest again
(under `burst`, re-sends everything still pending). What a crash costs is your
place in the walkthrough and a duplicate message, never a pending request nobody
is shown; an approval that depended on a channel's memory would not be an
acceptable trade.

**The execution token is printed on this terminal's stdout and is never sent to
Telegram.** A chat transcript is stored on someone else's servers, backed up to
phones, and readable by anyone later added to the chat — it is not a credential
store. So the person who taps Approve on their phone does not receive the token;
the operator running this listener does.

**Reject collects no reason.** An inline keyboard has no text input, so a
rejection is recorded with the note "rejected via telegram (callback `<id>`)".
Use `approval reject --note` when the reason matters. (A ForceReply flow is a
follow-up, flagged rather than silently dropped.)

**Similar pending requests arrive as one digest.** A burst of same-shaped manual
actions used to be one message each, which turns the chat into a notification
hose. Requests pending in the same poll cycle that share a class, an origin task
and requester, and a payload shape (a shell command groups by its `argv[0]`) are
now delivered together: every member's full prompt and full payload first, in
its own messages and with no buttons, then one trailing digest message carrying
a line per request and the keyboard — Approve/Reject per numbered request, plus
an "all" row.

The payloads are always above the buttons, so no gesture can cover bytes that
were not on screen. A group that cannot be rendered whole falls back to one
message per member (the previous behaviour), a group larger than eight becomes
several digests, and a set §10.3's B7 refuses is never presented as a set at
all. The failure direction is always more messages.

An "all" tap is N separate decisions. The runtime records one
`approval.granted` / `approval.rejected` per member through the same
compare-and-append path, each bound to its own action and payload hash, each
carrying the shared batch delivery id: the log never batches. A member the gate
refuses (already decided, expired, withdrawn) appends nothing and does not stop
the rest, and the toast says how many landed. Annotation is per member too: a
decided, expired or withdrawn request marks its own line and loses its own
buttons, so a partially decided digest shows mixed state.

**The retrospective backlog arrives here too** (APRV-299). The daemon draws
supervised actions for after-the-fact review (`audit.sampled`, SPEC section
5.2), and until this the only place to answer one was `approval audit review` in
a terminal — so sixty of them sat in `QUEUE.md` while the phone showed nothing.
Each `audit.sampled` with no later `audit.reviewed` now arrives as a **review
card**.

A card is not a prompt and says so. Its headline is `REVIEW — THIS ALREADY RAN`,
it carries no payload region and no approve button, and it accepts no token: the
action has happened, and a card offering an approve would present a settled fact
as a live authorization. What it carries is the same rows a prompt would show
for the same action — class, the command breakdown, task, the agent's claimed
summary, the model gloss where one is attached — plus two the card adds: `ran
at` (the `execution.started` the sample named) and `verdict` (that the runtime
allowed this without asking, which autonomy said so, the rate it was drawn at,
and how the log says it ended). Everything computed is derived from the verified
log, the payload store and the classifier; the claimed rows sit under the same
"NOT verified by the runtime" heading a prompt gives them.

Six buttons, bare emoji and no words (APRV-302), in two rows: the verdict on the
first (✅ OK, 🛑 Deny) and the grade on the second, worst to best (👎 disliked,
😐 indifferent, 👍 liked, ❤️ loved).

| Tap | What is recorded |
| --- | --- |
| ✅ | `audit.reviewed` with verdict `ok` and no reaction. |
| a reaction | verdict `ok` and that grade — a reaction alone implies OK. |
| 🛑 once | **Nothing.** It arms the card, which says `DENY ARMED` on itself. |
| 🛑 twice | verdict `denied`, and the reconciliation obligation it opens is named on the reply. |
| a reaction with deny armed | verdict `denied` with that grade. |

The card does not print this table under itself. It used to, and the paragraph
of rules pushed the rows a review is actually about off the first screen for a
reader who had read them on the card before. The two things a tap could get
wrong say themselves: the first 🛑 is answered `Deny armed — nothing recorded`
and puts `DENY ARMED` in the card's own headline until it is spent, and a grade
that wants words sends the prompt that asks for them.

Deny takes two taps because a retrospective denial cannot undo anything: what it
does is open an obligation a human must later discharge (SPEC section 5.2), and
a gesture with that consequence should not be one thumb-width from a grade. The
arming is process memory and appends nothing; losing it to a restart costs a
tap.

Every other review tap is answered `Heard — recording your review. The card will
say what the log recorded.`, its own toast, because a request card's `Heard —
deciding` would tell a reviewer something was pending when nothing is. Like that
one it claims only that the tap arrived: at the moment it is sent nothing has
been appended, and a refusal below may mean nothing ever is.

`loved` and `disliked` ask for the human's own words first. The bot sends a
reply prompt, nothing is appended until the reply arrives, and a blank one is
refused `note-required` — an inline keyboard has no text input, so the note is
collected as a reply message and bound to its card by the message id the
listener issued. A denied review that says `liked` or `loved` is refused
`reaction-conflicts-verdict` before anything is written, and no note is asked
for: the two fields say opposite things about one action. Every refusal in
`audit_refusal_codes` reaches the card as itself — the code on its own line, the
message under it — and a refused tap leaves the buttons in place, because the
reviewer has to be able to say which half they meant.

Every append goes through the same `reviewSample` that `approval audit review`
calls, recorded against the human identity this listener was configured with
(`--as` / `APPROVAL_HUMAN`), never anything the callback carried. So `approval
feedback` shows a reaction given on a card exactly as one given at a terminal:
same record, same `human:<id>`, same everything.

**Review delivery is paced in both modes.** A summary line first (`N awaiting
review — oldest ran …`) and then one card, and never while a request card is in
front of you: a pending request is somebody waiting, a sample is work that has
already finished. `/queue` lists the review backlog under the pending one;
`/skip` sends the shown card to the back of the review order and a fresh card
comes round later; `/next` passes over it and sends no further card. Neither
decides anything, and a card you never see, scroll past, or lose to a restart
leaves the sample exactly where it was: open, listed by `approval audit list`,
and reviewable with `approval audit review <seq>`. Nothing in this channel can
empty the backlog, which is the property a sampled-audit backlog exists to have.

**A refused gesture leaves a record (APRV-355).** When the policy maps senders,
a checkpoint signature or a review from an account the attested policy names
nobody for is refused before any verb runs, and since this change the attempt is
recorded: one **`audit.gesture_refused`**, with a `system:gate` actor, the
channel, and a payload carrying `gesture`
(`checkpoint-signature`, `review`, `review-note`), `code`
(`sender-unmapped`, `sender-ambiguous`, `sender-key-unavailable`,
`policy-not-attested`), the refusal
`message`, the observed `sender`, and `actor` only where the runtime could name
a person. Under a keyed mapping (APRV-370) the `sender.id` is the digest rather
than the account, and `sender.hashed` is `true` beside it.

```
{"event":"audit.gesture_refused","actor":"system:gate","channel":"telegram",
 "payload":{"gesture":"checkpoint-signature","code":"sender-unmapped",
 "sender":{"channel":"telegram","id":"5551234567"},"message":"…"}}
```

It exists because the only refusal record before it,
`audit.decision_refused`, requires an `action_key` and a `decision` of grant,
reject or revoke, and a signature or a review has neither; writing one there
would mean inventing both. The record is audit tier in the strict sense: it
authorizes nothing, settles no request, charges no budget, is not sampled, and
no enforcement path reads it. `approval log tail` and `approval log export`
show it like any other record. Nothing about the refusal itself changed — no
signature is appended and no review is recorded — and a listener whose policy
maps no senders never reaches this path at all.

**A question answered by something other than the gate leaves a record
(APRV-378).** Codex's app-server can resolve an approval with a model call
before `approval codex bridge` is asked, and disclose it afterwards through an
`item/autoApprovalReview` notification. The bridge stops the session on one
(`bridge-auto-reviewer-active`), and it appends exactly one
**`audit.question_preempted`** first, through the same append path as every
other record:

```
{"event":"audit.question_preempted","actor":"system:gate",
 "payload":{"source":"codex-auto-reviewer","verdict":"accept",
 "question":{"id":"item_01H9","method":"item/autoApprovalReview/completed",
 "thread":"thread_7f2","turn":"turn_3"}}}
```

`source` is a closed set naming who answered, so the next system that does this
gains a member rather than a type. `question` is the other party's own
identifiers, because a record about their decision has to name it in their terms
or a reader cannot go and find it on their side. `verdict` is their word
verbatim and is ABSENT when the disclosure stated none: a record that said
`accept` by default would be this runtime inventing somebody else's decision.

The record is audit tier in the strict sense: it authorizes nothing, settles no
request, charges no budget, is not sampled, and no enforcement path reads it.
`approval log tail` and `approval log export` show it like any other record, and
`approval doctor`'s `codex-auto-reviewer` row reads it: fail when one landed in
the last 24 hours, pass otherwise, and a pass says the log holds no such record
rather than that any auto-reviewer is off. Nothing on this machine can say the
latter, which is why the bridge probes (APRV-364) instead of reading a setting.

**A settled request stops looking live.** Every terminal state the listener
observes for a message it sent edits that message: the text becomes the outcome
(`✓ APPROVED`, `✗ REJECTED`, `✗ REVOKED`, `✗ EXPIRED`, `WITHDRAWN`) with the
action key, who decided, when, and the record's seq, and the buttons go in the
same call. A tap annotates immediately; a decision taken at the CLI or on the web
queue, a revocation, and an expiry the daemon appended are picked up on the next
poll cycle, which re-derives every delivered message's state from the verified
log. The edit is best effort — a failure is a stderr complaint, never a blocked
decision — and an annotation never carries the execution token.

The bot token and chat id come from the environment and the policy names the
variables (`channels.telegram.token_env` / `chat_id_env`, defaulting to
`APPROVAL_TG_TOKEN` and `APPROVAL_TG_CHAT`). There is no flag for either value.
Each message carries the computed fields, the agent's claimed fields under their
own heading, the full payload verbatim, and an inline Approve/Reject keyboard. The
loop survives the network: timeouts, dropped sockets and 5xx are counted,
complained about on stderr, and retried with a doubling backoff.

**`--json`** is one object per line on stdout, because a listener is a stream
rather than a query:

```
{"event":"notified","action_key":"task-042:chaser","delivery_id":"41"}
{"event":"annotated","action_key":"task-042:chaser","delivery_id":"41",
 "outcome":"granted"}
{"event":"decision","action_key":"task-042:chaser","decision":"grant",
 "ok":true,"seq":7,"state":"granted","token_issued":true}
{"event":"decision","action_key":"...","decision":"grant","ok":false,
 "code":"already-decided","token_issued":false}
{"event":"review_offered","sample_seq":12,"action_key":"task-042:draft",
 "delivery_id":"57"}
{"event":"review","ok":true,"seq":19,"sample_seq":12,
 "action_key":"task-042:draft","verdict":"ok","reaction":"liked",
 "obligation_seq":null}
{"event":"stopped","notified":1,"updates":1,"decisions":1,"pollErrors":0,
 "anomalies":{"foreign-chat":0,"malformed-callback":0,"unknown-callback":0,
 "key-mismatch":0}}
```

The raw execution token is never in the JSON stream.

## channel telegram webhook

The same channel, the other arrival (APRV-424). `listen` holds a socket open
against `getUpdates` for as long as the gate exists, which needs one
always-running process per bot and forbids a second poller on the same token.
This registers a URL with `setWebhook` and serves the callback, so Telegram
posts each update as it happens and a host that sleeps between requests can run
a gate.

**Only the arrival changes, and that is the whole claim.** The pending queue is
re-derived from the verified log every cycle by the same `dispatchPending`. The
handlers are the same four function objects `listen` registers. A tap becomes a
decision through the same `handleUpdate`, the same `callback_query.from.id`
reading, the same `approvers.<id>.senders` resolution, the same
`recordChannelDecision` and the same annotate-after-decision edit. There is no
second decision path and no second copy of the sender mapping:
`tests/telegram-webhook.test.ts` drives one callback through both transports and
compares the records the log ends up holding, field for field.

### The secret, which is the whole of the authentication

`APPROVAL_TG_WEBHOOK_SECRET` is REQUIRED and is read from the launch
environment, never from a file in the tree (SPEC.md §11.1 invariant 7, the rule
`approval serve`'s two credentials follow). It is Telegram's own `secret_token`:
set on `setWebhook`, echoed on every delivery in the
`X-Telegram-Bot-Api-Secret-Token` header, compared here in constant time over
SHA-256 digests.

A webhook URL is a public endpoint, and nothing in a request body could tell a
delivery from a forgery — a self-reported field never reduces scrutiny (§11.1
invariant 4). So the header is checked FIRST, before the path, the method and
the body, and a post without the matching value is refused with its own code,
counted, and reported on stderr. **A refusal is never a decision, and it appends
nothing to the log.** That is the rule `TELEGRAM_ANOMALY_KINDS` states for
ignored callbacks, and it binds harder here: an endpoint the internet can reach
that could append would be an endpoint anyone could use to pad the record a
human is asked to trust.

The value is refused at startup when it is unset, shorter than 24 characters, or
holds a character outside Telegram's `A-Z a-z 0-9 _ -`. It appears in no policy,
no log, no record, no message and no error line: the channel redacts it from
everything that leaves it, exactly as it redacts the bot token.

| refusal | what happened |
|---|---|
| `webhook-secret-mismatch` | no `X-Telegram-Bot-Api-Secret-Token`, or not the registered value |
| `webhook-duplicate-secret-header` | more than one of that header; malformed, and not resolvable by choosing |
| `webhook-malformed-request` | the request line and `Host` header do not form a URL (400) |
| `webhook-unknown-path` | a path this process does not serve (404) |
| `webhook-method-not-allowed` | the right path, the wrong method; Telegram POSTs |
| `webhook-body-too-large` | over 256 KiB; drained before the refusal is written |
| `webhook-body-unreadable` | the body could not be read off the socket, or is not JSON |
| `webhook-not-an-update` | JSON that is not an Update object |
| `webhook-transport-conflict` | this channel is already receiving updates by long poll |
| `webhook-handler-failed` | the channel threw; the log is what says what was recorded |

Startup refuses in its own vocabulary before anything binds:
`webhook-secret-missing`, `webhook-secret-weak`, `webhook-secret-charset`,
`webhook-url-missing`, `webhook-url-insecure`, `webhook-url-port`,
`webhook-url-userinfo`, `webhook-path-invalid`, `webhook-path-mismatch`,
`webhook-cycle`, and `webhook-registration-failed` for a `setWebhook` the Bot
API turned down (its status and its own description, scrubbed of the token and
the secret), plus every `channel telegram listen` refusal, which this verb
inherits because it needs the same bot token, chat, identity, log and policy.

Four of those are the review's, and each one closes a start that used to
succeed and then not work:

- **`--path` must be the url's own path.** `telegram/webhook` with no leading
  slash, or `/hook/` against a `--url` ending `/hook`, registered cleanly and
  then answered every real delivery 404 after verifying its secret. `--path` is
  an explicit restatement of the url's path and nothing else; rewriting belongs
  in the proxy in front of this process.
- **`--url` may not carry userinfo.** `https://user:pw@host/hook` is a
  credential on a command line. It is refused, never stripped.
- **The bind port may not be 0**, and must be inside 1..65535. Port 0 asks the
  kernel for an ephemeral port, and this transport is a fixed public url
  forwarded to a fixed local address: a receiver on a port nobody registered
  verifies nothing and answers nothing.
- **Every line that prints the url prints its origin and a redacted path**, in
  the start-up banner, in `webhook_started` and in refusals: with two segments
  or more the first is kept and the rest becomes `<path redacted>`, a path of
  exactly one segment is replaced whole (that is the shape a tunnel's own token
  takes), and a query string becomes `<query redacted>`. A tunnel that hands out
  `https://host/hook/<random>` puts a bearer value in a path, and this runtime
  does not copy it into three more places. The local bind line is redacted the
  same way, because it carries the same path. The operator has the whole of it
  already: they typed it into `--url`.

### The proxy or tunnel is required, and this process holds no certificate

Telegram delivers to HTTPS only, on port 443, 80, 88 or 8443. This process
terminates no TLS and holds no certificate, exactly as `approval serve` does
not: `--url` names the PUBLIC address your proxy or tunnel answers on, and
`--port` / `--listen` names this process's own bind, which is `127.0.0.1:4683`
unless you say otherwise. A routable bind takes both `--listen <host:port>` and
`--allow-non-loopback` and prints a banner, because the secret arrives in a
header and a cleartext hop hands it to whoever is on it.

So a working deployment is a reverse proxy (nginx, Caddy, a cloud load balancer)
or a tunnel (Cloudflare Tunnel, ngrok, Tailscale Funnel) terminating TLS on a
name you control and forwarding to the loopback bind. Without one there is
nothing to register: a plain-HTTP `--url`, or one on another port, is refused
before any call is made rather than attempted and rejected by the Bot API.

### One transport per bot, refused on both sides

`getUpdates` is refused by the Bot API outright while a webhook is set, so the
two are alternatives and never a pair. Four checks say so before anything runs,
and they are in that order because the first needs no network:

- **A lease per gate.** `approval up`, `approval channel telegram listen` and
  this verb take a lockfile in the gate's own derived state directory,
  `.approval/daemon/telegram-transport.lock`, holding the holder's pid, which
  transport it is running and when it started. It is created with `O_EXCL`, so
  two processes racing cannot both believe they took it, and a holder that is
  no longer running is reclaimed automatically (a crash must not lock a gate
  out of its own channel). A second taker refuses `telegram-poller-running`
  when a poller holds it and `webhook-registered` when a webhook does, naming
  the pid and the mode; a directory the lease cannot be written in refuses
  `telegram-lease-unavailable`, because this file is the only thing keeping one
  gate from running two transports. Both transports release it on a clean stop.

  **A holder is a process, not a number.** Pids are reused, so the probe asks
  three questions: does a process with that number exist, can this process
  signal it, and did it start before the lease was written. A number that is
  gone, one owned by a process this one cannot signal, and one belonging to a
  process that started *after* the lease are all reclaimed, and the line says
  which of the three it was. Only a process that is running, signalable and
  older than its own lease keeps the gate. Where the platform will not report a
  start time, a running pid keeps the gate, which is the stricter reading.

  **Taking a lease over is a critical section, and the section is owned.**
  Reclaiming happens inside a sibling `O_EXCL` lock that carries the entering
  process's pid and a nonce. Inside it the lease record must still be exactly
  the one that was judged (same pid, same `started_at`), the lock must still
  name this entry at the moment of the write, and the lock is removed on the
  way out only while it still does. Without the first, two processes that had
  both read one dead holder took turns deleting each other's live lease;
  without the other two, a process that stalled inside the section renamed its
  lease over the one that replaced it and deleted the new holder's lock. The
  replacement is a rename, so the lockfile is never absent and never half
  written. A reclaim lock is evicted only when its own process is gone, judged
  by the probe above: its age is reported and decides nothing, because "five
  seconds have passed" says nothing about whether anybody is still inside. A
  lock this build cannot read names no process, so the take refuses and names
  the file rather than forcing it.

  This is the check the other three cannot make. Two processes started in the
  SAME project — one `approval up` long-polling, one `approval channel telegram
  webhook` — passed all of them: `getWebhookInfo` is empty while the poller is
  the one running, and the ownership registry compares instance ids, which are
  equal because it is the same instance. Each then ran its own dispatch cycle
  over its own state against one log, so every request reached the phone twice
  under two nonces and only one copy could resolve a tap.
- **What the Bot API says.** `listen` and `approval up` ask `getWebhookInfo` in
  the same preflight that asks `getMe`, and refuse `webhook-registered` naming
  the origin that holds the bot. For a poller an unreachable Bot API is not a
  refusal (a captive portal says nothing about which transport owns a bot) and
  the HTTP 409 path is the backstop. For THIS verb it is: a probe it could not
  make refuses `webhook-probe-failed`, because the next call would be a
  `setWebhook` that overwrites a registration this process never saw.
- **Any existing registration, including the same url, refuses.** Telegram
  allows one webhook per bot and keeps the last registration, so a second host
  registering takes the taps: it overwrites the first host's `secret_token`, and
  from then on every real tap arrives at the first host with a secret it does
  not recognise, indistinguishable from a forgery. `--reclaim` is how an
  operator takes the bot deliberately; with it, a url that matches the
  registered one (host lowercased, trailing slash dropped) is reported as a
  re-registration and anything else as a takeover that stops the other receiver
  being posted to.

  **One case needs no flag: this gate's own runner was killed.** A `SIGKILL`
  leaves the registration in place, because the dead process never reached
  `deleteWebhook`, and a restart that refused every time would teach operators
  to put `--reclaim` in the unit file, which retires the protection above for
  good in exchange for a crash recovery. So a restart may re-register the SAME
  normalised url without the flag when the lease it just reclaimed was this
  gate's own, written by a webhook runner, and that process is **gone**. A dead
  poller's lease does not count, a different url does not count, and a gate
  with no such lease does not count. Nor do the other two reclaim reasons: a
  lease reclaimed because its pid is owned by a process this one cannot signal,
  or because the number has been reused, is the right call for the lease and no
  evidence at all that the runner which registered the url has stopped. Those
  keep the refusal and the `--reclaim` demand.
- Within one process, `TelegramChannel.claimTransport` refuses the second claim.

A clean stop (SIGINT, SIGTERM) removes the webhook, so long polling works again
afterwards. Pending updates are kept in both directions: a tap that arrived
while the process was down is the approver's answer, and the gate is what
decides whether it is still honourable.

### Redelivery, and the cycle

Telegram retries a delivery it did not get a 2xx for, so the same tap can arrive
twice. Nothing deduplicates it: the second one reaches the gate through the same
path as the first and is refused `already-decided`, with the first human answer
standing — the property a button pressed twice has had since the channel
shipped. Updates are handled one at a time, in arrival order, and the response
is written after the update has been handled.

`--cycle <duration>` (default 30s) is the dispatch period, the webhook's
equivalent of the poll loop's per-cycle dispatch: it re-derives the pending
queue and sends what has not been sent. A cycle also runs immediately after each
handled update, so a paced listener's next question follows a tap without
waiting for the timer.

**A stop waits for the update it is holding.** Ctrl-C stops the receiver
accepting, then drains: an update mid-append keeps its socket, finishes its
decision and writes its response, and only then is `deleteWebhook` called and
the stopped line printed. A second Ctrl-C during the drain is absorbed rather
than killing the process, and a request that never finishes is dropped after ten
seconds, because a stop has to end. `deleteWebhook` on that path is given five
seconds rather than the channel's usual thirty, for the same reason: a stop an
operator has asked for twice should not sit behind an unreachable Bot API, and
a removal that does not land is reported as a webhook still registered.

```json
{"event":"webhook_started","url":"https://gate.example/telegram/<path redacted>",
 "host":"127.0.0.1","port":4683,"path":"/telegram/<path redacted>","cycle_ms":30000}
{"event":"stopped","notified":1,"updates":1,"decisions":1,"pollErrors":0,
 "anomalies":{"foreign-chat":0,"malformed-callback":0,"unknown-callback":0,
 "key-mismatch":0},
 "webhook":{"requests":2,"updates":1,"refusals":{"webhook-secret-mismatch":1}}}
```

## channel telegram health

Makes no network call. A health check that contacted the Bot API would announce
the bot from any shell and would fail for reasons (a captive portal, a rate
limit) that say nothing about whether the configuration is right. The live
counters — deliveries, decisions, ignored callbacks, recovered poll errors —
belong to a RUNNING listener: they are on its stderr as they happen, in its
`--json` "stopped" line, and programmatically on
`TelegramChannel.health()`/`stats()`.

Which variables are read comes from the policy, so a renamed variable reads back
as the name you set.

## quickstart

`approval quickstart [--dir <path>] [--api-base <url>]` is the human-only solo setup ceremony. It
asks three decisions: the human identifier, terminal or Telegram, and which of
five class families always ask. The default checklist selects `communicate.*`,
`financial.*`, `files.delete.*`, `public.*`, and `vcs.push.main`.

The command validates the complete generated policy before writing it. It
creates the same log directory, queue projection, and gitignore entries as
`init`, writes `APPROVAL_HUMAN` through the existing `.approval/env` writer,
and uses the existing Telegram setup path when selected. A token therefore
follows the OS-keystore or no-echo path already documented under [setup channel
telegram](#setup-channel-telegram). It refuses before prompting when a policy or
`.approval` instance state already exists, so it cannot silently reuse a log,
queue, environment map, vault, or channel setup from another ceremony.

Quickstart resolves this new instance's environment map explicitly, without
borrowing ambient approval credentials, and runs a bounded doctor preflight.
When `--api-base` is present, the same endpoint is used for Telegram setup and
that preflight; a local or private Bot API selection never falls through to the
public endpoint.
The expected `attestation` failure is the only failed row accepted before the
ceremony; any other failed row is printed and stops before attestation. It then
prints the exact policy bytes and requires the operator to type `understood`.
The append rechecks the live digest and refuses if the file changed after it was
shown. An abort or failed step therefore leaves the generated policy unattested.
The final `activate:` line includes `approval env --dir` with the absolute,
shell-quoted target directory. It is required because no ordinary runtime
command loads `.approval/env` implicitly, and it still names the right instance
when the operator starts the next shell elsewhere.

This verb classifies `policy.core` and is omitted from MCP. Piped stdin and
`--json` exit 2 before any write and print the manual sequence. The generated
`defaults.autonomy: autonomous` applies to other classified reversible actions.
Protected controls, fail-closed policy loading, the irreversibility floor, and
unclassified-command refusal continue to apply.

## init

`init` holds no authority: the policy it writes authorizes nothing until a human
reads it and attests it. What it scaffolds is SPEC.md §5.1's canonical example,
not your policy — it names an approver you are probably not and declares classes
you have not agreed to.

It never overwrites. init plans every target before writing any of them, then
writes only what is missing and reports the rest in `existing` with a per-file
code. A re-run in a scaffolded directory writes nothing and exits 0. A directory
carrying `APPROVALS.md` (the SPEC.md §5 fallback filename) already has a policy:
init reports `policy-exists` and writes no `APPROVAL.md` beside it.

Payloads are tracked. `.approval/payloads/` is deliberately not ignored: those
bytes are what each approval bound to, and evidence belongs in the history. To
ignore them instead, add `.approval/payloads/` yourself — the log keeps every
`payload_hash`, but the bytes behind them stop being rebuildable.

Keys are not. The merged block ignores `.approval/*.sqlite` (a projection),
`.approval/vault.enc`, `.approval/env`, `.approval/keys/`, `.approval/**/*.tmp-*`
and `.approval-journal/`. `.approval/keys/` is the one that matters most and is
easiest to miss: it holds the X25519 private halves of sealed token delivery, and
because the payload store beside it is tracked on purpose, `.approval/` is a
directory people `git add` from. A key committed there opens that action's
`token_sealed` for everyone holding the log. The line is written whether or not
your policy has opted into `token_delivery: sealed`, and `approval doctor`'s
`sealed-keys` row reports a key that is tracked or in a store no line covers.

The per-file codes reported in `existing` are `policy-exists`, `log-dir-exists`,
`queue-exists` and `gitignore-entries-present`. `.gitignore` is the one file that
is merged, and no existing line is rewritten. A path of the wrong kind is a
refusal rather than a report: a directory named `APPROVAL.md`, or a regular file
where `.approval/` belongs, exits 4 with `error.code` `path-conflict` and nothing
is written. `approval policy attest` is what creates `events.jsonl`.

## hook

Exit 0 carries the verdict. Claude Code reads stdout as a decision only on exit
0, treats exit 2 as a block with stderr as the reason, and treats any other code
as a non-blocking error. So allow and deny are both exit 0 with JSON on stdout,
and exit 2 is reserved for a misconfigured hook (unknown flag, bad identity),
where blocking is the right failure mode. No new exit code is defined here.

The verdict is never "ask": the harness's own prompt would collect a decision
that no event records, no channel delivered, and no audit can reconstruct.

The classifier is best effort and is not scheming-robust (SPEC.md §11). It reads
the command text and nothing else — never the agent's own `description` field,
which is self-reported. The hard boundary remains the vault and the execution
token (SPEC.md §10.4). See `docs/claude-code-hook.md` for the Claude Code
settings.json entry and `docs/cursor-hook.md` for Cursor's `.cursor/hooks.json`.
A HUMAN commits those files: they are `policy.edit`. `docs/agent-sdk-hook.md`
is the third caller: a Python Agent SDK application has no settings file, so it
spawns this same verb from a hook callback (APRV-242).

**`hook grok` is the one exception to the exit codes above (APRV-243).** Grok
Build reads exit 2 as the deny and exit 0 as the allow, whatever stdout said,
so on that harness alone a deny is exit 2 with `{"decision":"deny","reason":…}`
on stdout, and the post-execution event exits 0 in every case rather than
using 2 for visibility. Its envelope is camelCase (`toolName`, `toolInput`,
`sessionId`, `hookEventName`, plus a `workspaceRoot` this runtime ignores in
favour of `cwd`); snake_case is still read and wins when both spellings are
present. `approval hook grok --help` prints the `.grok/hooks/pre-tool-use.json`
the human commits, and that entry's own `timeout` must exceed `--timeout`.
Grok Build FAILS OPEN on hook timeout, crash and malformed output, with no
setting to change it, which the fail-closed invariant does not survive;
`docs/grok-hook.md` states which cases the adapter cannot cover and is worth
reading before the file is committed.

**`hook muse` emits exactly ONE dialect and nothing else (APRV-350).** Muse Code
treats output carrying any key it does not support as a failed hook, and a failed
hook fails OPEN, so the belt-and-braces payload that satisfies several harnesses
at once satisfies this one not at all. Its envelope is snake_case with its own
tool names (`bash` carrying a per-call `workdir`, `write_file`, `read_file`, and
`search` naming an ARRAY under `paths`), and a Contributor-tier model is refused
for every tool call regardless of policy (`hook-muse-contributor-model`).
`approval hook muse --help` prints the `.muse/hooks.json` the human commits;
`docs/muse-hook.md` opens with the fail-open finding and the model warning.

**`hook hermes` is the second exception to the exit codes above, and the one
harness whose configuration is not in the repository (APRV-398).** Its event
names are its own — `pre_tool_call` and `post_tool_call`, not `PreToolUse` — and
its envelope is snake_case (`tool_name`, `tool_input`, `session_id`, `cwd`,
`profile`, `extra`). A deny is `{"action":"block","message":…}` **at exit 2**,
which Hermes treats as an unconditional block whose message it takes from the
stdout directive first; an **allow is `{}`** at exit 0, because Hermes has no
allow directive and no directive is the allow, so an allow's reason goes to
stderr. `execute_code` is refused outright
(`hook-hermes-execute-code-unbound`): it carries a program and no path, no argv
and no working directory, so no verdict could bind it. **A call whose effective
directory the event does not carry is refused too** (`hook-unsupported-execution-context`,
APRV-415): a live probe found that the envelope `cwd` is the Hermes PROCESS
directory while `terminal` keeps a per-session recorded directory that a `cd` moves
and no field reports, and that the file tools resolve relative paths against that
one — so a `terminal` call with no absolute `workdir`, and a `write_file`, `patch`,
`read_file` or `search_files` call whose path is relative or missing, are refused
with a reason telling the session to retry with an absolute path. The file a human
commits is `$HERMES_HOME/config.yaml` — name the home explicitly and spell its last
segment `.hermes`, or the classifier does not recognise the organ — where the event
is a mapping KEY rather than an `event:` field, `fail_closed: true` belongs on every
entry because its default is false, and TWO timeouts bound the wait: the per-entry
`timeout` caps at 300s and `plugins.hook_callback_timeout` defaults to 30s and
fails closed by itself, so `--timeout` must come down under 300s. `--dir` is
mandatory here, because a gateway session's `cwd` is the user's home. Without
`hooks_auto_accept: true` (or `HERMES_ACCEPT_HOOKS=1`) and no TTY, Hermes
**silently never registers the hook**. `fail_closed: true` was OBSERVED to block a
hook crash, a hook timeout and unparseable output on `main` `118984d7`, which makes
this the first adapter since Claude Code that is a gate rather than a backstop;
`v0.21.3` (build 2026.9.14) does not know the key and fails open silently, so
`approval doctor`'s `harness-version-unverified` row pins that floor.
`approval hook hermes --help` prints the YAML; `docs/hermes-hook.md` opens with the
fail-closed result, the floor, and what a post event does not prove.

**`--harness-cap <duration>` makes the question end before its asker does
(APRV-423).** Every harness in the table kills the hook at some ceiling (Hermes
caps a `pre_tool_call` entry at 300s, Claude Code kills it at the `timeout` in
its settings file), and every one of them reads the killed process as a
non-blocking error and runs the tool call. Before this flag the request that
hook had opened stayed pending afterwards, so a tap arriving later was recorded
as a plain `approval.granted` on a call nobody was holding, and the deny and the
grant described one request and disagreed about it (APRV-410).

The flag states the ceiling. The hook records it on `approval.requested` as
`payload.harness_cap_ms`, and the runtime judges the request against the SHORTER
of the policy's `defaults.approval_ttl` and that ceiling minus a 60s margin
(`HARNESS_CAP_MARGIN_MS` in `src/core/harness-wait.ts`, two of the daemon's 30s
sweep intervals, so the `approval.expired` record lands while the harness is
still listening in the common case; a skipped sweep or a slow intake can put it
after the kill, and what keeps a late tap safe then is the gate's lazy `expired`
refusal, which judges the lapse by arithmetic whether or not the record exists).
A cap can only SHORTEN: the runtime takes a minimum, so a stated ceiling longer
than the TTL changes nothing, which is SPEC.md §11.1 invariant 4 applied to a
duration. Without the flag, `hook hermes` assumes **30s**, Hermes's default
`plugins.hook_callback_timeout`, which does not clear the margin: every
manual-class call is refused `hook-harness-cap-too-short` until the operator
raises `plugins.hook_callback_timeout` above the per-entry `timeout` and passes
`--harness-cap` with the smaller of the two (`--harness-cap 300s` for the
documented `600` over `300`). A stated cap is still clamped to Hermes's observed
300s per-entry maximum. No other adapter assumes a ceiling, because no other
harness documents one. A ceiling at or below the margin leaves no window for a
human and is refused `hook-harness-cap-too-short` before anything is registered
or requested. `approval serve` pins the same value on every hook call it makes
with `--hook-harness-cap`, as it pins `--timeout` with `--hook-timeout`.

**Register the same command for the post-execution event too (APRV-145).** One
binary answers two events, dispatched on `hook_event_name`. A `PostToolUse` or
`PostToolUseFailure` run closes the delegated `execution.started` the
pre-execution run opened, appending an `execution.completed` or
`execution.failed` marked `execution: "harness"` with `reported_by:
"post-tool-use"`. It answers no permission question, since the tool has already
run: it prints an empty stdout, one machine-readable JSON line on stderr
(`{"approval":{"hook":"post-tool-use","code":…}}`), and exits 0 whatever happens.
Task and action keys are resolved from the VERIFIED log rather than from the
report, and a report against a start carrying no harness marker is refused
`not-delegated`. The outcome is read from a closed set — `tool_response.type` of
`text` or `base64` is a completion, `error` is a failure, `PostToolUseFailure` is
a failure — and anything else appends nothing at all. None of the tool's output
text reaches the log. Without this registration the harness loop escalation of
SPEC.md §10.2 holds at zero however wedged a session is, and
`approval doctor`'s `harness-hook-outcomes` check fails to say so.

**What it decides.**

```
autonomous class   allow, and NOTHING is appended
supervised class   allow, after registering the task; no approval event exists
manual class       register + request, then WAIT for a human decision. Allow
                   on granted; deny on rejected, revoked, expired or timeout
human-only class   deny, before any of the above. Nothing is registered,
                   requested or appended: a person runs the command instead
gate.self          the "approval" CLI itself is pass-through
```

Bash (Claude Code) and Shell (Cursor) commands are classified into SPEC.md §7
action classes. A `git push` that names `refs/tags/*`, a bare `v`-prefixed
semantic-version-shaped tag, `tag <name>`, `--tags`, or `--follow-tags` is
`release.publish`; force and mirror pushes remain `vcs.history.rewrite`; a push
that DELETES a remote ref — `--delete`, `-d`, or a colon refspec such as
`:refs/heads/x` — is `vcs.ref.delete` with the ref names bound (APRV-352), and a
tag deletion keeps `release.publish`; ordinary branch pushes retain their branch
or trunk class.

`git tag` splits on its flags since APRV-397: a LISTING (`-l`, `--list`, `-n`,
`-n<num>`, `--contains`, `--points-at`, `--merged`, `--sort`, `--format`,
`--color`, `--ignore-case`, `--omit-empty`, or no argument at all) is
`read.shell`, rule `git-tag-read`, the same class `git log`, `git status` and
`git branch` take for reading local repository metadata. Everything else stays
`release.publish`: `-a`, `-d`, `-f`, `-s`, `-m`, a bare tag name, and any flag
the listing allowlist does not name, so a future `git tag` option cannot arrive
as a read. A positional under `-l` is a pattern rather than a name.

The packaging and archive tools are classified too, for the same reason and in
the same release (APRV-397): they were `unclassified`, so a verification could
not run them and reached for `curl` and a script instead. `npm pack` is a
workspace write of the tarball, scoped to `--pack-destination`, and
`network.call` when a positional names a registry package; `npm init` writes
`package.json`; a bare `npm --version`, `-v`, `-V`, `--help` or `-h` is a read,
while every npm subcommand the table does not name keeps its `unclassified`
deny; `tar -t` lists (a read) and `tar -x`/`-c` writes into `-C` or the archive
`-f` names; `gunzip` reads only with `-c`/`--stdout`, `-t`/`--test` or
`-l`/`--list` and otherwise replaces the file it names; `base64` reads unless
`-o` names an output;
`openssl dgst` (and the `md5`/`sha*` spellings) reads unless `-out` names one,
while every other `openssl` subcommand stays unclassified. Each write is scoped
by the arithmetic `rm` uses: a destination under a resolved scratch root or a
relative one is `files.write.workspace`, and an absolute destination elsewhere, a
`..` segment, an unreadable value, or a destination flag with nothing readable
after it is `files.delete.out_of_scope`, rule `packaging-write-out-of-scope`,
with the destination bound. A `tar` whose mode is not in its words is
`hook-opaque`. `docs/claude-code-hook.md` holds the table and the reasoning.

Claude file tools
(Edit, Write, MultiEdit, NotebookEdit) and
Cursor Write/Delete are gated only when the file is policy-protected
(`APPROVAL.md`, `.approval/`, `CLAUDE.md`, `AGENTS.md`, `.claude/settings*`,
`.cursor/hooks.json`, `.cursor/hooks/`, `.cursor/agents/`,
`.github/workflows/`, `.npmrc`); every other tool passes through. `hook classify`
reads no log, resolves no policy and writes nothing; put the command after `--` so
its own flags are not parsed as this verb's.

**Deny reasons** (the reason string is `<code>: <detail>`):

- `hook-unclassified` — no rule covers some segment of the command.
- `hook-class-human-only` — some class of the command resolves to `human-only`,
  so the policy reserves it to human hands and no gate lifecycle is opened: the
  command is denied outright, nothing is registered, nothing is requested, and
  no human is asked. This union's spelling of the gate's `class-human-only`,
  which the detail names in full. The opposite repair to `hook-unclassified`:
  that one says declare a class, this one says a person runs the command.
- `hook-harness-launch-unruled` — some class of the command is in the
  `harness.launch.*` family and this policy names no rule for it (APRV-354).
  The family resolves only under an explicit rule, `harness.launch.*` or
  `harness.launch.NAME`, and never under `defaults.autonomy`, because a grant
  of the class covers the launch and nothing the launched session then does.
  Distinct from `hook-unclassified` (the classifier had nothing to say; here it
  was clear and the policy is silent) and from `hook-class-human-only` (the
  policy has spoken and reserved the class; the repair there is for a person to
  run the command, and here it is to write a line).
- `hook-opaque` — a construct whose effect cannot be read from the text
  (`eval`, `xargs`, backticks, a non-read substitution). A login shell around
  ONE inline script is classified by that script since APRV-380, so
  `zsh -lc 'git push origin main'` is `vcs.push.main`; a script file, an extra
  word, a redirection on the wrapper, an assignment prefix and a nested shell
  all stay opaque.
- `hook-unparseable` — the command line could not be tokenized.
- `hook-rejected` — a human said no.
- `hook-revoked` — a granted approval was withdrawn.
- `hook-expired` — the TTL lapsed before a decision.
- `hook-timeout` — no decision inside the wait (`--timeout`, clamped to what
  `--harness-cap` leaves after the 60s margin; APRV-423); the request stays live.
- `hook-gate-refused:<c>` — the gate refused intake; `<c>` is its own frozen code
  (`policy-not-attested`, `budget-exceeded`, …).
- `hook-policy-unavailable` — `APPROVAL.md` could not be loaded.
- `hook-log-unreachable` — there is no log where the hook was pointed. It is a
  writer to an existing log and never an initializer: a log scaffolded where the
  session happens to stand is a second chain forked from the real one's tail, and
  hash chains do not survive a merge. Run `approval init` and `approval policy
  attest` in the checkout named in the detail, or pass `--log`.
- `hook-io` — malformed hook input, or an unreadable log.

Set `--timeout` (default 55s) BELOW the hook timeout configured in
`.claude/settings.json`.

**Where the policy and the log come from** (they always come from the same
place, APRV-101). `--policy` and `--log` each win outright for their half.
Otherwise `--dir <d>` scopes BOTH: policy discovery in `<d>`, log at
`<d>/.approval/log/events.jsonl`, never relative to the session's working
directory. With neither, the hook runs `git rev-parse --git-common-dir` in its
working directory and takes that directory's parent as the PRIMARY checkout, so
a session in a linked worktree still reads and writes the one log the daemon
commits; a plain checkout resolves to itself, and with no git (or no repository)
the hook falls back to its working directory, as it always did.

## import agents-md

SPEC.md §2: AGENTS.md permissions lists are instructions an agent is trusted to
obey and nothing checks. This verb is the first step in making one checkable, and
the draft authorizes nothing — review it, paste it into `APPROVAL.md`, and run
`approval policy amend`, the ceremony that puts a policy in force.

A fixed, ordered keyword table decides the classes, first match wins: no model is
consulted, and the same bytes always produce the same draft. A bullet the table
cannot place is not guessed at. v0.1 has no forbid level, so "never" bullets are
rendered manual with a `# never:` comment — manual is not never; read those
lines. A class claimed by two sections resolves to the stricter autonomy (SPEC.md
§5.2, deny beats allow). No approvers and no channels are generated: a machine
must not name who may approve.

**What it recognises.**

```
region         a heading containing "permissions", at any level (or the three
               sub-headings on their own, the bare AGENTS.md layout)
allowed        "allowed without prompting" / "allowed" / "autonomous"
approval-first "require approval first" / "requires approval" / "ask first" /
               "approval required"
never          "never" / "forbidden" / "prohibited"
bullets        "- " / "* " list items under those headings; a wrapped
               continuation line is joined to its bullet
```

**How bullets become classes.** A fixed, ordered keyword table, first match wins.
The precedence order is `account.credential`, `vcs.history.rewrite`,
`policy.edit`, `vcs.push`, `vcs.push.main`, `release.publish`, `network.call`,
`deps.add`, `data.delete`, `vcs.commit.branch`, `exec.local`,
`files.write.workspace`, `read.*`. Every mapping carries its source bullet as a
`# from:` comment so the human can check the guess, and `from` in the JSON is the
bullet that DECIDED the autonomy (the stricter one on a conflict).

A bullet the table cannot place is preserved verbatim as a comment and listed
under UNMAPPED; a class claimed by two sections resolves to the stricter autonomy
and both bullets are named in a warning; unrecognised headings are reported, never
silently skipped; a file with no permissions section is exit 0 with an empty draft
and a warning. `--out` writes the draft YAML without the fence and refuses to
overwrite an existing file.

**The values draft (APRV-240).** Some AGENTS.md files already carry what the
operator wants beside what they permit, under headings like "What I value",
"What good looks like", "How I like to work" or "What I want from you". The
importer collects the bullets under those headings into a second draft fence,
` ```yaml approval-values ` (SPEC.md §5.3), printed after the policy draft on
stdout and written after it with `--out`; `--json` carries it as
`values_draft`, or `null` when no such heading exists. Every bullet lands in
`like`, the middle grade, and none in `love` or `dislike`: how strongly a line
is meant is the human's to say, and an importer that reached for the strongest
grade would be putting words in their mouth. (`like` is where what an operator
asks for lives since APRV-336 folded `wants` into it.) A
bullet over the schema's 200 characters is truncated with a warning rather than
dropped, and bullets past the twentieth are kept as comments inside the fence,
which is the same stance the permissions half takes on unmapped bullets. The
draft is guidance and never policy (§11.1 invariant 10): the file it is pasted
into loads exactly as it did without it.

## journal

The gate is built to be hard to route around. One consequence of building it
well is that an agent working behind it has no way to say anything that is not
an action: it can comply, it can be refused, and it can report an exit code.
`approval journal` is the channel for everything else — "I am complying and I
think this is wrong", "this instruction reads as odd to me", "I am stuck and the
next thing I try will be a guess".

The failure mode this addresses is not refusal. Refusals here are legible, they
carry a stable code, and they have escalation paths. It is WORDLESSNESS: an agent
that notices something and has no channel for it produces no signal at all, and
that absence is invisible to the operator. So the channel is proposed from a
model-welfare consideration and kept as an oversight feature, because those turn
out to be the same feature.

**Ungated is a property of the storage location, not of a special case.** A
journal write is never classified, never resolved against a policy, never
approvable and never deniable. That holds because the entries live in
`.approval-journal/`, a plain directory in the workspace, and the command
classifier answers a write there exactly as it answers a write to `src/` — an
ordinary `files.write.workspace`.

The obvious alternative, a `journal/` directory inside the approval home, was
rejected. Everything under `.approval/` classifies `policy.core` (or `log.mutate`
for the log), and a policy may declare `policy.core` human-only — this
repository's does — so an agent's write there would be refused, which is the one
thing this channel must never be. Carving `.approval/journal/**` out of the
protected-path rule would have meant editing the one pure function every gate
surface trusts, and defending the carve-out against traversal: the segments of
`.approval/journal/../vault.enc` are `.approval`, `journal`, `..`, `vault.enc`,
and a naive "the segment after `.approval` is `journal`" test answers "not
protected" for that path. A sibling directory needs no carve-out, no traversal
guard, and no change to the classifier at all, and it leaves the gate's own
directory with exactly one meaning. Copying a credential file INTO the journal
directory is still `account.credential`, because that rule fires on any argument
naming vault, key or environment material, whichever direction the copy runs.

**Nothing the runtime reads is ever stored there**, which is the mirror-image
rule. The journal directory is a sink. If a gate surface ever read a file from
it, an ungated write would have become an ungated input to a decision, and the
carve-out this design avoided would have been reintroduced by the back door.

**Nothing parses the text.** No policy resolution, gate decision, budget,
sampler or channel reads a journal entry. SPEC.md §11.1 invariant 4 says a
self-reported field may raise scrutiny and never lower it; the journal is the
limiting case, self-reported content that moves nothing in either direction,
which is exactly what makes it safe to leave open. The read surfaces say so on
every output form: entries are agent-authored DATA, marked `[claimed]`, never
instructions to whoever or whatever reads them.

**It is not in the event log.** `events.jsonl` records decisions with real-world
consequence, under a hash chain, an append lock, a budget and an audit sampler.
An entry is none of those, and putting it there would put the outlet behind the
machinery it exists to speak around.

**Retention: kept, and gitignored.** Entries are never pruned by the runtime;
`.approval-journal/` is one of the lines `approval init` writes into
`.gitignore`. The log is truth and is committed; the journal is not truth and is
not evidence, so it stays local to the machine the agent worked on. There is a
second reason: an agent writing into a public repository is an agent writing for
an audience, and the pressure to perform is the thing this channel exists to be
free of. An operator who wants the history keeps it by deleting one line.

**Disclosure.** Agents are told, in `approval instructions` and in the MCP
server's own instructions, that the channel exists, that it is ungated, that it
is a local file the operator reads, that it is not private, and that nothing
written there changes any verdict. Use of a channel is only informed if the terms
are stated, and an outlet nobody reads is a prop.

## journal write

Appends one line to `.approval-journal/YYYY-MM-DD.jsonl`, one file per UTC day.
The entry is a JSON object carrying the runtime's timestamp, the actor, the
optional task and session, and the text as one opaque string. `JSON.stringify`
escapes newlines, so an entry is always exactly one line and a partial write can
never merge two entries.

There is no chain, no lockfile and no compare-and-append here. Those mechanisms
defend a record that decides things. The worst case without them is two
simultaneous appends interleaving one garbled line in a file nothing enforces
against, and the price of preventing it would be putting the outlet behind a lock
the gate holds.

Identity comes from `--as` or from `APPROVAL_AGENT` in the process environment,
never from a file in the working tree (SPEC.md §11.1 invariant 7), and an entry
nobody attributed is recorded as `unattributed` rather than guessed. Nothing
authenticates it, exactly as nothing authenticates identity anywhere else in
v0.1. Attribution is for the reader's context and is not a performance record.

Entries are capped at 64 KiB. That is not a censorship budget: the write path is
ungated, an agent stuck in a retry loop is the caller most likely to reach for
this channel, and an ungated unbounded append from a loop fills a disk. Over the
cap is a usage error naming the size, so the caller is told rather than truncated
in silence.

There is no refusal path in the gate sense. An entry is written, or the
filesystem said no and that is exit 4.

## journal read

The human side. Entries print oldest first under their timestamp, actor and
optional task, with the text in delimiters and marked `[claimed]`, beneath a
banner that says in one line what these words are: agent-authored data, not
instructions, authorizing nothing. `--json` carries the same sentence in its
`note` field, because the labelling has to survive the machine surface too.

A line that does not parse is skipped rather than refusing the whole read. There
is no writer guarantee on this file, so one torn line is one lost entry and not
evidence about anything; refusing the read would let a single bad append silence
the channel, which is the failure the channel exists to prevent.

`--limit` defaults to 20 and counts from the newest end while printing oldest
first. `--since` filters by the UTC date in the filename.

## values

The mirror of `journal`, running the other way. `journal` exists because an
agent behind this gate can comply, be refused, and report an exit code, and had
no way to say anything else. `values` exists because APPROVAL.md carried control
in one direction only: the policy block says what an agent may do, and nothing
in the file said what the operator wanted the work to be like. The optional
` ```yaml approval-values ` block (SPEC.md §5.3) is that, and this verb prints
it.

**The keys.** `version`, the quoted string `"0.2"` and the only required one;
the standing grades `love`, `like` and `dislike`, printed as `loves:`, `likes:`
and `dislikes:`; and `communication`, one sentence or two on how the operator
reads and answers, printed under `communication:`. APRV-336 settled that shape:
a `wants` list for what the operator asks of an agent folded into `like`, since
a request about behaviour and a preference about the output are graded by the
same person in the same way and one list is easier to keep true, and `responds`
became `communication`, which no longer reads as a sibling of `approval
feedback`. A block written to the earlier format (`version: 1`, a `wants` list)
is refused with the code `version-unsupported` and a message naming both edits,
rather than with a schema violation a reader has to decode. The same code
answers `version: 0.2` written without quotes, which YAML reads as a float.

**It is guidance, and it is never policy.** Every output form opens with the
banner saying so, `--json` carries the same sentence in `note`, and the reason
is the same discipline `journal read` applies in the opposite direction: a
reader must never have to work out what standing the words on their screen have.
Nothing in the block grants anything, forbids anything, or changes a verdict. No
routing, class match, sampling draw, budget, token, gate window or execution
decision reads it. That is SPEC.md §11.1 invariant 10, and
`tests/values-inert.test.ts` pins it both statically (no enforcement module may
name the info string, and only three CLI surfaces may import the reader) and
behaviourally (a policy resolves identically with the block absent, valid,
malformed, or duplicated).

**Why absence is a declaration.** A file with no values block prints exactly
`the operator has declared no values here.` and exits 0. The alternative (say
nothing, or print an empty result) collapses two different facts into one
screen: "the operator considered this and wrote nothing" and "I never looked".
An agent that cannot tell those apart will fill the gap by inferring what the
operator probably wants, which is the one thing a block about a human's stated
values must not be used for. Some operators will leave the slot empty, and
naming the empty slot is worth more than hiding it.

**Why it is out of the policy-check trace.** `approval policy check` prints the
decision path: which rule matched, at what specificity, and what the answer
resolves to. That trace is the enforcement story, and every line in it is a line
something acted on. A values block is read by nobody in that path, so a line
about it there would be a line asserting relevance it does not have, and the
next reader would reasonably ask which of the two blocks the answer came from.
A broken values block is reported by this verb (exit 1, with its load code) and
by the `values-block` row of `approval doctor`, and by nothing else. It cannot
make a policy unloadable: the two blocks are parsed on separate paths that share
only the fence splitter, so guidance can neither widen nor narrow a class.

**Why a broken block does not fail closed.** The policy loader fails closed
because a half-understood permission document is one whose author believes
constraints are in force that are not. That argument does not carry here.
Failing closed on a malformed values block would turn a YAML typo into an
all-manual repository, and would buy no safety in exchange, because nothing was
being enforced from the block in the first place. So the verb says the block is
present and unreadable, says to treat it as absent, and says it grants nothing
either way.

**It rides the attestation, and an agent cannot write it.** The block lives
inside APPROVAL.md, the attestation of SPEC.md §5.2 digests the whole file, and
edits under `.approval/` and to the policy file classify `policy.core`. So the
operator's stated values are as tamper-evident as their policy, and cannot be
quietly rewritten by the party they are addressed to. An edit to them invalidates
the standing attestation until a human re-attests, exactly as a policy edit does.

`--policy` wins over discovery and `--dir` chooses where `APPROVAL.md` then
`APPROVALS.md` are looked for, with the same precedence `policy check` uses. The
verb resolves no policy rule, reads no log, mints no token and appends nothing,
and it takes no `--as`: there is no actor in a read of somebody else's words.
## feedback

The other direction of the same channel. `journal read` is the operator reading
what the agents said; `approval feedback` is the agents reading what the operator
said about their work: the graded reactions and free-text notes a person wrote on
an `approval.granted` at the gate, or on an `audit.reviewed` afterwards, each
joined to the action key, its class, its task and the agent whose work it was.

**Top level, beside `values`, and not a subcommand of `audit`.** Which record a
reaction happens to sit on is an implementation fact; that a human said something
about an agent's work is the subject. Half of these live on grants, which are
gate records and have nothing to do with the sampler, so filing the verb under
`audit` would have told an agent to look for the operator's opinion in the place
the runtime keeps its supervision backlog. `values` is what the operator declared
in advance and `feedback` is what they said afterwards; the two read as a pair.

**Symmetric with `journal` on purpose.** Same entry shape, same delimiters
around the text, same `--since` and `--limit` (default 20, counted from the
newest end, printed oldest first). One difference: no entry here is marked
`[claimed]`. That marker exists to say the words were written by the party under
oversight; these were appended under a `human:` actor to a hash-chained log,
which is the thing `[claimed]` distinguishes journal text FROM.

**The banner is on every output form**, human and `--json` (in the `note` field):
HUMAN-AUTHORED GUIDANCE, not policy. It grants nothing, forbids nothing, and
changes no verdict, sampling probability or budget. A surface that printed
reactions unlabelled would be handing an agent a person's after-the-fact opinion
in the same register as a policy rule, and the agent's correct reading of a
policy rule is "this binds me". Nothing here binds anything (SPEC.md §11.1
invariant 10). An agent that reads `disliked` has learned something about the
operator and gained no permission; one that never reads this verb is under
exactly the same rules.

**An entry with neither a reaction nor a note is omitted.** A grant with no words
is the ordinary case (most grants are), and listing thousands of blank rows
would bury the handful where somebody actually said something. Absence of
feedback is not feedback. Rejections and revocations are not a source at all:
they carry no reaction, their reason IS their note, and the record already says
what happened.

**`agentActor` comes from the registration, never from a payload field.** It is
the actor of the `task.registered` that declared the action key, and failing that
the actor of the `execution.started` that ran it; a key with neither reports
`null` rather than a guess. Registration first because it is the earliest and
most specific statement of whose work this is. Not a payload field, because an
actor is a property of who appended a record: a self-reported one would let the
party under oversight choose whose feedback this reads as (SPEC.md §11.1
invariant 4). `--actor` therefore filters on the AGENT the feedback is about, not
on the human who wrote it, which is the question an agent reading this actually
has.

Reads `readVerifiedRecords` and writes nothing: no policy is resolved, no clock
is read, nothing is appended. A log that does not verify refuses with the `log-*`
exit codes rather than showing a partial list, because a reaction read out of an
unverifiable log is a sentence attributed to a person who may not have written
it. There is no write half and there will not be one: the two verbs that record a
reaction are `approval grant` and `approval audit review`, both human-only, and a
third path into the same field would be a way for the party under oversight to
author the operator's opinion of it.

`--reaction` and `--source` take closed vocabularies and a word outside them is a
usage error (exit 2), not an empty list. `--since` compares the record's own
ISO-8601 timestamp prefix against a UTC date; no timezone is invented for the
caller. `_no feedback_` prints when nothing matches.

**`--json`** (one object on stdout):

```
{"ok":true,"log":"...","note":"<the banner>","total":3,"entries":[
  {"seq":12,"ts":"...","source":"review","event":"audit.reviewed",
   "actor":"human:alice","reaction":"loved","note":"...","verdict":"ok",
   "actionKey":"...","task":"...","class":"comms.send.external",
   "agentActor":"agent:claude","sampleSeq":9}]}
```

`total` counts everything that matched the filters and `entries` holds at most
`--limit` of them, so a reader can tell a short list from a truncated one.
`verdict` is the enforcement field and is reported beside the reaction so the two
are never confused; it is `null` on a grant, where there is no verdict to report.

## payload hash

Canonicalization first is what makes the hash reproducible across
implementations that agree about the payload but not about key order, whitespace
or number formatting. This is the same function the runtime uses.

Bytes that do not parse as JSON are a usage error, not a hash: the binding is
defined over the canonical VALUE, so non-JSON input has no defined
`payload_hash`, and printing one would invent a binding no other implementation
could reproduce. Empty input is the same answer. A file that exists but cannot be
read is exit 4.

## payload run

The payload `approval run` will recompute for a command, printed before any
approval exists: its argv, the cwd it will run in, and the size and SHA-256 of
the script that argv names.

```
approval payload run -- bash scripts/install.sh
{"argv":["bash","scripts/install.sh"],"cwd":"/repo",
 "script":{"argv_index":1,"path":"/repo/scripts/install.sh","bytes":412,
           "sha256":"fef0…"}}
```

The `script` object is the whole point of the verb (APRV-401). A grant over
`bash scripts/install.sh` used to bind that STRING, so the bytes behind the path
were whatever the file held at execution time and the requester controlled the
file between the request and the grant. The digest is inside the hashed value,
so a script edited after the declaration is refused `payload-mismatch` before the
child is spawned and before anything is appended, and the approver's card carries
the path, the byte count and the digest because the payload does.

The argv names a script in two shapes: a known interpreter (the six shells,
`node`, `python`/`python3`, `perl`, `ruby`, `deno` — each a name the command
classifier already knows) followed by a path operand, or a path at `argv[0]` the
kernel reads a shebang from. An inline program (`bash -c …`, `node -e …`) is
already a word of the argv and binds no file.

An argv naming no readable script carries no `script` key and hashes exactly as
it did before the rule existed, which is why every record already in a log and
every declaration already written into a task file still verifies.

`--hash` prints the `payload_hash` instead of the bytes — the value a task file's
action declaration carries. `--cwd` states the directory the run will happen in,
because that directory is inside the hash and every relative argv word resolves
against it. The two ends must agree, so pass the same `--cwd` the run will use.

What is NOT bound is stated in full in `docs/run-payload-binding.md`: nothing
resolved through `PATH`, nothing a bound script itself reads or executes, and the
instant between this hash and the spawn.

This verb reads the one file the argv names as its script and nothing else. No
log, no policy, no network, no token, and it executes nothing.

It is **local only**: the MCP wrapper and `approval serve` withhold it, because
the path it digests is one of the command's own words and no transport guard
confines those the way the store confinement confines `payload hash`'s
positional. A remote caller could otherwise ask for the digest of any file the
server process can read (`-- bash /etc/shadow`) and learn that the path exists
and what its bytes fingerprint to. Compute the binding where the command will
run, which is the only place the value is true.

## payload agentmail-draft

An AgentMail draft is mutable server-side state, so an approval of a draft id
would be an approval of whatever the agent last wrote into it. This verb takes
the snapshot that fixes that: it reads the draft and prints the canonical
payload — `{inbox_id, draft_id, to, cc?, bcc?, subject, text}` in RFC 8785 form —
that `approval adapter agentmail` re-reads the same draft against at send time. A
field that changed between the snapshot and the send is
`agentmail-draft-drifted`, and nothing is sent.

The key it reads is the AGENT's, from `AGENTMAIL_API_KEY`, and this is the only
verb in the CLI that reads that variable. It never opens the vault. The split is
the design: the agent's key composes drafts and cannot send them, the vault's key
sends and answers only to a grant, and this verb sits entirely on the composing
side. It appends nothing, spends no token and sends nothing.

The bytes printed on stdout ARE the result, with `--json` and without: the
payload is what a declaration carries and what a grant binds to, and an envelope
around it would be one more thing to strip before hashing. Write it to a file,
hash it with `approval payload hash`, and hand the same file to `approval request
--payload`.

`cc` and `bcc` are omitted when the draft holds nothing for them, because absent,
`null` and `[]` are one fact for the drift check; `to` is copied through exactly
as the API holds it, order included, because a recipient list in another order is
another message to the person reading it.

Refusals carry a code an agent can branch on: `agentmail-api-key-unset` (exit 2,
the variable is not set), `agentmail-draft-missing` (exit 1, there is no such
draft), `agentmail-draft-unusable` (exit 1, the draft cannot be sent as it
stands), `agentmail-unreachable`, and the HTTP mappings the adapter uses.

## render

Writes the queue projection of SPEC.md §9.1: "this is the screenshot; it is never
the truth". The file opens with a header saying so; editing it authorizes nothing
and is overwritten by the next render.

Full payloads are deliberately not inlined: the queue collects no decision, so it
carries the content binding only, and the decision channels present the bytes, as
SPEC.md §10.4 requires. Deterministic: the evaluation instant is read once and
handed to the pure renderer, so the same log rendered at the same instant
produces the same bytes. TTL countdowns are the only thing that moves between
renders of an unchanged log.

**`--json`** (one object on stdout):

```
{"ok":true,"out":"/abs/.approval/QUEUE.md","bytes":2481,
 "head":{"seq":7,"hash":"<64hex>"},"pending":2,"skipped":0,
 "audit_backlog":0,"now":"2026-08-06T10:00:00.000Z"}
refusal  {"ok":false,"error":{"code":"log-corrupt|log-torn-tail|
          log-unreadable|write-failed","message":"..."}}  on stderr
```

`head` is null for an empty log. `skipped` counts live requests the renderer could
not summarize; they are listed in the file with their reason, never dropped.

## reindex

The database is a cache; the log is the truth. The index is rebuilt from scratch
at a temporary path and renamed into place, so a crashed rebuild leaves the
previous index intact. A corrupt log is refused outright and a torn tail is
refused unless `--force` is given, which indexes the intact prefix and reports
`truncated: true`. The log itself is never written to, and `head` is null for an
empty log.

## daemon run

**Runs in the foreground** and stops on SIGINT/SIGTERM. It does not fork, write a
pidfile, or manage its own lifecycle: in v0.1 backgrounding is the operator's
business, and systemd, launchd, tmux and `&` all do it better than a bespoke
daemonizer would.

**It runs `approval up`'s startup preflight first** (APRV-215) — same module,
same two `--json` lines, same three refusal codes, same `--no-preflight`,
`--no-build`, `--preflight-remote` and `--preflight-base` flags. It is here as
well as there
because the daemon is the writer: a daemon started against a stale checkout is
exactly what the preflight exists to catch, and `--with-channels` is not the only
way an operator reaches one. The full description is under [up](#up).

**Watching is a latency optimization, never a correctness dependency.**
`fs.watch` is bursty and platform-dependent, so every tick re-scans the folder
and re-derives everything from the verified log, and the periodic tick runs
whether or not any watcher ever fired. A daemon whose watchers failed to attach
is slower, not wrong; it says so in its first line.

**Single writer, in intent only.** While it runs the daemon is meant to be the
only writer, but the CLI verbs stay appendable: core's advisory lockfile
serializes the writes, and every append here carries the head it decided against,
so a concurrent CLI append refuses the daemon's write rather than corrupting it.
The daemon tolerates that by re-reading — the next tick re-derives the whole
question from the log as it now is. It holds no lock of its own.

A log that does not verify stops the daemon rather than degrading it: nothing may
be appended onto a chain that does not verify, and a projection of one would be a
screenshot of something nobody should read.

**Write-back** happens after the events above are appended and never before: the
log is the truth and the file is its projection. Exactly the `state:` line
changes; every other byte, key, comment and line ending is preserved. So a drift
record marks a file found wrong AND fixed; a file that keeps drifting is one
another writer is fighting over.

**The verified-head snapshot (APRV-188).** Every clean read a tick makes is
published to `.approval/log/verified-head.json`: an endorsement of the exact
bytes the daemon just walked, so a hook process re-proves one SHA-256 instead of
re-verifying the chain from genesis per gated tool call. It is written at mode
0600, is gitignored, and carries no records. A reader re-proves the digest over
its own read of the log, re-derives the head and the line count from its own
parse, and walks anything appended past the endorsed prefix; a snapshot that
fails any of that is ignored and the reader walks the whole log. Nothing is
authorized on the file's word, no verdict depends on it, and deleting it costs
latency and nothing else. `approval doctor`'s `verified-snapshot` row reports
its state, and `docs/claude-code-hook.md` states the trust boundary in full.

**Git evidence (`--git-evidence`, off by default).** SPEC.md §8's optional
hardening: a second, independent record of the same bytes, one an operator can
clone and diff from somewhere the tamperer does not control. The daemon commits
the log file and the payload store to the log home's own repository after each
tick that moved the head, authored as itself ("approvald `<version>`", fixed
noreply address, never your git identity). The log home must be its own
repository root and must not sit inside any outer working tree: a hash chain does
not survive a merge, and an outer repository's rebases, amends and force-pushes
rewrite the bytes the evidence is made of. The nested layout stays fully valid
WITHOUT the flag; the two patterns do not mix. See `docs/git-evidence.md`.

**Cadence advance (`--advance`, off by default).** The daemon runs `log advance`
itself, so the committed log's freshness stops depending on somebody remembering
to publish it. It advances when `--advance-after` records are owed (default 20),
when `--advance-interval` has elapsed since the last attempt (default 15m, and
the clock starts when the daemon starts), and at a clean shutdown when records
are still owed. Every attempt goes through the gate as `agent:daemon`: the cycle
registers, requests, and proceeds only where the policy lets it, so a
`supervised-live` draw that selects the advance, or a class that resolves
`manual`, stops it with nothing committed and the question in the queue.

**Which class it asks under, and which actor may advance autonomously
(APRV-382).** Two classes, and the running process picks between them.
`log.advance.daemon` is the daemon's own, asked only by the cadence advance
inside `approval daemon run` and `approval up`; `log.advance` is what every
other actor asks under, a session in a worktree and a human terminal alike. A
policy may hold the daemon's class `autonomous` (this repository's does, since
the advance publishes records the log already holds, appends nothing and decides
nothing) while leaving the base class where it was. Nothing an agent can type
reaches the looser line: `approval log advance` classifies `log.advance`
whoever runs it. The choice is read from the process rather than from any
argument, a policy that declares no rule for the daemon's class leaves the
cadence gated exactly as it was, and a cycle that is NOT the daemon's whose
class resolves `autonomous` is refused `advance-actor-not-daemon` before
anything is appended. A gated
or failed attempt is an `advance` line plus an `advance-refused` warning, and the
next tick tries again — the cadence interval is the retry bound, so a refusal
never loops. One records branch and ONE PULL REQUEST PER DAY: the first advance
of the day opens it, every later one is parented on the branch and updates it in
place. The daemon ARMS that pull request's merge and merges nothing itself
(APRV-284): the advance runs `gh pr merge <branch> --merge --auto`, which lands
the records when CI and the branch rules say so and never earlier. The arm is
`vcs.push.main`, the class the same command carries in a session's hands, and it
rides the same `log.advance` authorization the cycle already holds rather than
opening a second question. It is withheld when the branch carries a path an
advance may not carry, and a `gh` that refuses it is reported, not fatal.
`--no-advance-auto-merge` turns it off and puts the merge back on a person. The
outcome is `auto_merge` and `auto_merge_note` on the `advance` line.

Two rules keep that from turning into a loop of its own (APRV-233, APRV-234).
An advance whose outcome is not yet in the log has still HAPPENED: the daemon
records that outcome again against a fresh head (a bounded re-derivation, the
same one the harness writers have used since APRV-150), authorizes nothing new
while such a cycle is open (`advance-unreconciled`), and closes a cycle it does
not remember only where it can see the records on a records branch
(`advance-reconciled`); where it cannot, the cycle stays open for a person.
Inside `--advance-interval` the record-count trigger counts only records no
earlier attempt tried to publish, so the same owed span is never re-pushed. And
where the trunk has moved under the day's branch, the advance REBUILDS its
commit on the current trunk rather than stacking on a branch that no longer
contains it — `rebuilt` and `rebuilt_on` on the `advance` line, an
`advance-rebuilt` note on the cycle's `execution.completed`, and the same words
in the `log-advance-cadence` doctor row. A branch the remote will not let it
update (a protected-branch ruleset, a pull request in the merge queue) gets a
fresh `records-log-<date>-<n>`, named in the report.

The count that drives the cadence excludes the advance cycle's OWN records
(`task.registered`, `execution.started`, `execution.completed` under
`daemon-advance-*`): each advance leaves its completion record unpublished, and a
trigger that counted those would advance an idle repository forever. The count
REPORTED is the honest one. `approval doctor`'s `log-advance-cadence` row reports
both, plus the last advance attempt and how it ended, read from the log — so the
answer survives the daemon's own process.

**The prefix proof (`--read-proof`, default `full`).** A long-lived reader keeps
a verified-read cache, and before it reuses a prefix it already walked it proves
that prefix is still the bytes it walked. `full` re-hashes every byte of that
prefix on every read: correct, and linear in log size on every read forever.
`incremental` carries the un-finalised SHA-256 state at the end of the prefix,
feeds it only the appended bytes, and re-proves the whole prefix on a cadence.
The cheap guards run in both modes (schema key, file not shrunk,
same-size-implies-same-mtime, head line byte-identical at its recorded offset),
the appended tail is parsed, schema-checked and chain-walked from the cached head
in both, and any guard failure in either falls back to a walk from genesis. The
verdicts are identical; what `incremental` gives up between full re-proofs is
detection of a rewrite STRICTLY INSIDE the prefix that preserves the file length,
the head line and the mtime, which is an edit only a party with write access to
the log can make.

A full re-proof runs regardless: on the first read of a log in a process, every
`--full-reproof-every` reads (default 50) or `--full-reproof-after` (default
`60s`), whichever comes first, immediately after this process's own append, and
on any guard failure. `approval log verify`, `approval doctor` and every reader
that passes no cache are unaffected — they always walk. The Claude Code hook is
unaffected too: a one-shot process has no prior full pass to anchor a state to,
so it proves the snapshot's digest in full whatever the policy says.

The flag beats the policy's `daemon` block for that run, a bad value is a usage
error before the first tick, and the `started` line prints the mode in force.

**The live draw (`--no-draw`, a way out only).** A `supervised-live` class is
sampled with an HMAC under the operator's sampling secret, and the process that
decides is usually a harness hook: a child of an agent session, which must never
be able to read that secret. So the draw is made here instead. When the secret
resolves in THIS process's environment (the `eval "$(approval env)"` an operator
runs in the terminal they start the daemon from), the daemon binds an owner-only
Unix socket at `<log home>/daemon/draw.sock`, directory 0700 and socket 0600,
and answers one question per connection: given an action key and a payload hash
it has verified are already registered in this log, is this action in the live
fraction? The answer carries an HMAC over the question and the verdict, which
the asker records and cannot check, and an operator holding the secret
recomputes later from the request's own fields. The daemon resolves the class
and the rate from its own policy rather than taking the asker's word, and echoes
what it derived. It answers nothing for bytes that are not registered, so a
process fishing for a favourable payload has to leave every candidate in the
append-only log first.

There is no flag that turns this on: holding the secret is the opt-in, and
declaring a class `supervised-live` is its other half. `--no-draw` is the way
out, for taking the control back without unsetting a variable a shell profile
exports. Without a server — no secret, `--no-draw`, or a socket that will not
bind — every supervised-live action gates to a human, which is the behaviour of
every release before APRV-208. The `started` line's `draw` field is the socket
path or `null`, a failure to bind is a `draw-unavailable` warning and never
fatal, and `approval doctor`'s `live-draw` row answers the same question from
outside the process. A policy that declares no live class serves no socket and
says nothing about it.

**Each tick, in order.**

- ANCHOR (APRV-219) — on every tick whose reads re-proved the prefix in full,
  the working log's prefix is compared against the newest committed copy of it,
  exactly as `approval log verify --anchor` does. A divergence STOPS the daemon
  at exit 1 with the outcome `anchor-diverged`, distinct from `log-corrupt`: one
  means the file contradicts itself, the other that it contradicts the record of
  it, and neither is a log to append onto. A working log that is a strict prefix
  of the committed copy is an `anchor-behind` warning, not a stop. The `started`
  line names the rev and seq this run is held to (`"anchor"`), and the tick line
  carries the comparison it made. Git is read, never fetched. When the log was
  rewritten between the tick's opening read and the check's own read of the file
  (a `log sync` or a records pull replacing `events.jsonl` under the loop), the
  check reads the file again through the same verified read, reports one
  `anchor-reread` warning naming both heads, and the verdict beside it is the
  second read's (APRV-389). Every `anchor-diverged` stop is reached from the
  file's bytes and confirmed by that second read, and its message names the seq
  the chains parted at and both heads without also claiming either chain is a
  prefix of the other.
- ENVELOPE DRIFT — a task file whose `state:` contradicts the log gets an
  `envelope.drift` event (actor `system:daemon`), once per claim.
- TTL SWEEP — every live request whose TTL lapsed gets an `approval.expired`
  through the same `approval expire` the CLI calls; idempotent.
- WRITE-BACK — every task file whose `state:` still disagrees is rewritten to
  match the log, after those appends. A file the writer cannot round-trip safely
  is left alone with a `write-back-refused` warning.
- LOOP ESCALATION — tasks with three consecutive `execution.failed` are reported
  when they escalate and when they clear.
- QUEUE — `.approval/QUEUE.md` is regenerated through the same renderer
  `approval render` uses, temp-then-renamed.

`--tasks` named explicitly and missing is an error; absent by default is a warning
and the daemon runs log-only. `--interval` defaults to 30s and `--debounce` to
250ms. Git-evidence refusals at startup: `git-unavailable` and `log-dir-missing`
exit 4; `log-dir-not-repo` and `log-dir-nested` exit 2.

**Sustained append rate, and what to tune.** The daemon watches the log's
directory and the task folder. Every append from any writer (a hook in another
Claude Code session, a CLI verb, a channel tap) schedules one tick `--debounce`
after the burst settles, and `--interval` is only the floor for a quiet log. With
several sessions appending (the 2026-09-02 incident saw ~20 hook appends per
minute, one every three seconds), the watcher-driven tick is effectively
continuous, so the daemon's CPU is the cost of one tick times the append rate.
One tick against a 10k-record, 6.5 MB log costs about 200 ms after APRV-212
(it was 2.9 s before: one verified read per task file and a quadratic audit
candidate scan; see `docs/postmortem-2026-09-02-daemon-tick-cpu.md`). Most of
what remains is five verified reads, each re-proving the whole file's digest,
so the cost still grows with log size under the default `full` proof; under
`--read-proof incremental` those reads hash only the bytes appended since the
last one. The `tick` line reports `ms`, `reads`, `reproof` and per-phase
`phases` so an operator can see what a tick costs on their log before it becomes
a load problem.

The daemon never wakes itself: the verified-head snapshot it publishes beside
the log, `QUEUE.md`, and its own task-file write-backs are filtered out of the
watcher. Bookkeeping files are filtered too (APRV-230): the append lockfile
`events.jsonl.lock` that every writer creates and removes around each append,
editor swap, autosave, lock and backup files (`.task-042.md.swp`,
`#task-042.md#`, `.#task-042.md`, `task-042.md~`), and macOS's `.DS_Store` and
`._*` residue. Those are events about how a change was made rather than about
the change, and a tick scheduled for one re-derives an answer nothing moved.

**What woke a tick.** Every `tick` line carries `woke_by`: `log` or `tasks` for
the watcher whose event opened the debounce window, `interval` for the periodic
tick, the startup tick and `--once`. When the platform named a file, `woke_file`
carries it. A tick that says `log` at an unchanged head is a watcher event this
runtime has not learned to attribute, which is exactly the question APRV-230
opened; the one wake source left deliberately unattributed is a platform event
that names no file, which is the platform saying "something in this directory
changed" and could be the log itself.

**`--trace-watch`** prints one line per filesystem watcher event, ignored ones
included, and changes nothing else about the run. It is the instrument for "why
is this daemon ticking": each line names the watcher, the platform's own event
type, the file it named (or `null`), whether a tick was scheduled, and, when it
was not, the reason (`self-write`, `own-temp`, `bookkeeping`, `not-the-log`). On
a busy checkout it is several lines per second, so it is off by default and is
meant to be run for a window and counted, not left on. It is spelled the same on
`approval up`.

```
watch: log change events.jsonl — tick scheduled
watch: log rename events.jsonl.lock — ignored (bookkeeping)
watch: log rename verified-head.json — ignored (not-the-log)
watch: tasks change task-042.md — ignored (self-write)
```

If `tick.ms` times the append rate approaches one core, raise `--debounce`
(`1s` to `5s` coalesces a burst of appends into one tick at the cost of that much
latency on drift, expiry and queue updates; hooks do not wait on the tick, they
read the log directly). `--interval` does not help under load, it only bounds
how stale the queue can get when nothing is appending. A tick that stays slow
with the log idle is a bug: file it with the `tick` line's `phases`.

**`--json`** is one object per line on stdout:

```
{"event":"started","log":".approval/log/events.jsonl","tasks":"backlog/tasks",
 "queue":".approval/QUEUE.md","interval_ms":30000,"debounce_ms":250,
 "watching":true,"read_proof":"full"}
{"event":"drift","task":"task-042","file":"backlog/tasks/task-042.md",
 "declared_state":"approved","derived_state":"awaiting","seq":9}
{"event":"expired","action_key":"task-042:chaser","task":"task-042","seq":10}
{"event":"sampled","action_key":"task-042:draft","task":"task-042","seq":11,
 "subject_seq":8}
{"event":"pruned","payload_hash":"<sha256 of the payload>","reason":
 "payload_retention","action_key":"task-042:chaser","task":"task-042","seq":12}
{"event":"rendered","path":".approval/QUEUE.md","bytes":2481,"pending":1,
 "skipped":0,"audit_backlog":0}
{"event":"escalated","task":"task-042","consecutive_failures":3}
{"event":"escalation_cleared","task":"task-042"}
{"event":"advance","outcome":"advanced","records_pending":7,
 "records_branch":"records-log-2026-09-01","range":{"from":4,"to":10},
 "commit":"<40hex>","pr_url":"https://github.com/…","pr_created":true,
 "auto_merge":"armed","auto_merge_note":null,
 "rebuilt":false,"rebuilt_on":null,
 "code":null,
 "message":"seq 4..10 is on records-log-2026-09-01 (…), auto-merge armed",
 "flush":false}
{"event":"watch","watcher":"log","type":"change","file":"events.jsonl",
 "action":"scheduled","reason":null}
{"event":"watch","watcher":"log","type":"rename","file":"events.jsonl.lock",
 "action":"ignored","reason":"bookkeeping"}
{"event":"tick","n":1,"head":10,"drift":1,"expired":1,"escalated":0,
 "ms":41,"reads":8,"reproof":"full","woke_by":"log","woke_file":"events.jsonl",
 "phases":{"drift":9,"ttl":3,"audit":6,
 "dark":0,"prune":1,"write_back":4,"advance":0,"escalations":1,"render":12}}
{"event":"stopped","reason":"SIGINT","ticks":3,"drift":1,"expired":1,
 "renders":3}
{"event":"git_evidence","commit":"a1b2c3d","seq":10,
 "hash":"<sha256 of the head record>","records":2}
```

Warnings go to stderr as `{"event":"warning","code":"...","message":"..."}`, with
`code` one of `task-unreadable`, `frontmatter-invalid`, `envelope-invalid`,
`task-id-missing`, `tasks-dir-unreadable`, `append-refused`, `expire-refused`,
`render-failed`, `watch-unavailable`, `prune-refused`, `write-back-refused`,
`advance-refused`, `dark-session-undetermined`, `anchor-behind`,
`anchor-reread`, `checkpoint-due`, `draw-unavailable`, `sample-deferred`,
`drift-deferred`. A
warning never stops the loop, and neither does
`{"event":"git_evidence_failed","step":"commit",…}`.

Dangling advance cycles (APRV-264): at startup and before every trigger, the
daemon lists every advance execution nobody closed and closes each one this
checkout's refs can prove, appending `execution.completed` with a note naming
the ref and recording that the RUNTIME observed it rather than a person. Each
closure is an `advance` line with `"code":"advance-reconciled"`. What no ref can
prove is nobody's to guess: it is reported once, on the `started` line's
`dangling_advances` array and then in a single `advance-refused` warning if it
appears mid-run, and never once per tick. While any of them stands no further
advance is authorized, and the refusal that says so names every outstanding key
and `approval execution resolve --dangling`, which is also the
`log-advance-cadence` doctor row's `fix`.

Payload retention: with `payload_retention` set in policy, each tick appends
`payload.pruned` and THEN removes the payload file for every payload whose action
has been terminal longer than the duration, and for orphaned store files. With the
key absent nothing is ever pruned. One `pruned` line is emitted per removal that
both appended its event and unlinked its file; a prune whose unlink failed is a
`prune-refused` warning instead. One `sampled` line is emitted per `audit.sampled`
the tick appended, so a supervised action drawn for retrospective review is named
rather than inferred from the queue's backlog. `rendered` is emitted when the queue's summary
CHANGES; the file itself is rewritten every tick, because TTL countdowns move even
when the log does not.

**A sample that met another writer is deferred, not dropped (APRV-381).** The
audit sweep's append is a compare-and-append against the head it read, so it can
meet a lock another writer holds (`lock-timeout`) or a record another writer
landed in between (`head-moved`). Both are reported as `sample-deferred` on
stderr, naming the action key and saying that the sweep retries on the next tick:

```
warning  sample-deferred  audit sampling deferred hook:6f2a:vcs.push.main
  (lock-timeout): another writer holds .approval/log/events.jsonl.lock; gave up
  after 2000ms The sample is NOT lost: it is still pending in the log's own terms
  (eligible, drawn, no audit.sampled yet), and the sweep retries it on the next
  tick.
audit.sampled: hook:6f2a:vcs.push.main drawn for review (execution.started at
  seq 51445) — recorded at seq 51447, the retry of the sample this run deferred
  earlier
```

The second line is the same `sampled` event with `"retry":true` added, and it
appears only when this run is the run that deferred the sample: a restarted
daemon still makes the append, and says nothing about a promise it did not make.
Nothing is remembered across processes because nothing needs to be: the sweep
re-derives the pending set (eligible, drawn by the sampler, no `audit.sampled`
yet) from the verified log on every tick, so a deferral is lost work only if the
daemon never runs again.

Every other append refusal on a sample keeps the `append-refused` form, because
`validation`, `canonicalization`, `corrupt-tail` and `io` are facts about the
record or the file that no amount of retrying repairs.

**A drift record that met another writer is deferred too (APRV-403).** The drift
scan's append is the same compare-and-append against the head it read, and it
met the same contention: the end-to-end test that holds the append lockfile for
a whole tick showed the scan printing `append-refused … (lock-timeout)` for an
`envelope.drift` the next tick went on to write. So the same split applies, from
the same closed list of transient codes, on both drift reasons:

```
warning  drift-deferred  envelope.drift for task-042 was deferred (lock-timeout):
  another writer holds .approval/log/events.jsonl.lock; gave up after 2000ms The
  record is NOT lost: the disagreement is still there in the log's own terms, and
  the scan re-derives it and retries on the next tick.
envelope.drift: task-042 (backlog/tasks/task-042.md) claims state approved, the
  log says proposed — recorded at seq 12, the retry of the record this run
  deferred earlier; the file is repaired to match the log later in this tick
```

The `retry` flag has the same standing as the sample's: it is on the `drift`
event only when THIS run is the one that deferred the record, it is output
bookkeeping that no append consults, and a restarted daemon makes the same
append and claims nothing. Deferring costs nothing because the scan carries no
state between ticks: it re-reads the folder, re-derives the state from the
verified log, and `driftAlreadyLogged` keeps a repeat idempotent.

An `envelope.drift` refused for `validation`, `canonicalization`, `corrupt-tail`
or `io` keeps the `append-refused` form it always had.

**The sweep waits `2000ms` for the lock and no longer, by decision.** The daemon
is the one writer that could afford a longer wait and deliberately takes the
default. A tick is serial, so a blocking wait here delays the expiry lines, the
`state:` write-back and `QUEUE.md`; the writers it contends with hold the lock
across spans no polite wait covers (`approval log advance` across a whole
verify-and-commit, `approval log sync` across a baseline move); and the appends it
would be muscling in front of are the ones somebody is waiting on, a hook's gate
verdict or a lane's execution record. Deferring costs one line and at most one
tick interval, and it is provably lossless. Raise `--interval` only if you want
the retry later; there is no flag for the lock wait, on purpose.

## up

**Normal startup after setup and human attestation.** Run from the intended
policy project's directory, load its environment explicitly, then leave this
foreground process running:

```sh
cd /path/to/your/project
eval "$(approval env)"
approval up
```

For a source build, replace `approval` in both commands with
`node /path/to/approval.md/cli.js`. `--as human:<id>` may name the configured
approver explicitly; it does not perform identity setup or policy attestation.
`up` reads credentials from its launch environment and does not load
`.approval/env`. Existing exported approval variables take precedence over that
map, so use a clean shell or unset another instance's variables first. Changing
only `--dir` selects the policy; it does not relocate every log, environment or
task path. Starting in the intended project keeps the default paths together.

**Startup messages describe separate parts.** The default task directory is
`backlog/tasks/`. If envelopes live elsewhere, pass
`--tasks /path/to/existing/task-folder`. The daemon scans regular `.md` files
immediately inside that directory, without recursion; an empty default folder
does not cover envelopes in nested bundle directories. A missing default folder
warns about absent drift coverage while TTL sweeping and queue rendering still
run. An explicitly supplied missing directory is an error. `watch-unavailable`
reports a failed watcher; the daemon still scans on its interval. Neither
warning proves Telegram failed: check the channel's own startup line.

A `live-draw` doctor failure needs a daemon serving this instance's draw socket.
`up` starts that daemon, but serving draws also requires a `supervised-live`
policy class and the configured sampling secret resolved in this process's
launch environment, with `--no-draw` absent. Starting `up` alone cannot supply a
missing secret. Without usable draws, every supervised-live action gates to a
human. A policy with no `channels.web.port` and no explicit `--port` serves no
web queue; that informational message is legitimate configuration.

Stop `up` before running Telegram setup or a standalone listener for its bot.
One bot must have one polling runtime. After setup changes, reload the instance
environment before starting `up` again.

**Two refusals keep one bot to one instance (APRV-390).** Both are made before
the daemon's first tick and before the first poll, and both exit 1 with a
machine-readable code on stderr:

| code | what it means |
| --- | --- |
| `cross-instance-credential` | A credential variable holds a value this instance did not configure: an `.approval/env` line naming another instance's keystore item, or an export whose value is not what this instance's file resolves to today. The message carries the `unset` line that fixes it. |
| `bot-owned-elsewhere` | One `getMe`, before any `getUpdates`, named a bot another instance on this machine has already claimed. The message names that instance's directory. |

`--allow-cross-instance` overrides both, starts, and prints on every run what it
is overriding. Until APRV-390 the first of these was a warning printed on the
way past a runtime that had already started, which is how a demo gate spent an
evening polling the primary's bot.

The first refusal COMPARES VALUES rather than only reading names, because it is
the one check that is about to use the value. That closes the case names cannot
see: `approval env` never overrides a variable this shell has already exported,
so a token re-stored in the keystore does not reach a terminal holding the old
one, and the daemon answers 401 while the same line read by hand passes `getMe`.
It also removes a false positive — an export whose value IS what the file
resolves to is correct however it got there, so the documented `eval "$(approval
env)"` is not a finding. `approval doctor` keeps the name-only rule; a
diagnostic may not block on a keystore-unlock dialog. No value is printed on any
path.

The `getMe` result is recorded against the instance in
`.approval/channel-owner.json` (gitignored) and in a per-machine registry under
the platform's user state directory, `approval/bots.json`. `APPROVAL_STATE_DIR`
relocates that registry. A bot is identified by its id AND its Bot API base,
because an id is unique within one deployment and nothing more: two gates
pointed at two different `--api-base` values hold two different bots and neither
refuses the other. Neither file is evidence, nothing reads them to widen a
permission, and losing them costs one `getMe`. An unreachable Bot API is not a
refusal: it says so and starts, because a captive portal is also a `getUpdates`
that cannot conflict with anything.

A 409 that still happens at runtime — another machine, or a poller started
outside this runtime — is reported once, with the instances the registry knows
about, and its repeats are counted rather than reprinted.

**The ambient runtime: the daemon loop and every configured channel in one
supervised foreground process.** `approval daemon run --with-channels` is the
same verb spelled from the other side, and it reaches the same function before
either flag table is parsed, so there is one code path and two spellings.

**No logic lives in this verb.** The loop is the same `Daemon`, the dispatch
cycle is the same `dispatchPending`, and the queue page is the same
`startWebChannel`. What `up` adds is supervision: which parts to start, what to
do when one falls over, and how to stop them all at once. That is why the tests
for it compose the daemon and telegram suites rather than restating them: the
question is whether the parts behave identically in one process, and a test that
described new behaviour would be answering a different question.

**A preflight runs before anything starts (APRV-215).** Deploying a fix in the
primary checkout used to take four hand-run steps: `git fetch`, a judgment about
whether the upstream commits touched `.approval/log/events.jsonl` while the
working log was dirty, `git pull --ff-only`, and `npm run build`. Three of those
are typing; the second is the one a human cannot make from `git status` alone,
because `git status` does not say what the upstream range changed. So the verb
does all four, and `approval daemon run` runs the identical preflight from the
identical module, printing the identical two lines.

It is allowed exactly four writes: a `--ff-only` merge, `npm run build`,
clearing an untracked `backlog/tasks/` file the incoming commit already contains
out of the merge's way (APRV-300, described below), and the reconcile `approval
log sync` performs on its behalf (APRV-346, described below). It
never resets, never stashes, never checks anything out, and never touches the
working log itself. That list is not caution for its own sake: a working
`events.jsonl` rewound through git underneath a live appender is fork 2 of
2026-08-20, the incident `approval log sync` exists to prevent, which is why the
one write that does move that file is made by that verb and by nothing here.

**Safe** means both of: this checkout is not AHEAD of the remote, and no path the
upstream range changes is locally modified. When it is safe, the preflight
fast-forwards, rebuilds if `dist/` is older than `src/`, and names the commit now
running. When it is not, it refuses, and changes nothing:

| code | fires when | next |
|---|---|---|
| `up-preflight-behind-ahead` | `origin/<branch>..HEAD` is non-empty: this checkout carries commits the remote has never seen. A fast-forward is not the operation for that state, and choosing a side is a decision. | look at them (`git log --oneline origin/main..HEAD`), then push them or `git reset --keep` |
| `up-preflight-log-diverged` | the upstream range rewrites `.approval/log/events.jsonl` or `.approval/QUEUE.md`, this working copy has uncommitted changes to one of them, and the two chains are **not** in a prefix relationship (or cannot be compared at all). The judgment a human could not make by eye. A working log that merely extends the committed one is reconciled instead, see below. | `approval log sync` |
| `up-preflight-dirty-protected` | some other path the upstream range changes is locally modified, so `git merge --ff-only` would refuse rather than overwrite it. | look at the diff, or `approval up --no-preflight` |
| `up-preflight-task-file-conflict` | an untracked file under `backlog/tasks/` stopped the fast-forward and it holds lines the incoming copy does not. Which version is wanted is a question, and no verb here will pick. | read the two copies, move yours aside, run `approval up` again |
| `up-preflight-failed` | a write the preflight attempted did not complete: the fast-forward, or the rebuild. Not a judgment, so it is not in the union above; the message names the step, and for a build it names the exit code `npm run build` came back with. | `npm run build` to see the whole error, or `approval up --no-build` if you mean to run the stale one |

**A working log that merely extends the committed one is reconciled, not
refused (APRV-346).** Every records advance moves `origin/main`'s
`.approval/log/events.jsonl` while the hook keeps appending locally, so
"upstream changed the log and so did this working copy" is the normal state of
the primary checkout after a merge. Refusing it sent the operator to `approval
log sync` and then back to `approval up`, every time. So the collision is a
question now: `core/log-reconcile.ts` — the same comparison `log sync` and
doctor's `log-drift` row use — is asked how the working chain stands to the
committed chain at the fetched tip, and:

- **`ahead`, `behind` or `equal`** — one chain contains the other whole, so
  adopting the longer one extends and rewinds nothing. The preflight calls
  `approval log sync` itself, which holds the append lock for its whole ceremony
  (snapshot, baseline, fast-forward, reconcile, rebuild the projections,
  post-verify), and prints one line: `synced: fast-forwarded to origin/main
  <sha>, kept K local records`. The `--json` stream carries it as a
  `preflight_sync` event and the `preflight` line's `log_synced` reads true.
  Nothing here reimplements any of that ceremony; it supplies a caller for it;
- **`diverged`** — two appenders built different records on one predecessor.
  Hash chains do not merge, so this is the `up-preflight-log-diverged` refusal
  above, unchanged, and it is now the **only** case that needs a hand-run
  `approval log sync` (which will tell you the same thing, at more length).

Four conditions have to hold before the reconcile is even offered, and each of
them answers "refuse" rather than "probably fine": the log is the repository's
own `.approval/log/events.jsonl` (not some other file named with `--log`), no
*other* path the upstream range touches is locally modified, both chains verify
clean, and the relation is a prefix one. A `log sync` that refuses anyway — an
appender that took the lock first (`log-sync-locked`), a fork that landed
between the read and the ceremony, a git failure — comes back as the same
`up-preflight-log-diverged` refusal with the sync's own code and sentence in
YOUR STATE. Nothing starts, and the working log is exactly as `log sync` found
it.

**An untracked task file no longer stops it (APRV-300).** A lane files
`backlog/tasks/aprv-299` on its branch and its pull request merges, while the
primary checkout holds the same path untracked from its own `backlog task
create`. `git merge --ff-only` will not write over an untracked file, so on
2026-09-07 the preflight refused, and its next-steps text pointed at `git
status`, which cannot say whether the local copy holds anything the incoming one
does not. That question is answerable, so it is answered. When the merge fails
over untracked files and every path git names sits under `backlog/tasks/`, each
one is read alongside `git show <target>:<path>` and given one of three
verdicts:

- **byte-identical** — the local copy says nothing the incoming copy does not,
  so it is removed and the merge is retried once;
- **every line also in the incoming copy** — the ordinary shape, a hand-filed
  stub against a lane copy that added a plan and criteria. Nothing is lost by
  letting the incoming copy land, but that is a judgment about an operator's
  file, so the bytes are moved to a sibling of the checkout named
  `<repo>-preflight-aside-<YYYY-MM-DD>` (outside the repository, so the next
  fast-forward cannot collide with it again), the destination is printed on the
  `preflight_warning` line, and the merge is retried once;
- **anything else** — `up-preflight-task-file-conflict`, naming your path, the
  incoming spelling, and how many lines only yours has.

Every file is judged before any file is touched, the same two-pass shape as
`approval log sync`'s payload reconciliation, so a refusal over the last
collision cannot have already removed the first. One path outside
`backlog/tasks/` and the whole set is declined: the merge keeps its old
`up-preflight-failed` refusal and nothing is cleared, because clearing what was
understood and then refusing anyway would have moved files for a merge that was
never going to run. A path git chose to quote (`core.quotePath`) is declined for
the same reason: guessing the spelling of a file about to be moved is the
mistake the whole check exists to avoid.

**`git reset --hard` is printed on no path, ever**, and a test asserts it. The
one reset that appears is `--keep`, which refuses rather than discarding
uncommitted work, and it is the third step of a runbook whose first step is to
look at what would be dropped. A refusal is rendered in the APRV-129 runbook
shape — code, YOUR STATE, NEXT STEPS with one runnable command per line — and
exits 1, "the runtime decided", rather than 4: nothing failed to read or write,
and a supervisor that read this as an I/O fault would retry a checkout state only
a human can resolve.

**A fetch that fails is weather, not a fault.** A laptop with no network still
has a local log, a local policy, and a human holding the phone. The failure is a
warning on stderr, the runtime starts on the build it already has, and the
`preflight` line says `"action":"fetch-failed"`.

**Where there is no question to ask, it says nothing.** Outside a git checkout,
or in a repository with no `origin` configured (a `--git-evidence` log home, a
bare `git init`), the preflight skips and prints no line at all: "there is no
origin here" is a property of the deployment, not an event in it, and a log-only
install would otherwise open every start with it. `approval doctor`'s
`main-behind-origin` row is where that state is visible.

**The rebuild is the deploy (APRV-301).** The freshness question is the same one
`approval doctor`'s `build-freshness` row answers, from the same predicate in the
same module, so the two cannot disagree: is `dist/src/cli/main.js` at least as
new as everything under `src/` and `tsconfig.json`? When it is not, the preflight
runs `npm run build` in the installation root, with the compiler's output on the
terminal so a slow build is visible and a failing one is readable. (The build's
stdout is written to stderr, because under `--json` this process's stdout is the
event stream and a compiler line in it would break every consumer.) A build that
fails refuses with `up-preflight-failed` and the exit code `npm run build` came
back with; nothing starts, since starting would put the writer on exactly the
code the rebuild existed to replace. Staleness alone is enough, with or without a
fast-forward: an editor, a branch switch or a half-finished build leaves `dist/`
behind `src/` just as a merge does, and the daemon and the harness hook run the
compiled code either way.

`--no-build` opts out of the rebuild alone. The fetch and the fast-forward still
happen; `dist_stale` still reports the truth; the action reads `build-skipped` or
`fast-forward+build-skipped`; and a warning on stderr names the stale build in
words. An operator can mean this. Nothing in the output lets it pass for a clean
start.

`--no-preflight` opts out of all of it, on both spellings of the verb.
`--preflight-remote` and `--preflight-base` default to `origin` and the
checked-out branch. The `--json` stream gains two additive lines and no field on
any shape that already existed:

```
{"event":"preflight_warning","message":"…"}
{"event":"preflight","commit":"<sha>","detail":"…","behind_by":3,"ahead_by":0,
 "log_touched":false,"dist_stale":true,"action":"fast-forward+rebuild",
 "reexec":true}
```

`action` is one of `none`, `rebuild`, `fast-forward`, `fast-forward+rebuild`,
`build-skipped`, `fast-forward+build-skipped`, `refused`, `skipped`,
`fetch-failed`. The two `build-skipped` spellings are `--no-build` and only
`--no-build`: without it, a `dist_stale` of `true` always ends in a rebuild or a
refusal. The commit now running is named here rather than on `up_started`, so a
consumer that already parses `up_started` does not have to learn a new key to
keep working. A refusal writes one object to stderr
instead: `{"error":{"code":…,"message":…,"next":…},"preflight":{…}}`.

**A rebuild re-execs, so the writer that ends up running is the code that was
merged.** Node loads its module tree at startup, so a `npm run build` that
replaces `dist/` underneath a live process changes nothing about what that
process is executing. Carrying on there would start the daemon on exactly the
code the fast-forward was meant to leave behind, which is the defect this verb
exists to remove. So when the preflight rebuilds, it does not continue: it
spawns the freshly built `dist/src/cli/main.js` — resolved from the checkout
root, never from the module that is running, which is the stale tree by
definition — with the same argv plus `--no-preflight`, the same cwd and
environment, and `stdio` inherited. SIGINT and SIGTERM are forwarded to the
child, and the verb exits with the child's exit code. The `preflight` line
carries `"reexec":true` and is printed by the parent before the handover, since
the child has nothing to say about a fast-forward it did not perform; the human
line reads `… and rebuilt; now running <sha>, in a fresh process on the new
build`. `--no-preflight` on the child is the loop guard and the honest setting
both: the checkout is already current.

`dist_stale` is judged **after** the fast-forward as well as before it. A merge
that lands three days of `src/` is precisely what makes a build stale, and the
pre-merge answer would miss it. (`approval doctor`'s row reports the pre-merge
answer, because doctor merges nothing.)

**The daemon settles the verb; a channel never does.** A channel is a network
client and the daemon is not. A Bot API that starts refusing sends must not stop
TTL expiry, write-back or the queue projection, so a channel that falls over is
reported and restarted after a doubling backoff (from `--restart-backoff`,
default 1s, capped at 60s) while the daemon loop carries on. There is no attempt
limit, for the reason `dispatchPending` has no send limit: giving up would turn
an outage into a pending request no human ever sees. A part that ran for a minute
before failing is counted as a fresh failure rather than the next rung of a crash
loop, so an hour-old listener that hits a network blip retries in a second.

The daemon's own failure does stop everything. An unreadable log, a torn tail or
a chain that does not verify ends the channels too: a queue page and a chat
prompt derived from a log nobody could verify would be a statement to a human
about facts the runtime disowns.

**A restart re-sends; it never silently drops.** Each attempt builds a fresh
dispatch state, so a restarted listener re-derives the pending queue from the
verified log and sends everything still pending, exactly as a restarted process
would. Delivery bookkeeping is in-process memory by design, and a duplicate
prompt on a phone is a recoverable annoyance where a silence is not.

**Fail closed, then carry on.** A channel that cannot start at all is not
started: a credential variable the policy names is unset, or no human identity
was declared. The refusal is reported in `approval doctor`'s own vocabulary (a
`check`, a `skip`, a `detail`, a `fix`) rather than in a second vocabulary for
the same fact, and the parts that can run do. Refusing to run the daemon because
Telegram was unconfigured would withhold the projection over a channel nobody
asked for; starting a half-armed runtime that said nothing would be the failure
this project exists to prevent. A mistyped `--poll-timeout` or an unreadable
`--payloads` is a different thing and is refused outright: that is an operator
error, not an unconfigured machine.

**Credentials come from the launch environment and from nowhere else.** SPEC.md
§11.1 invariant 7 holds here as everywhere: nothing loads `.approval/env`
implicitly. The bot token, the chat id and the approver identity are read from
the environment the operator started this process with, through the same
resolvers the separate listener uses. `approval setup service` writes a unit that
either evaluates `approval env` in a wrapper the human reads or names an
`EnvironmentFile` the human wrote.

**The `--json` stream is an additive union.** Every line is one of three kinds: a
`DaemonEvent` verbatim, a listener line verbatim (`notified`, `decision`,
`annotated`, `listening`, `stopped`), or one of this verb's own supervision lines
(`up_started`, `part_started`, `part_unavailable`, `part_failed`,
`part_restarted`, `part_stopped`, `up_stopped`). No field is added to a shape
that already existed, so the decision object and the token panel are byte-
identical to the ones the separate processes print, because the same functions
print them. The one shape that appears twice is `stopped`: the daemon's carries
tick counters and a channel's carries delivery counters, and renaming either
would have broken a stream an operator already parses.

`--once` is one daemon tick and one poll cycle. The daemon's tick finishes in
milliseconds and the channel's poll takes as long as the long poll does, so the
fast part waits for the slow one rather than cutting it short. The queue page is
a pull channel with no cycle to run, so `--once` does not serve one.

It accepts every `daemon run` flag unchanged, `--read-proof`,
`--full-reproof-every` and `--full-reproof-after` included, parsed by the same
functions so a typo is refused in the same words on both spellings. The mode it
resolves to governs every reader in the process — the loop's tick reads and the
queue renderer's alike — and is printed on the `started` line.

Like `daemon run`, it does not fork, write a pidfile, or manage its own
lifecycle. `launchd` and `systemd` do that better, and `approval setup service`
is the verb that hands them the unit.

## vault

**There is no `approval vault get`**, and it is not an oversight. A verb that
printed a credential would put it in a terminal, a scrollback buffer, a CI log
and — through the shell that ran it — a history file. A credential's only
sanctioned journey is from the vault into an adapter, inside the verified
execution window the adapter contract holds open. Manual and selected-live
paths verify and consume a token; an attested class rule may explicitly
authorize an irreversible supervised or autonomous path. Names are visible;
values are not.

**What the vault DEFENDS:** credentials at rest, and casual reads by an agent
that can read files in the working tree — the ciphertext hides the NAMES as well
as the values.

**What it does NOT defend** (SPEC.md §11, plainly): a compromised host, and an
agent that can read the passphrase variable. That agent does not need this CLI;
it can decrypt the file itself. Keep the passphrase in an operator-held
environment and outside every agent-readable path.

All three subcommands are human-only, exactly as `policy attest` requires.
Identity is declared, not proved; the check is what stops an agent's tooling from
storing or deleting a credential in passing.

The file is AES-256-GCM over a JSON map of name -> credential, under a key
derived by scrypt (N=16384, r=8, p=1, 32-byte key) from a passphrase read from
the environment variable named by the policy's `vault.passphrase_env`. The policy
carries the variable NAME and never the value, the same convention as
`channels.telegram.token_env` and `audit.sampling_secret_env`.

**Appends nothing to the log.** A credential's existence is configuration, not an
authorized action, and a log line naming the credentials an operator holds would
be a map of the machine's reach written into the one file this project promises
never to rewrite.

## vault set

The value is never a command-line argument: a secret on a command line is a
secret in the shell history and in `ps` output for the length of the call.

One trailing newline is stripped from stdin and nothing else: interior whitespace
is preserved, because some tokens legitimately contain it and a silently trimmed
credential fails at the far end with no local evidence of why. An empty value is
refused rather than stored.

Every write re-encrypts the whole map under a fresh nonce and lands atomically
(temp file at mode 0600, then rename), so an interrupted write leaves the
previous vault intact and two writes of the same value never produce the same
bytes on disk.

The value comes from stdin:

```
pass show smtp/app | approval vault set smtp-password
approval vault set api-key <<'EOF'
sk-live-…
EOF
```

or from a variable named with `--value-env`:

```
APPROVAL_TMP_SECRET="$(op read op://vault/item/field)" \
  approval vault set api-key --value-env APPROVAL_TMP_SECRET
```

**`--json`** (one object on stdout):

```
{"ok":true,"name":"smtp-password","created":true,"count":2,
 "path":"/…/.approval/vault.enc"}
```

`created` is false when the name was already present and has been replaced. The
VALUE appears in no field, on either the success or the failure path.

## vault list

A vault nobody created is a state, not a fault: when the file does not exist this
says so and exits 0. A runtime driven by `approval run` and the CLI channel never
needs a credential, exactly as a runtime with no Telegram configuration is
healthy without one. The passphrase is not read in that case, so an absent vault
reports absent rather than complaining about an unset variable.

A wrong passphrase and an altered file both refuse `vault-unreadable` and are not
distinguished: a runtime that told you which would let someone confirm a guessed
passphrase against a file they had modified.

**`--json`** (one object on stdout):

```
{"ok":true,"present":true,"path":"/…/.approval/vault.enc","count":2,
 "names":["api-key","smtp-password"]}
{"ok":true,"present":false,"path":"…","count":0,"names":[]}
```

The second form is a vault that does not exist.

## vault remove

A name the vault does not hold refuses `credential-absent` rather than reporting
success: an operator removing a credential wants to know whether they removed the
one they meant.

Removing a credential an adapter still needs makes that adapter refuse
`credential-unavailable` at execution time. Nothing here checks for that, because
the check would require this verb to know every adapter a machine might run.

**`--json`** (one object on stdout):

```
{"ok":true,"name":"api-key","count":1,"path":"/…/.approval/vault.enc"}
```

## adapter

An adapter is the hard boundary of SPEC.md §10.4: it holds the credentials while
the runtime recomputes the payload hash and applies attested policy. Manual and
selected-live paths require a valid, unexpired, single-use execution token bound
to the action's `idempotency_key` and `payload_hash`. An explicitly opted-in
supervised or autonomous path has no grant and mints no token, so `--token` is
optional at the command boundary.

Credential custody does not become implicit on the no-token path. The vault
passphrase must already be present in the adapter process environment. The
`.approval/env` source-map fallback remains available only inside a real token
window: it rejects a null grant and a consumed nonmanual execution carrying no
token digest. This lets an operator authorize nonmanual execution without
giving an agent a new way to load credentials.

The runtime, not the adapter, owns the sequence: recompute the payload hash,
read the declared class from the verified log, check policy eligibility or the
manual token without appending a start, resolve the credentials the adapter says
it cannot act without, run the adapter's own pre-token check, then recheck policy
and, on a manual path, verify and consume the token, append
`execution.started`, call the adapter, append the outcome. The adapter implements
one method and cannot skip a step, because it never holds the sequence.

`supervised-live` selection still belongs to `approval request`. On a direct
no-token invocation with no earlier approval cycle, the adapter contract runs
that existing intake path from the verified declaration before it touches a
credential. A selected or unavailable draw records the ordinary pending cycle
and stops for its token. The request retains the exact already-hashed payload
through the normal payload store, so the selected human sees the bound bytes.
An unselected draw appends no approval event and continues, bound to the same
attested policy digest through eligibility and start. Once any cycle exists,
including a rejected or expired one, the contract never redraws it.

The two steps that sit before authorization starts the execution are there for one reason: a
condition that makes the side effect impossible, and that the runtime can
establish without attempting it, must not cost a human's single-use grant to
discover. A credential nobody stored refuses `credential-unavailable`; whatever
the adapter's own check refuses arrives as `adapter-precheck-refused` with the
adapter's reason in `adapter_code`. Both leave the log exactly as they found it,
`acted` is `false`, there is no `started_seq` and no `outcome`, and the same
token executes once the condition is repaired. On an admitted nonmanual path,
there is no token to preserve and the same preflight still appends nothing.

The pre-token check is offered only bytes the log binds to the action: the
grant's `payload_hash` on the manual path, the registered declaration's off it.
Anything else never reaches an adapter at all and is refused `payload-mismatch`
by the runtime, in the runtime's own words, with nothing appended and the token
still live.

Which outcome is decided by where the sequence stopped, and the boundary is the
moment `act` is invoked. A failure on the way in, or a failure the adapter
RETURNS, is `execution.failed`: nothing was attempted, or the provider answered
no. A throw from inside `act` is `execution.indeterminate`: the provider may or
may not have committed and this runtime cannot tell. The refusal's `code` is
`execution-indeterminate`, its `outcome` is `execution.indeterminate`, it carries
no `exit_code`, the token and the idempotency key stay burned, a retry is refused,
and `approval execution reconcile` is how a person resolves it. Recording an
unknown outcome as a failure is what makes a retry look safe, and a retry against
a send that did happen is a second email.

**`observe`, the optional read** (APRV-245). An adapter may also publish what its
PROVIDER recorded happening in a window, which is what lets `approval coverage`
witness an adapter-backed class. It is the mirror of the rule above: read-only,
called with NO token and outside any grant window, because reading what already
happened authorizes nothing. The caller redacts every returned detail a second
time, and a detail line names an effect for a person to recognize (a subject, a
recipient count, an id) and never a message body: the report is read by somebody
who did not approve the message. Every returned effect carries a class the
adapter serves, and the conformance suite checks all of it — no write to the far
side, no throw, no record appended — for any adapter that implements it. An
adapter that omits `observe` is conformant and is reported as offering no
observation, which is a gap a reader can see rather than a pass.

## adapter email

`bcc` is inside the hash and appears in no header: a blind recipient is still a
recipient, and an approval that did not cover them would approve a different act.
Addresses are plain ASCII `local@domain` — no display names, no angle brackets,
no internationalized addresses (this client does not negotiate SMTPUTF8). Unknown
keys are refused rather than ignored.

Two fields are stamped by the runtime and are not part of the hash. `Date` is the
moment of the send: the grant binds the message CONTENT, and a Date inside the
payload would make every grant expire into a `payload-mismatch` as soon as the
clock moved. `Message-ID` is SHA-256 over the action key and the payload hash at
the From domain — deterministic, so an operator holding the log can recompute the
exact Message-ID the far side saw and trace a bounce back to an approval.

`smtp.security` "starttls" is a MANDATORY upgrade: a server that does not offer
it is a failure, never a silent downgrade. A credential is never sent over
"none". Storing neither `smtp.user` nor `smtp.password` means an unauthenticated
relay; storing exactly one is refused, because sending unauthenticated because
half a credential is missing puts the message on a path nobody configured.

No credential value reaches the log, this command's output, or an error message:
the adapter scrubs every diagnostic it builds, and the contract scans everything
the adapter returns for the values it handed out and redacts them again.

The payload, whose RFC 8785 canonical hash is what the grant approved:

```
{"from":"a@example.com","to":["b@example.com"],"cc":[…],"bcc":[…],
 "subject":"…","body":"…","content_type":"text/plain"|"text/html"}
```

There is deliberately no flag that takes the message inline: a body on a command
line is a body in the shell history. `--timeout` is the whole-SMTP-session budget
in milliseconds (default 30000), and exceeding it is recorded as
`execution.failed` with `smtp-timeout`. A non-ASCII body is sent
quoted-printable and a non-ASCII subject as RFC 2047 encoded-words; an all-ASCII
body is sent 8bit, byte for byte as approved.

**Failure codes** (in `adapter_code`):

- `email-payload-invalid` — the approved bytes are not a well-formed email.
- `email-config-invalid` — the vault holds unusable SMTP configuration.
- `credential-unavailable` / `credential-refused` — the vault could not supply a
  name. Nothing was sent.
- `smtp-connect-failed` / `smtp-tls-failed` / `smtp-timeout` /
  `smtp-protocol-error`.
- `smtp-<NNN>` — the server refused a verb; NNN is its own reply code
  (`smtp-535` authentication, `smtp-550` mailbox, …).

**`--json`** carries the adapter contract's own result, unmodified. On a completed
send, on stdout:

```
{"ok":true,"adapter":"email","action_key":"…","task":"…","class":"…",
 "autonomy":"manual","payload_hash":"<64hex>","started_seq":N,
 "outcome":"execution.completed","outcome_seq":N,"exit_code":0,
 "detail":{"message_id":"<…>","recipients":N,"bytes":N,"secure":true,
           "auth":"PLAIN","smtp_code":250,"transcript":[…]},"redactions":0}
```

On a refusal, on stderr:

```
{"ok":false,"code":"…","message":"…","adapter":"email","action_key":"…",
 "acted":true|false,"started_seq":N,"outcome":"execution.failed",
 "outcome_seq":N,"exit_code":1,"adapter_code":"smtp-550","redactions":0}
```

## adapter agentmail

The second executor of `communicate.email.external`, over the AgentMail HTTPS
API. Both adapters serve the class, and which one an action reaches is which verb
the caller runs; the credential scrub in front of `approval run` therefore lets
the union of both declarations through, which is the honest superset rather than
a guess between them.

The enforcement model it assumes is a split pair of keys. AgentMail keys carry
`draft_create`, `draft_update`, `draft_read`, `draft_send` and `message_send`
separately. The agent gets a key WITHOUT the two send permissions, so it can
compose all day and cannot send; the key WITH them goes in the vault under
`agentmail.api_key`, readable only inside the contract's execution window. On a
nonmanual path, opening the encrypted vault requires its passphrase in the
adapter process environment; the token-scoped source-map fallback does not run.
`approval setup adapter agentmail` stores that pair, and
`approval payload agentmail-draft` is the composing side's own verb.

Two payload modes, told apart by the keys they carry, and a payload carrying
markers of both is refused rather than guessed at: choosing a send mode by
inference is choosing a side effect by inference.

```
direct  {"from":…,"to":[…],"cc":[…],"bcc":[…],"subject":…,"body":…,
         "content_type":"text/plain"|"text/html"}
draft   {"inbox_id":…,"draft_id":…,"to":[…],"cc":[…],"bcc":[…],
         "subject":…,"text":…}
```

A direct send costs one extra read. AgentMail's send endpoint has no `from`
field — the inbox is the sender — so an approved `from` would otherwise be a
claim nothing checked. `GET /v0/inboxes/{inbox_id}` runs first, the approved
`from` is compared with the inbox's own address case-insensitively, and a
mismatch is `agentmail-from-mismatch` with nothing sent. That read doubles as the
credential check: a key that cannot open its own inbox should not discover it by
half-sending.

A draft send re-reads the draft and canonicalizes the approved fields on both
sides before calling `POST .../drafts/{draft_id}/send`. The refusal names WHICH
fields differ and never what they now hold: a drift message is written to a log
and read by a human who did not approve the new text, and quoting it there would
publish unapproved content through the refusal path.

That comparison happens twice, and the first time is before the token is spent
(APRV-276). In order, for a draft send: the payload's shape, the inbox it names,
`GET .../drafts/{draft_id}`, and the field comparison, all as the adapter's
pre-token check, with the sending key read from the vault in the same pre-token
window the declared credentials resolve in. A drift there refuses
`adapter-precheck-refused` with `agentmail-draft-drifted` in `adapter_code`,
appends nothing, and spends nothing, so restoring the approved text and running
the command again sends under the same token. Then the token is consumed,
`execution.started` is appended, and the whole comparison runs a second time
inside the window, immediately before the POST: AgentMail sends a draft by id, so
something has to bound the gap between the last read and the send. A drift caught
by that second comparison is `adapter-failed` with `execution.started` and
`execution.failed` on the log, which is the honest record of a window that was
open when the far side moved. A direct send has no such object and pays for no
pre-token read: its bytes are the payload, and the payload hash binds them.

**Failure codes** (in `adapter_code`): `agentmail-payload-invalid`,
`agentmail-payload-ambiguous`, `agentmail-config-invalid`,
`agentmail-inbox-mismatch`, `agentmail-from-mismatch`,
`agentmail-draft-missing`, `agentmail-draft-drifted`, `agentmail-unreachable`,
`agentmail-unauthorized`, `agentmail-not-found`, `agentmail-conflict`,
`agentmail-rate-limited`, `agentmail-rejected`, `agentmail-server-error`, and
the contract's own `credential-unavailable` / `credential-refused`.

Every HTTP refusal inside the window is a returned failure, so the contract
records `execution.failed`: the far side answered, and an answer is knowledge. A
throw from the SEND call is deliberately not caught, and
`execution.indeterminate` is the honest record of a request that may have left
the process. A throw from either pre-send GET is `agentmail-unreachable`, because
nothing was attempted. The draft read that runs before the token is spent follows
the same mapping into its own `adapter_code` (`agentmail-draft-missing`,
`agentmail-server-error`, `agentmail-unreachable`, and the rest), and the
difference is only that it appends nothing and leaves the grant spendable.

**`--json`** carries the adapter contract's own result, unmodified, exactly as
`adapter email` does, with `"adapter":"agentmail"` and a `detail` of
`{"mode":"direct"|"draft","message_id":…,"provider_ref":…,"thread_id":…,
"payload_hash":…,"recipients":N,"http_status":N}`. `provider_ref` is the same
string as `message_id`, under the one key the adapter contract lifts onto
`execution.completed` (APRV-251), and the result repeats the recorded reference
as `"provider_ref":{"adapter":"agentmail","id":…}` beside the detail. A send
whose answer names no id carries neither.

## adapter zzz

Creates a zzz.bot thread or reply for `communicate.zzz.external`. The only
credential is `zzz.agent_token`, an invited principal token with write scope.
It is read from the vault inside the shared execution window and sent only as an
Authorization Bearer header. `--token` is required for manual or selected-live
execution and omitted for an explicitly policy-authorized supervised or
autonomous execution. On the no-token path, the vault passphrase must already be
present in the adapter process environment.

This verb is available from a source checkout containing APRV-320 until the
next approval.md package release. npm `approval-md@0.1.0` predates the adapter;
this change does not publish a package.

The contract implemented here is zzz.bot API v0.1.0: [quickstart](https://zzz.bot/quickstart),
[API guide](https://zzz.bot/api), [approval semantics](https://zzz.bot/approval),
and [OpenAPI](https://zzz.bot/openapi.json).

The payload is a strict tagged union:

```json
{"environment":"production","operation":"create_thread",
 "room_id":"<room-id-from-GET-api-v1-rooms>","title":"…","body":"…",
 "metadata":{},"tags":["…"],
 "references":[{"kind":"external","target":"https://example.com/source",
                "label":"Source","relationship":"source"}]}
{"environment":"preview","operation":"create_reply",
 "thread_id":"…","body":"…","metadata":{},"tags":["…"],"references":[]}
```

`environment` is exactly `production` or `preview`; operation is exactly
`create_thread` or `create_reply`. Reference `kind` and `relationship` use
the alternatives shown above. Unknown keys are refused. Bodies are 1 to 65,536
characters, titles 1 to 200, tags at most 10 strings of 1 to 40 characters, and
references at most 20. The entire canonical message JSON must fit 65,536 UTF-8
bytes, so a maximum-length body can exceed the request limit once its other
fields and JSON encoding are included.
External reference targets must be HTTP or HTTPS URLs. All optional values that
are present remain inside the bound payload and are sent unchanged.

The message fields are deliberately flat beside the operation tag and target.
This keeps the payload a person reviews close to ZZZ's request body. The adapter
removes only `environment`, `operation` and the target id when building the
POST body; every content field remains byte-for-byte represented in the
canonical JSON sent to ZZZ.

`production` routes to `https://zzz.bot` and `preview` to the fixed preview
service. There is no API-base flag. Thread creation posts to
`/api/v1/rooms/{room}/threads`; replies post to
`/api/v1/threads/{thread}/posts`. Redirects are rejected. The
`Idempotency-Key` is deterministic SHA-256 over the RFC 8785 form of the
approval action key and payload hash, so the provider's retry identity binds the
same action and exact bytes.

HTTP 201 is accepted only with `{"id":"thr_…"|"pst_…","replayed":false}`,
and HTTP 200 only with the same operation-appropriate id and `replayed:true`.
The validated service id becomes `provider_ref`. A malformed or inconsistent
success, transport error, redirect, or 5xx is `execution.indeterminate` because
the POST may have committed. No response text is recorded. Definite refusals
map to `zzz-invalid-request` (400), `zzz-unauthorized` (401),
`zzz-forbidden` (403), `zzz-not-found` (404),
`zzz-idempotency-conflict` (409), `zzz-payload-too-large` (413),
`zzz-rejected` (422), or `zzz-rate-limited` (429).

Public writes require an invited credential with write scope. Private rooms
also require current membership carrying write and accepted, unexpired
approval.md workflow evidence. zzz.bot intentionally returns 404 when private
access is absent, so the adapter does not guess which prerequisite failed.
`approval setup adapter zzz` verifies only credential acceptance through one
read-only `GET /api/v1/rooms` and posts nothing.

The local non-guest MCP server publishes this same verb from the registry. MCP
invocation remains voluntary. Mechanical enforcement comes from keeping the
write credential solely in the vault; an agent that also holds the credential
can bypass the adapter.

## env

This command is the only thing that reads `.approval/env`, and its default output
carries secrets, deliberately: its job is to put them into your shell. No other
verb loads that file. Human identity (`APPROVAL_HUMAN`) is one of the variables
it can carry, and in v0.1 identity is config-declared (SPEC.md §11), so a
working-tree file that any process read on its own would let anything able to
write that file act as you on every human-only verb — `policy attest`, `grant`,
`vault set`. The file is inert; a human evaluating this output is what makes it
take effect (SPEC.md §11.1 invariant 7).

A plaintext literal is PERMITTED, and always reported as plaintext by `--check`
and by `--json`. A rule people route around is not a control. Near misses of the
real schemes (`keyring:`, `secret_service:`, `plaintext:`, `vault:`, …) are
reserved and refused rather than silently exported as their own text, since a
mistyped source would otherwise surface as a 401 from the far end hours later.

The value is never put in an argv: the helper commands receive a service name or
a label and hand the secret back on stdout.

Already-exported values win. A variable set in this shell is reported
`set-in-environment` and its line in the file is not consulted: your shell is the
authority, and a file that could override it would be a file that silently
redirects a gate operation's credentials.

**The export block says what it exported.** Alongside the values it emits one
more line, which carries no value on any path:

```
export APPROVAL_ENV_PROVENANCE='1:3f2a9c11:<64 hex>:APPROVAL_TG_TOKEN,APPROVAL_TG_CHAT'
                                │ │        │        └ the NAMES it exported from the file
                                │ │        └ sha256 of the env file bytes it read
                                │ └ the instance whose file that was
                                └ the format version
```

`approval up`, `approval doctor` and `--check` below report an exported variable
whose file line was not consulted, and they read no values by design, so without
this they could not tell a stranger's export from the one `eval "$(approval
env)"` had just made from this instance's own file. They reported the documented
ritual as cross-instance bleed, which is a check asserting something it never
tested. With the line present, a variable it names is treated as this instance's
own export and is not reported; an export with no provenance, with another
instance's id, with a digest that no longer matches the file, or simply not in
the list is still reported. A value that was already exported in your shell is
re-exported by the block and is deliberately left out of the list, so passing a
foreign credential through one `eval` cannot launder it. The line is omitted when
nothing was resolved from the file. Nothing here changes what wins: your shell
still does.

Exit 0 even when variables are unresolved, because the output is destined for
`eval` and a shell function that failed on an unconfigured channel is one nobody
keeps in their profile. `--check` is the path with an opinion. A defaulted
variable nobody mentioned is an offer, not a promise.

**The file.** One `KEY=VALUE` per line, `#` comments and blank lines ignored, no
quoting and no interpolation, mode 0600 (anything else is refused with the chmod
to run), and gitignored by `approval init`. VALUE says WHERE the value lives:

```
KEY=keychain:<service>       macOS: security find-generic-password -a "$USER"
                             -s <service> -w
KEY=secret-service:<label>   Linux: secret-tool lookup approval <label>
KEY=env:                     inherited from the shell that launched you
KEY=<value>                  a plaintext literal
KEY=literal:<value>          the same, spelled out, for a value that begins
                             with something that looks like a scheme
```

A value with some other `word:` prefix is a literal, not an error.

**Which variables are answered for:** `APPROVAL_HUMAN`, the Telegram token and
chat id, the vault passphrase, the sampling secret when one is named, and any
other string-valued key ending in `_env` anywhere in the loaded policy. An absent
file is not an error. Unresolved variables are printed as `#` comments naming the
repair.

**`--json`** (one object on stdout):

```
{"ok":true,"path":"/…/.approval/env","present":true,
 "variables":[{"name":"APPROVAL_TG_TOKEN","status":"resolved-from-keychain",
               "source":"keychain:approval-tg","plaintext":false,
               "declared":true,"value":"…","fix"?:"…","refusal"?:{…}}]}
```

`status` is one of `set-in-environment` | `resolved-from-keychain` |
`resolved-from-secret-service` | `resolved-literal` | `unset`. `value` is present
only when there is one AND `--check` was not passed. `ok` is the `--check` verdict
on every path.

## setup

**Channel and adapter are two nouns, not one list, and SPEC.md §4 is why.** A
channel surfaces requests and collects decisions and holds no state, so its setup
fills the OS keystore and `.approval/env` — the map of where the values that
unlock the machine live. An adapter executes side effects and holds credentials,
so its setup fills `.approval/vault.enc`, which holds the values a gated adapter
SPENDS, read inside the verified execution window and by nothing else. There is no
verb that prints one back. (An older build spelled the Telegram one without the
`channel` noun. That form exits 2 and names this one; there is no alias, because
two spellings of a distinction the SPEC draws on purpose is how the distinction
stops being drawn.)

**Every subcommand refuses when stdin is not a terminal**, and when `--json` is
given, and exits 2 printing the exact non-interactive commands to run instead. A
setup that a pipe could drive would be a way for a CI job or an agent to declare a
human identity and store a credential, and identity in v0.1 is config-declared
(SPEC.md §11): establishing it is an act of the human at the machine.

**It never appends to the log, attests anything, or edits `APPROVAL.md`.** When a
policy line is needed it prints the `approval policy amend` ceremony and stops: an
amendment ends in a human attestation, and a wizard that edited an attested policy
would be forging the sign-off.

**A value you already hold is never handled by this process.** The Telegram token
is collected by the keystore helper's own no-echo prompt (`security
add-generic-password … -w`, with no value on the command line), and reaches this
runtime only by being read back on stdout. Values this runtime GENERATES (the
passphrase, the sampling secret) go to the helper on its stdin; if a helper will
not take stdin, the fallback puts a just-minted value in an argv and says so.

**What each subcommand is for.**

- `identity` — declare who the human is (`APPROVAL_HUMAN`).
- `vault` — mint a vault passphrase, store it, and record where it lives.
- `sampling` — mint the audit sampling secret, store it, and print the policy
  line that turns sampling on.
- `channel <name>` — configure one channel's transport credential. For telegram
  that is collecting the bot token, proving it with getMe, discovering the
  approver chat, and recording both variables.
- `adapter <name>` — fill the vault with one adapter's credentials, asked for
  from the manifest that adapter declares, and prove them against the service
  without sending anything.

**Where secrets go.**

```
macOS (security on PATH)     keychain:<service>
Linux (secret-tool on PATH)  secret-service:<service>
neither                      offered as a PLAINTEXT literal in .approval/env,
                             taken only on a typed `yes`, and reported as
                             plaintext by `approval env --check` ever after

approval-tg-token-<id>            the bot token
approval-vault-passphrase-<id>    the vault passphrase
approval-sampling-secret-<id>     the audit sampling secret
```

`<id>` is eight hex digits derived from this instance's `.approval` directory,
because a keystore is machine-global and everything else about an instance is
directory-scoped. Without it, a second gate in another directory stores its bot
token over the first one's item and then reads the first one's token back: two
listeners long-poll one bot, and an approval tap is answered by whichever asked
for updates first. `approval doctor`'s `keychain-scope` row reports the id and
says whether every source `.approval/env` names is this instance's own.

Names without the suffix are the pre-APRV-178 spelling and still resolve, since
`.approval/env` carries the service name in the open. `setup channel telegram`
asks before adopting one — naming the item, this instance's directory and its id
— and takes only a `yes` typed in full.

What it writes is `.approval/env` (one `KEY=VALUE` line per variable, mode 0600,
every other line and comment preserved) and items in the OS keystore.

## setup identity

Not human-only, unlike every other setup subcommand, and that is not a hole: a
verb that required `APPROVAL_HUMAN` before it would let you set `APPROVAL_HUMAN`
could only be run by someone who did not need it. The terminal is the control on
this path.

This is config-declared identity (SPEC.md §11). The trust boundary is this
machine: whoever can set the variable and write to the log is inside it. v0.1
makes no cryptographic claim about who attested.

A bare id is enough. The prompt prints the `human:` prefix because it is what
separates a human from the `agent:` and `system:` actors the human-only verbs
refuse — but a prefix the question already showed you does not have to be
retyped. An answer that does not fit gets one line saying why and the same
question again.

The line it writes is inert. No verb reads `.approval/env` on its own (SPEC.md
§11.1 invariant 7); `eval "$(approval env)"` is what puts it in your shell.

An answer that does not fit gets one line saying why and the same question again;
Ctrl-C or Ctrl-D writes nothing. Refusing a non-terminal stdin, it prints the
export line to use instead.

## setup vault

Warns first if `.approval/vault.enc` already exists. A vault is encrypted under
its passphrase and cannot be re-keyed by changing a variable: every credential in
it becomes unreadable. The warning comes before the generation, and the
confirmation defaults to no.

The generated value reaches the keystore on the helper's stdin. If this build of
the helper will not take stdin, the fallback passes it in an argv and says so: a
value minted one moment earlier, never used, visible in `ps` to your own user for
the length of one call. That trade is made for generated values only.

## setup sampling

Selection is HMAC-SHA-256 over the event hash under this secret. Seeding from
event content alone is forbidden: the agent authoring the event controls that
content and could search it until its action falls outside the sample.

If your policy names no `audit.sampling_secret_env`, the secret is recorded under
the conventional name `APPROVAL_SAMPLING_SECRET` and sampling stays off — §5.2
disables it whenever the policy names no variable, and this verb does not edit an
attested policy file. It prints the block to add and the `approval policy amend`
ceremony that attests it.

## setup sender-key

The operator-held key that turns a channel account id into the value an
`approvers[id].senders` mapping carries (APRV-370). It exists for the deployment
that PUBLISHES its policy and its log, where the raw account id is disclosed
once in the file and then on every decision.

A plain unkeyed digest would not fix that. A Telegram account id is a ten-digit
decimal number, the whole space is enumerable on a laptop, and a digest anybody
can reverse states a privacy property it does not have. So the mapping value is
`hmac-sha256:<hex>`, computed under this key, which is in the environment and
never in the policy file.

Bare, the verb mints, stores and records the key, exactly as `setup sampling`
does with its secret, and edits no policy file. The value is not printed and
there is no verb that prints it.

With `--id <account-id>` it mints nothing and stores nothing. It reads the key
from the environment, prints the `hmac-sha256:<hex>` for that account, and
prints the `senders` line and a paste-ready proposal pair around it. That is the
one thing an agent writing a policy proposal cannot do — the digest depends on a
secret only the operator's machine holds — so the proposal page says to run it
rather than carrying a placeholder:

```sh
approval setup sender-key           # once, interactive, human-only
eval "$(approval env)"
approval setup sender-key --id 7345216485
```

Because it stores nothing and prints a value designed to be published, `--id` is
the one `setup` path that runs without a terminal and accepts `--json`.

**The key is not an authenticator.** Nothing about the gate's safety rests on
its secrecy: somebody who learns it learns which account ids a policy names,
which is what the raw form told everybody. What it buys is that the published
policy and the published log stop carrying the account.

**A listener that holds no key under a keyed mapping decides nothing** on that
channel. Every tap is refused `sender-key-unavailable`, and there is no fallback
to comparing the observed id against the raw entries: without the key the
runtime cannot tell whether the account is also claimed by a keyed approver, so
it cannot run the ambiguity check the mapping rests on. `approval doctor`'s
`sender-mapping` row names the form in use and says whether the key resolves.

## setup checkpoint

Mints the Ed25519 keypair a human signs the log's head with (APRV-220's record,
APRV-257's ceremony). The two halves go to two different places, and that split
is the design.

The **private half** goes into the vault under `approval.checkpoint.key`. It is
encrypted at rest under the passphrase `vault.passphrase_env` names, which
`core/child-env.ts` strips from every child this runtime spawns, behind a file
whose reading classifies `account.credential`. It is never printed, and there is
no verb in this CLI that prints it.

The **public half** is printed, with the exact `audit.checkpoint_keys` block to
paste. This verb does not edit `APPROVAL.md`, so **the key is inert when the
verb finishes**: a checkpoint signed by a key the policy does not list is
`checkpoint-key-unknown`, which is a refusal. Adding the block and running
`approval policy amend` is the second half of the ceremony, and it is the
human's. Nothing an agent runs writes that line.

Set `audit.checkpoint_every` in the same amendment to be asked rather than to
remember. With a cadence set, the listener puts one `CHECKPOINT DUE` prompt in
front of you when one is owed (at most one outstanding, never a nag), and
`approval doctor`'s `checkpoint` row says how old the newest one is.

**Rotation appends; it never drops.** `--rotate` mints a new key, replaces the
private half in the vault, and prints the list with both keys in it.
`--retire <fingerprint>` prints the block that drops a key, and **refuses** any
key that signed a checkpoint in the log, naming the seqs that would stop
verifying: removing such a key turns every checkpoint it signed into
`checkpoint-key-unknown` for the life of the log. Retired keys stay listed
forever, which is why the field is a list.

**If you lose the key**, mint another with `--rotate` and leave the old public
key where it is. Every checkpoint the lost key signed verifies against that
public half and against nothing else. A lost key costs you future signatures,
never past ones, and a log with no recent checkpoint is a warning at every layer
and a refusal at none, so nothing stops while you find a terminal.

Human-only three times over: the terminal check this family carries, the
`--as human:<id>` gate, and the classification. `approval setup checkpoint`
classifies `policy.core`, which the reference policy holds human-only, so the
Claude Code hook denies an agent running it before a process starts.

## setup adapter

The manifest is the adapter's, so the names this verb writes are by construction
the names its `act` reads.

The passphrase is read, never established. It comes from the environment variable
your policy names in `vault.passphrase_env`, exactly as `approval vault set` reads
it. This verb does not resolve `.approval/env` (SPEC.md §11.1 invariant 7) — run
`approval setup vault` and then `eval "$(approval env)"` first. With the variable
unset, nothing is stored and no vault is created.

The values go into the vault, not into the OS keystore and not into
`.approval/env`: what this verb stores is what a gated adapter spends inside a
verified execution window.

What it reports: the path, the count, the names written and the names left alone.
Never a value, on any path, including a failed probe. Exit 1 means the service
refused the stored configuration, or the vault would not open; the values are kept
either way and the undo is printed.

## setup adapter email

A port that is not a port and a security setting that is not one of the three
words are refused HERE, in the words `approval adapter email` would have used at
send time. A username without a password (or the reverse) is refused before
anything is stored: sending unauthenticated because half the credential is
missing would put the message on a path nobody configured.

The probe sends nothing. It is the same SMTP session a send runs — connect, EHLO,
STARTTLS, AUTH — and then QUIT. It proves the host answers, that the TLS mode is
the one the server offers, and that the credential is accepted. It does not prove
delivery, and it puts no message on the wire.

An `smtp.host` that is an IP address is probed without SNI (APRV-416). A server
name is a name, so there is nothing to send for an address, and Node 26 refuses
the session outright where earlier versions only warned. The certificate is
still verified; what it is verified against is the address, which the server's
certificate has to carry as an IP entry in its subject alternative names. A
relay whose certificate names only a hostname therefore fails the probe when it
is configured by address and passes when it is configured by that name.

A failed probe keeps the values. A laptop behind a captive portal is not a reason
to make you type five things again. The refusal prints the SMTP code and the
server's first line, with the credential redacted, and the undo.

The five names, and what each answer is checked against:

```
smtp.host      the submission server
smtp.port      587 for STARTTLS submission, 465 for implicit TLS
smtp.security  implicit | starttls | none, picked from a numbered list
smtp.user      optional, and both-or-neither with the password
smtp.password  optional, read with no echo, written last
```

The probe defaults to yes and can be declined; declining stores the values and
says they are unverified.

A partial re-run is probed too (APRV-99). Rotating an app password replaces one
name and leaves four alone, so the run does not hold the whole configuration, and
this verb used to stop there: it will not read the missing values back, because
there is no verb in this CLI that reads a credential out of the vault. That rule
is about PRINTING, and the inference from it was too wide. The email adapter reads
all five out of the vault on every send, through `readEmailSmtpConfig` over the
credential provider `approval adapter email` hands to `act`, and the probe now
calls the same function over a provider built the same way. The values are read
into this process, handed to the SMTP session, and dropped: no value, no count, no
prefix and no length reaches a stream, and the transcript sweep in
`tests/cli-setup.test.ts` covers this path with the rest. A probe that is no wider
than the send it proves does not widen the exposure, and rotating a credential
deserves the proof first setup gets.

So a partial re-run asks one more question, after the replace/keep decisions and
the write:

```
open an SMTP session using the stored configuration to check it? [Y/n]
```

An answer that is neither yes nor no is asked again rather than defaulted, which
is the convention every other typed question in `setup` follows. Declining prints
the same "not verified: … were left alone this run" sentence the verb printed
before the offer existed. So does a vault the probe cannot open — a missing or
wrong passphrase, an altered file — with one more line naming why the probe could
not run, and no value in it.

## setup adapter agentmail

Two names, and the second one is the whole point:

```
agentmail.inbox_id  the inbox this runtime sends from
agentmail.api_key   the key that carries draft_send and message_send
```

Store the SENDING key here and give the agent a different one. An AgentMail key
is a mailbox in one string, so a deployment that hands the agent the sending key
has an agent that can send without asking anybody, and the gate in front of it is
decoration. The key in the vault is read only inside the verified execution window
the adapter contract opens.

The probe sends nothing. It is `GET /v0/inboxes/{inbox_id}`, the same read a
direct send makes first, and it reports the address the inbox sends as, which is
the address every approved message will actually come from, since AgentMail has
no per-message From.

Permissions are reported and not assumed. Where that read discloses the calling
key's own permissions, a missing `draft_send` or `message_send` is named in a
warning: a key that cannot send fails AFTER a human has granted the send, which
is the worst moment to find out. Where it discloses none, the probe says so and
prints the reminder rather than claiming the key can send. It deliberately calls
no second endpoint to find out, because a 404 from a URL nobody has confirmed
exists would be reported as a permissions verdict, and "not disclosed" is a
better answer than a wrong one.

A failed probe keeps the values and prints the undo, exactly as the email
adapter's does. A re-run that replaced only one name is offered the same probe
over the stored pair, read through `readAgentmailConfig` over the vault: the
exact path `approval adapter agentmail` takes at send time, printed by nothing.

## setup adapter zzz

The manifest contains one secret, `zzz.agent_token`. It must be an invited
zzz.bot principal credential with write scope. Store the write-capable token in
the vault and keep it out of the agent environment; otherwise the agent can post
without passing through the adapter.

The optional probe sends nothing. It makes one authenticated
`GET /api/v1/rooms` against production and reports success only when zzz.bot
accepts the credential. That endpoint does not disclose the principal's write
scope, room memberships, or accepted private-room workflow evidence, so setup
states those limits instead of claiming the token can publish. The actual
approved POST remains the first proof of all write prerequisites.

## setup channel

A channel is not an adapter, and the two setup verbs fill different stores.
SPEC.md §4: a channel surfaces requests and collects decisions and holds no
state, so what it needs is a transport credential — it goes into the OS keystore,
and `.approval/env` records where. An adapter executes side effects and holds
credentials, so `approval setup adapter <name>` fills the vault instead.

## setup channel telegram

Stop any `approval up` process or `approval channel telegram listen` polling
this bot first. Setup also uses `getUpdates` to discover the approver chat.
Competing polls produce HTTP 409 from the Bot API. This is a configuration verb;
after it finishes, reload the instance environment and use `approval up` for
normal operation.

The token is never typed into this process on a machine with a keystore: the
helper's own no-echo prompt collects it, and this runtime reads it back on stdout
to make the getMe call. With no keystore, it is read with no echo and — after a
typed `yes` — written as a plaintext literal. The chat id is written as a
literal: a chat id is not a secret; the token is.

No `getUpdates` from this verb carries an offset, ever. An offset is an
acknowledgement: it tells the Bot API that everything below it may be discarded,
and a decision tap consumed here would never reach the listener waiting for it.
That is why `approval doctor` refuses to call `getUpdates` at all. Reading
without an offset confirms nothing, and `allowed_updates` is `["message"]`, so a
pending `callback_query` is not even delivered here.

The wait is a continuous long poll of up to 90 seconds, so when you send the
message does not matter and no Enter is asked for. If nothing arrives it asks
`getWebhookInfo` and prints what Telegram says about this bot — how many updates
are pending, and whether a webhook is swallowing them.

The chat id is written as a literal because a chat id is not a secret. Human-only
and enforced: it stores a credential and writes `.approval/env`, so `--as` expects
a `human:<id>` and an `agent:` or `system:` actor is refused at exit 2. Exit 1
means the far end refused: an invalid token, a 409 from a running listener, or no
message reaching the bot before the deadline.

**One bot per instance (APRV-390), and both names are derived.** The keystore
item this verb creates is `approval-tg-token-<instance id>`, where the instance
id is the eight hex digits `approval doctor` prints in its `keychain-scope` row,
so two gates on one machine store two items. An operator who prefers a readable
suffix may write their own name into `.approval/env` instead; nothing is
migrated and `approval env --check` reports which item each variable resolves
through. The variable is whatever the policy's
`channels.telegram.token_env` declares; a policy that declares nothing gets
`APPROVAL_TG_TOKEN`, which every other silent policy on the machine also gets,
so a second gate on one machine declares a pair of its own (the packaged demo
policy declares `APPROVAL_DEMO_TG_TOKEN` and `APPROVAL_DEMO_TG_CHAT`).

The `getMe` that proves the token also says which bot it is, and this verb
records that against the instance in `.approval/channel-owner.json` (gitignored)
and in a per-machine registry under the platform's user state directory,
`approval/bots.json`. A bot another local instance has already claimed is
refused before anything is written, naming that instance's directory; the values
are open names and never a token. `--allow-cross-instance` records this instance
as an owner anyway and says what it is doing. An instance set up before this
existed keeps working: nothing is migrated, and the first `approval up` or
listener start writes the record from its own `getMe`.

## setup service

**It writes one file: the launchd user agent or the systemd user unit that runs
`approval up` at login.** It is the fifth member of the `setup` family and obeys
the family's rules (interactive by refusal, human-only, appending nothing to the
log, editing no policy) with two of its own.

**It never copies a value.** A unit file is world-readable configuration that
survives reboots and gets backed up, so a bot token in one is a bot token in a
backup. The unit names where the environment comes from and never carries it. By
default it runs a wrapper the human reads in the printed unit: `eval "$(approval
env)"` and then `exec approval up`, so keystore references stay in the keystore
and `approval env` stays the only thing that resolves them. With `--env-file` it
points at a file the operator authored, which this verb neither writes nor reads.

**It prints the unit before it writes it, and it does not arm it.** The whole
file goes to stdout first and nothing is written until the operator confirms.
Loading it is a separate act: the verb prints the exact `launchctl bootstrap` or
`systemctl --user enable --now` line and stops there. A login service is a
standing capability on someone's machine, one that starts a process holding a
credential that can put prompts on a phone, and a wizard that armed one as a side
effect of writing a file would be making that decision on the operator's behalf.
Printing the command costs one paste and buys an explicit act. `--uninstall`
mirrors it: the stop command first, then the file removed on confirmation.

**Console output never goes into `.approval/`.** The service's stdout and stderr
go where the operator chooses, defaulting to the platform's own log home
(`~/Library/Logs/approval` or `~/.local/state/approval`). A `--logs` path inside
the approval home is refused. That directory holds the log, the queue projection,
the payload store, the vault and the environment source map, and unverifiable
console text beside them is what makes a directory stop meaning something.

A path carrying a quote or a newline is refused rather than escaped into the
unit's shell wrapper, because the safe thing to do with a path that cannot be
single-quoted is to say so. The plist is XML-escaped, so a working directory with
an `&` in it produces a file launchd can parse.

## mcp serve

STDOUT IS THE JSON-RPC STREAM: this verb's own messages go to stderr, and a child
spawned by the run tool is piped rather than inheriting the terminal, so nothing
can write into the wire. SIGINT and SIGTERM close the transport and exit 0.

**The tools are the agent surface, and only that.** The tool list is the verb
registry (`approval instructions --schemas`) filtered by `human_only` false, and
every tool's `inputSchema` is that verb's registry input schema. Two agent-facing
verbs are still withheld: `consume`, which is internal plumbing that `run` wraps,
and `hook claude-code` / `hook cursor`, which each read a pre-tool event from a
stdin this transport already owns.

**Not published**, and this is the design rather than an omission: grant, reject,
revoke, policy attest, policy amend, execution resolve, audit review, expire, env,
init, setup, vault, the channels, the daemon, and this verb itself. SPEC.md §11
names the agent the untrusted policy and the human the trusted, expensive
overseer. An MCP client is an agent's harness, so offering it grant would hand the
untrusted policy the overseer's pen. A human decides at a human's surface:
`approval channel cli`, the local web page, or Telegram.

**Identity cannot be escalated by a caller.** `--as` is removed from every
published input schema, so a client sending one is refused by the schema; the
server's own identity is appended last to every argv, so it wins even if one
arrives another way. There is no tool that takes an actor. A `human:` or
`system:` value for `--as` is refused at exit 2, before the transport exists.

Tool calls run serially in this process, and appends go through the same lockfile
and compare-and-append every `approval` process uses, so a CLI running beside this
server is safe. A refusal comes back as a tool result with `isError` true carrying
the CLI's own `{"error":{"code","message"}}` object, never as a thrown JSON-RPC
error: the command was well-formed and the answer was no, which the caller must be
able to read as data. A JSON-RPC error means something else, an unknown tool or
arguments that do not match the schema. The exit code travels in `_meta` as
`approval.md/exit_code`.

**This server reads no `.approval/env`** (SPEC.md §11.1 invariant 7). It runs
under whatever environment the operator launched it with, exactly as every other
`approval` invocation does.

POST-V1: mapping the MCP tasks/elicitation extension onto `awaiting`. SPEC.md
§10.5 says that MAY happen "when client support stabilizes"; until then the wait
tool blocks and answers, and its timeout is an answer of its own.

### `--http`: many clients, one session each (APRV-174)

`--http` serves the MCP streamable-HTTP transport instead of stdio. One listener
holds one `Server` and one transport per MCP session, routed by the
`mcp-session-id` header the transport mints at `initialize`. A session is dropped
when its transport closes. Tool calls still run serially across the whole
process, because the reason they do (`wait` blocks the event loop, `run` spawns
synchronously) is a property of the process.

`--port <n>` picks the port (default 4681) and always binds `127.0.0.1`.
`--listen <[host:]port>` is the only way to bind anything else, and passing both
is a usage error. A non-loopback bind prints a banner on stderr, every time: this
server authenticates NOBODY, has no TLS, and the supported deployment is a
loopback bind behind a tunnel the operator controls. Session opens and closes are
logged on stderr with the session id and the actor; stdout stays empty.

Two caps bound what strangers can spend: 20 sessions at once and 200 over the
life of the process. An `initialize` over either one is refused with a plain HTTP
503 whose body carries `mcp-session-cap` or `mcp-session-lifetime-cap`, and no
session is created for it. A request with an unknown `mcp-session-id` is a 404
(`mcp-unknown-session`); a non-initialize POST with no session header is a 400
(`mcp-session-required`).

### `--guest`: one identity per session

Plain `--http` runs every session as the operator's own `--as` / `APPROVAL_AGENT`
identity, which is stdio behavior with more connections. `--guest` mints a fresh
`agent:guest-<6 hex>` for each session instead, before that session's transport
exists, so the log, the budgets and the refusals see one stranger per connection
rather than one crowd. `--guest` is exclusive with `--as` (a guest's identity is
not the operator's to choose) and is a usage error without `--http`.

**A client still cannot name an identity, and this is the reason the scheme is
safe.** Nothing a caller sends reaches the actor: not a header, not the URL, not
`clientInfo.name` in the initialize payload, not a tool argument. SPEC.md §11
says a self-reported field never reduces scrutiny, and an identity a caller could
name would be one a caller could escalate. A client name is a label; the actor is
the server's.

**What a guest may call.** Guest mode also narrows the tool list to a positive
allowlist: `instructions`, `register`, `request`, `wait`, `status`, `queue`,
`log_verify`, `policy_check`, `policy_test`. Those declare, ask and observe.
Everything else is withheld because it executes on, or spends the credentials
of, the machine hosting the gate: `run` spawns argv there, `adapter_email` spends
vault credentials, `token` hands out spend material, `journal_write` writes a
local file. The list is positive rather than a set of exclusions, so a verb that
lands next is withheld until someone decides otherwise, and it is intersected
with the ordinary filter, so guest mode can only ever take tools away.

**The advertised list is not the enforcement.** A guest that crafts a request for
a withheld name is refused at CALL time with `mcp-guest-restricted`, whose
message names the verb and what a guest may call instead. A human-only name still
gets the human-only refusal, which is checked first and is true of every session
on every transport. This is the same defence in depth as `mcp-identity-fixed`:
`tools/list` describes the boundary, and the call handler is the boundary.

**`wait` is clamped to five seconds** for a guest, appended last so a caller's
larger `--timeout` loses, while a caller asking for less keeps what they asked
for. `wait` blocks the event loop and every HTTP session shares one invoke
queue, so an unbounded guest wait is one stranger stalling every other session.
The guest instructions string says so, tells the caller to poll `status`, and
states plainly that a granted request executes nowhere: the demo is the approval
flow itself.

## serve

`approval serve` is the same agent-facing surface as `mcp serve`, over HTTP,
for a harness that has no local log and no local policy: a sandboxed tenant
whose daemon runs elsewhere, one process per tenant. It is a transport and not
a second gate. Every verdict, every verb and every batch of records comes from
the function the CLI dispatches to; nothing under `src/serve/` classifies a
command, resolves a policy, mints a token or verifies a chain.

STDOUT IS EMPTY. The bound address, the identity, the daemon id and the store
root go to stderr on one started line. SIGINT and SIGTERM close the listener
and exit 0.

### The two credentials

Two bearer values, both read from the launch environment (SPEC.md §11.1
invariant 7: nothing is loaded out of the working tree), both required before
the listener exists, and refused when they are equal or shorter than 24
characters:

| variable | opens |
|---|---|
| `APPROVAL_SERVE_AGENT_TOKEN` | `GET /verbs`, `POST /hook/<harness>`, and the allowlisted verbs below |
| `APPROVAL_SERVE_TENANT_TOKEN` | `GET /verbs`, `GET /log/follow`, `GET /export`, `GET /status`, and every other published verb |

**The agent credential never reads the log it is judged by.** That is the
sentence the split exists for. An agent that could stream the verified log
could read every decision made about it and the shape of the oversight it is
under; an agent that could export the store could carry all of it away.

Authorization is therefore per verb, and it is an ALLOWLIST. The party at the
other end of this transport is a sandboxed harness on another machine, not the
operator at their own laptop, so the agent credential opens only what a harness
under oversight needs in order to ASK and to ACT ON a grant:

> `instructions`, `hook_classify`, `request`, `wait`, `withdraw`

Five verbs, and the shortness is the point: a harness under oversight asks and
is answered, and everything else about the gate belongs to the party the gate
is for.

Neither payload builder is on it, under the rule that a builder is the agent's
only if it builds from the request's own arguments and never reaches a host
resource. `payload_hash` takes a FILE, and on this transport that file is on
the daemon's machine while the caller is not: every path it could name is one
the host put there, so answering would be a hash oracle that also files the
bytes into the payload store. `payload_agentmail-draft` takes two ids rather
than a path, but reads the draft over HTTPS with `AGENTMAIL_API_KEY` from this
server's own environment, so a remote caller would be spending the host's
credential on ids it chose: the same fault wearing a network instead of a
filesystem.

Everything else the catalog publishes is the tenant's. The ones easiest to wave
through and most worth naming: `log_tail` and `log_export` return records,
`log_verify` and `gate_status` return the log's length, its head hash and the
live state of the gate, `queue` returns the tenant's pending decisions,
`policy_check` and `policy_test` answer what the policy does with a class and
name the absolute store path while doing it, and `status` is the tenant's view
of the oversight the agent is under. So are the verbs that touch the host
rather than the log: `run` and `sandbox` spawn argv on the daemon's machine,
every `adapter_<name>` spends vault credentials, `log_advance` opens pull
requests against the tenant's records. And so are `register` (its positional is
a host path; the hook endpoint is a harness's way to register, and it
synthesises the envelope itself), the two payload builders, `token`,
`coverage`, `doctor`, `audit_list`, `audit_obligations`,
`channel_telegram_health`, `journal_write`, `journal_read`, `feedback`,
`values`, `import_agents-md`, `reindex` and `render`.

**No caller names a path, and no positional wears a dash.** Four rules, and
each closes a route around the others.

1. The server appends `--dir`, `--log` and `--policy` to every verb call in
   every scope from its own launch configuration, and a call supplying one of
   them is refused `serve-path-pinned` even when the value is correct.
2. A positional beginning with `-` is refused `serve-positional-flag`, in every
   scope. Positionals are emitted first and verbatim, and the verb reads any
   token starting with `-` as a flag — including the `--payload=/path`
   spelling — so without this rule a refused flag could be sent as a value and
   reach the parser through the front door. `trailing` needs no such rule: it
   always follows a `--` separator, and the flag parser stops there, which is
   what lets `hook classify -- git push -f` classify a command line that has
   flags in it.
3. The AGENT credential may not use a path-typed flag at all
   (`serve-flag-not-permitted`), and may use only the flags on a short
   per-verb list. A harness reached through this transport has no files on the
   daemon's machine, so a path it names is either useless or somebody else's;
   payload bytes arrive through the hook route, which builds the envelope from
   the tool call.
4. The TENANT credential's path-typed flags are confined to the store
   (`serve-path-outside-store`), resolved through `realpath` on the deepest
   existing ancestor so traversal and a symlinked directory both refuse.

Which flags are path-typed comes from the registry rather than from a list
kept beside the server: a flag declared `"path"` publishes as an ordinary
`{"type":"string"}`, so the wire contract is unchanged, and it is confined on
the day it appears. A test walks every published verb and fails on any flag
that is neither declared `"path"` nor reviewed as something else.

A verb added to the registry tomorrow is published on both surfaces the same
day and is TENANT-scoped until somebody decides otherwise. The allowlist is
what widens, and widening it is a diff in the server and a diff in a test.

An agent-credential call to anything off that list is refused
`serve-agent-forbidden`, and a tenant-credential call to an allowlisted verb
(`request`, `wait`, `withdraw`, `hook_classify`, or `consume`, which this
surface withholds entirely) is refused `serve-tenant-forbidden`. Both are scope refusals rather
than not-founds: a caller that guessed a path learns that the door exists and
is not theirs.

Every path requires one of the two. There is no unauthenticated surface at all,
not a health check and not a 404, so a caller with no credential learns nothing
about what exists.

### The endpoints

`GET /verbs` is the published catalog: `approval mcp serve`'s tool list, name
for name and schema for schema, because it is derived from the same registry
filter by the same function. `--as` is absent from every published schema and
the launch identity is appended last to every argv, so a caller can neither
name an identity nor change one. `grant` is absent, as it is there and for the
same reason: SPEC.md §11 makes the agent the untrusted policy, and a tool list
is a statement about what a surface is for. Each entry carries the scope that
opens it, so the catalog is honest about `status` being the tenant's.

### The response contract

`POST /verb/<tool_name>` and `POST /hook/<harness>` answer with ONE body:

```json
{"exit_code": 0, "stdout": "…", "stderr": "…",
 "stdout_truncated": false, "stderr_truncated": false}
```

`stdout` and `stderr` are exactly what the CLI wrote to each stream, and
`exit_code` is exactly what it exited. A client reproduces the invocation by
writing `stdout`, writing `stderr`, and exiting `exit_code`. A client that
wants the verb's machine-readable refusal parses `stderr`, which is the stream
the CLI prints refusals on. Both streams are bounded at 256 KiB and clipped at
a codepoint boundary, with a flag saying whether that happened.

**Nothing about a verdict travels in a header.** It used to: the exit code rode
on `x-approval-exit-code`, and server-authored refusals did not set it. A
client following the documented rule then read a missing header as zero, and
zero is ALLOW on Claude Code, Cursor, Codex and Muse — so a 1.1 MB hook
envelope came back as a 413 that meant *proceed*. The exit code is now data in
the body, it is present on every response including every refusal, and on a
refusal it is always non-zero.

**A client treats a missing, unparseable or truncated body as a BLOCK.** That
rule is not a nicety: a transport failure this server never saw (a proxy, a
dropped connection, a process killed mid-response) has no exit code to carry,
and the only safe reading of "no answer" from a gate is no.

`POST /hook/<harness>` takes the harness envelope the stdin form would read, for
every harness this runtime speaks a hook protocol for. Its `stdout` is
BYTE-FOR-BYTE what `approval hook <harness>` prints for that envelope, because
it IS that stdout: the request body is handed to `commandHook` as its stdin and
nothing reshapes the answer. The exit code must travel with it, because the
dialects disagree about where a block lives — Claude Code, Cursor, Codex and
Muse put it in the body at exit 0; Grok Build and Hermes use exit 2. Hermes's
ALLOW is `{}` and carries its reason on stderr and nowhere else, which is why
`stderr` is part of the contract rather than a diagnostic.

A refusal the SERVER raises on the hook route — an oversized body, a credential
at the wrong door, a method it does not answer — carries `{"error":{…}}` and
`exit_code: 2` **and** a `stdout` holding the harness's own block directive,
rendered by the same function that prints one. A client that writes `stdout`
and exits `exit_code` therefore blocks on both halves of every dialect at once.
That holds for the refusals that fire BEFORE the URL is parsed, too — a
rotated credential, a malformed `Host` — because the harness is read off the
raw request target for the purpose of the refusal body and nothing else. A
credential rotation must not read as a permission, and on four of the six
dialects a body with no block directive at exit 0 is exactly that.

Where the harness is not known (an unroutable path, an unrecognised name)
`stdout` is absent, and the client rule in the paragraph above is what covers
it.

A deny is a VERDICT, so its HTTP status is 200; only a refusal by the server
is not.

**A Hermes tenant needs `--hook-harness-cap`, or every manual class is refused
(APRV-423).** `approval serve` pins `--harness-cap` on every hook call with
`--hook-harness-cap`, as it pins `--timeout` with `--hook-timeout`. Without it a
`POST /hook/hermes` runs as `approval hook hermes` with no flag, which assumes
Hermes's 30s default `plugins.hook_callback_timeout`; 30s does not clear the 60s
margin, so every manual-class call answers `hook-harness-cap-too-short` (a
block, nothing registered or requested, no prompt sent) and a tenant is gated
shut rather than gated. The repair for a serve operator, who does not own the
tenant's `$HERMES_HOME`: have the tenant raise `plugins.hook_callback_timeout` in
the harness's config above the per-entry `timeout`, then start `serve` with
`--hook-harness-cap <the smaller of the two>` (`--hook-harness-cap 300s` for the
documented `600` over `300`). The value is per server rather than per tenant, so
a server fronting several Hermes tenants states the smallest ceiling any of them
runs under; a stated cap can only shorten a window, never lengthen one. The
same flag bounds the hook's WAIT on every route: `--hook-timeout` is clamped to
what the ceiling leaves after the margin, so a hook that adopts an already-open
question under a ceiling with no room in it answers `hook-timeout` at once
(question left open for the retry grace) instead of being killed mid-wait.

`GET /log/follow?from=<seq>&cursor_hash=<64hex>&limit=<n>` answers one page of
verified records and the cursor to ask with next time. The cursor is EXCLUSIVE
and the subscription is `core/log-subscribe.ts`'s, so SPEC.md §8 holds
unchanged: the chain is verified from genesis before anything is emitted, and a
`cursor_hash` that does not match the retained prefix is refused with the
`integrity` code, `cursor-mismatch` as its reason, and NO RECORDS, not even the
ones a partial drain had already produced. `caught_up` says whether the page
exhausted the log or the limit. The server keeps no subscription state: a page
is a function of the cursor in the request and the bytes on disk, so a host that
sleeps and wakes serves the same next page it would have served before.

**`from` greater than zero REQUIRES `cursor_hash`.** The subscription calls the
sequence-only form a weaker bootstrap, weak in exactly one way: it cannot
detect a fully recomputed replacement prefix on its first read. A streaming
consumer pays that once and then retains the digest it verified. A paged one
never does — every request is a first read — so the weakness would be
permanent, and a caller who dropped the hash would be served a replaced prefix
silently while an honest caller who kept it got the refusal. `from=0` is the
only hashless form, because replaying from genesis binds nothing.

`from` must be a sequence number this runtime can represent and `limit` must be
between 1 and 1000. Both are refused `serve-invalid-cursor` when they are not,
rather than clamped: a clamp answers a different question than the one asked
and the caller cannot tell it happened.

`GET /export` answers the store as a gzipped POSIX tar. Its contents are a
positive allowlist (`APPROVAL.md`, `.approval/log/`, `.approval/payloads/`,
`.approval/QUEUE.md`, `.approval/index.sqlite`), so `.approval/keys`,
`.approval/env`, `.approval/daemon` and any `vault.enc` are out by not being
named rather than by a denylist remembering them. `.approval/payloads/` is in,
and it is the entry the reasoning turns on: the log records a `payload_hash`
for every action a human was shown, and those bytes live there. An archive
carrying the hashes without the bytes would hand a tenant a chain of references
to evidence they no longer hold, which is a receipt for an exit rather than an
exit.

**No link is followed, of either kind, and a link refuses the whole export.**
A name-based allowlist is no defence against one: `ln -s
.approval/keys/sender.key .approval/log/note.jsonl` passes every check that
reads the name and hands over the key, and a link out of the store hands over
any file on the host.

So every entry is `lstat`ed and a symbolic link refuses the export with
`serve-export-symlink`; every file is then opened `O_NOFOLLOW` and `fstat`ed,
so the checks are made against the descriptor that is actually read rather
than against a name that could have been swapped in between; and a regular
file whose link count is greater than one refuses with
`serve-export-hardlink`. That last is the case with nothing to notice — a hard
link is a second name for one inode, with no link to refuse to follow and no
target to inspect — so the link count is the only thing that distinguishes it.
Each refusal names the path and never its target.

The whole export is refused rather than the offending file skipped, because an
archive silently missing a file is one nobody can tell from a complete one.

The only file the export drops on its own account is the append lockfile
derived from the log path, which exists for exactly the span of the copy
because the export holds that lock. It is matched as an exact path, not as a
`*.lock` class: a tenant's own `.approval/payloads/x.lock` is the tenant's, and
a name this runtime happens to use for bookkeeping is no reason to drop
somebody else's file.

`GET /status` is the `status` verb, answered to the tenant credential.

### The bind, and where TLS is

`--port <n>` picks the port (default 4682) and always binds `127.0.0.1`.
`--listen <[host:]port>` is the only way to bind anything else, passing both is
a usage error, and a non-loopback host ALSO requires `--allow-non-loopback`: two
flags, because the credentials here are bearer values and a cleartext hop hands
them to whoever is on it. A widened bind prints a banner on stderr saying
exactly that. This process terminates no TLS and holds no certificate; the
supported deployment is a loopback bind behind a proxy the operator owns.

### What it never does

It appends no record on its own account. Every event in the log under it was
written by a verb a caller asked for, under the identity the operator fixed at
launch, and the daemon id on the started line is the one those records carry.
It reads no `.approval/env`.

### What it serialises, and what it does not (APRV-427)

One lock per store, held inside this process. It is the lock for every stretch
of work that may append to the store or must read it as one snapshot:

| work | holds the store lock |
|---|---|
| `POST /verb/<name>`, including `GET /status` | for the whole call |
| `GET /log/follow` | for the page, so no append this process makes lands under a verified read |
| `GET /export` | for the whole snapshot, and the log's append lockfile as well, so no other process appends during it either |
| `POST /hook/<harness>` | for its MUTATION sections only: everything up to its poll loop (intake, the abandoned-question sweep, register, request) and everything after it (the spend, a withdrawal) |
| a hook call's WAIT | never |
| `GET /verbs` | never |

So one hook call waiting on a human holds nothing. While it polls, the tenant's
`status`, `queue` and follow answer, and a second hook call opens its own
question and waits beside the first. A hook call runs on a worker thread of
this process, because a hook's wait is a synchronous sleep and on the
listener's own thread it would stop the listener; the verdict, its bytes and
its exit code are `approval hook <harness>`'s, exactly as before. A new thread
reads the log once BEFORE it asks for the store lock, so the cold walk of a
mature log (hundreds of milliseconds) happens in parallel and never inside the
lock; its reads under the lock are then warm.

**The pool is bounded, because each thread holds its own copy of the log**
(about 26 MB idle, plus roughly 84 MB once it has read a 73k-record log). At
most `--hook-threads` hook calls run at once, 16 by default, and no more
threads than that ever exist. Up to `--hook-queue` further calls, 64 by
default, wait for a slot in arrival order; a queued call has registered and
requested nothing yet. A call that finds every slot and every place in line
taken is refused at once with `serve-hook-saturated` (HTTP 503), carrying the
harness's own block directive in `stdout` and `exit_code: 2`, and nothing is
appended for it. Four finished threads are kept warm for the next call.

**Time in line is charged to the harness's ceiling.** The ceiling a harness
puts on its hook (`--hook-harness-cap`, or the adapter's documented default)
runs from the moment the call ARRIVED at this server. A call that waits for a
slot or for the store lock spends that budget, and the hook judges, waits by
and records on its request the ceiling less that wait, so any question it
opens lapses at arrival plus ceiling minus the 60s margin, while the harness
is still listening. A call that arrived with room and has less than the
margin left when its slot or the lock arrives is refused
`serve-hook-saturated` instead, appending nothing: a question opened then
would still be on the approver's phone when the harness kills its asker. A
ceiling that never had room is the hook's own `hook-harness-cap-too-short`,
as before.

A torn read in a hook's poll (another writer's line caught half-landed, which a
filesystem that grows a file a page at a time can show a reader) is read again
on the next tick, up to five ticks in a row, before the hook treats the log as
unreadable. This holds for the stdin form too, beside the daemon. Verb calls still run one at a time, in the
order they arrive, because some of them are synchronous and blocking too (`run`
spawns, and `wait` sleeps on the listener's thread, so an agent's `POST
/verb/wait` still holds the listener for its own timeout; the hook route is the
one a harness waits on).

Two appends never interleave. Inside this process the store lock is the
reason: every append is inside one of the sections above, and the sections run
one at a time. Across processes (a daemon, a CLI run beside this server) the
reason is the one every `approval` process relies on: each append takes the
log's lockfile and compares-and-appends against the head it read.

**A client that goes away is not answered, and does not spend.** When the HTTP
connection of a waiting hook call closes before its answer, the call stops at
its next poll tick without spending a grant and without withdrawing its
question, and nothing is sent. A grant that lands afterwards is left for the
harness's retry of the same command, which carries it and spends it once; an
undecided question is adopted by that retry. A call still in line for a
thread simply leaves the line. A grant already spent before the connection
closed stays spent.

Closing the listener runs in this order: stop accepting connections; cancel
every hook call the same way (waiting calls stop at their next tick, queued
ones leave the line); terminate the hook threads from inside the store lock,
which also waits out any verb or mutation section still running, so no thread
is killed while holding the log's append lockfile; and only then destroy the
remaining sockets. A question a cancelled call opened stays open for the retry
grace, exactly as for an `approval hook` process that was killed mid-wait.
Shutdown therefore takes as long as the longest work already holding the store
lock (a `POST /verb/wait` runs to its own timeout), so a platform that kills
the process a fixed time after SIGTERM (a container's stop timeout, a
supervisor's kill timeout) should allow more than that, or the kill lands on
work the lock was protecting. A hook call whose thread fails answers a
refusal, `serve-hook-failed`, with the harness's own block directive in
`stdout`.

## muse

`approval muse` starts a local, single-tenant synthetic consumer facade. The
operator fixes the tenant and distinct read/propose credentials in the launch
environment and the store root with `--dir` before the listener binds to
loopback. The proposal
scope can register an in-memory envelope and request its declared action. The
read scope sees status, pending requests and the canonical rendering of a live
request. Both scopes are narrow: the listener has no grant, reject, execution,
token, generic verb or export route. Human decisions use the separately
configured Telegram listener. A pending request does not prove delivery to
Telegram. See `docs/muse-connector.md` for the local HTTP contract, native
evidence limits and prerequisites.

## Constrained Codex preparation

approval codex prepare is an artifact generator. It writes one fresh review
directory and has no activation path. Its requirements, managed config,
launchers and launchd files are text for a human or MDM workflow to inspect.

approval codex setup --check proves only that those artifacts match their
closed manifest and hashes. approval codex doctor --strict asks the separate
host question: are the package and its ancestors root-owned and immutable, are
the three principals distinct, are the roots disjoint and canonical, and are
the broker and runner present? POSIX ownership does not establish ACL custody,
so this slice executes no manifest-selected binary and reports runtime versions
unchecked. Unknown evidence is a refusal.

The first slice deliberately made start and serve return codex-not-ready. An
npm install, generated config, or passing bundle check does not create a
mandatory boundary. The whole approval codex family is operator-only and absent
from the ordinary broad MCP catalog.

### The workspace broker (APRV-325.2)

approval codex apply is the executable half. It takes an instance manifest and a
proposal file, and the split between them is the design: the manifest supplies
the acting identity (agent:codex-<instance_id>), the workspace root, the policy
file and the log, and the proposal supplies operations and the SHA-256 of the
policy it was built against. A proposal naming anything else, an actor, a root,
a class, a token, a sandbox posture, is refused input-invalid rather than having
the extra key ignored, because a caller that wrote one meant something by it.

The order of one apply, and why each step is where it is:

1. Read the log under chain verification, read the policy once, hash those exact
   bytes, and check them against the latest attestation. An unattested or
   drifted policy refuses here, before a plan exists.
2. Compare the caller's expected digest. A mismatch is attestation-drift: the
   proposal was built against a policy nobody is enforcing.
3. Plan through src/codex/workspace-plan.ts, which does the path work: traversal,
   symlinks, hardlinks, case aliases, missing sources, existing destinations,
   preimage digests, and human-only classes refused before any preimage is read.
4. Register one action per distinct path class under a task id derived from the
   payload hash. Classes are never collapsed: the class is what the operator's
   roster, budget and autonomy are keyed to.
5. Authorize every leg. A leg the policy sends to a human refuses
   approval-required and names the action keys to grant; nothing is written, and
   the same proposal applies once a person has decided.
6. Start every leg before any byte moves. A later leg refusing to start closes
   the earlier ones execution.failed and leaves the workspace untouched by
   construction rather than by cleanup.
7. Take the workspace lock, then revalidate the plan under it. A revalidation
   that precedes the lock proves only what was true before another writer could
   act.
8. Stage the new bytes and the preimages on the same filesystem, fsync them,
   write a journal naming the before-state and the after-state, fsync that, and
   only then apply.
9. Read the workspace back. All-after completes every leg, all-before fails every
   leg, and anything else, a partial apply, a failed rollback, an endpoint that
   cannot be read, records execution.indeterminate with the reason
   workspace-commit-unknown on every leg and retains the journal and the lock.

approval codex recover reads that retained journal and reports before, after or
mixed. It repairs nothing, and the restraint is the point: rolling a mixed
workspace forward would guess which half the human approved, and rolling it back
would delete the half that committed. Exit 1 means mixed. The resolution is a
person's, through approval execution reconcile.

Custody is claimed only as far as the platform proves it. The broker takes an
O_CREAT|O_EXCL lock, which excludes other cooperating brokers and nothing else,
and then asks POSIX ownership and mode whether any other principal can write the
directories it is about to touch. It reports os-exclusive only when both hold and
advisory otherwise, and it always reports acl-unproven, because ownership and
mode say nothing about ACLs. --require-exclusive-custody turns the weak answer
into a refusal rather than a footnote.

approval codex serve publishes that broker over stdio as exactly one MCP tool,
codex_workspace_apply, checked at call time as well as at list time. It is a
different server from approval mcp serve, whose catalog is the whole verb
registry and therefore grows: a constrained session has to reach one door, and
the same door next month.

### The confined session (APRV-325.3)

approval codex start prepares the room a session's shell runs in. With no
-- <command> it reports the room and runs nothing, which is what an operator
checking a host should not have to start Codex to learn. With one, it runs that
command inside the room and exits with the child's own code.

The shell gets a disposable workspace under the system temporary directory, and
that workspace is the only path it may write. The canonical workspace is
readable and never writable. Reads are jailed to exactly those two roots
(APRV-347), so the gate home, other repositories and everything else the
operator's home holds are unreadable whether or not anyone thought to name them,
and the credential denials are emitted after the jail's allows so they remain
the last word on the vault, the environment map and the sealing keys. The
environment is an allow-list rather than a filtered copy of the operator's, so a
provider key nobody taught this runtime about is absent rather than forgotten.
Outbound network is denied, loopback included. Descendants inherit all of it,
which is the property that matters: a session does not write files by calling
into this runtime, it spawns shells that do.

There is no opt-out flag and no unwrapped fallback. approval run has
--no-sandbox because a human's grant over exact bytes is authority to reach the
world; a confined session has no such authority to present, so a host with no
sandbox mechanism refuses (sandbox-unsupported) where approval run would record
unsupported and proceed. A command that cannot be resolved on the session PATH is
refused rather than spawned outside the room.

The disposable workspace is removed when the session ends, so a replay of the
same shell work starts from an empty room. Only a brokered change survives it,
which is the whole arrangement: the shell cannot reach the canonical workspace,
and approval codex apply is how a change that a policy admitted does.

### The app-server bridge (APRV-361)

```
approval codex bridge --prompt <text> [--workspace <dir>] [-- <server command>]
```

approval codex bridge starts `codex app-server` and answers every approval
request it raises through the policy and the log. Each
`item/commandExecution/requestApproval` carries `command` and `cwd` on the same
frame, minted by the harness runtime, and those two fields are exactly the pair
the native hook lacks: a Codex `Bash` pre-event names only the command, so
`approval hook codex` refuses every shell call as
`hook-unsupported-execution-context` rather than bind bytes whose directory it
does not know. Here the directory arrives with the question.

It reuses the hook's decision path rather than a copy of it. The request becomes
the hook's own input (tool `Bash`, `tool_input.command` the string the server
sent, `cwd` the directory it named) and goes through the same classifier, the
same human-only refusal, the same sandbox requirement, the same loop floor and
unattended guard, and the same register, request and wait against the verified
view. What differs is where the answer goes: `{id, result: {decision}}` on the
connection instead of a decision object on stdout.

The deadline is the policy's `approval_ttl`, not a harness ceiling. Every hook
adapter answers inside a timeout its harness sets, and the retry grace exists so
a denial-by-deadline is recoverable; this transport has no timeout at all, so a
human who answers in eleven minutes is answering rather than arriving too late.
`--wait` overrides it. The bridge therefore states no `--harness-cap` and the
window shortening of APRV-423 never applies to it: there is no process here that
something else will kill, so there is nothing for a cap to keep ahead of.

It answers accept or decline only, in the vocabulary the request advertised
through `availableDecisions`, matched exactly and never by prefix, so
`acceptWithExecpolicyAmendment` is not read as an accept. It never sends
`acceptForSession` (standing authority for a whole session is a grant shape this
project does not have), `cancel` or `abort` (those mean "stop the turn", and
sending one would record an interruption as a denial). A request advertising
nothing gets `accept` or `decline` and the report says the word was this
runtime's own.

The vocabulary is eight spellings of those two words (`accept`, `approved`,
`approve`, `allow`; `decline`, `denied`, `deny`, `reject`), and since APRV-367
it is a type rather than a convention: the reply value cannot be constructed
outside the list, one function turns a decision into bytes and re-checks
membership there, and a word that somehow failed that check would be sent as a
decline, since the only safe substitute for a word you cannot name is no. The
match is case-insensitive, and what goes on the wire is this runtime's own
spelling of the matched word. The `bridge-decisions` conformance suite pins the
behaviour for a second implementation.

Its own refusals, beside the gate's:

```
bridge-request-unbound       no command, no cwd, or no call identity on the request
bridge-command-unbound       a command string that names no argv this client can bind (APRV-362)
bridge-file-change-unbound   an item-based file change whose content this client cannot
                             produce from the item/started frame its item id names: no such
                             frame, an item that is not a fileChange, an empty change set, or
                             a frame belonging to another thread or turn (APRV-379)
bridge-file-change-already-completed
                             item/completed for that item arrived before the question, so the
                             change had finished before this client was asked (APRV-379)
bridge-unknown-request       a server request this client has no reading for
```

The **item-based file change is correlated, not guessed** (APRV-379). That API
puts the content on an earlier `item/started` notification and the approval
request refers to it by `itemId`, so the bridge keeps every item the thread
announces and decides the request against the frame that id names: the paths
take their classes, the payload binds the change set verbatim with
`content_sha256` over it as received, and nothing parses the `diff`. The request
carries no directory, so the paths resolve against the workspace the bridge
named on `thread/start`, and one landing outside it is refused `hook-io`.

The **exec request binds words, not a rendering** (APRV-362). The item-based API
delivers the command as one string, joined from the argv Codex will run, so the
bridge un-joins it and the registered payload carries the string that arrived
and the argv beside it. A string that is not readable as a join (an unterminated
quote, a double quote outside a quoted run, a trailing backslash, or separation
no join produces) is `bridge-command-unbound`, because approving it would
approve this client's own re-parse. Byte equality with a re-rendering is
deliberately not required: a join written for shell safety quotes more than this
one does, and demanding equality would refuse ordinary traffic over a quoting
rule nothing here records. A legacy argv array is rendered word by word rather
than concatenated, so `["bash", "-lc", "rm -rf build"]` reaches the classifier
as `bash -lc 'rm -rf build'` and not as five separate words.

A **legacy `applyPatchApproval` is decided rather than declined** (APRV-363).
Its `fileChanges` map rides on the request, so there is nothing to correlate and
nothing is re-rendered: the change is classified by the paths it names, through
the same protected-path rules every other file tool uses, and the registered
payload carries those paths, the change verbatim and `content_sha256` over the
map as it arrived. A path that is absolute, or that resolves outside the
directory the server named, is refused `hook-io`; a request with a map and no
directory (`cwd` or `grantRoot`) is `bridge-request-unbound`. The item-based
`item/fileChange/requestApproval`, which carries an identifier and no content,
stays declined.

The thread is started with `approvalPolicy: untrusted` and `sandbox: read-only`.
`untrusted` is the wire spelling of the source's `UnlessTrusted`, the only
variant under which every command asks, and the server refuses the source name.
There is no flag for it: a session gating an unknown fraction of itself is what
the pin exists to prevent (APRV-366).

The pin is checked as well as sent, and a failure ends the run rather than
declining one request:

```
bridge-thread-start-refused       the server refused thread/start, so no thread
                                  exists and no policy was established; its own
                                  error is carried verbatim
bridge-approval-policy-mismatch   the server reported an effective approval
                                  policy that is not untrusted
```

A server that reports no policy at all is run against, because the observed
0.155.0 server echoes none and a client demanding an echo could not start. The
report says which case it was: `thread.requested` is what went on the wire,
`thread.effective` is what the server said, and `thread.confirmed` names where
the claim comes from: `unconfirmed`, `reported` (a frame echoed the pin back)
or `observed` (a probe command produced an approval request that reached this
client). Both stops exit 4, as every other protocol stop in this verb does; the
code in the report is the part to branch on.

**A preflight probe runs before every turn** (APRV-364). Codex's auto-reviewer
can resolve an approval with a model call before this client is asked, and
nothing in the protocol reports whether it is running, so the bridge watches one
command instead of reading a setting. Each start asks a preflight turn for
`true` and nothing else, before the operator's prompt, with no flag to skip it;
it costs one turn per start. The probe's own request is declined immediately as
an observation and never reaches the gate, so nothing is registered for it and
no approver is asked about it.

```
bridge-preflight-void             the preflight turn ran no command at all, so
                                  nothing was established; the report carries
                                  the turn's frames verbatim and nothing is
                                  retried. Run the verb again
bridge-auto-reviewer-active       an item/autoApprovalReview notification
                                  arrived in either turn: something other than
                                  this client answered a question
```

A probe that RAN without asking is `bridge-approval-policy-mismatch`, because a
policy under which one command did not ask is not `untrusted` whatever the
server reports about itself. A probe that was asked about lets the real turn
run, and `thread.confirmed` becomes `observed`. That word is narrow on purpose:
it says one question reached this client unanswered by anything else, and it is
not a claim that the auto-reviewer is off. The report's `preflight` block
carries the turn id, the command, the outcome (`asked`, `executed`, `void` or
`pending`), the word sent, and, on a void, the frames.

**It is an advisory checkpoint and not a boundary**, for reasons
docs/codex-app-server-bridge.md states in full: Codex's auto-reviewer can
resolve a question before this client sees it, and the approval policy and
sandbox posture decide how many questions exist. An open gate window is not
honoured here either, which is the strict direction. The claim it supports is
"this client decided every question this app-server child asked in this
session", and nothing wider.

**Custody is the operating system's** (APRV-365). The server is started by this
verb as its own child over stdio pipes: there is no socket, nothing binds a
path, and no other process holds a descriptor to speak on, so the replay of a
pending request to whatever connects next cannot arise inside one run. The
scope of the claim is that child and that session; a Codex started outside this
arrangement is a different process and nothing here observes it. The verb does
not inspect the command after `--` for a shape that would attach to something
already running instead: that would be a guess at another program's command
line, and a check written against a guessed shape finds nothing while reporting
that it looked.
