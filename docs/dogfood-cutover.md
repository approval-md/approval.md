# Dogfood cutover — the daemon takes the pen (APRV-49)

M5 shipped the daemon. This page turns CLAUDE.md's interim rule ("if a gate
operation is needed mid-task, stop and escalate") into the workflow it was
holding the door for: agent sessions route manual-class repo actions through
`approval request` + `approval wait` against the live log, the daemon watches
and renders, and the decision arrives from the human's phone.

Everything here operates on the PRIMARY checkout (`/Users/carter/dev/approval-md`)
and its committed log. Nothing below ever runs in an agent worktree, and
log-touching commits never ride feature branches; those two rules are unchanged.
The one process that a worktree session does start is `approval hook
claude-code`, and it obeys the same rule from the other side: it resolves the
primary checkout and appends there, or denies with `hook-log-unreachable`
(APRV-101), so no worktree ever grows a log of its own.
Main is protected, so the log commit reaches it through a branch that exists for
exactly one commit and a pull request merged with a merge commit. See "The proof
runbook" below for the commands, and `approval policy amend --branch` for the
version the CLI runs itself.

## The session workflow

A session that needs a manual-class action (`deps.add`, `network.call`,
`release.publish`, `vcs.history.rewrite`, `files.delete.out_of_scope`,
`policy.edit`) does this, all against the primary checkout's paths:

```sh
cd /Users/carter/dev/approval-md

# 1. The task file carries the approval envelope (see backlog/tasks/aprv-51
#    for the first real one). Register it: validates the envelope, appends
#    task.registered.
approval register "backlog/tasks/<task file>.md" --as agent:<session>

# 2. Request the action. The class, cost, and reversibility come from the
#    registered record; the payload is supplied here and filed by hash.
#    For a command-shaped action the payload is {"argv": [...], "cwd": "..."}.
approval request <TASK-ID> --action "<idempotency-key>" --as agent:<session> \
  --payload <payload.json>

# 3. Block on the decision. Exit code encodes it: 0 granted, and each refusal
#    shape is its own documented code (approval wait --help).
approval wait <TASK-ID> --timeout 6h

# 4. On grant, execute through the gate with the token the human's grant
#    minted. run recomputes the payload hash from the argv+cwd it is about to
#    spawn; a changed command is refused payload-mismatch.
approval run "<idempotency-key>" --token <token> --as agent:<session> -- <cmd...>
```

On **reject**, the session records the refusal in its task notes and does not
retry the same request. On **timeout/expiry**, the request dies per policy
(`on_expiry: reject`); a session that still needs the action opens a fresh
request, which is a fresh fact for the approver. Three consecutive
`execution.failed` for one task escalate to manual regardless of policy.

Token delivery: `approval grant` prints the raw token exactly once, on the
channel the human used. For a phone grant via the Telegram listener, the token
reaches the operator terminal running the listener; handing it to the session
is the human's step, which is what makes the human the gate.

## The daemon, live

The human runs, in the primary checkout:

```sh
eval "$(approval env)"         # APPROVAL_HUMAN, APPROVAL_TG_TOKEN, APPROVAL_TG_CHAT
approval daemon run &          # watch, drift, TTL, QUEUE.md — the sole writer
approval channel telegram listen   # pushes requests to the phone, records taps
```

That eval establishes the identity the human-only verbs read and the bot token
and chat id the listener needs, from the sources recorded in `.approval/env`.
`approval setup identity` and `approval setup channel telegram` are what write that file
(the token goes into the OS keystore, the file records where); `approval env
--check` prints the whole table with no values in it; and nothing reads the file
implicitly, which is why the eval is a step a human takes. Exporting the three
variables by hand still works and is what the eval expands to.

(Foreground processes by design; two terminals or a multiplexer. Backgrounding
is the operator's business at v0.1.)

The listener delivers requests **as they arrive**, not only the ones pending
when it started (APRV-55). Before every `getUpdates` it re-derives the pending
queue from the verified log and sends whatever it has not already sent this
process lifetime, so a session that runs `approval request` an hour into the
day gets its message on the phone within one poll cycle, with no restart. The
M5 proof ran the other way round (request first, listener second) and so never
exercised this; the order no longer matters.

Two consequences worth knowing at the terminal. A restarted listener re-sends
everything still pending, because the "already sent" set lives only in the
process (SPEC.md §10.3: channels hold no state that is truth), and the buttons
on the pre-restart messages stop resolving: a duplicate on the phone, never a
request nobody sees. And a send that fails is retried on every later cycle
without an attempt limit, so a phone out of signal or a Bot API outage delays
delivery rather than dropping it; the stderr warnings thin out after a few
consecutive failures for the same request. Only a failure during the startup
send exits non-zero, which is how a mistyped token or chat id announces itself.

`approval channel web` needs no equivalent: it builds the queue from the log on
every page load, so a refresh shows what is pending now. `approval channel cli`
is one-shot by design; running the verb again is its refresh.

## Drafts for the human's hands

Agents do not edit CLAUDE.md or APPROVAL.md. The two edits this cutover wants
are drafted here for the human to apply verbatim or amend.

### CLAUDE.md — replace the final bullet of "Dogfooding — escalates at M2"

Replace the bullet beginning "**The committed log has one writer.**" with:

```markdown
- **The committed log has one writer: the daemon.** `.approval/log/events.jsonl`
  on main is the project's live log, and `approval daemon run` in the primary
  checkout is its sole writer while it runs (the M5 daemon this rule was
  waiting for; CLI verbs still serialize through the append lockfile when it
  is not running). Sessions no longer stop and escalate for manual-class repo
  actions (deps.add, network.call, release.publish, and kin): they carry an
  approval envelope on the task file, then run `approval register`,
  `approval request`, and `approval wait` against the PRIMARY checkout's log
  and policy, and proceed only on a granted exit, executing through
  `approval run` with the granted token. The decision arrives via the
  Telegram channel; docs/dogfood-cutover.md is the runbook. Unchanged and
  still binding: gate operations never run in agent worktrees, log-touching
  commits never ride feature branches, and hash chains do not survive git
  merges. A session that cannot reach the gate (daemon down, channel dark,
  wait timed out) is back under the old rule: stop and escalate.
```

### APPROVAL.md — optional additions (policy already carries the classes)

The three manual classes this cutover routes (`deps.add`, `network.call`,
`release.publish`) are already in the attested policy; no edit is required
for the proof. Two additions are worth making when convenient, via
`approval policy amend` so the edit and its attestation land together:

```yaml
audit:
  supervised_sample_rate: 0.15
  sampling_secret_env: APPROVAL_SAMPLING_SECRET   # name only; secret in the env
```

and, if request volume grows, per-class `limits.max_pending` per SPEC §5.2.
`approval setup sampling` mints and stores the secret and records where it
lives; it prints this amendment rather than making it, because an amendment ends
in a human attestation and a wizard that edited an attested policy would be
forging the sign-off. `approval doctor` reports the sampler's state either way:
an unconfigured sampler is a stated skip, a half-configured one is a failure
with the fix.

## The proof runbook (APRV-51)

The first real action through the full loop: refresh `@types/node` within its
`^26` range. Class `deps.add`, manual. The envelope already carries the
payload hash of exactly `{"argv":["npm","update","@types/node"],"cwd":"/Users/carter/dev/approval-md"}`.

Session side (steps 1–3 run by the agent, watched by the human):

```sh
cd /Users/carter/dev/approval-md
approval register "backlog/tasks/aprv-51 - M5-dogfood-proof-one-real-deps.add-flows-session-to-phone-to-execution.md" --as agent:fable
printf '{"argv":["npm","update","@types/node"],"cwd":"/Users/carter/dev/approval-md"}' \
  | approval request APRV-51 --action "aprv-51:deps-refresh:2026-08-05" --as agent:fable --payload -
approval wait APRV-51 --timeout 6h
```

Human side: daemon and Telegram listener running as above; the request lands on
the phone with the computed class, the payload bytes, and the claimed summary
visibly distinguished. Tap **Approve**. The listener prints the token once.

Session side, with the token:

```sh
approval run "aprv-51:deps-refresh:2026-08-05" --token <token> --as agent:fable \
  -- npm update @types/node
approval log verify
```

Then the log advance lands on main. The rule is unchanged: log commits are made
in the primary checkout and never ride a feature branch that carries other work.
Main is protected, so that means one commit on a short-lived records branch and a
pull request carrying only it — which is a verb now rather than a sequence
(APRV-125):

```sh
cd /Users/carter/dev/approval-md
approval log advance --pr
```

`log advance` verifies the chain under the append lock, stages EXACTLY
`.approval/log/events.jsonl`, `.approval/QUEUE.md` and `.approval/payloads/`,
commits on the branch you are standing on with the seq range in the message, and
pushes that commit by refspec to `records-log-<date>`. It checks out nothing, and
any other staged path is refused (`log-advance-dirty-stage`) rather than
unstaged. Something that is not a log file and still needs committing —
`package-lock.json` from a granted `deps.add`, say — gets its own commit, made by
hand, because an advance that carried it would be the mixed branch the rule
forbids.

Merge it with a **merge commit**. A branch that exists for one commit and is
merged the moment CI passes is not a feature branch in the sense the rule
forbids: nothing else appends to the log while it is open, so no second chain
is ever created, which is the property the rule protects. What the rule still
forbids is a branch that accumulates work alongside the log commit, and two
branches appending to the log at once.

## Coming back the other way: `approval log sync`

Once the pull request merges, the primary checkout has to catch up, and that step
used to be a hand-run stash-pull-pop. It is a verb now, for three reasons the old
ritual handed us: it rewound the working log through git while the daemon held
that file open for append (fork 2 of 2026-08-20), it reached the phone labelled
`policy.edit` over a protected path, and `git stash pop` conflicted once and left
conflict markers inside the log mid-ceremony.

```sh
cd /Users/carter/dev/approval-md
approval log sync
```

It holds the append lockfile for the WHOLE operation, so nothing can append
mid-sync; verifies the chain; snapshots `events.jsonl` aside inside `.approval/`
(never `git stash`); fast-forwards, refusing anything that is not a fast-forward;
and then reconciles. The committed chain must be a prefix of the snapshot, equal
to it, or an extension of it. Prefix means the snapshot goes back, extension
means the pulled file stays, and anything else is a fork it refuses as
`log-diverged`, naming both heads and the first divergent seq. It never merges
and never re-chains, because hash chains do not merge and re-chaining is
fabrication. `QUEUE.md` and the index are rebuilt from the reconciled log rather
than restored, and any failure at any step puts the snapshot back before exiting.

Neither verb appends an event. Both move the file the log lives in, and the log
records decisions rather than its own housekeeping.

`approval doctor`'s `log-drift` check answers the same question standing still —
ahead-by-N, equal, behind, or DIVERGED at seq N — sharing one implementation with
sync's reconcile, so the two can never disagree about whether this repository has
forked.

Both verbs run in the PRIMARY checkout only and refuse elsewhere with their own
codes (`log-sync-not-primary`, `log-advance-not-primary`), and both carry their
own action classes (`log.sync`, `log.advance`), so a prompt about one says what
it is instead of `policy.edit`.

Policy amendments take the same shape and the CLI runs it for you:
`approval policy amend --commit` detects a protected default branch and switches
to the branch flow on its own, creating `policy-amend-<seq>`, committing the
policy edit and its attestation as one commit, pushing, and opening the PR.
`--branch <name>` forces that flow and names the branch; `--direct` forces the
old in-place commit, and warns before printing a push that protection will
reject.

## If an envelope goes missing

A task file can lose its `approval:` block to an ordinary board edit: the pinned
Backlog.md CLI rewrites the frontmatter it knows and drops the key it does not,
which is what happened to APRV-51 and is captured byte for byte in
`tests/fixtures/backlog/envelope-edit-{before,after}/`. The log still holds the
registration, so the runtime treats the file as having lost something rather
than as a task that never had one (APRV-63). `approval register` refuses the
stripped file with `envelope-missing`, naming the seq of the registration,
because re-registering it would narrow the record to whatever survived in the
file. The daemon records the loss once per episode as `envelope.drift` with
`payload.reason: "envelope-missing"`, distinct from a state mismatch. `approval
doctor`'s `envelope-integrity` check lists every task whose log history implies
an envelope its file lacks. Restoration is by hand: `approval log tail` shows
the `task.registered` record with the declared actions, and you copy the block
back into the file yourself. Nothing in the runtime rewrites a task file to
repair this, and nothing will — the log records the actions, so a writer could
re-emit the envelope from it, and an envelope generated from a projection is no
longer a declaration anyone made.

## Why this page exists

The enforcement layer was built by sessions operating on trust plus review.
Twice during M4.1/M5 that gap showed itself: an unapproved dependency change
(APRV-50, correct act, wrong authorization path) and a permission denial met
with a clean double refusal (its counterpart note). Both were caught by
process, not by mechanism. This cutover is the mechanism arriving: after it,
the APRV-50 shape is one the runtime refuses instead of one the review
catches.
