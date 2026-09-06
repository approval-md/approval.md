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

The three subcommands open the log for reading only. `verify` walks the hash chain
end to end and reports clean | torn-tail | corrupt, `tail` prints the last N
records (default 10), and `export` streams every stored line to stdout, byte for
byte. The default log path is `.approval/log/events.jsonl`, relative to the
working directory.

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
4. **Baseline.** The working file is set to the bytes git already has at `HEAD`,
   so the path is clean and a fast-forward can move over it. That is a plain
   write of bytes we are holding, not a checkout.
5. **Fetch, a fast-forward CHECK, then the merge.** A non-fast-forward is named
   and refused (`log-sync-not-fast-forward`): a merge commit over the log would
   be a merge of two hash chains, and chains do not merge.
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
7. **Reconcile.** The committed chain must be a prefix of the snapshot, equal to
   it, or an extension of it. Prefix: the snapshot goes back, because the longer
   chain contains the shorter one whole. Extension: the pulled file stays, for
   the same reason in the other direction. Anything else is a fork:
   `log-diverged`, both heads, the first divergent seq, snapshot restored,
   nothing else touched. Re-chaining is fabrication and this verb will not do it.
8. **Projections are REBUILT, never copied back.** `QUEUE.md` is re-rendered from
   the reconciled log and the index is reindexed from it. The direction is
   load-bearing: a projection restored from before the pull would be a
   screenshot asserting something the log no longer says.
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
 "prUrl":null,"dryRun":false}
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
  what policy actually said.
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
"irreversible" are three different questions. Only the explicit `false` engages
SPEC §7's irreversibility floor.

**`--json`** (one object on stdout):

```
{"class":"vcs.push.main","reversible":null,
 "outcome":{"autonomy":"supervised","approvers":null,"limits":null},
 "provenance":"rule"|"default"|"inherited"|"fail-closed"|"floor",
 "manualBecause":null|"matched-rule"|"irreversibility-floor"|"load-failure",
 "loadFailure":null|{"code":"file-missing"|"no-block"|"multiple-blocks"|
                     "yaml-error"|"schema-invalid"|"protected-route-floor",
                     "message":"..."},
 "matched":null|{"pattern":"vcs.push.main","rule":{"autonomy":"supervised"}},
 "overridden":null|{"pattern":"read.web"|null,"autonomy":"autonomous"},
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
`{"policy_path":"APPROVAL.md","sha256":"<64 hex>"}`.

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
running the policy suite against the amended file (21 pinned resolutions)
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
expectation diff. Nothing is attested, committed or pushed on that path. The pins
live in `src/core/policy-expectations.ts`, which the dogfood suite imports too, so
the check on the laptop and the check in CI are one list: update the pins, run
`npm run build`, and re-run the ceremony.

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

`--commit` carries exactly two files: the policy and the log. It refuses outside
a git repository, and refuses when the index holds staged changes to anything
else — a commit that swept in an unrelated staged edit would make "this commit
is the amendment" false. On the branch flow it also refuses when there is no
`origin` remote, and when a `--branch` name already exists. Every one of those
refusals happens BEFORE the attestation, so a refused `--commit` never leaves an
attested policy without its commit. The same holds for the fetch, the two base
checks and the policy suite above.

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
  ✓ committed the policy and the log together:

    git add APPROVAL.md .approval/log/events.jsonl
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
6. attests: one `policy.updated` event, identical to `approval policy attest`;
7. prints, or with `--commit` runs, the git ceremony — `git add <policy> <log>`,
   a `git commit` citing the attestation seq, and the push (and, on the branch
   flow, the branch and the pull request);
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
 "ceremony":{"attested":true|false,"seq":null|2},
 "publishing":null|{"attempted":true,"complete":true,
             "via":"direct"|"branch"|"recovery"|"none",
             "branch":null|"policy-amend-2","pushed":true,
             "prUrl":null|"https://...",
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
- `commit-preconditions` — `--commit` outside a git repository, with staged
  changes beyond the policy and the log, or (branch flow) with no origin remote
  or a `--branch` name already taken. Checked before the attestation; nothing was
  appended.
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
- `loop-escalated` — three consecutive `execution.failed` events escalated the
  task to manual (SPEC.md §10.2). Its MANUAL actions are unaffected; the streak
  clears on a completion.
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
told wrong. `--payload-hash` is consequently a CHECK and never a substitute
(APRV-140): a value differing from the recomputed one is refused
`payload-mismatch` before the child exists and before anything is appended. An
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

This is a scrub and not a sandbox. The child keeps the network, the filesystem,
and every other ambient capability of the session, so a granted command can
still reach anything the session could reach. Taking those away is APRV-193's
subject, and `approval run` says nothing here that pretends otherwise.

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
- `loop-escalated` — three consecutive `execution.failed` events escalated the
  task to manual; route it through a human grant instead.
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

## wait

Polls the log and writes nothing — not even the `approval.expired` event it may
derive: expiry is judged lazily from the request's own timestamp, and
materialising it is `approval expire`'s job, not a reader's. The one exception is
`--withdraw-on-timeout`, below.

For `approval wait` the exit code IS the decision (SPEC.md §10.1). The
overloading of 1 (integrity / rejected) and 3 (torn tail / expired) is
deliberate: wait appends nothing and cannot fail a chain verification of its
own, and `--json` names the outcome exactly (`granted | rejected | withdrawn |
expired | timeout`) for callers that need more than a number. Flagged for human
review.

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
          "status":"granted"|"rejected"|"withdrawn"|"expired",
          "actions":[{"action_key":"...","state":"granted","seq":4}]}
timeout  {"ok":false,"task":"task-042","status":"timeout",
          "actions":[{"action_key":"...","state":"requested","seq":3}]}
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
with rejected/revoked outranking withdrawn, withdrawn outranking expired, and
expired outranking granted. `--timeout` and `--interval` take the SPEC.md §5.2
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
 "ttl_remaining_ms":3599000}]}
```

`pending` is `[]` for an empty inbox. `ttl_remaining_ms` is null when the policy
declares no `defaults.approval_ttl` (no TTL means no lapse).

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
- `loop_escalations` — tasks with three consecutive `execution.failed` events.
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

**`--json`** (one object on stdout):

```
{"ok":true,"healthy":false,
 "attestation":{"state":"attested","seq":1},
 "verification":{"status":"clean","records":6},
 "dangling":[{"action_key":"...","task":"...","ts":"...","seq":5}],
 "budgets":[{"limit":"global.daily_usd","scope":"global",
   "window":"rolling-24h","consumed":0.02,"requested":0,"remaining":9.98,
   "pass":true}],
 "loop_escalations":[{"task":"task-042","consecutive_failures":3,
   "escalated":true}],
 "coverage":{"available":true,"reason":null,"observed":4,"covered":3},
 "reconciliation":[{"seq":18,"ts":"...","action_key":"...","task":"...",
   "class":"records.write","obligation":"gated-revert","review_seq":17}],
 "payload_store":{"present":true,"files":2,"pruned":0,"orphans":0,
   "note":"..."}}
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

### The window rule, stated exactly

For one observed effect, evidence is the EARLIEST record that is all three of:

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

**The AgentMail join is by class and window, not by message id.** The adapter
reports the provider's own `message_id` and the report prints it, but the id is
not matched against anything: `execution.completed` records an `exit_code`, and
the provider's id reaches only the CLI result, so an id-level binding needs an
event-schema amendment. Putting the reference on-chain is APRV-251. Until that
lands, a sent message is covered by a record of its class inside its window,
exactly like a commit, and the id in the report is there for a person to paste
into the provider's own console rather than for this verb to match on.

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
  registers `approval hook` for PreToolUse over every gated tool (Bash, Edit,
  Write, NotebookEdit). SKIP, named, when the file is absent, unreadable, or
  registers the hook for only some tools: a spawned-agent worktree without the
  entry is how the APRV-151 bypasses happened, and a session started elsewhere
  may still be hooked, so this row can only speak for the checkout it runs in.
  PASS means the entry is present on disk, and says so plainly: it is not proof
  the running session loaded it. The check that trusts no session is the
  CI-side grant cross-check (`scripts/protected-path-guard.mjs`) over the
  committed log, which since APRV-202 requires every added and removed line of a
  protected path to trace to the bound material of a grant, rather than only
  that the path was granted at some point in the week.
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
  and reduces nothing anywhere, so a match is not proof the hook fired.
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
  repair, because what the block should say is the human's to write.
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
`supervised-retro` class — and the bare `supervised`, which is now an alias for
it — is what this page is about. `approval policy check` names the mode in its
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
easier. The same reading applies to the irreversibility floor that keeps a
`reversible: false` action out of `supervised-retro` entirely: it is a floor, not
a proof — it acts on the acting party's own claim, so it catches the honest
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
re-delivery banner. Bot commands are not read in that mode, and the listener
asks Telegram for callback updates only.

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
{"event":"stopped","notified":1,"updates":1,"decisions":1,"pollErrors":0,
 "anomalies":{"foreign-chat":0,"malformed-callback":0,"unknown-callback":0,
 "key-mismatch":0}}
```

The raw execution token is never in the JSON stream.

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
action classes. Claude file tools (Edit, Write, MultiEdit, NotebookEdit) and
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
- `hook-opaque` — a construct whose effect cannot be read from the text
  (`bash -c`, `eval`, backticks, a non-read substitution).
- `hook-unparseable` — the command line could not be tokenized.
- `hook-rejected` — a human said no.
- `hook-revoked` — a granted approval was withdrawn.
- `hook-expired` — the TTL lapsed before a decision.
- `hook-timeout` — no decision inside `--timeout`; the request stays live.
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
`wants` and none in `love`, `like` or `dislike`: grading is the human's act,
and an importer that guessed a grade would be putting words in their mouth. A
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
`--preflight-remote` and `--preflight-base` flags. It is here as well as there
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
`manual`, stops it with nothing committed and the question in the queue. A gated
or failed attempt is an `advance` line plus an `advance-refused` warning, and the
next tick tries again — the cadence interval is the retry bound, so a refusal
never loops. One records branch and ONE PULL REQUEST PER DAY: the first advance
of the day opens it, every later one is parented on the branch and updates it in
place. The daemon never merges; `gh pr merge` is `vcs.push.main` and stays a
human's act or a session's.

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
  carries the comparison it made. Git is read, never fetched.
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
 "rebuilt":false,"rebuilt_on":null,
 "code":null,"message":"seq 4..10 is on records-log-2026-09-01","flush":false}
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
`advance-refused`, `draw-unavailable`. A warning never stops the
loop, and neither does `{"event":"git_evidence_failed","step":"commit",…}`.

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

## up

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

It is allowed exactly two writes: a `--ff-only` merge, and `npm run build`. It
never resets, never stashes, never checks anything out, and never touches the
working log. That list is not caution for its own sake: a working `events.jsonl`
rewound through git underneath a live appender is fork 2 of 2026-08-20, the
incident `approval log sync` exists to prevent.

**Safe** means both of: this checkout is not AHEAD of the remote, and no path the
upstream range changes is locally modified. When it is safe, the preflight
fast-forwards, rebuilds if `dist/` is older than `src/`, and names the commit now
running. When it is not, it refuses, and changes nothing:

| code | fires when | next |
|---|---|---|
| `up-preflight-behind-ahead` | `origin/<branch>..HEAD` is non-empty: this checkout carries commits the remote has never seen. A fast-forward is not the operation for that state, and choosing a side is a decision. | look at them (`git log --oneline origin/main..HEAD`), then push them or `git reset --keep` |
| `up-preflight-log-diverged` | the upstream range rewrites `.approval/log/events.jsonl` or `.approval/QUEUE.md`, and this working copy has uncommitted changes to one of them. The judgment a human could not make by eye. | `approval log sync` |
| `up-preflight-dirty-protected` | some other path the upstream range changes is locally modified, so `git merge --ff-only` would refuse rather than overwrite it. | look at the diff, or `approval up --no-preflight` |

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

`--no-preflight` opts out, on both spellings of the verb.
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
`refused`, `skipped`, `fetch-failed`. The commit now running is named here rather
than on `up_started`, so a consumer that already parses `up_started` does not
have to learn a new key to keep working. A refusal writes one object to stderr
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
sanctioned journey is from the vault into an adapter, inside the verified-token
window the adapter contract holds open (SPEC.md §10.4: "the credentials only
answer to tokens"). Names are visible; values are not.

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

An adapter is the hard boundary of SPEC.md §10.4: it holds the credentials and
refuses to act without a valid, unexpired, single-use execution token bound to
the action's `idempotency_key` and its `payload_hash`. An agent that bypasses
this CLI still cannot send, because the credentials only answer to tokens.

The runtime, not the adapter, owns the sequence: recompute the payload hash,
verify and consume the token, append `execution.started`, call the adapter,
append the outcome. The adapter implements one method and cannot skip a step,
because it never holds the sequence.

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
`agentmail.api_key`, readable only inside the verified-token window the contract
opens. `approval setup adapter agentmail` stores that pair, and
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

**Failure codes** (in `adapter_code`): `agentmail-payload-invalid`,
`agentmail-payload-ambiguous`, `agentmail-config-invalid`,
`agentmail-inbox-mismatch`, `agentmail-from-mismatch`,
`agentmail-draft-missing`, `agentmail-draft-drifted`, `agentmail-unreachable`,
`agentmail-unauthorized`, `agentmail-not-found`, `agentmail-conflict`,
`agentmail-rate-limited`, `agentmail-rejected`, `agentmail-server-error`, and
the contract's own `credential-unavailable` / `credential-refused`.

Every HTTP refusal is a returned failure, so the contract records
`execution.failed`: the far side answered, and an answer is knowledge. A throw
from the SEND call is deliberately not caught — `execution.indeterminate` is the
honest record of a request that may have left the process. A throw from either
pre-send GET is `agentmail-unreachable`, because nothing was attempted.

**`--json`** carries the adapter contract's own result, unmodified, exactly as
`adapter email` does, with `"adapter":"agentmail"` and a `detail` of
`{"mode":"direct"|"draft","message_id":…,"thread_id":…,"payload_hash":…,
"recipients":N,"http_status":N}`.

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
SPENDS, read inside the verified-token window and by nothing else. There is no
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
verified-token window.

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
decoration. The key in the vault is read only inside the verified-token window
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

## setup channel

A channel is not an adapter, and the two setup verbs fill different stores.
SPEC.md §4: a channel surfaces requests and collects decisions and holds no
state, so what it needs is a transport credential — it goes into the OS keystore,
and `.approval/env` records where. An adapter executes side effects and holds
credentials, so `approval setup adapter <name>` fills the vault instead.

## setup channel telegram

Stop `approval channel telegram listen` first. Two processes long-polling one bot
is a 409 from the Bot API, and the loser is whichever asked second. This is a
configuration verb; it is not meant to run beside the listener.

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
