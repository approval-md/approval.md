# Watching a PR to a verdict

A session that pushes a branch, opens a PR and arms the merge has not shipped
anything. It has handed the work to CI. If CI goes red the arm never fires, the
PR waits, and from the Backlog side the task says Done. That is what happened to
PR #532: armed at 03:09, red, and still sitting there about twenty hours later.
Every session cut from `main` in that window branched from a `main` that did not
know the work had landed, which is exactly the stale-context churn the
pull-before-starting rule exists to prevent, and no pull fixes it.

Two habits close it. The lane watches its own PR to a verdict (below), and the
human can see every red armed PR at a glance without opening any of them
([At a glance](#at-a-glance)).

## The lane's side

Watch, in the terminal, until the checks resolve:

```bash
gh pr checks <n> --watch
```

It exits 0 when every required check passed and non-zero otherwise, so it is a
verdict and not a status page. The desktop app's CI monitor is the same thing
without the held terminal: bind the PR and set the monitor, and a failure wakes
the session that opened it.

A red shard names the run; the failing test names come out of the run's log:

```bash
gh run view <run-id> --log-failed
```

Fix, push, watch again. The session ends on green, or on a red whose cause is
filed as a Backlog task and named in the handover. It never ends on pending, and
it never leaves a red PR armed and unattended.

## Known failures are a list of names

A closing note that says "22 failures, the known baseline" is not evidence.
Two failures can swap places and leave the total untouched; PR #532's new
conformance failure hid inside a count that was, as a count, entirely correct.

`scripts/ci-baseline.json` holds the known failures as ids, each with the task
that owns the fix. Compare a run against it:

```bash
node scripts/run-tests.mjs --baseline
node scripts/run-tests.mjs --only adapter-email smtp-probe --baseline
```

The run prints, after the usual output, which failures were already on the list
and which are **NEW**, by name. Nothing about the exit code changes: a run whose
every failure is known is still a red run. What changes is that a lane can write
"these failures and no others" and mean it.

An ids file captured elsewhere (a CI artifact, say) compares on its own:

```bash
node scripts/ci-baseline.mjs <ids-file>
```

That exits 0 only when no failure is new.

**The list is a LOCAL baseline, and that is the point.** Every one of today's 22
entries is APRV-416, a Node 26 refusal of an IP literal as a TLS servername. CI
runs the floor on Node 20 and the shard matrix on Node 22, so all 22 pass there
and a green shard matrix says nothing about them. That asymmetry is exactly why a
lane needs both halves of this page: CI is the verdict on the code, and the
baseline is what lets a lane's own red local run still carry the sentence "these
failures and no others". A failure that is new locally is new whether or not CI
has noticed it yet — which is how the conformance regression inside PR #532's
count of twenty-two would have been caught.

A local run can also fail for reasons that are neither debt nor a regression.
`package-adapters` and `codex-package` pack the tarball and `npm install` it into
a scratch consumer, so they need registry access; a worktree with no
`node_modules` of its own fails them too. Those belong in a lane's report as
environment, not on this list, and the list stays short enough to read for that
reason.

Adding an entry means adding an id, the owning `APRV-` task and a one-line note.
A known failure with nobody's name on it is an unknown failure somebody got
tired of looking at, so the task id is required and loading fails closed without
it. Fixing a failure means deleting its entry in the same PR.

## At a glance

Every open PR of yours that is armed for auto-merge and cannot merge, in one
line:

```bash
gh pr list --state open --json number,title,mergeStateStatus,autoMergeRequest \
  --jq '.[] | select(.autoMergeRequest != null and .mergeStateStatus != "CLEAN") | "\(.number)\t\(.mergeStateStatus)\t\(.title)"'
```

`mergeStateStatus` is the field that separates the two ways an arm stalls:

| value | what it means |
|---|---|
| `CLEAN` | mergeable, checks passed; the arm will fire |
| `BLOCKED` | a required check is failing or still pending, or a review is required |
| `DIRTY` | merge conflict with the base branch; the arm is lost until the branch is repaired |
| `BEHIND` | the branch needs updating before it can merge |
| `UNKNOWN` | GitHub has not finished computing mergeability; ask again in a moment |

An armed PR sitting at `BLOCKED` is the red-and-waiting case. An armed PR that
went `DIRTY` is the conflict case, which for a records or policy branch is
[APRV-420](../backlog/tasks) territory: see `approval policy amend --pr` in
[the CLI reference](./cli-reference.md).

Drop the `select` to see the state of every open PR:

```bash
gh pr list --state open --json number,title,mergeStateStatus,autoMergeRequest \
  --jq '.[] | "\(.number)\t\(.mergeStateStatus)\t\(if .autoMergeRequest then "armed" else "-" end)\t\(.title)"'
```

In the desktop app the same information is the PR bar: bound PRs show their
check state there, and a red one is visible without opening the PR page.
