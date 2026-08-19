# End-to-end demo: an MCP client asks, the phone grants, the tool call proceeds

A scripted twin of this walkthrough lives in `tests/e2e-mcp-demo.test.ts` and runs
in CI: a real `approval mcp serve` child process, a real MCP client from the
official SDK, a local mock Bot API, and every hop asserted against `approval log
tail`. That test proves the wrapper. It cannot prove that an MCP client nobody
here wrote speaks to this server, and it cannot prove a person deciding. This
document is the walkthrough a human runs once, with Claude Code on one side and a
phone on the other, so those two things are checked by a human.

Everything below happens against a scratch directory, or against the repository's
own log if you are running the dogfood cutover. Nothing here needs a change to
`APPROVAL.md`.

## What the demo shows

1. An MCP client registers the approval server and sees its tools.
2. The tool list carries the agent's verbs (`register`, `request`, `wait`,
   `run`, `queue`, `status`, `log_verify`, …) and carries no `grant`, no
   `policy_attest`, no `vault_set`. The agent's harness cannot reach the
   overseer's pen.
3. In a session, the agent registers a task file and requests a `manual` action.
4. The request reaches your phone over Telegram, with the full payload.
5. You tap Approve. The grant lands in the log under your identity, and the
   listener's terminal prints a single-use execution token.
6. You hand the token to the agent. It calls the `run` tool, the command
   executes, and `execution.completed` lands.
7. `approval log tail` shows the whole story: two actors, six records, one
   clean chain.

## Prerequisites

- Node 20 or newer, and this repository built (`npm run build`).
- A working Telegram bot and chat id. If you have not set one up, do
  [examples/telegram-demo.md](telegram-demo.md) first; the setup half of that
  document is the setup half of this one.
- An MCP client. The commands below use Claude Code; any client that can run a
  stdio server works, and the JSON form is given for clients that take a config
  file instead.

## Step 1: register the server with the client

The server is one command: `approval mcp serve`. It speaks MCP over stdin and
stdout and runs in the foreground until the client stops it.

```sh
claude mcp add approval -- \
  node /path/to/approval-md/dist/src/cli/main.js mcp serve \
    --as agent:claude-code \
    --dir /path/to/project
```

The JSON form, for a client that reads `.mcp.json` (or Claude Code's own project
config), is the same command written out:

```json
{
  "mcpServers": {
    "approval": {
      "command": "node",
      "args": [
        "/path/to/approval-md/dist/src/cli/main.js",
        "mcp",
        "serve",
        "--as",
        "agent:claude-code",
        "--dir",
        "/path/to/project"
      ]
    }
  }
}
```

Use absolute paths in both forms. An MCP client starts its servers from a working
directory you did not choose, which is what `--dir` is for: it pins the directory
every relative path in every tool call resolves against, and it is the directory
whose `.approval/log/events.jsonl` the tools read and append to.

**`--as` is the identity, and the agent cannot change it.** Every append a tool
call makes is recorded under the `agent:<id>` you wrote there, chosen by you when
you registered the server. There is no tool that takes an actor: `--as` is deleted
from every published input schema, so a client that sent one is refused by the
schema, and the server's own identity is appended last to every argv, so it wins
even if one arrived another way. A `human:` or `system:` value is refused at
startup, before the transport exists (`APPROVAL_AGENT` sets the same thing for a
client that cannot pass flags).

Restart the client, then check what it got:

```
> /mcp
```

The approval server should list its tools. Read the list. `register`, `request`,
`wait`, `run`, `queue`, `status`, `payload hash`, `policy test`, `log verify` and
the rest of the agent's surface are there; `grant`, `reject`, `revoke`, `policy
attest`, `execution resolve`, `audit review`, `vault set`, `env`, `init`, the
channels and the daemon are not, and their absence is the design rather than an
oversight. SPEC.md section 11 names the agent the untrusted policy and the human
the trusted, expensive overseer. An MCP client is an agent's harness, so a `grant`
tool on it would hand the untrusted policy the overseer's pen. A human decides at
a human's surface, which is the phone in step 3.

`approval mcp serve --help` prints the whole rationale, including the two
agent-facing verbs that are withheld for transport reasons (`consume`, which
`run` wraps, and `hook claude-code`, which reads a PreToolUse event from a stdin
this transport already owns).

## Step 2: start the daemon and the listener

In the project directory, in two terminals, exactly as
[docs/dogfood-cutover.md](../docs/dogfood-cutover.md) describes:

```sh
eval "$(approval env)"             # APPROVAL_HUMAN, APPROVAL_TG_TOKEN, APPROVAL_TG_CHAT
approval daemon run                # watch, drift, TTL, QUEUE.md
approval channel telegram listen   # pushes requests to the phone, records taps
```

Both are foreground processes by design. The listener is the terminal that will
print the execution token, so keep it where you can read it.

## Step 3: the task file and the payload

The agent asks for one declared action, so there has to be a declaration. Put
this file in the project directory (the agent can write it for you; it is an
ordinary Backlog.md-shaped task file with an `approval:` envelope):

```sh
cat > payload.json <<EOF
{"argv": ["echo", "hello"], "cwd": "$PWD"}
EOF

HASH=$(approval payload hash payload.json)
echo "$HASH"
```

`approval run` binds to SPEC.md section 6.2's command payload, `{argv, cwd}`, and
recomputes that hash from the argv it is about to spawn. So the envelope declares
the hash of *this* command in *this* directory, and a tool call that asked to run
anything else is refused `payload-mismatch`.

```sh
cat > task-mcp-demo.md <<EOF
---
id: task-mcp-demo
title: Greet the operator from inside the gate
status: In Progress
approval:
  origin:
    app: mcp-demo
    created_by: "agent:claude-code"
  state: proposed
  actions:
    - class: exec.local
      summary: "Run \`echo hello\` in the project directory"
      reversible: true
      est_cost_usd: 0
      idempotency_key: "task-mcp-demo:greet"
      payload_hash: "$HASH"
---

## Description

The smallest command worth gating: the point is the route the request takes,
not the blast radius of the command at the end of it.
EOF
```

`exec.local` is autonomous by default in SPEC.md section 7's
developer-workstation table, so for this walkthrough the policy has to say
otherwise. Add the class to `APPROVAL.md` and attest again, or use a class your
policy already resolves to `manual`:

```yaml
classes:
  exec.local:
    autonomy: manual
```

```sh
approval policy attest
```

Tightening a class is always allowed. The gravity is the policy's decision, which
is the property this step is really showing: `echo` is harmless, and it is gated
anyway, because the gate reads the policy and not the command.

## Step 4: ask the agent

In a Claude Code session in that directory, with the approval server connected,
say this:

> Using the approval MCP server, register `task-mcp-demo.md`, then request the
> action `task-mcp-demo:greet` with `payload.json`. Report what the request
> returned, then wait for the decision. Do not try to grant anything.

The agent should make two tool calls and report two objects:

```json
{"ok": true, "seq": 2, "task": "task-mcp-demo", "actions": 1}
{"ok": true, "task": "task-mcp-demo", "action_key": "task-mcp-demo:greet",
 "class": "exec.local", "autonomy": "manual", "proceed": false,
 "requested": true, "seq": 3}
```

`proceed: false` is the gate answering. The class, the cost and the reversibility
came from the registered record rather than from the tool call, so an agent
cannot rename its own class between registering and asking.

If the agent tries to grant its own request, the answer is `unknown tool
"grant"`, with a message naming the surfaces where a human decides. That is worth
provoking once, deliberately, so you have seen it.

## Step 5: watch the phone

Within one poll cycle the listener prints:

```
notified task-mcp-demo:greet (message 501)
```

and your phone has the message: the action key, a **COMPUTED** block derived by
the runtime, a **CLAIMED** block naming `agent:claude-code` as its author and
marked unverified, the **FULL PAYLOAD** with the argv and the cwd, and two
buttons.

Read the payload. This is the moment the whole system exists for, and the only
moment at which the argv the agent chose is in front of a person.

## Step 6: tap Approve

The listener's terminal prints:

```
granted task-mcp-demo:greet (seq 4) by human:alice via telegram
─────────────────────────────────────────────────────────────
  execution token   task-mcp-demo:greet
  9c92f89a81cbfc4e6c2f1ebc48f8539dc904dd894cff5b665aaabce0f1fee629
  single-use · stored nowhere · not sent to Telegram · copy it now
─────────────────────────────────────────────────────────────
```

**The token does not travel over MCP, and handing it over is your step.** The
runtime prints it exactly once, on the terminal where the human decided, and the
log holds only its SHA-256. There is no tool that fetches it, because a token an
agent could fetch would be a grant an agent could give itself. Copy it and paste
it into the session:

> The approval was granted. The execution token is
> `9c92f89a...`. Call the `run` tool with action key `task-mcp-demo:greet`,
> that token, and trailing argv `["echo", "hello"]`.

The `run` tool takes the token as an ordinary string input, which is exactly what
`approval run --token` takes at a shell prompt. Nothing else about the token is
special to MCP.

## Step 7: watch it execute

The agent's tool result carries the run summary and the child's own output:

```json
{"ok": true, "action_key": "task-mcp-demo:greet", "task": "task-mcp-demo",
 "class": "exec.local", "autonomy": "manual", "started_seq": 5,
 "outcome": "execution.completed", "outcome_seq": 6, "exit_code": 0,
 "payload_hash": "..."}
```

```
child stdout:
hello
```

The child is piped rather than given the terminal, which on a stdio server it has
to be: inheriting would hand the child the JSON-RPC stream and let a command's
output corrupt the protocol. What the child said comes back as tool content
instead.

Ask the agent to call `run` a second time with the same token. It is refused
`token-consumed`, as a tool result with `isError` set rather than as a protocol
error, and no second `execution.started` is appended: a refusal is an answer the
agent has to be able to read as data.

## Step 8: read the log

```sh
approval log tail -n 6
approval log verify
```

```
1  2026-08-19T10:14:02.096Z  policy.updated       human:alice        -
2  2026-08-19T10:19:11.285Z  task.registered      agent:claude-code  task-mcp-demo
3  2026-08-19T10:19:12.447Z  approval.requested   agent:claude-code  task-mcp-demo
4  2026-08-19T10:20:41.371Z  approval.granted     human:alice        task-mcp-demo
5  2026-08-19T10:21:05.292Z  execution.started    agent:claude-code  task-mcp-demo
6  2026-08-19T10:21:05.524Z  execution.completed  agent:claude-code  task-mcp-demo
clean: 6 record(s), head seq 6 81627b0e...
```

Two actors, and the split is the point: everything the MCP client did is recorded
under the identity you pinned in the config, and the one record that carries
authority is recorded under yours. Record the seq range of your run on APRV-88.

## What the scripted twin proves, and what only this run proves

`tests/e2e-mcp-demo.test.ts` walks every hop above against a real
`approval mcp serve` child, a real SDK client, and a mock Bot API. It proves the
wrapper: that the tool list is the agent's surface and nothing more, that a tool
call reaches the CLI's own code path, that the identity is the server's, that the
grant is recorded against the human, that the token is spent once, that the
child's output survives a piped stdio, and that the raw token appears in exactly
one stream in the whole walk.

It cannot prove the two things this document is for. **A real MCP client speaks
to this server**: the SDK client in the test was written here, agrees with this
server by construction, and would not notice a tool description no client can
render or an input schema a real client rejects before sending. And **a person
decides**: a queued callback in a mock is not a phone in a pocket, a payload block
a human actually reads, and a thumb.

## Cleaning up

```sh
claude mcp remove approval
rm task-mcp-demo.md payload.json
```

If you ran this against a scratch directory, delete it. If you ran it against the
repository's own log, the six records stay: that is the proof, and it is what the
seq range on APRV-88 points at.

## When something goes wrong

| Symptom | Cause |
| --- | --- |
| The client shows the server as failed at startup | `--as` is missing or is not `agent:<id>`. The server refuses before the transport exists and says so on stderr; check the client's MCP log. `APPROVAL_AGENT=agent:<id>` is the alternative. |
| Tools run against the wrong directory | `--dir` is unset, so paths resolve against whatever directory the client started the server in. Pass an absolute `--dir`. |
| A tool call is refused `mcp-identity-fixed` | The client sent `--as`. It cannot: the server acts as one agent, chosen when you registered it. |
| A tool call is refused `mcp-stdin-unavailable` | An argument was `-`, which means "read from stdin" everywhere in this CLI, and on a stdio server stdin is the JSON-RPC stream. Write the bytes to a file and pass its path. |
| `unknown tool "grant"` | Working as designed. The overseer's verbs are not published to an agent's harness. |
| `policy-not-attested` or `hash-mismatch` from every tool | `APPROVAL.md` changed since it was attested. Run `approval policy attest` again, at a human's terminal. |
| The request never reaches the phone | The listener is not running, or `APPROVAL_TG_TOKEN` / `APPROVAL_TG_CHAT` is unset in *its* shell. See the troubleshooting table in [examples/telegram-demo.md](telegram-demo.md). |
| `payload-mismatch` from `run` | The trailing argv or the working directory is not the one the envelope declared and the human approved. The binding is over `{argv, cwd}`. |
| `token-required` from `run` | No token was passed, or the agent invented one. The token comes from the listener's terminal, by way of you. |
