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
eval "$(approval env)"   # APPROVAL_HUMAN, APPROVAL_TG_TOKEN, APPROVAL_TG_CHAT
approval up              # the daemon loop AND every configured channel, one process
```

`approval up` (APRV-110) is the whole gate in one foreground process: the watch
loop that records drift, expires what lapsed and regenerates `QUEUE.md`, plus the
Telegram listener that puts requests on the phone and records the taps. It is the
terminal that prints the execution token, so keep it where you can read it. A
channel whose credential is unset is not started, is reported the way `approval
doctor` reports it, and the daemon runs anyway; a channel that falls over is
restarted with a doubling backoff while the loop keeps ticking.

The two separate processes still work and behave identically, which is what the
composed test suite asserts. Reach for them when you want to restart one half
without the other:

```sh
approval daemon run &              # watch, drift, TTL, QUEUE.md — the sole writer
approval channel telegram listen   # pushes requests to the phone, records taps
```

With several sessions appending at once the daemon ticks after every append;
the `tick` line's `ms` says what each costs, and `--debounce` is the knob when
that times the append rate approaches a core. See "Sustained append rate" under
`daemon run` in `docs/cli-reference.md` and the 2026-09-02 postmortem.

To have the runtime there without starting it by hand, `approval setup service`
writes the launchd agent (macOS) or systemd user unit (Linux) that runs
`approval up` at login. It prints the whole unit for you to read before it writes
anything, it names the variables and never copies a value, and it does not arm
the service: it prints the one command that does, because that act is yours.

That eval establishes the identity the human-only verbs read and the bot token
and chat id the channels need, from the sources recorded in `.approval/env`.
`approval setup identity` and `approval setup channel telegram` are what write that file
(the token goes into the OS keystore, the file records where); `approval env
--check` prints the whole table with no values in it; and nothing reads the file
implicitly, which is why the eval is a step a human takes. Exporting the three
variables by hand still works and is what the eval expands to.

(Foreground by design, whichever spelling you use. `approval up` needs one
terminal; the separate pair needs two, or a multiplexer. Backgrounding is the
operator's business at v0.1, and `approval setup service` is how it stops being
a thing you remember.)

The listener delivers requests **as they arrive**, not only the ones pending
when it started (APRV-55). Before every `getUpdates` it re-derives the pending
queue from the verified log and sends whatever it has not already sent this
process lifetime, so a session that runs `approval request` an hour into the
day gets its message on the phone within one poll cycle, with no restart. The
M5 proof ran the other way round (request first, listener second) and so never
exercised this; the order no longer matters.

Two consequences worth knowing at the terminal. A restarted listener starts its
walkthrough over — it re-derives the pending set from the verified log and shows
the oldest again, or under `channels.telegram.delivery: burst` re-sends
everything still pending — because the "already sent" set and the order live
only in the process (SPEC.md §10.3: channels hold no state that is truth): a
duplicate on the phone, never a request nobody sees. Since APRV-196 the older
copies keep working, and since APRV-216 there is one request on screen at a
time; the section below is the operator's view of both. And a send that fails is retried on every later cycle
without an attempt limit, so a phone out of signal or a Bot API outage delays
delivery rather than dropping it; the stderr warnings thin out after a few
consecutive failures for the same request. Only a failure during the startup
send exits non-zero, which is how a mistyped token or chat id announces itself.

Under `approval up` that last sentence reads differently, and deliberately: a
startup send that fails takes the CHANNEL down rather than the process. The
supervisor reports it, waits a doubling backoff, and starts the listener again
with a fresh dispatch state, which re-derives the pending queue from the verified
log and re-sends. The daemon loop ticks through all of it. So the two behaviours
above are the same behaviour, reached on a timer instead of by your hand.

`approval channel web` needs no equivalent: it builds the queue from the log on
every page load, so a refresh shows what is pending now. `approval channel cli`
is one-shot by design; running the verb again is its refresh.

### `supervised-live` needs this process up (APRV-208)

A `supervised-live` class puts a declared fraction of its actions through the
phone and lets the rest run. Which fraction an action falls in is an HMAC under
the operator's sampling secret, and that secret must never be readable by an
agent: an agent that can compute its own luck can grind its payload until the
draw comes up unsampled. So the process that decides is almost never the process
that holds the secret. The harness hook is a child of an agent session, nothing
sources the secret there, and nothing may.

Before APRV-208 that combination meant the draw failed closed on every action,
correctly and permanently: 15 of 15 supervised-live actions on this repository's
own log gated to a human (APRV-184). A class declared live at 0.1 was gated at
100%, which is safe and is also the setting never once having been live.

The draw now lives in the daemon, which holds the secret legitimately because a
human exported it in the terminal they started it from. A gate process asks over
an owner-only Unix socket at `.approval/daemon/draw.sock` and records the MAC'd
answer it gets back. Three consequences at the terminal:

- **The secret has to resolve in this process's environment.** `eval "$(approval
  env)"` before `approval up`, the same line the identity and the bot token
  already need. Started without it, `approval up` says on stderr that it will
  serve no draws, and every supervised-live action keeps gating.
- **No daemon means no sampling.** With `approval up` stopped the socket goes
  with it, and every supervised-live action gates to a human: the behaviour of
  every release before this one, reached now by a route that names itself. The
  three refusals are distinct on the request (`draw-daemon-absent`, nothing is
  listening, start it; `draw-daemon-stale`, something is there and will not
  answer, so it is wedged or was killed; `draw-answer-invalid`, something
  answered and it was not this daemon).
- **`approval doctor` has the row.** `live-draw` skips when the policy declares
  no live class, passes when the socket is present and owner-only, and fails
  when a live class is declared and no usable socket is there. That failure is
  the only place the difference shows: "every policy edit asks for a tap" and
  "one in ten policy edits asks for a tap" look identical from inside the policy
  file, and one of them is the operator's control not being in force.

`--no-draw`, on either spelling of the runtime, turns the server off without
unsetting a variable a shell profile exports. There is no flag that turns it on:
holding the secret is the opt-in, and amending the policy to declare a class live
is the other half. Both are deliberate acts by the human.

### What a restart looks like on the phone (APRV-216, and APRV-196 before it)

**There is no wall any more.** The default since APRV-216 is
`channels.telegram.delivery: paced`, and a restart with five pending requests
sends two things: one summary line (`5 pending — oldest 2h 10m ago —
policy.edit ×3, network.call ×2`) and the OLDEST request, with its buttons. The
next one arrives on the first cycle after you decide that one, `/skip` it (it
comes round again, last) or `/next` past it (this process does not show it
again). `/queue` lists everything pending at any time, including while a request
is on screen, and that list is read from the log rather than from the chat, so it
is right even when the chat is not.

Nothing is withheld by this. Every request is still pending in the log, still
listed by `approval queue`, and still decidable from any copy of its message
already in the chat. What is paced is your attention.

The rest of this section is what a restart looked like before, and what it still
looks like under `channels.telegram.delivery: burst`. Read it that way: the
duplicate-copy rules and every toast below hold in both modes, because they are
properties of the buttons rather than of the pacing.

The re-delivery above used to arrive as a wall: five pending requests, five new
messages with no warning, sitting under five older copies whose buttons had
quietly stopped working. Taps on the older copies did nothing at all, so the
natural response (tap it again, harder) was the one response that could not
help. Three things changed.

**A restart announces itself.** Under `burst`, the first batch a listener sends is
preceded by one line: `LISTENER STARTED — re-sending N pending requests`,
followed by the requests. A flood that says what it is is a re-delivery; the
same flood in silence is an incident. Later cycles send no banner, because a
request that arrives at 14:00 is a notification and not a re-delivery. The line
says *started* rather than *restarted* because the listener genuinely cannot
tell the two apart: it keeps nothing across a restart, on purpose.

**Every copy's buttons work.** A button now carries a short digest of the action
key alongside its own message nonce, so a tap on last night's copy resolves to
the request this process is holding open and decides it, on the ordinary gate
path, with one log event. You do not have to find the newest copy, and you
cannot decide the same request twice by tapping two copies of it: the second tap
finds the request already settled and says so. Older copies are not edited to
say "superseded", and that is deliberate: a restart does not know their message
ids, so a design that depended on editing them would work only when the crash
was gentle. They are made harmless instead of tidy.

**Every tap gets a toast.** A button never spins now. What the toast says is the
useful part:

| Toast | What happened |
|---|---|
| `Heard — deciding. The message will say what the log recorded.` | Your tap arrived. **Nothing has been decided yet**; read the message. |
| `Earlier copy of this request — Heard — deciding…` | Same, and you tapped an older copy. It decides the request this listener holds, once. |
| `Already granted/rejected/revoked — the recorded answer stands…` | Someone (possibly you) already answered this, here or at another surface. Nothing was recorded for this tap. |
| `Still pending — this copy's buttons are not live here…` | The listener is holding the request but has not yet re-sent it. The new copy is seconds away. |
| `This request is not open here…` | The listener could not place the request at all: another listener holds it, or the log it reads does not carry it. Check which checkout `approval up` is running in. |
| `This button is no longer live…` / `Unrecognized button.` | A button this listener never issued, or one it has already annotated. Read the message. |
| `Received — this listener could not finish reading your tap.` | A tap that reached no branch at all. Nothing was recorded by it; check the listener's stderr. |

### The toast means "heard". The message means "recorded".

Since APRV-206 these are two different statements and it is worth being precise
about which is which, because only one of them is evidence.

- **The toast** is sent the moment the tap is recognized, *before* the gate runs.
  It says the listener has your tap and is deciding. It is never a decision, and
  it deliberately does not contain the words approved, granted, rejected or
  recorded. Telegram allows exactly one answer per button press, and this is it.
- **The message edit** is written afterwards, from the record the gate actually
  appended: `✓ APPROVED` or `✗ REJECTED`, with the actor, the timestamp and the
  sequence number of the event. That line is the receipt, and it is the one that
  agrees with `approval queue`, `approval log verify` and the log itself.
- **`✗ NOT RECORDED`** on the message means the gate refused the tap (already
  decided, withdrawn, expired, over budget) or the listener fell over while
  recording it. The reason is on the line under the headline. Nothing was
  appended by the tap, and the buttons are removed: if the request is still
  pending, the next dispatch cycle sends a fresh prompt for it.

Why the split: the decision path reads and verifies the log, re-checks the
budgets and appends under a lock, and the parts of that which grow with the log
used to sit in front of your spinner. On this repository's own log the tap's
toast went from ~23 ms to well under a millisecond of local work when the ack
moved in front of the gate. What did not move is the order of events in the log:
the toast is not evidence of anything, and the message is written from the
record.

A toast that fails to send (Telegram drops a callback query after its own
window, so a tap from a phone that was offline can arrive too late to answer) is
reported on the listener's stderr and changes nothing about the decision.

**A tap on an "all" button** is acked the same way, before any of its member
decisions run. The digest is then redrawn once, member by member, and that
redraw is where you read what landed; the tally (`Approved 3 — one log event
each.`) goes to the listener's stderr for the operator.

### When the phone channel misbehaves, decide at the CLI

The phone is one channel, not the gate. Every decision the Telegram listener
records goes through the same `decide()` as every other surface, so a dark
channel (the bot is rate-limited, the listener will not start, the buttons are
behaving strangely) is no reason to wait and no reason to work around the gate.
Decide in the primary checkout:

```sh
approval queue                       # what is pending, from the verified log
approval channel cli --interactive   # walk the queue, full payload, grant/reject
approval grant <action-key>          # or answer one directly
```

This is what unblocked the APRV-182..185 wave while APRV-196 was still open, and
it is the standing fallback. The decision is identical in the log; only the
surface that collected it differs, and `approval.granted` records which one.
Once the listener is healthy again it annotates the chat prompts it delivered
with the outcome the log now carries, so the transcript catches up on its own.

## Drafts for the human's hands

At the time of the cutover, agents edited neither CLAUDE.md nor APPROVAL.md,
and the two edits this cutover wanted were drafted here for the human to apply
verbatim or amend. Both landed. Since APRV-182 the CLAUDE.md half of that
convention is retired: agents edit CLAUDE.md directly, the edit classifies
`policy.edit` through the hook, and the human's tap is the sign-off.
APPROVAL.md is unchanged, still edited only through the human's own amend
ceremony. The drafts below stay as the historical record.

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

Human side: `approval up` running as above (or the separate pair); the request
lands on the phone with the computed class, the payload bytes, and the claimed
summary visibly distinguished. Tap **Approve**. The runtime prints the token
once, in the terminal it is running in.

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

`log advance` verifies the chain under the append lock, FETCHES `origin/main`,
and builds a commit on it carrying EXACTLY `.approval/log/events.jsonl`,
`.approval/QUEUE.md` and `.approval/payloads/`, with the seq range in the
message; it pushes that commit by refspec to `records-log-<date>`. You do not
fetch or reset first — the verb owns its own git preconditions (APRV-203) — and
your checkout ends the verb exactly as it started it: same branch, same index,
same working tree. It checks out nothing, a local main ahead of origin is not a
refusal (the commit is parented on origin either way), a working log the remote's
log is not a prefix of is refused (`log-advance-behind-remote`,
`log-advance-remote-diverged`), and any other staged path is refused
(`log-advance-dirty-stage`) rather than unstaged. Something that is not a log
file and still needs committing —
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

**Untracked payload files no longer stop it.** An advance commits
`.approval/payloads/`, so the primary checkout usually already holds those files
untracked, and `git merge --ff-only` will not write over an untracked file. That
was a hand step until APRV-225: on 2026-09-02, after the advance to seq 11361
merged, sync refused `log-sync-git-failed` over 33 payload files, every one of
them identical to the incoming copy. Sync now proves that rather than assuming
it. Before the fast-forward it takes the untracked files under
`.approval/payloads/` that the incoming commit also carries, and for each one
requires that SHA-256 of the local bytes is the filename and that those bytes
equal the incoming blob. Only when every file has passed does it clear them out
of the way, and the run reports how many it reconciled:

```
payloads      33 untracked file(s) proved identical to the incoming commit
```

A payload that disagrees refuses `log-sync-payload-mismatch` naming the file,
pulls nothing, appends nothing and leaves the working tree as you left it. That
one is yours: a payload is the material evidence an approval bound to, so two
versions of one is a question about which bytes were approved, and no verb here
will pick. A payload you hold that the incoming commit does not carry (recorded
and not yet advanced, usually) blocks nothing and is left alone.

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

Policy amendments take the same shape and the CLI runs it for you. **The whole
ceremony, for the human, is three steps: edit the line, run the verb, tap.**

```sh
cd /Users/carter/dev/approval-md
$EDITOR APPROVAL.md
approval policy amend --commit
```

No `git fetch` and no `git reset --keep origin/main` first. That instruction used
to precede every ceremony, and it was both a step to forget and a step that could
fail on its own (`Entry '…' not uptodate. Cannot merge.` on a task file that had
been edited locally and upstream). Since APRV-203 the verb does it: it fetches,
bases the amendment commit on `origin/main` rather than on whatever this
checkout's main happens to be, runs the dogfood policy suite against the amended
file, pushes by refspec, opens the pull request, and arms the merge. It detects a
protected default branch and switches to the branch flow on its own, creating
`policy-amend-<seq>`; `--branch <name>` forces that flow and names the branch;
`--direct` forces the in-place commit, and warns before printing a push that
protection will reject.

Your checkout is left exactly as the verb found it: still on `main`, working tree
carrying the policy edit you made and nothing else, and the amendment commit held
on `policy-amend-<seq>`. After the pull request merges, `approval log sync`
brings main down safely. Four things stop the ceremony, all of them before the
attestation, so nothing is ever half-done: `fetch-failed`,
`base-policy-diverged` (somebody amended the policy on origin since this edit
began; bring the checkout up to origin and re-apply the edit),
`base-log-diverged` (run `approval log sync` first), and `policy-suite-failed`
(the amended policy no longer resolves the way `src/core/policy-expectations.ts`
pins it: update the pins, `npm run build`, run the verb again).

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
