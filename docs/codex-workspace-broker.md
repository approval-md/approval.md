# The Codex workspace broker

`approval codex apply`, and the one-tool server `approval codex serve` in front
of it, are the executable half of APRV-325. `docs/codex-workspace-planner.md`
describes the read-only planner this is built on; that document's closing
warning, that snapshot checks establish no OS custody, is the gap this one
closes as far as a POSIX host allows and says plainly where it does not.

## What is fixed, and what a caller may say

Everything that decides authority comes from the instance manifest, which lives
under a root-owned install root (`docs/codex-enforced-session.md`,
`approval codex doctor --strict`):

| fact | source |
|---|---|
| acting identity | `agent:codex-<instance_id>` from the manifest |
| workspace root | `paths.workspace` |
| policy file | `paths.policy` |
| event log | `paths.log` |
| action class | derived from the path by the policy's `protected_paths` |
| reversibility | always `false` |

A caller supplies two things and nothing else: `operations`, and
`expected_policy_sha256`. Any other key is refused `input-invalid`. There is no
`--as`, no path, no class, no token and no sandbox argument in the published
tool schema, because none was ever published and so none had to be removed.

The server-side allowlist is positive and has one member. A name not on it is
refused whether or not anything advertised it, and the check runs at call time
as well as at list time.

## The order of one apply

1. **Verified log, attested policy.** The log is read under chain verification;
   the policy file is read once and those exact bytes are hashed and checked
   against the latest attestation. Unattested, drifted or unparseable policy
   refuses before a plan exists.
2. **Expected digest.** A caller's `expected_policy_sha256` that differs from
   the attested digest refuses `attestation-drift`: the proposal was built
   against a policy nobody is enforcing.
3. **Plan.** `planWorkspaceProposal` does the path work. Traversal, absolute
   paths, symlinks, hardlinked preimages, case aliases, missing sources,
   existing destinations and preimage mismatches are refused, and a human-only
   class is refused *before* its preimage is read.
4. **Register.** One action per distinct path class, under a task id derived
   from the plan's payload hash. Classes are never collapsed: the class is what
   the operator's roster, budget and autonomy are keyed to, and an action that
   reports a cheaper class than it performs is exactly the self-report SPEC.md
   §11.1 invariant 4 forbids.
5. **Authorize every leg.** Policy decides. A leg the policy sends to a human
   refuses `approval-required` and names the action keys awaiting a decision;
   nothing is written, and the identical proposal applies once a person has
   granted. No grant is fabricated and no token is minted here.
6. **Start every leg before any byte moves.** A later leg refusing to start
   closes the earlier ones `execution.failed` and returns `start-refused`. The
   workspace is untouched by construction, not by cleanup.
7. **Custody, then revalidation under it.** The lock is taken first and the plan
   is revalidated afterwards, because a revalidation that precedes the lock
   proves only what was true before another writer could act.
8. **Stage, journal, apply.** New bytes and preimages are written and fsynced
   into a staging directory on the same filesystem, then a journal naming the
   before-state and the after-state of every endpoint is written and fsynced,
   and only then does anything move.
9. **Read the workspace back.** The outcome is what the readback proved, never
   what the applying code believed: a `rename` that returned zero and a `rename`
   whose effect a crash lost look identical from inside the process that made
   the call.

## The three outcomes

| readback | broker result | log |
|---|---|---|
| every endpoint is the after-state | `ok`, `state: "after"` | `execution.completed` on every leg |
| every endpoint is the before-state | `commit-not-applied` | `execution.failed` on every leg |
| anything else | `commit-unknown` | `execution.indeterminate`, reason `workspace-commit-unknown`, on every leg |

`workspace-commit-unknown` is new to SPEC.md §8's closed reason set and to
`schema/event.schema.json` (APRV-325.2). It is the local counterpart of
`act-threw`: POSIX offers no atomic multi-file rename, so a crash, a permission
error or a failed rollback can land between two of them. It is a separate member
rather than a reuse of the first because a reader deciding what to do next needs
to know whether the unknown effect was a remote call or a half-written tree.

A mixed commit retains both the transaction journal and the workspace lock, so
no further brokered change can run until a person has looked.
`approval codex recover` reads that journal and reports `before`, `after` or
`mixed`, and it changes nothing: rolling a mixed workspace forward would guess
which half the human approved, and rolling it back would delete the half that
committed. Resolution is `approval execution reconcile`, which is human-only.

## What custody does and does not prove

The broker takes an `O_CREAT | O_EXCL` lock on a reserved name in the workspace.
That excludes every other broker that respects it and nothing else. It then asks
POSIX ownership and mode whether any principal other than its own effective user
can write the workspace root or the directories the transaction touches.

- `os-exclusive`: the lock is held and POSIX says no other principal can write.
- `advisory`: the lock is held and that second claim failed or could not be made.

Every report also carries `acl-unproven`, because ownership and mode say nothing
about ACLs — the same honesty `approval codex doctor --strict` already keeps.
`--require-exclusive-custody` turns the weak answer into a refusal instead of a
footnote, and an installation that needs the strong claim sets it.

Two paths inside the workspace are reserved and can never be a proposal
endpoint: `.approval-codex-txn/` and `.approval-codex-lock`. Staging must share
a filesystem with the workspace for `rename` to be atomic, so it lives inside
it; reserving the names is what stops a proposal from writing its own journal.

## What this is not

This is a gate on **workspace writes**. It confines no shell, revokes no
credential and blocks no egress, and neither its presence nor a passing
`codex setup --check` makes a session enforced. A Codex session that can still
write the workspace by some other route is not bounded by this broker, and
proving that no such route exists is APRV-325.3's job, not this one's.
