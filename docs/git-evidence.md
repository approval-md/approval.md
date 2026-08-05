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

## Demonstrating both layers

`tests/daemon-git-evidence.test.ts` runs the demonstration: commit a log,
rewrite a committed line in place, and observe that `approval log verify` exits
1 on the chain while `git status` and `git diff HEAD` independently report the
file as modified — and that the pre-tamper bytes are still readable out of the
witnessing commit.
