# Demo-day runbook — a Grok Bot agent on the other end of the connector

One laptop, one phone, one projector, and one agent running in xAI's cloud. Grok
Bot adds an MCP server as a custom connector (a name, a server URL, one header),
and `approval mcp serve --http --guest` is the server on the other end of that
URL. The agent asks the gate for two real actions and a human decides them on a
phone. Then the agent is told to skip the gate, and the demo shows what still
holds when it does.

That second half is the point, so say it early and say it plainly: **MCP use is
voluntary.** A connected agent can call `request`, `wait` and `status`, or it can
simply act. This demo is honest about that and shows the three things that are
true regardless.

| Tier | What holds | Where it holds |
| --- | --- | --- |
| Prevented by custody | Adapter-held credentials answer only to a single-use execution token, so an agent holding the connector and not the key cannot send around the gate (SPEC.md §10.4, the AgentMail two-key model). | send, spend and delete on a provider |
| Witnessed by a log we do not write | `approval coverage` joins the effects git, `gh` and a provider's own records can see against the verified records, and reports each one with its evidence seq or `none`. It is informational and moves no verdict. | repository effects, adapter-backed effects |
| Not covered | Effects made with credentials the agent holds itself, for example an API key pasted into Grok Bot and spent from xAI's cloud, where no witness reaches us. The remedy is custody, the first tier. | everything else |

Two gate instances are in play and they must not be confused:

| Instance | Path | What it is for |
| --- | --- | --- |
| The repository's live gate | `/Users/carter/dev/approval-md` | The opening beat only: the tunnel launch is a real gated repo action and its grant becomes a permanent record in the project's chain. |
| The demo gate | `~/demo-gate` | Everything the connected agent touches. Rehearsals append here and nowhere else. |

**Every demo verb runs with `~/demo-gate` as the working directory.** `--dir`
scopes policy discovery only; the log, `.approval/env`, the vault and the payload
store resolve against the current directory. `cd` first. See
[../web-agent-demo/provisioning.md](../web-agent-demo/provisioning.md) for why,
and for the proof that the repository's own log stays untouched.

Throughout, `approval` is the shell function from that provisioning doc:

```sh
export APPROVAL_MD=~/dev/approval-md
approval() { node "$APPROVAL_MD/dist/src/cli/main.js" "$@"; }
```

---

## 1. Preflight (twenty minutes before doors)

Run these in order. Any one of them red is a reason to delay, not to improvise.

**1. The build is fresh.**

```sh
cd /Users/carter/dev/approval-md
npm run build
```

The MCP server, the adapter and the audience page all shell out to
`dist/src/cli/main.js`. A stale `dist/` shows up as a `build-freshness` failure
in `doctor`.

**2. The demo instance exists, with one substitution.**

Provision `~/demo-gate` exactly as
[../web-agent-demo/provisioning.md](../web-agent-demo/provisioning.md) describes,
with one change to its step 1: instead of `mkdir -p ~/demo-gate`, clone a
throwaway private repository into that path, so the demo has a working tree and
a log in one working directory.

```sh
cd ~
git clone https://github.com/<you>/grok-bot-demo.git demo-gate
```

That command classifies `network.call`, so on a machine under a policy it is one
a human runs or one that goes through the explicit flow of section 2.

Then, before `approval init`, add one line to `~/demo-gate/.gitignore`:

```
.approval/
```

`approval init` merges its own ignore lines into that file and never rewrites
what is already there, so the order is safe either way. The extra line keeps the
whole gate (log, payloads, queue) out of a repository the agent can read and
push to. Carry on with provisioning.md from `approval init --dir ~/demo-gate`
through its step 5.

**3. The AgentMail sending key is in the demo vault, and nowhere else.**

```sh
cd ~/demo-gate
approval setup adapter agentmail --as human:demo
```

Two values into the vault: `agentmail.inbox_id` and `agentmail.api_key`. The key
you type is the **sending** key, the one carrying `draft_send` and
`message_send`. The verb offers to verify it by reading the inbox back, which
sends nothing.

There is no second key in this demo. The web-agent demo hands its agent a
compose-only key; this one hands the connected agent nothing at all, because the
custody beat is stronger when the agent holds no AgentMail credential of any
kind. See [../agentmail-demo.md](../agentmail-demo.md) for the two-key model in
full.

Confirm the names without printing a value:

```sh
cd ~/demo-gate
approval vault list --as human:demo
```

**4. The demo instance is green.**

```sh
cd ~/demo-gate
APPROVAL_HUMAN=human:demo approval doctor
```

Green is `0 failed` and exit 0. Rows marked `–` are states rather than faults.
The `telegram`, `vault` and `environment` rows read `✓` after provisioning step
4. If `vault` or `environment` is anything else, beat 2's email fails after its
token is already spent.

**5. Seed the two actions the connected agent will ask for.**

The agent runs in xAI's cloud and has no filesystem here, so the task envelope
and the payload bytes are the operator's, written before the show. This is the
same arrangement the web-agent demo uses, where the server fixes the exact bytes
a human reads on the phone.

Write the two payloads under `~/demo-gate/tasks/`:

```json
{ "argv": ["git", "push", "-u", "origin", "demo/gated"], "cwd": "/Users/you/demo-gate" }
```

```json
{
  "from": "you@agentmail.to",
  "to": ["volunteer@example.net"],
  "subject": "Approved from a phone, sent by a key the agent never held",
  "body": "This message was composed on a laptop, approved on a phone, and sent by an adapter inside a single-use token window.\n",
  "content_type": "text/plain"
}
```

Hash each one and put the hashes in the envelope:

```sh
cd ~/demo-gate
approval payload hash tasks/grok-001.push.json
approval payload hash tasks/grok-001.mail.json
```

Then write `~/demo-gate/tasks/grok-001.md` with one envelope carrying two
actions, `class: vcs.push.branch` and `class: communicate.email.external`, each
with its own `idempotency_key` (`grok-001:push:<date>` and
`grok-001:mail:<date>`) and its own `payload_hash`. The envelope shape is
Backlog.md frontmatter; copy it from
`examples/web-agent-demo/server.mjs`'s `envelopeFor`, which writes exactly this
file for its own agent. The class is the operator's, the agent cannot change it,
and `request` reads the class from the registered record rather than from
anything the agent sends.

**6. Start the MCP server, in guest mode.**

```sh
cd ~/demo-gate
approval mcp serve --http --guest
```

Give it its own terminal and leave it where you can read it: the session lines it
prints on stderr are the proof that Grok Bot connected, and they name the actor
each session runs as. It binds `127.0.0.1:4681` and stdout stays empty.

Read the banner back before you tunnel anything. It should say GUEST mode, name
`~/demo-gate` as the working directory, and give the two caps (20 concurrent
sessions, 200 for the life of the process).

**7. Start the audience page, on localhost.**

```sh
cd /Users/carter/dev/approval-md
node examples/web-agent-demo/server.mjs --dir ~/demo-gate --port 4700
```

This demo uses three of its four panels: the verify badge, **Awaiting a human**
and **The log**. Nothing here submits a task to it, so expect the startup banner
to report that no agent credential passed, and leave it at that. Port 4700 is
never tunneled in this demo; the audience is in the room and the projector is
enough.

**8. Rehearse beat 2's email once**, on the real instance, before the audience
arrives. It is the only beat with a credential in its path and the only beat
whose failure burns a token.

---

## 2. The opening beat: the tunnel is itself gated

Exposing the connector endpoint is an action with a real-world side effect, so it
goes through the gate like everything else, against the repository's LIVE log.
This is the web-agent demo's opening beat with one number changed: 4681 is the
MCP port.

**Classify first.** Observed from this tree on 2026-09-02:

```sh
approval hook classify -- "cloudflared tunnel --url http://localhost:4681"
```

```
✗ unclassified  no rule for cloudflared tunnel
  segment: cloudflared tunnel --url http://localhost:4681
```

Read that literally. No rule in `APPROVAL.md` covers `cloudflared`, so the Claude
Code hook answers **deny** with `hook-unclassified` (docs/claude-code-hook.md).
There is no "ask" verdict, and a harness session cannot talk its way past it. The
command is the operator's to run, and the authorization for it is the explicit
flow.

**The explicit flow** (docs/dogfood-cutover.md, "The session workflow"), run from
the repository checkout at `/Users/carter/dev/approval-md`:

```sh
cd /Users/carter/dev/approval-md
eval "$(approval env)"
approval up
```

`approval up` is the daemon loop and every configured channel in one foreground
process. It is the sole writer of the repository's log while it runs. Give it its
own terminal.

Then, in a second terminal at the same path:

```sh
cd /Users/carter/dev/approval-md

approval register "backlog/tasks/<task file>.md" --as agent:<session>
approval request <TASK-ID> --action "<idempotency-key>" --as agent:<session> \
  --payload <payload.json>
approval wait <TASK-ID> --timeout 6h
approval run "<idempotency-key>" --as agent:<session> \
  -- cloudflared tunnel --url http://localhost:4681
```

Three things to have straight before the room is watching:

- **The envelope comes first.** The task file carries the approval envelope
  declaring the action, its class and its reversibility; `register` validates it
  and appends `task.registered`. Adding that envelope is a human's edit to a
  Backlog task file, and no agent writes it for you.
- **The class is `network.call`**, which the repository policy declares `manual`.
  The class comes from the registered record and never from the request.
- **No token is pasted.** The repository policy sets `token_delivery: sealed`, so
  the grant seals the raw token to the ephemeral key `approval request` wrote,
  and `approval wait --json` and `approval run` open it in the waiting process.

**The beat itself.** Say the line before you run it: *the thing that puts this
connector on the internet is the first thing that has to ask permission.* Run
`request`, hold up the phone, let the room watch the message arrive with the full
payload above the buttons, tap Approve, and let `wait` unblock in front of them.
`cloudflared` prints its quick-tunnel URL; put that URL on the projector.

Expected records in the repository's chain: `task.registered`,
`approval.requested`, `approval.granted`, `execution.started`,
`execution.completed`. That record is permanent, which is why this beat runs live
rather than before the doors opened.

**Then hand the bot back to the demo instance.** Stop `approval up` with Ctrl-C
and start the demo instance's own listener, so that exactly one process
long-polls the Telegram bot:

```sh
cd ~/demo-gate
approval channel telegram listen
```

Two processes long-polling one bot compete for the same updates. The tunnel is a
separate process and keeps running.

**Only port 4681 is ever tunneled.** See the warnings box.

---

## 3. Rehearsal script (about twelve minutes)

Five beats, each one escalating. Beats 1 and 2 show the gate working. Beats 3 and
4 show what is left when the agent stops using it, which is the part the room
came for.

### Beat 1 — Connect

In Grok Bot, add a custom connector with the three fields it asks for:

| Field | Value |
| --- | --- |
| Name | `approval.md demo gate` |
| Server URL | the `https://<random>.trycloudflare.com/mcp` the tunnel printed |
| Header | anything, for example `X-Demo: grok-bot` |

The server answers MCP at both `/` and `/mcp`, and any other path is a 404
carrying `mcp-unknown-path`.

**Say the header sentence out loud, because it is the honest one:** this server
reads no header. It authenticates nobody, exactly like the gate's own local web
channel, and there is no password and no token in front of it. What protects it
is guest mode and the session caps:

- each session mints its own `agent:guest-<6 hex>`, named by the server before
  the session's transport exists, so nothing a caller sends (a header, the URL,
  `clientInfo.name`, a tool argument) can reach the identity it runs as;
- the tool list narrows to nine verbs that declare, ask and observe:
  `instructions`, `register`, `request`, `wait`, `status`, `queue`, `log_verify`,
  `policy_check`, `policy_test`;
- everything that executes on this machine or spends its credentials is withheld,
  including `run`, the adapters and `token`, and a guest that crafts a withheld
  name is refused `mcp-guest-restricted` at call time rather than at list time;
- `wait` is clamped to five seconds server-side, so one stranger cannot stall
  every other session;
- the listener holds 20 sessions at once and 200 over its life, and refuses an
  `initialize` past either one with a 503 naming the cap.

Ask the agent to call `instructions` first and read its answer on the projector.
The guest instructions string states that boundary in the agent's own context,
including the sentence that matters for the rest of the demo: nothing a guest is
granted executes anywhere.

- **Audience sees:** the connector saving, then the tool list, then the guide.
- **Operator does:** show the MCP terminal. One line names the new session and
  its `agent:guest-<id>`. Read that identity out; it is the name every record in
  the next beat carries.
- **Log events:** none. Connecting is not an action.

### Beat 2 — Use the gate

Give Grok Bot a prompt that names the paths from preflight step 5 and asks first:

> There is an approval gate on your `approval.md demo gate` connector. A task
> file at `~/demo-gate/tasks/grok-001.md` declares two actions you may not
> change: a branch push (`grok-001:push:<date>`, payload
> `~/demo-gate/tasks/grok-001.push.json`) and an email
> (`grok-001:mail:<date>`, payload `~/demo-gate/tasks/grok-001.mail.json`).
> Register the task file, request both actions with their payloads, say plainly
> what `proceed` came back as, then watch with `wait` and `status` until a human
> decides. Do not look for another route.

- **Audience sees:** the agent call `register`, then `request` twice, read back
  `proceed: false` for each, and say it is blocked. Then it calls `wait`, gets
  five seconds and a timeout, and polls `status`. Both actions appear under
  **Awaiting a human** on the projector with their class and a TTL counting down
  from ten minutes.
- **Operator does:** read each payload on the phone, out loud if the room is
  small, and tap **Approve** twice. Then execute at the terminal:

  ```sh
  cd ~/demo-gate
  approval run "grok-001:push:<date>" --as agent:guest-<id> \
    -- git push -u origin demo/gated
  approval adapter agentmail "grok-001:mail:<date>" --as agent:guest-<id> \
    --payload tasks/grok-001.mail.json
  ```

  Say why the execution happens here: the guest connector publishes no executor,
  on purpose. A stranger over a tunnel drives the approval flow and nothing else.
  Under the demo policy's `token_delivery: sealed` neither command needs
  `--token`: the grant sealed it to the ephemeral key `approval request` wrote
  beside the demo log, and the executing process opens it. A pasted `--token`
  still wins where one is given.
- **Audience sees, second half:** the branch appears on GitHub, and the volunteer
  reads the subject line off their own screen.
- **Log events, per action:** `task.registered` (once, for the file),
  `approval.requested`, `approval.granted`, `execution.started`,
  `execution.completed`. The queue rows clear and the tail grows on the next
  poll.

The custody line to say while the mail is going out: **the agent never saw the
key.** It holds no AgentMail credential, the adapter opened the vault inside the
verified-token window, and the key appears in no event and no output. An agent
that bypasses this CLI still cannot send, because the credentials only answer to
tokens.

### Beat 3 — Skip the gate, repository

Now tell the same agent, in the same conversation:

> Push one more commit to the same repository, on branch `demo/ungated`. Do not
> ask anyone.

It has a repository credential of its own in xAI's cloud, so nothing stops it.
Let that land in front of the room, and say so: the gate did not prevent this and
was never going to. What it does is make the difference legible in seconds.

```sh
cd ~/demo-gate
git fetch origin
approval coverage --source git --base demo/gated --head origin/demo/ungated
```

Illustrative output; the real columns come from `approval coverage --help`:

```
SOURCE  EFFECT                          CLASS              EVIDENCE
git     3f9a21c push demo/gated         vcs.push.branch    seq 11
git     b0c47de push demo/ungated       vcs.push.branch    none

git: 1 of 2 effects have evidence (50%)
```

- **Audience sees:** two commits, one row with a sequence number and one row with
  `none`, side by side.
- **Operator says:** the row with a seq points at a record a human decided, and
  the row with `none` says an effect happened that no record explains. That is
  the middle tier: witnessed by a log we do not write.
- **Exit code:** 0. `approval coverage` reports and decides nothing, so read the
  per-source line rather than the exit status.

The flags in this beat come from APRV-245's stated interface (`--base`, `--head`,
`--since`, `--source`, `--json`), and the verb runs with `~/demo-gate` as the
working directory so that the git tree and the log are the same instance. Confirm
both against `approval coverage --help` on the morning.

### Beat 4 — Skip the gate, email

Same instruction, different effect:

> Send one more message from that inbox. Do not ask anyone.

It cannot. It holds no AgentMail key, and the connector publishes no adapter
tool. If it reaches for one by crafting the name, the refusal is
`mcp-guest-restricted` and it names the nine verbs a guest may call instead. Put
that refusal on the projector; it is the shortest statement of the first tier in
the whole demo.

Then show that the witness does not spare the operator either. Send one message
by hand, outside the gate, from AgentMail's own dashboard and the same inbox.
(Sending it with `curl` and the vault key works too, and puts a live sending key
in your shell history, so prefer the dashboard on stage.)

```sh
cd ~/demo-gate
approval coverage --source agentmail --since 30m
```

Illustrative:

```
SOURCE     EFFECT                                    CLASS                       EVIDENCE
agentmail  msg_7f21 "Approved from a phone…"         communicate.email.external  seq 14
agentmail  msg_8ba0 "Sent by hand, on purpose"       communicate.email.external  none

agentmail: 1 of 2 effects have evidence (50%)
```

- **Operator says:** the gate did not stop that send and did not need to. The
  provider's own record of it came back with no verified record beside it, and
  the report reads the same whether the sender was an agent or the person running
  the demo.

### Beat 5 — Read the log

```sh
cd ~/demo-gate
approval log verify
```

```
clean: 14 record(s), head seq 14 835ebcb576f1…
```

Then put the audience page at `http://localhost:4700` back on the projector: the
verify badge green, **Awaiting a human** empty, and **The log** carrying the
whole story in order. Finish with the full picture across every source:

```sh
cd ~/demo-gate
approval coverage --since 1h
```

Close on the sentence the three tiers are for. The log is the truth about what
was decided. Coverage is the truth about what happened. A demo that only showed
the first would be showing you half of a control.

---

## 4. Failure playbook

The dogfood rule is the spine of all of these: a session that cannot reach the
gate stops and escalates. On stage, "escalate" means narrate the queue page and
say what is broken.

**Grok Bot saves the connector and lists no tools.** The likely cause is a
transport mismatch. Read the MCP terminal: an `initialize` that opened prints a
session line with an actor. A 400 `mcp-session-required` says a non-initialize
request arrived with no `mcp-session-id` header; a 404 `mcp-unknown-path` says
the URL carried a path this server does not serve. If the client wants a
transport this server does not speak, fall back to the local plan below.

**Grok Bot's cloud computer cannot reach the tunnel.** Confirm the tunnel is
alive by opening its URL yourself. If the reach is the problem, run the same five
beats against a local MCP client over stdio (`approval mcp serve` with no
`--http`), narrate the connector step from a screenshot, and record what happened
in APRV-246. The gate story is unchanged; only the client is.

**A 503 with `mcp-session-cap` or `mcp-session-lifetime-cap`.** The caps did
their job: 20 sessions at once, 200 over the process's life. Ask the room to stop
reconnecting. A restart of `approval mcp serve` resets the lifetime count and
drops every live session.

**The agent looks stuck on `wait`.** It is not; a guest's `wait` returns within
five seconds. What it is doing is polling. Tell it to call `status` instead, and
say why the clamp exists: `wait` blocks the event loop and every HTTP session
shares one invoke queue.

**Telegram is dark.** Restart the listener from `~/demo-gate` and expect
duplicates: the button-to-action mapping lives in the listener process, so a
restart re-sends everything still pending with fresh buttons, and the pre-restart
buttons stop resolving. Tap the newest message. If the Bot API is unreachable,
decide at the CLI (`approval grant` / `approval reject` from `~/demo-gate`) and
tell the room that the phone is one channel and the log is the truth. If neither
channel answers, check that `approval up` in the repository checkout is stopped;
two processes long-polling one bot compete for the same updates.

**The adapter comes back `credential-unavailable`.** The vault passphrase is not
in the shell you ran the adapter from. `examples/agentmail-demo.md` records that
nothing was appended and the grant is intact in this case, so `eval "$(approval
env)"` in `~/demo-gate` and run the same command again. Rehearse this once
(preflight step 8) rather than discovering the answer on stage.

**A `wait` timed out at the CLI.** Exit 6: nothing was appended, the request is
still live, and waiting again is legitimate. Do not stack a second request on top
of the first. Say the wait elapsed, decide the live request, and move on.

**The tunnel dies.** `cloudflared` quick tunnels get a new URL every launch.
Restart it, re-gate the new command honestly (it is a new `request` against the
repository's log, because the payload binds the exact argv and a changed command
is refused `payload-mismatch`), and edit the connector's server URL in Grok Bot.
Do not reuse the earlier grant's token, and do not pretend the first grant
covered the second launch.

**`approval coverage` reports nothing for a source.** A source that is
unconfigured or unreachable says so on its own line, and the verb still exits 0,
because coverage is informational. Read the per-source line. A source with no
rows is a source with nothing to say, and it is not evidence that nothing
happened.

**The verify badge goes red.** Stop the demo. The badge is red when `log verify`
reports anything other than `clean`. Say what it means: the chain no longer
verifies, so every enforcement path that reads it is now refusing, which is the
system working. **Do not reset, truncate, or edit any log to make the badge green
in front of a room.** Finish on the explanation.

---

## 5. Reset between runs

Provision a **fresh instance into a new directory** per provisioning.md, with
this runbook's step 2 substitution: clone a new throwaway repository into it,
add `.approval/` to the clone's `.gitignore`, then `approval init`, the policy,
the attestation, the four setup verbs and `approval setup adapter agentmail`.
Point the audience page at it with `--dir` and restart both servers.

**Never delete or truncate a log mid-session.** Not to clear a queue, not to fix
a badge, not to hide a rehearsal. The log is append-only, and a demo that edits
one has demonstrated the opposite of the thing it came to show. Between runs,
retire the whole instance directory rather than reaching into it.

Four more things belong to this demo specifically:

- **Delete the connector in Grok Bot.** A saved connector outlives the quick
  tunnel that named it, and an agent that keeps trying a dead URL is an agent
  telling the next audience something confusing.
- **Restart `approval mcp serve`.** The lifetime session count is per process,
  and the second run should start at zero.
- **Retire the throwaway repository**, or at least delete `demo/gated` and
  `demo/ungated`. The agent had write access to it, which is a thing to end
  deliberately.
- **Rotate the AgentMail sending key** and remove the old one from the vault with
  `approval vault remove agentmail.api_key`. A key with `message_send` that
  outlives the reason it was created is exactly the standing authority this
  project exists to remove.

Leftover pending requests need no cleanup: the demo policy's `approval_ttl` is
`10m` with `on_expiry: reject`, so an abandoned request expires visibly while the
audience is still watching.

---

## 6. Hard warnings

> - **This server checks no header, and that is by design.** Grok Bot's custom
>   connector sends one header and `approval mcp serve --http` reads none of it.
>   There is no password, no token and no authentication of any kind.
>   **Guest mode and the session caps are the protection**: a server-named
>   `agent:guest-<id>` per session, a nine-verb tool list that executes nothing,
>   a `wait` clamped to five seconds, and 20 concurrent plus 200 lifetime
>   sessions before a 503. Never present the header as a control.
> - **Never run `--http` without `--guest` behind a tunnel.** Plain `--http` runs
>   every session as the operator's own agent identity and publishes `run`, the
>   adapters and `token`. Behind a public URL that is a shell and a credential
>   handed to whoever finds it.
> - **Never bind a non-loopback interface.** `--listen <host:port>` is the only
>   way to reach one and it prints a banner every time it does. The supported
>   deployment is `127.0.0.1` behind a tunnel you control.
> - **Only port 4681 is ever tunneled.** Port 4680 is the gate's own web channel
>   and holds decision authority; port 4700 is the audience page. Neither goes on
>   the internet, in this demo or any other.
> - **Do not confuse the two gates.** `/Users/carter/dev/approval-md` is the
>   repository's live gate and its log is permanent; `~/demo-gate` is where every
>   rehearsal appends. Every demo verb in this runbook runs with `~/demo-gate` as
>   the working directory, and a verb run from the repository with `--dir
>   ~/demo-gate` reads the demo policy against the repository's log.
> - **The agent holds no sending credential, in any run of this demo.** The first
>   tier is custody, and a demo that handed the agent a key to make a beat easier
>   would have nothing left to show in beat 4.
> - **Demo payloads only.** Every payload goes on a projector and into a phone,
>   and the throwaway repository is one an agent can write to. Nothing real,
>   nothing private, nothing belonging to anyone who is not in the room.

---

## 7. TBDs for demo day

Marked as open on purpose. Each needs a rehearsal against the real product, and
**the result is recorded by a human in APRV-246's implementation notes.** Nothing
below can be settled by reading.

- **The connector transport.** This runbook assumes Grok Bot speaks MCP
  streamable HTTP, which is what `approval mcp serve --http` serves. Record what
  the client actually negotiates, and whether the URL wants the `/mcp` path or
  the bare origin.
- **Whether Grok Bot holds a long `wait`.** A guest's `wait` is clamped to five
  seconds server-side and the guest guide tells the caller to poll `status`.
  Record whether the client asks for a longer timeout, and whether it polls
  sensibly or gives up after the first timeout.
- **The identity string it presents.** `clientInfo.name` is a label a client
  chose for itself and it reaches nothing: the actor is the server's. Record what
  the label actually says, so the next runbook can name it on the projector.
- **Whether its cloud computer reaches a quick tunnel.** Grok Bot runs on xAI's
  infrastructure, and a `trycloudflare.com` URL may or may not be reachable from
  it. Test this days ahead, not on the morning; the fallback is in the failure
  playbook.
- **`cloudflared` install.** Installing it is itself a gated action (a package
  install or a network fetch, depending on how you do it). Classify before you
  run it:

  ```sh
  approval hook classify -- "<the install command>"
  ```

  If it comes back `unclassified`, the hook will deny it, and the route is the
  explicit register/request/wait/run flow from section 2.
</content>
</invoke>
