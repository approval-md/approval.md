# End-to-end demo: request, Telegram approval, executed run

A scripted twin of this walkthrough lives in `tests/e2e-demo.test.ts` and runs in
CI against a local mock Bot API. That test proves the runtime; it cannot prove
the network, the phone, or the bot. This document is the walkthrough a human runs
once against real Telegram, so that the one thing the mock cannot check is
checked by a person: a message arrives on a phone, a thumb taps Approve, and a
command runs because of it.

Everything below happens in a scratch directory. Nothing here touches the
repository's own `APPROVAL.md` or `.approval/`.

## What the demo shows

1. An agent registers a task and requests a `manual` action.
2. The request appears in `approval queue`, and `approval render` writes
   `.approval/QUEUE.md`.
3. `approval run` before the approval refuses at exit 5 and writes nothing.
4. The Telegram listener delivers the full payload to your chat.
5. You tap Approve. The grant lands in the log and mints a single-use execution
   token, printed on the listener's terminal and nowhere else.
6. `approval run` spends that token and the command executes.
7. Spending the same token twice is refused.
8. `approval log verify` reports a clean chain over the whole story.

## Prerequisites

- Node 20 or newer, and this repository built (`npm run build`).
- A Telegram account.

### 1. Create a bot

In Telegram, open a chat with **@BotFather**, send `/newbot`, and follow the
prompts. BotFather answers with a token of the form `1234567890:AA...`. That
token is a credential: it is the entire authentication for the Bot API, which
carries it in the URL path. Treat it like a password.

### 2. Find your chat id

Send any message to your new bot (a bot cannot message you first), then fetch the
update queue:

```sh
curl -s "https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates"
```

The reply contains `"chat":{"id":123456789,...}`. That number is your chat id.
The listener answers only that chat and ignores every other one.

### 3. Export the configuration

```sh
export APPROVAL_TG_TOKEN='1234567890:AA...'   # from BotFather
export APPROVAL_TG_CHAT='123456789'           # your chat id
export APPROVAL_HUMAN='human:carter'          # who the approvals are recorded as
```

`APPROVAL.md` carries only the *names* of the first two variables and never their
values (SPEC.md section 5.1). There is no flag that would put a bot token into a
shell history or a process listing.

**Identity caveat (SPEC.md section 11).** Human identity in v0.1 is
config-declared: `APPROVAL_HUMAN` or `--as human:<id>`, declared and not proved.
The trust boundary is the local machine, and anyone who can set that
configuration and write to the log is inside it. Concretely, for this demo:
every decision the listener records is recorded against `APPROVAL_HUMAN`
regardless of which Telegram account tapped the button, so anyone who can reach
your approval chat can approve as you. Attestation proves that someone with local
control signed off, not who. Cryptographic identity is future work, not a v0.1
claim.

## The walkthrough

Set up a scratch directory. `APPROVAL_MD` points at your checkout.

```sh
export APPROVAL_MD=~/dev/approval-md
approval() { node "$APPROVAL_MD/dist/src/cli/main.js" "$@"; }

mkdir -p /tmp/approval-demo && cd /tmp/approval-demo
approval init
```

`approval init` scaffolds the directory: `APPROVAL.md` (SPEC.md section 5.1's
canonical policy), the empty `.approval/log/` directory, `.approval/QUEUE.md` in
its empty state, and the `.gitignore` lines for the index, the vault and the
atomic-write temp files. It appends nothing, attests nothing, and overwrites
nothing, so re-running it in a scaffolded directory writes nothing and exits 0.
The first `approval policy attest` is what creates `events.jsonl`.

### Step 1: write the policy

This demo replaces the scaffolded policy with a smaller one carrying the
Telegram channel config the walkthrough needs, so delete the scaffolded file
first (`init` never overwrites, and refusing here would be its whole point):

````sh
rm APPROVAL.md
cat > APPROVAL.md <<'EOF'
# Approval policy (demo)

```yaml approval-policy
version: "0.1"
defaults:
  autonomy: manual
  approval_ttl: "1h"
  on_expiry: reject
  channel: telegram
classes:
  read.*:
    autonomy: autonomous
  communicate.email.external:
    autonomy: manual
    limits:
      per_action_usd: 1
channels:
  telegram:
    token_env: APPROVAL_TG_TOKEN
    chat_id_env: APPROVAL_TG_CHAT
```
EOF
````

The policy block inside the heredoc is itself a fenced block, which is why the
command above is wrapped in four backticks. What matters is that `APPROVAL.md`
ends up holding one fenced block opened with `yaml approval-policy` and carrying
exactly that YAML.

### Step 2: write the payload and its binding

An approval binds to specific bytes (SPEC.md section 6.2). The action's payload
lives in a file, and its `payload_hash` is SHA-256 over the RFC 8785 canonical
serialization of that value. `approval payload hash` computes it with the same
function the runtime uses, so the value below is exactly what the request and its
grant will record.

```sh
cat > payload.json <<'EOF'
{
  "to": ["agency@example.co.uk"],
  "subject": "Deposit refund chaser <second> & final",
  "body": "Following up on the deposit refund, now 21 days past the scheme deadline."
}
EOF

HASH=$(approval payload hash payload.json)
echo "$HASH"
```

Expected: `ce0edde10155883e7c6c7dceea7c5717889b590134eb6bb4b1be1329441f4b17`
for exactly the payload above. A different payload gives a different hash, and
that is the point.

### Step 3: write the task file

```sh
cat > task-demo.md <<EOF
---
id: task-demo
title: Chase the letting agency for the deposit refund
status: In Progress
approval:
  origin:
    app: demo
    created_by: "agent:drafter"
  state: proposed
  actions:
    - class: communicate.email.external
      summary: "Send the deposit chaser to agency@example.co.uk"
      reversible: false
      est_cost_usd: 0.02
      idempotency_key: "task-demo:chaser"
      payload_hash: "$HASH"
---

## Description

The agency has not answered two emails. Chase once more, then escalate.
EOF
```

### Step 4: attest the policy

```sh
approval policy attest
```

```
attested /tmp/approval-demo/APPROVAL.md at seq 1: sha256 b9388aeb...
```

Attestation records that a human saw these policy bytes. Edit `APPROVAL.md`
afterwards and every gate operation refuses with `hash-mismatch` until you attest
again.

### Step 5: register and request

```sh
approval register task-demo.md --as agent:drafter
approval request task-demo --action task-demo:chaser --payload payload.json \
  --as agent:drafter
```

```
registered task-demo at seq 2: 1 action(s)
requested task-demo task-demo:chaser at seq 3 (manual)
```

The class, cost, reversibility and binding come from the registered envelope, not
from flags. An agent cannot rename its own class between registering and asking.

`--payload` supplies the concrete bytes. They must hash to the `payload_hash` the
envelope declared — anything else is refused `payload-mismatch` and nothing is
stored or appended — and they are filed at
`.approval/payloads/<payload_hash>.json`. That store is where `approval render`
and every channel read the payload from, which is why no later step below passes
a payload flag to anything.

### Step 6: look at the queue

```sh
approval queue
approval render
approval status
```

```
task-demo:chaser  task-demo  communicate.email.external  $0.02  2026-08-05T12:07:51.447Z  3600s left
wrote /tmp/approval-demo/.approval/QUEUE.md: 3204 byte(s), head seq 3 c0ec5027..., 1 pending, 0 not summarized, 0 awaiting audit review
health: ok
attestation: attested (seq 1)
verification: clean (3 record(s))
dangling executions: none
budgets: none configured
loop escalations: none
```

Note `1 pending, 0 not summarized`, agreeing with `approval queue`. `approval
render` still takes no payload flag and needs none: the material went into the
payload store at request time, so the renderer can summarize the request like
every other surface. It still does not print the bytes. QUEUE.md carries the
binding only, by design: it is regenerated on every event and read by anyone with
the working directory, and it collects no decision. The decision surfaces are the
channels, which do present the payload (SPEC.md section 10.4).

### Step 7: try to run it before it is approved

```sh
approval run task-demo:chaser --payload-hash "$HASH" --as agent:drafter -- echo sent
echo "exit=$?"
```

```
approval: token-required: action task-demo:chaser resolves to manual (rule) and cannot execute without the single-use token minted at grant. Request the action, have a human grant it, and pass the token that grant printed.
exit=5
```

Nothing was spawned, and nothing was appended to the log. This is the demo's
whole point stated as a refusal.

### Step 8: start the listener

```sh
approval channel telegram listen
```

```
notified task-demo:chaser (message 501)
```

Your phone now has a message from the bot. It shows, in order: the action key,
a **COMPUTED** block (class, task, state, binding, budget verdicts, chain head)
derived by the runtime, a **CLAIMED** block naming `agent:drafter` as its author
and marked unverified, the **FULL PAYLOAD** with the recipients, subject and
body, and two buttons: Approve and Reject.

Check that the subject reads `Deposit refund chaser <second> & final`. The
angle brackets and the ampersand arrived intact and did not become markup: the
channel sends HTML and escapes agent-authored text, because an agent that could
inject markup into an approval prompt could reshape what you think you are
approving.

### Step 9: tap Approve

The listener's terminal prints:

```
granted task-demo:chaser (seq 4) by human:carter via telegram
execution token for task-demo:chaser: 9c92f89a81cbfc4e6c2f1ebc48f8539dc904dd894cff5b665aaabce0f1fee629
approval: that token is single-use, stored nowhere, and was NOT sent to Telegram — copy it now
```

Copy the token. It was never sent to Telegram (a chat transcript is not a secrets
store) and the log holds only its SHA-256, so nothing can recover it. If you lose
it, revoke the grant and request again.

Stop the listener with Ctrl-C, and check the two scans the scripted test makes
automatically:

```sh
grep -c 9c92f89a .approval/log/events.jsonl   # expect 0: the raw token is in no log byte
```

### Step 10: spend the token

```sh
export TOKEN=9c92f89a...     # what the listener printed
approval run task-demo:chaser --token "$TOKEN" --payload-hash "$HASH" \
  --as agent:drafter -- echo sent
echo "exit=$?"
```

```
sent
exit=0
```

Two records were appended around that command: `execution.started` before the
child was spawned, and `execution.completed` with `exit_code: 0` after it
finished. `approval run` exits with the child's own exit code, so it composes
with `make`, CI, and `&&` exactly as an unwrapped command would.

In a real deployment the command after `--` is the adapter that sends the email.
Here it is `echo`, so the demo has no side effect outside the log.

### Step 11: try to spend it twice

```sh
approval run task-demo:chaser --token "$TOKEN" --payload-hash "$HASH" \
  --as agent:drafter -- echo sent
echo "exit=$?"
```

```
approval: token-consumed: action task-demo:chaser already executed: execution.started at seq 5 spent this token. A token is single-use and the log is the proof.
exit=1
```

No second `execution.started` was appended. A retried agent cannot double-send.

### Step 12: look again, then verify

```sh
approval queue
approval status
approval log tail -n 6
approval log verify
```

```
queue: empty — no requests awaiting a decision
health: ok
attestation: attested (seq 1)
verification: clean (6 record(s))
dangling executions: none
budgets: none configured
loop escalations: none
1  2026-08-05T12:07:51.096Z  policy.updated       human:carter   -
2  2026-08-05T12:07:51.285Z  task.registered      agent:drafter  task-demo
3  2026-08-05T12:07:51.447Z  approval.requested   agent:drafter  task-demo
4  2026-08-05T12:07:52.371Z  approval.granted     human:carter   task-demo
5  2026-08-05T12:08:05.292Z  execution.started    agent:drafter  task-demo
6  2026-08-05T12:08:05.524Z  execution.completed  agent:drafter  task-demo
clean: 6 record(s), head seq 6 81627b0e...
```

Six records: policy attested, task registered, approval requested by an agent,
granted by a human from a phone, execution started, execution completed. The
closing claim of the demo is the chain's own.

## Cleaning up

```sh
cd .. && rm -rf /tmp/approval-demo
unset APPROVAL_TG_TOKEN APPROVAL_TG_CHAT APPROVAL_HUMAN TOKEN HASH
```

If the bot was created only for this walkthrough, revoke its token with
BotFather (`/revoke`) or delete the bot (`/deletebot`).

## When something goes wrong

| Symptom | Cause |
| --- | --- |
| `telegram is not configured` at exit 2 | `APPROVAL_TG_TOKEN` or `APPROVAL_TG_CHAT` is unset or empty. The message names which. |
| `no human identity` at exit 2 | `APPROVAL_HUMAN` is unset and no `--as human:<id>` was given. The listener refuses to record decisions against nobody. |
| The listener starts but no message arrives | The chat id is wrong, or you have not messaged the bot yet. A bot cannot open a conversation. |
| `telegram cannot deliver ... (payload-unavailable)` | Nothing is stored at `.approval/payloads/<hash>.json` — the request was made without `--payload` — and no `--payloads` override was given. |
| `telegram cannot deliver ... (payload-mismatch)` | The stored (or overriding) payload no longer hashes to the recorded binding. A store file is refused rather than rendered when its contents stop matching its name. |
| Tapping Approve answers "only accepts decisions from its configured approval chat" | The tap came from a chat other than `APPROVAL_TG_CHAT`. Nothing was logged, and the request is still live. |
| `policy-not-attested` / `hash-mismatch` at exit 1 | `APPROVAL.md` changed since it was attested. Run `approval policy attest` again. |
| `payload-mismatch` from `approval run` | The `--payload-hash` presented is not the one the grant approved. A grant approves specific bytes. |

## Exit codes worth knowing

| Code | Meaning |
| --- | --- |
| 0 | Success, or the child's own exit code from `approval run`. |
| 1 | The runtime's answer is no: a gate or token refusal. |
| 2 | Usage: a bad flag, a missing argument, an unresolvable identity. |
| 3 | A torn tail: a crashed write. Nothing is repaired automatically. |
| 4 | A filesystem fact: unreadable path, permissions. |
| 5 | `approval run` only: no valid token was presented. |
| 6 | `approval wait` only: the timeout elapsed with decisions still pending. |
