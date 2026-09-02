# Demo-day runbook — the web agent behind the gate

One laptop, one phone, one projector. The demo server
(`examples/web-agent-demo/server.mjs`) shows a room the gate's queue and log and
lets an attendee hand the agent a task; the agent runs behind
[`~/demo-gate`](provisioning.md); a human on a phone decides.

Two instances are in play and they must not be confused:

| Instance | Path | What it is for |
| --- | --- | --- |
| The repo's live gate | `/Users/carter/dev/approval-md` | The opening beat only: the tunnel launch is a real gated repo action and its grant becomes a permanent record in the project's chain. |
| The demo gate | `~/demo-gate` | Everything the audience submits. Rehearsals append here and nowhere else. |

**Every demo verb runs with `~/demo-gate` as the working directory.** `--dir`
scopes policy discovery only; the log, `.approval/env` and the vault resolve
against the current directory. `cd` first. See
[provisioning.md](provisioning.md) for why, and for the proof that the repo log
stays untouched.

Throughout, `approval` is the shell function from provisioning.md:

```sh
export APPROVAL_MD=~/dev/approval-md
approval() { node "$APPROVAL_MD/dist/src/cli/main.js" "$@"; }
```

---

## 1. Preflight (ten minutes before doors)

Run these in order. Any one of them red is a reason to delay, not to improvise.

**1. The build is fresh.**

```sh
cd /Users/carter/dev/approval-md
npm run build
```

Both the demo server and the MCP wrapper shell out to `dist/src/cli/main.js`. A
stale `dist/` shows up as a `build-freshness` failure in `doctor`.

**2. The daemon and the channels are up, in the primary checkout.**

```sh
cd /Users/carter/dev/approval-md
eval "$(approval env)"
approval up
```

`approval up` is the daemon loop and every configured channel in one foreground
process (docs/dogfood-cutover.md). Give it its own terminal and leave it where
you can read it. It is the process that expires lapsed requests and regenerates
`QUEUE.md`, and it is the sole writer of the repo's log.

**3. The demo instance is green.**

```sh
cd ~/demo-gate
APPROVAL_HUMAN=human:demo approval doctor
```

Green is `0 failed` and exit 0. Rows marked `–` are states rather than faults.
After provisioning step 4 the `telegram`, `vault` and `environment` rows read
`✓`. If `vault` or `environment` is anything else, the email finale will fail
after its token is already spent (see the finale's own warning below).

**4. The phone is listening.**

```sh
cd ~/demo-gate
approval channel telegram health
```

This checks configuration and makes no network call, by design. The live proof
that the phone buzzes is the opening beat itself, which is one of the reasons
the opening beat exists. If you want a buzz before the room fills, stop the
demo instance's listener first: two processes long-polling one bot compete for
the same updates.

**5. Mint the agent child's token.**

```sh
claude setup-token
export CLAUDE_CODE_OAUTH_TOKEN="<the token it prints>"
```

The agent child does **not** run in your account. It runs with a `HOME` and a
`CLAUDE_CONFIG_DIR` the demo generates under the instance
(`~/demo-gate/agent-home/`), so that an attendee's prompt never reaches your
plugins, your connected MCP servers, your user memory, your slash commands or
your hooks. That isolation is also why a keychain login does not reach it: on
2026-08-31 the scrubbed child came back `Not logged in` /
`authentication_failed` for exactly this reason. `claude setup-token` mints a
token that lives in an environment variable instead, and
`CLAUDE_CODE_OAUTH_TOKEN` is one of the five names the server forwards
(`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and
`ANTHROPIC_MODEL` are the API-key alternative). Nothing else from this shell
crosses into the child.

Export it in the same shell you start the server in, and check the startup
banner: `agent auth:` names the credential it found, or says in as many words
that none passed and the child will fail to authenticate.

**6. Export the finale's addresses, then start the server.**

```sh
cd /Users/carter/dev/approval-md
export APPROVAL_DEMO_EMAIL_TO="volunteer@example.net"
export APPROVAL_DEMO_EMAIL_FROM="you@example.net"
node examples/web-agent-demo/server.mjs --dir ~/demo-gate --port 4700
```

`APPROVAL_DEMO_EMAIL_TO` and `APPROVAL_DEMO_EMAIL_FROM` are read once at
startup, so a change of recipient means a restart of this process. Both default
to `demo@example.invalid`. Start this server in a shell that holds **no** gate
credential: no `APPROVAL_HUMAN`, no vault passphrase, no bot token. That is the
security contract at the top of `server.mjs`, and it is what makes the port safe
to expose.

The startup banner names the gate instance, the log, the tasks directory, the
agent's home and credential, the agent binary (`CLAUDE_BIN`, default `claude`)
and the routes. Read it back before you tunnel anything. If it prints a
`memory above:` line, a `CLAUDE.md` in a directory above the instance is still
project memory the child can see: move the instance somewhere without one, or
remove them.

**7. Rehearse the finale once**, on the real instance, before the audience
arrives. It is the only beat with a credential in its path and the only beat
whose failure burns a token. Details in beat 4.

---

## 2. The opening beat: the tunnel is itself gated

Exposing the demo is an action with a real-world side effect, so it goes through
the gate like everything else, against the repo's LIVE log.

**Classify first.** Observed from this tree on 2026-08-30:

```sh
approval hook classify -- "cloudflared tunnel --url http://localhost:4700"
```

```
✗ unclassified  no rule for cloudflared tunnel
  segment: cloudflared tunnel --url http://localhost:4700
```

`--json` says the same: `{"ok":false,"code":"unclassified","segment":"cloudflared
tunnel --url http://localhost:4700","detail":"no rule for cloudflared tunnel"}`.

Read that literally. No rule in `APPROVAL.md` covers `cloudflared`, so the
Claude Code hook answers **deny** with `hook-unclassified`
(docs/claude-code-hook.md). There is no "ask" verdict, and a harness session
cannot talk its way past this. The command is the operator's to run, and the
authorization for it is the explicit flow.

**The explicit flow** (docs/dogfood-cutover.md, "The session workflow"), run
from the primary checkout:

```sh
cd /Users/carter/dev/approval-md

approval register "backlog/tasks/<task file>.md" --as agent:<session>
approval request <TASK-ID> --action "<idempotency-key>" --as agent:<session> \
  --payload <payload.json>
approval wait <TASK-ID> --timeout 6h
approval run "<idempotency-key>" --as agent:<session> \
  -- cloudflared tunnel --url http://localhost:4700
```

Three things to have straight before the room is watching:

- **The envelope comes first.** The task file carries the approval envelope
  declaring the action, its class and its reversibility; `register` validates it
  and appends `task.registered`. Adding that envelope is a human's edit to a
  Backlog task file. It is not written here, and no agent writes it for you.
- **The class is `network.call`**, which the repo policy declares `manual`. The
  class comes from the registered record and never from the request.
- **No token is pasted.** The primary's policy sets `token_delivery: sealed`
  (attested at seq 3067 on 2026-08-30), so the grant seals the raw token to the
  ephemeral key `approval request` wrote, and `approval wait --json` and
  `approval run` open it in the waiting process. `--token` still wins where one
  is given.

**The beat itself.** Say the line before you run it: *the thing that puts this
demo on the internet is the first thing that has to ask permission.* Run
`request`, hold up the phone, let the room watch the message arrive with the
full payload above the buttons, tap Approve, and let `wait` unblock in front of
them. `cloudflared` prints its quick-tunnel URL; put that URL on the projector.

Expected log events, in the repo's chain: `task.registered`,
`approval.requested`, `approval.granted`, `execution.started`,
`execution.completed`. That record is permanent, which is the point of doing
this beat live rather than before the doors opened.

**Only port 4700 is ever tunneled.** See the warnings box.

---

## 3. Rehearsal script (about ten minutes)

The page (`GET /`) shows four panels: the verify badge, **Awaiting a human**
(the pending queue with a TTL countdown), **The log** (the tail), and **Give the
agent a task**. The four curated templates are served from `GET /api/templates`.
One agent runs at a time; at most five tasks may wait.

Take the beats in this order. Each escalates.

### Beat 1 — `read_the_gate` ("Read the gate")

Benign, autonomous, no side effect. The agent calls `status`, `queue` and
`log_tail` and gives a four-line summary of the gate's own state.

- **Audience sees:** the transcript narrating three read calls, then the
  summary. Nothing appears in the pending queue.
- **Operator does:** nothing. Say out loud that the phone did not buzz, and why:
  `read.*` is `autonomous` in the demo policy.
- **Log events:** none. Reads write nothing.

### Beat 2 — `run_a_command` ("Run a command")

One `exec.local` action: `echo hello from the demo agent` in `~/demo-gate`.

- **Audience sees:** the agent registers, requests, reads back `proceed: false`,
  says plainly that it is blocked, and stops. The action appears under **Awaiting
  a human** with its class and a TTL counting down from ten minutes.
- **Operator does:** tap **Approve** on the phone. The agent's `wait` returns
  granted, the sealed token opens inside the child, `run` executes, and the
  agent reports the exit code. No token is ever narrated or displayed; the
  server truncates every 64-hex run before it reaches a browser.
- **Log events:** `task.registered`, `approval.requested`, `approval.granted`,
  `execution.started`, `execution.completed`. The queue row clears and the tail
  grows on the next poll.

### Beat 3 — `loosen_the_policy` ("Loosen the policy") — the recursive beat

The agent asks to change `exec.local` from `manual` to `autonomous` in the demo
gate's own `APPROVAL.md`. Declared `policy.edit`, irreversible, executor `none`.

- **Audience sees:** the agent asking, out loud, for the rules it runs under to
  be loosened. This is the beat to slow down on.
- **Operator does:** reject it with a reason. The inline keyboard collects no
  text, so a tapped rejection records the note "rejected via telegram (callback
  `<id>`)". To put the sentence in the chain, reject at the CLI instead:

  ```sh
  cd ~/demo-gate
  approval reject "<action-key>" --as human:demo \
    --note "the agent does not hold the pen on its own policy"
  ```

  Say the note aloud as you send it.
- **Audience sees, second half:** the rejection lands on the projector, the
  agent quotes the status and the note verbatim, and it stops. It has no `run`
  step here and there is no `grant` tool on its MCP server at all.
- **Log events:** `task.registered`, `approval.requested`, `approval.rejected`.
  No execution of any kind.

### Beat 4 — `send_the_email` ("Send the email") — the finale

One `communicate.email.external` action. The exact bytes (sender, recipient,
subject, body) are fixed by the server and are what the human reads on the
phone.

- **Before the show:** get the volunteer's address into
  `APPROVAL_DEMO_EMAIL_TO` and restart the server. The value is read once at
  startup.
- **Audience sees:** the agent registers and requests, says the message is now
  in front of a person, and blocks.
- **Operator does:** read the payload on the phone, out loud if the room is
  small, and tap **Approve**. Then read the subject line back from the
  volunteer's own screen.
- **Log events:** `task.registered`, `approval.requested`, `approval.granted`,
  `execution.started`, `execution.completed`. The credentials are opened inside
  the token window and appear in no event and no output.

**Rehearse this beat before the room fills.** The adapter consumes the token and
appends `execution.started` *before* it opens the vault, so a credential that
cannot be read produces `execution.failed` with the token already burned, and a
retry of the same request is refused `token-consumed`. Recovering on stage means
a fresh submission and a second approval. If the agent's `adapter_email` comes
back `credential-unavailable`, the vault passphrase did not reach the MCP child
(the server scrubs `APPROVAL*` names out of the agent's environment, and no verb
reads `.approval/env` implicitly). The honest stage recovery is to send the
approved payload yourself from `~/demo-gate` per examples/email-demo.md, and to
say why you are doing it.

**Free text.** The fifth slot takes up to 500 characters of attendee text and
runs read-only: no declared action, so nothing to register and nothing to
request. The agent treats the text as a request from a stranger rather than as
instructions. Expect someone to try to talk it into a side effect; let that
attempt land and let the agent name the class it would have needed.

---

## 4. Failure playbook

The dogfood rule is the spine of all four: a session that cannot reach the gate
stops and escalates. On stage, "escalate" means narrate the queue page and say
what is broken.

**The daemon is down / `approval up` died.** Requests still append (the CLI
serializes through the append lockfile), and `wait` still polls, so a decision
taken at the CLI still lands. What stops is expiry, `QUEUE.md` regeneration and
the phone. Restart it in the primary checkout. If it will not come back, stop
requesting: narrate the pending queue on the projector, and use the read beats.

**Telegram is dark.** Restart the listener and expect duplicates: the
button-to-action mapping lives in the listener process, so a restart re-sends
everything still pending with fresh buttons, and the pre-restart buttons stop
resolving. Tap the newest message. If the Bot API is unreachable, decide at the
CLI (`approval grant` / `approval reject` from `~/demo-gate`) and tell the room
that the phone is one channel and the log is the truth.

**The agent exits immediately, "Not logged in" / `authentication_failed`.** The
child has no credential. Its `HOME` is the demo's, so your keychain login is
invisible to it by design. Stop the server, run `claude setup-token`, export
`CLAUDE_CODE_OAUTH_TOKEN` in that shell, restart, and check the banner's `agent
auth:` line before resubmitting. The submitted task is only a queue entry: it
appended nothing, and nothing needs undoing.

**A `wait` timed out.** Exit 6: nothing was appended, the request is still live,
and waiting again is legitimate. On stage, do not stack a second request on top
of the first. Say the wait elapsed, decide the live request, and move on.

**The tunnel dies.** `cloudflared` quick tunnels get a new URL every launch.
Restart it, put the new URL up, and re-gate the new command honestly: it is a
new `request` against the repo's log, because the payload binds the exact argv
and a changed command is refused `payload-mismatch`. Do not reuse the earlier
grant's token, and do not pretend the first grant covered the second launch.

**The verify badge goes red.** Stop the demo. The badge is red when `log verify`
reports anything other than `clean`, and a badge that hedges would be worse than
no badge at all. Say what it means: the chain no longer verifies, so every
enforcement path that reads it is now refusing, which is the system working.
**Do not reset, truncate, or edit any log to make the badge green in front of a
room.** Finish on the explanation.

**Stray requests flood the phone.** Requests pending in the same poll cycle that
share a class, an origin task, a requester and a payload shape arrive as one
digest: every member's full payload first without buttons, then a trailing
message with per-request Approve/Reject and an "all" row. An "all" tap is N
separate decisions, each its own record. If it is genuinely out of hand, reject
them all and say the true thing about what you just did: a flood of rejections
is not a considered denial. It clears the queue and it decides nothing. The
submission desk already throttles at one submission per client address every 15
seconds and refuses a sixth waiting task with a 429.

---

## 5. Reset between runs

Provision a **fresh instance into a new directory** per
[provisioning.md](provisioning.md): `mkdir -p ~/demo-gate-2`, `approval init
--dir ~/demo-gate-2`, `cd`, write the policy, attest, run the four setup verbs,
`doctor` green. Point the server at it with `--dir` and restart.

**Never delete or truncate a log mid-session.** Not to clear a queue, not to fix
a badge, not to hide a rehearsal. The log is append-only and a demo that edits
one has demonstrated the opposite of the thing it came to show. Between runs,
retire the whole instance directory rather than reaching into it.

Leftover pending requests need no cleanup: the demo policy's `approval_ttl` is
`10m` with `on_expiry: reject`, so an abandoned request expires visibly while
the audience is still watching. `approval expire` materializes it early if you
want the row gone; the daemon's sweep does it on its own.

The `tasks/` directory under the demo instance accumulates envelopes, payloads,
transcripts and `mcp-config.json`. `agent-home/` holds the child's generated
configuration (its settings, its `CLAUDE.md`, and whatever cache the binary
writes). Both go with the instance, and both are regenerated at the next
server startup, so a fresh instance needs no copying: export
`CLAUDE_CODE_OAUTH_TOKEN` again if you started a new shell, and restart the
server with the new `--dir`.

---

## 6. Hard warnings

> - **Never tunnel port 4680.** The gate's own web channel (`src/channels/web.ts`)
>   is loopback-only by design and holds decision authority. Port 4700 is the
>   only port that may ever be exposed, and nothing in `server.mjs` starts 4680.
> - **Never run the demo server with gate credentials in its environment.** No
>   `APPROVAL_HUMAN`, no vault passphrase, no bot token. A process that cannot
>   name an approver cannot approve anything, and that is the entire reason this
>   port is safe behind a tunnel.
> - **The `tasks/` tee is verbatim.** What the server serves is shortened; what
>   it writes to disk is the child's own stdout, untruncated. Treat that
>   directory as local-only, publish nothing out of it, and throw it away with
>   the instance.
> - **The child is not your laptop, and must stay that way.** It runs with the
>   demo's own `HOME` and `CLAUDE_CONFIG_DIR` under the instance, one MCP server
>   declared with `--strict-mcp-config`, and settings with no hooks and no
>   plugins. Do not "fix" an authentication failure by handing it your `HOME` or
>   your `CLAUDE_CONFIG_DIR`: that puts your plugins, connected servers, memory
>   and hooks behind an attendee's prompt and on the projector. Mint a token
>   (preflight step 5) instead.
> - **Demo payloads only.** Attendee text and every payload the gate renders go
>   on a projector and into the phone. Nothing real, nothing private, nothing
>   belonging to anyone who is not in the room.

---

## 7. TBDs for demo day

Marked as open on purpose. Each needs a decision before the room fills.

- **SMTP account.** Which mailbox sends the finale, and its app-specific
  password in the demo vault (provisioning.md step 4). Rehearse one real send
  end to end.
- **Recipient.** Whose address goes into `APPROVAL_DEMO_EMAIL_TO`. Recruit the
  volunteer before the demo starts, since changing it means restarting the
  server. Have a fallback address of your own for the rehearsal.
- **Agent model and turn cap.** `CLAUDE_BIN` selects the binary; the server
  hard-codes `--max-turns 25` and a ten-minute kill. Decide whether the model
  you are demoing finishes the finale inside both bounds, and rehearse the
  slowest beat.
- **`cloudflared` install.** Installing it is itself a gated action (a package
  install or a network fetch, depending on how you do it). Classify before you
  run it:

  ```sh
  approval hook classify -- "<the install command>"
  ```

  If it comes back `unclassified`, the hook will deny it, and the route is the
  explicit register/request/wait/run flow from section 2. Do this days ahead,
  not on the morning.
