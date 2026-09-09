# Git evidence: two layouts, and why they do not mix

SPEC.md §8 offers an optional second evidence layer: the log directory is a git
repository and the daemon commits per event with its own identity. `approval
daemon run --git-evidence` implements it. This page states the two supported
layouts, the one that is refused, and the reasoning, so an operator can decide
before typing the flag rather than after being refused by it.

## The primary layer is the chain, always

Every record in `events.jsonl` carries `prev` and `hash`, and `approval log
verify` detects any mutation or truncation without consulting anything else.
That is true in every layout on this page, with or without the flag. Git
evidence never changes a verdict, never feeds a projection, and is never read by
the enforcement path. It adds a second, independent record of the same bytes:
one an operator can clone, mirror, and diff from a machine the tamperer does not
control. A mutation then has to be plausible against both layers at once.

Because it is redundancy rather than dependency, a git failure at runtime is a
warning and the daemon keeps going. Losing the second layer must never stop
approvals.

## Layout A: standalone log deployment (the opt-in applies)

The log's home directory is its own git repository, holding the log and its
payload store and nothing else.

```
/srv/approval/            <- git repository root, nothing above it is a repo
  .git/
  log/events.jsonl
  payloads/<sha256>.json
```

```sh
git init /srv/approval
approval daemon run --log /srv/approval/log/events.jsonl --git-evidence
```

After each tick in which the head moved, the daemon stages `log/events.jsonl`
and `payloads/` and commits:

```
seq 42 sha256:9f2c…

approvald 0.0.1 tamper evidence: 3 record(s) since the previous commit.
One commit per daemon tick, witnessing the verified head named above.
```

Details worth knowing before you run it:

- **Identity is the daemon's own**: `approvald <version>
  <approvald@noreply.approval.md>`, passed per commit with `git -c`. Your
  `user.name` is neither copied into the commit nor written anywhere on disk. A
  commit that claimed a human made it would be a false statement about who wrote
  the evidence.
- **Batching is one commit per tick**, not literally one per event. A tick is
  the only moment the daemon holds a *verified* head, and a commit is only
  meaningful against a head that verified. A tick that observed three appends
  makes one commit naming the new head and the number of records it covers; the
  intermediate states remain fully recoverable from the log, which is the
  artifact being witnessed.
- **Only the log and the payload store are committed.** `QUEUE.md` is a
  projection, rewritten every tick as TTL countdowns move; committing it would
  fill the history with churn that proves nothing the log does not already
  prove. Add it to a `.gitignore` in the log home if the untracked entry bothers
  you.
- **Nothing is ever pushed.** No fetch, no remote, no branch named by the
  runtime, no hooks (`--no-verify`), no signing prompt
  (`commit.gpgsign=false`), no credential prompt (`GIT_TERMINAL_PROMPT=0`).
  Mirroring the repository somewhere else is the operator's job, and it is the
  step that turns local commits into distributed evidence.

## Layout B: nested project layout (valid, without the opt-in)

This repository's own dogfood arrangement, and the common one: `.approval/` is
part of a larger project repository, committed alongside the code by the humans
working on it.

```
my-project/               <- the project's git repository
  .git/
  src/…
  .approval/log/events.jsonl
```

```sh
approval daemon run          # no --git-evidence, and none is needed
```

This is fully supported. Its tamper evidence is the hash chain, plus whatever
the project repository's own history already gives you when a human commits the
log. What it does not get is a daemon writing commits, and `--git-evidence` here
is refused at startup with `log-dir-nested`.

## Why the two do not mix

The refusal is not caution about an untested case. It is a statement about what
git can and cannot witness:

- **A hash chain does not survive a merge.** Two branches that each append to
  the log produce a chain that is corrupt by construction — the `prev` links
  fork — and no merge strategy repairs the semantics, because there is no
  ordering of the two branches' records that both branches attested to. A daemon
  committing into a branch that humans also branch and merge is manufacturing
  that situation on a schedule.
- **An outer repository rewrites the bytes.** Rebase, amend, squash, filter, and
  force-push are ordinary operations on a project repository and every one of
  them rewrites history the evidence is made of. Evidence the subject of the
  investigation can rewrite is not evidence.
- **A second writer to someone else's branch.** CLAUDE.md's single-writer rule
  for the committed log exists for exactly this reason; a daemon committing into
  a shared project branch violates it from the other direction.

So the runtime does not try to be clever: own-root repository, or no git
evidence at all.

## Refusals

All four are checked once, before the first tick — an operator who asked for a
second evidence layer and silently did not get one is worse off than one who was
refused at startup. Each is machine-readable under `--json` as
`{"error":{"code":…,"message":…}}`.

| code | meaning | repair | exit |
| --- | --- | --- | --- |
| `git-unavailable` | no working `git` on PATH | install git, or drop the flag | 4 |
| `log-dir-missing` | the log home is not a directory | create it, or fix `--log` | 4 |
| `log-dir-not-repo` | the log home is not a repository | `git init` in the log home | 2 |
| `log-dir-nested` | the log home is inside an outer working tree, or is not the root of the one it is in | move the log out of that tree, or run without the flag (Layout B) | 2 |

The last one fires in both nested shapes: a log home tracked by an outer repo,
and a log home that *is* a repository root but sits inside another repository's
working tree. Containment is the hazard, not tracking.

## Reading the evidence back: log anchoring (APRV-219)

Everything above is about WRITING a second record of the log. Anchoring is the
other half: reading it back, and refusing a working log that contradicts it.

Why the two halves are not the same thing is
`docs/proposals/incremental-prefix-proof.md` §3. The chain is unkeyed, so a
party with write access to `events.jsonl` can truncate it and recompute a chain
that walks clean from genesis; every check inside the file agrees with them.
What they cannot rewrite is a copy of the log already committed somewhere they
do not control, which is precisely what Layout A's per-tick commits, Layout B's
human commits, and `approval log advance`'s records branches all produce.

```sh
approval log verify --anchor          # the newest committed copy this checkout can see
approval log verify --anchor-rev refs/remotes/origin/main
approval doctor                       # the `log-drift` row is this same check
```

The check compares the working log's first N bytes against the anchored copy's
digest, and the working record at the anchored head's `seq` against the
anchored head's hash. A contradiction is `anchor-diverged` at exit 1. A working
log that is a strict *prefix* of the anchored copy is not a contradiction; it is
`behind`, and `approval log sync` is the repair. No committed copy at all is a
skip with a reason, never a pass. The rev resolution and the JSON shape are in
[cli-reference](cli-reference.md).

It reads git, never fetches, and writes nothing at all, which is what lets it
run on the daemon's hot path. `approval daemon run` resolves the anchor at
startup (the `started` line names the rev and seq it holds this run to) and
makes the comparison on every tick whose reads re-proved the prefix in full:
every tick under `read_proof: full`, and the re-proof cadence under
`incremental`. A divergence stops the daemon at exit 1 with its own outcome,
`anchor-diverged`, distinct from `log-corrupt` — one means the file contradicts
itself, the other means the file contradicts the record of it, and a daemon that
kept appending after either would be extending a chain nobody else has.

Anchoring applies in BOTH layouts, and it is why Layout B is not
evidence-free: a project repository whose humans commit `.approval/` gives the
check a witness at every one of those commits, and on the trunk behind whatever
branch protection the remote enforces.

## The second witness: human-signed checkpoints (APRV-220, APRV-257)

Anchoring answers "does somebody else hold a copy of these bytes?", and it
answers from git, so it is exactly as fresh as the last push and says nothing at
all on a machine with no remote. A checkpoint answers a different question with
a different witness: **did a key no agent process holds sign this head?**

```sh
approval setup checkpoint --as human:<id>   # mint the key (human-only ceremony)
approval log verify --checkpoints           # demand every checkpoint in range
approval doctor                             # the `checkpoint` row is this same check
```

Against the §3 forger the two fail in different directions, which is the point
of having both. The anchor catches a truncation whose records somebody else
already holds. A checkpoint catches one inside the window nobody has pushed yet:
every checkpoint in the rewritten range names a `(seq, hash)` the rewritten
chain does not carry, and the forger cannot re-sign the hashes they recomputed.
`--anchor` and `--checkpoints` are separate flags, the daemon runs both on the
same full re-proof, and **a skip on one never excuses the other**.

What each needs is different too, which is worth reading before choosing to run
only one:

| | anchor (APRV-219) | checkpoint (APRV-220/257) |
| --- | --- | --- |
| witness | a git object somebody else holds | an Ed25519 key the runtime has no copy of |
| freshness | the last push or commit | the last human tap |
| offline | skips: nothing to compare | works |
| needs a human | no | yes, on a cadence |
| absent | skip, never a pass | skip, never a pass |

The human half is a cadence rather than a chore. With `audit.checkpoint_every`
set, the listener puts one `CHECKPOINT DUE` prompt on the phone when one is
owed, and the signature happens on the machine the listener runs on, with the
vault passphrase a human exported into the shell that started it. A checkpoint
that is due and unsigned is a warning at every layer and a refusal at none: a
person who has been away is not evidence of tampering. The ceremony, the
rotation rule and what to do about a lost key are in
[cli-reference](cli-reference.md#setup-checkpoint); the design and the decisions
inside it are in [checkpoints](checkpoints.md).

## Demonstrating both layers

`tests/daemon-git-evidence.test.ts` runs the demonstration: commit a log,
rewrite a committed line in place, and observe that `approval log verify` exits
1 on the chain while `git status` and `git diff HEAD` independently report the
file as modified — and that the pre-tamper bytes are still readable out of the
witnessing commit.
