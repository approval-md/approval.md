# Dogfood cutover — the daemon takes the pen (APRV-49)

M5 shipped the daemon. This page turns CLAUDE.md's interim rule ("if a gate
operation is needed mid-task, stop and escalate") into the workflow it was
holding the door for: agent sessions route manual-class repo actions through
`approval request` + `approval wait` against the live log, the daemon watches
and renders, and the decision arrives from the human's phone.

Everything here operates on the PRIMARY checkout (`/Users/carter/dev/approval-md`)
and its committed log. Nothing below ever runs in an agent worktree, and
log-touching commits never ride feature branches; those two rules are unchanged.

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
export APPROVAL_TG_TOKEN='<bot token>'    # BotFather
export APPROVAL_TG_CHAT='<chat id>'
export APPROVAL_HUMAN='human:carter'
approval daemon run &          # watch, drift, TTL, QUEUE.md — the sole writer
approval channel telegram listen   # pushes requests to the phone, records taps
```

(Foreground processes by design; two terminals or a multiplexer. Backgrounding
is the operator's business at v0.1.)

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
`approval doctor` now reports the sampler's state either way: an unconfigured
sampler is a stated skip, a half-configured one is a failure with the fix.

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

Then the human commits the log advance and the lockfile diff to main (log
commits are the human's, by hand, and never ride feature branches; branch
protection makes this the one push that uses their bypass, which is fitting,
because the log records why it was allowed).

## Why this page exists

The enforcement layer was built by sessions operating on trust plus review.
Twice during M4.1/M5 that gap showed itself: an unapproved dependency change
(APRV-50, correct act, wrong authorization path) and a permission denial met
with a clean double refusal (its counterpart note). Both were caught by
process, not by mechanism. This cutover is the mechanism arriving: after it,
the APRV-50 shape is one the runtime refuses instead of one the review
catches.
