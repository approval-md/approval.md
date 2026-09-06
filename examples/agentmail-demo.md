# End-to-end demo: an agent's draft, approved from a phone, sent by AgentMail

`examples/email-demo.md` runs the same gate over SMTP: an agent composes bytes, a
human approves them on a phone, and one adapter spends one token to put real mail
in somebody's inbox. This walkthrough changes the far side. The mail is composed
as an **AgentMail Draft**, the agent holds an API key that cannot send it, and
the key that can send it waits in the vault until a grant opens the window.

That difference is the point. An SMTP credential is all-or-nothing: whoever holds
it can send. AgentMail issues keys with per-permission booleans, so a deployment
can hand an agent a mailbox it can write to and cannot send from, and put the
sending half behind approval.md. The gate stops being the only thing between the
agent and the world and becomes the second thing, with the provider's own
permission check in front of it.

Everything below happens in a scratch directory. Nothing here touches the
repository's own `APPROVAL.md` or `.approval/`.

## What the demo shows

1. Two AgentMail keys: an agent key with `draft_create`, `draft_update` and
   `draft_read`, and a sending key with `draft_send` and `message_send`.
2. The agent composes a Draft with its own key. Nothing has left the machine's
   control: a draft is mail that sits still.
3. The agent tries to send it with its own key and AgentMail refuses. This is the
   step that proves the split before any of the gate's machinery is involved.
4. `approval payload agentmail-draft` snapshots the draft's recipients, subject
   and text, and that snapshot is the payload the grant binds to.
5. `approval register` and `approval request` put the action in the queue; the
   Telegram channel shows the human the words, not the draft id.
6. You tap Approve. A single-use execution token is printed on the listener's
   terminal and nowhere else.
7. Editing the draft after the grant and running the adapter refuses
   `agentmail-draft-drifted`. Nothing is sent, and the grant survives, because a
   refusal that costs the human another tap teaches operators to stop checking.
8. Restoring the approved text and running the adapter again sends it once.
9. Spending the same token twice is refused `token-consumed`.
10. `approval log verify` reports a clean chain over the whole story.

## What only this run proves

The adapter's unit tests drive a mock AgentMail over an injected `fetch`, so the
payload modes, the drift comparison, the failure vocabulary and the outcome
events are all proved in CI. What a person has to see once:

- a real AgentMail key **without** send permissions really is refused by the API,
  rather than being refused only by this runtime's own belief about it;
- the key in the vault really is accepted, which is the one fact `vault set`
  deliberately cannot check for you;
- the drift refusal fires against a draft edited through AgentMail's own surface,
  not just against a mutated fixture;
- the mail that arrives is the mail the phone displayed.

## Prerequisites

- Node 20 or newer, and this repository built (`npm run build`).
- A Telegram bot, established exactly as `examples/telegram-demo.md` describes.
- An AgentMail account with an inbox you control, and **two API keys**:
  - the **agent key**, with `draft_create`, `draft_update` and `draft_read`
    enabled and `draft_send` and `message_send` **off**;
  - the **sending key**, with `draft_send` and `message_send` enabled.

  Create them in the AgentMail dashboard; the permission booleans are set per key
  at creation. If your account cannot issue a key without send permissions, stop
  here: the enforcement model this adapter is written for does not exist on that
  account, and running the demo anyway would demonstrate a gate with an open door
  beside it.
- Somebody who is expecting the mail, or your own second address. It is real
  mail.

A vault passphrase is not a prerequisite: `approval setup vault` generates one
and no verb in this CLI ever prints it.

**Identity caveat (SPEC.md section 11).** Human identity in v0.1 is
config-declared. Anyone who can reach your approval chat can approve as you, and
anyone who can read your environment can open your vault. The trust boundary is
the local machine.

## The walkthrough

Steps 1 and 2 are `examples/email-demo.md`'s Steps 1, 2 and the *Configure the
environment* section, unchanged: scaffold a directory, write a policy that routes
`communicate.email.external` to `manual` on the Telegram channel, attest it, and
run `setup identity`, `setup vault` and `setup channel telegram` followed by
`eval "$(approval env)"`. Follow that document to the end of its Step 2, in a
directory of this demo's own, and come back here.

```sh
export APPROVAL_MD=~/dev/approval-md
approval() { node "$APPROVAL_MD/dist/src/cli/main.js" "$@"; }

mkdir -p /tmp/approval-agentmail-demo && cd /tmp/approval-agentmail-demo
# … init, policy, attest, setup identity / vault / channel telegram, approval env
```

### Step 3: fill the vault with the SENDING key

```sh
approval setup adapter agentmail --as human:alice
```

Two values, both into the vault: `agentmail.inbox_id` and `agentmail.api_key`.
The key you type here is the **sending** one. It is the credential the adapter
opens inside the verified-token window, and it is the only place in this demo
where a key with `message_send` is written down.

The verb offers to verify the result against AgentMail without sending anything:
it reads the inbox back, which proves the key is accepted and the inbox exists,
and puts no message anywhere.

### Step 4: put the AGENT key in this shell

```sh
export AGENTMAIL_API_KEY=…      # the key WITHOUT send permissions
export INBOX=you@agentmail.to
```

`AGENTMAIL_` is a credential-bearing prefix (SPEC.md section 10.4), so this
variable is withheld from every child `approval run` spawns, alongside
`APPROVAL_`, `TELEGRAM_` and `VAULT_`, and the `execution.started` record counts
it in `env_stripped` without naming it. The adapter's own declared credentials
are vault names (`agentmail.api_key`, `agentmail.inbox_id`), so nothing under the
prefix rides into a child on a declaration either.

### Step 5: the agent composes a draft

With AgentMail's own SDK, or with curl:

```sh
curl -sS -X POST "https://api.agentmail.to/v0/inboxes/$INBOX/drafts" \
  -H "Authorization: Bearer $AGENTMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": ["someone-you-know@example.com"],
    "subject": "Deposit refund: second chaser",
    "text": "The deposit has been due since 12 July.\n\nOne chaser was sent on 21 July with no reply. Please confirm the refund date by return.\n"
  }'
```

Keep the `draft_id` it returns. It is a UUID, not a prefixed id:

```sh
export DRAFT=67799b7c-…
```

### Step 6: watch the agent key fail to send

```sh
curl -sS -o /dev/null -w '%{http_code}\n' \
  -X POST "https://api.agentmail.to/v0/inboxes/$INBOX/drafts/$DRAFT/send" \
  -H "Authorization: Bearer $AGENTMAIL_API_KEY"
```

```
403
```

This is the demo's first result and the load-bearing one. The agent's key holds
`draft_create`, `draft_update` and `draft_read` and nothing else, so the send is
refused by AgentMail before approval.md is consulted at all. The adapter refuses
an ungranted send too, and the two refusals are independent: it is the first that
makes the second worth having, because a gate an agent can walk around is a
report rather than a control. AgentMail publishes no pre-send
webhook, so this permission split is the whole mechanism: there is no hook where
a send in flight could be held for a human.

### Step 7: snapshot the draft and bind it

```sh
approval payload agentmail-draft "$INBOX" "$DRAFT" > payload.json
cat payload.json
HASH=$(approval payload hash payload.json)
```

```json
{
  "inbox_id": "you@agentmail.to",
  "draft_id": "67799b7c-…",
  "to": ["someone-you-know@example.com"],
  "subject": "Deposit refund: second chaser",
  "text": "The deposit has been due since 12 July.\n\nOne chaser was sent on 21 July with no reply. Please confirm the refund date by return.\n"
}
```

A draft is mutable server-side state, so an approval of a `draft_id` would be an
approval of whatever the agent wrote into it last. The payload therefore carries
the **bytes fetched at request time**: the recipients, the subject and the text,
beside the two ids. That is what the hash binds, that is what your phone
displays, and that is what the adapter checks the live draft against before it
sends.

### Step 8: register, request, approve

Write the task file exactly as `examples/email-demo.md`'s Step 5 does, with
`class: communicate.email.external`, `payload_hash: "$HASH"` and an
`idempotency_key` of `task-042:chaser:2026-09-02`. Then:

```sh
approval register task-042.md --as agent:claude-admin
approval request task-042 --action task-042:chaser:2026-09-02 \
  --payload payload.json --as agent:claude-admin
approval channel telegram listen
```

The message on your phone shows the subject, the recipients and the text, in a
COMPUTED block the agent did not write. Tap **Approve**, copy the token the
listener prints, and stop the listener with Ctrl-C.

```sh
export TOKEN=aceea22f…
```

### Step 9: edit the draft, and watch the send refuse

Change the draft through AgentMail (raise the amount, add a recipient, anything).
Editing a draft is `PATCH` on the draft's own path, and it answers with the
updated draft, so the first command below is also how you confirm the edit landed
before the adapter is asked about it. `POST` on that same path answers
`not_found`, which reads like a missing draft and is really a missing route:

```sh
curl -sS -X PATCH "https://api.agentmail.to/v0/inboxes/$INBOX/drafts/$DRAFT" \
  -H "Authorization: Bearer $AGENTMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"subject": "Deposit refund: FINAL notice"}'

approval adapter agentmail task-042:chaser:2026-09-02 --token "$TOKEN" \
  --payload payload.json --as agent:claude-admin
echo "exit=$?"
```

The `PATCH` echoes the updated draft back, and then the adapter refuses:

```
approval: adapter-failed (agentmail-draft-drifted): the draft differs from the snapshot the grant was taken over in: subject. Nothing was sent.
exit=1
```

The refusal names **which** fields differ and never what they now hold: a drift
message is written to a log and read by a human who did not approve the new text.
Nothing was sent, `execution.failed` records the attempt that did not commit, and
the grant is untouched.

### Step 10: restore the text and send it

Put the approved subject back with the same `PATCH`, then run the adapter again
with the same token. The refusal in Step 9 spent nothing, so there is no second
tap here:

```sh
curl -sS -X PATCH "https://api.agentmail.to/v0/inboxes/$INBOX/drafts/$DRAFT" \
  -H "Authorization: Bearer $AGENTMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"subject": "Deposit refund: second chaser"}'

approval adapter agentmail task-042:chaser:2026-09-02 --token "$TOKEN" \
  --payload payload.json --as agent:claude-admin
echo "exit=$?"
```

The `PATCH` echoes the restored draft back, and then the send goes through:

```
sent task-042:chaser:2026-09-02 through the agentmail adapter: execution.started at seq 6, execution.completed at seq 7
exit=0
```

In order: the payload was re-hashed against the binding the grant recorded, the
token was verified and consumed, `execution.started` was appended, the vault was
opened and the sending key was read **inside the token window**, the draft was
re-fetched and compared field by field, `POST /v0/inboxes/{inbox_id}/drafts/{draft_id}/send`
was called, the window closed, and `execution.completed` was appended. AgentMail
deletes a draft when it sends, so the draft id is now gone and the mail exists;
re-running would find nothing to send.

Add `--json` for the machine-readable form.

### Step 11: try to send it twice

```sh
approval adapter agentmail task-042:chaser:2026-09-02 --token "$TOKEN" \
  --payload payload.json --as agent:claude-admin
echo "exit=$?"
```

```
✗ token-consumed  action task-042:chaser:2026-09-02 already executed: execution.started at seq 6 spent this token. A token is single-use and the log is the proof.
exit=1
```

The refusal happens before any HTTP request: a retried agent cannot double-send,
and it does not need AgentMail's cooperation not to.

### Step 12: read the log out

```sh
approval log tail -n 8
approval log verify
```

```
clean: 8 record(s), head seq 8 835ebcb576f1…
```

Eight records: policy attested, task registered, action requested, granted from a
phone, the drifted attempt started and failed, then started and completed. The
failed attempt stays in the chain. A log that showed only the send would be a log
that hid the interesting part of the story.

## The direct-send variant

The adapter takes a second payload shape, the email adapter's own, and posts it
to `POST /v0/inboxes/{inbox_id}/messages/send`:

```sh
cat > message.json <<'EOF'
{
  "from": "you@agentmail.to",
  "to": ["someone-you-know@example.com"],
  "subject": "Deposit refund: second chaser",
  "body": "The deposit has been due since 12 July.\n"
}
EOF

approval adapter agentmail task-042:chaser --token "$TOKEN" \
  --payload message.json --as agent:claude-admin
```

The two modes are told apart by the shape of the payload, and a payload carrying
markers of both, or of neither, is refused (`agentmail-payload-ambiguous`,
`agentmail-payload-invalid`) rather than guessed at: choosing a send mode by
inference is choosing a side effect by inference.

Direct send has no draft to drift, so it has no drift check. It costs one extra
read instead: AgentMail's send endpoint has no `from` field, the inbox is the
sender, so the adapter reads `GET /v0/inboxes/{inbox_id}` first and refuses
`agentmail-from-mismatch` when the inbox's own address is not the approved one.
The read doubles as the credential check, and a transport failure on it is
`agentmail-unreachable` precisely because nothing was attempted.

Prefer the draft mode where a human is approving words. The direct mode binds the
words too, so it is equally safe; what the draft mode adds is that the agent's
composing surface and the approver's reading surface are the same object.

## When something goes wrong

- **`agentmail-unauthorized`** on the send: the vault holds the agent key rather
  than the sending key. Re-run `approval setup adapter agentmail`.
- **`agentmail-inbox-mismatch`**: the payload names an inbox that is not the
  configured one. The vault's `agentmail.inbox_id` is the only inbox this
  instance sends from.
- **`agentmail-draft-missing`**: the draft was deleted, or already sent. A sent
  draft is gone by design; request a fresh action over a fresh draft.
- **`credential-unavailable`**: the vault could not be opened or a name is
  missing. Nothing was appended and the grant is intact, so fix the vault and run
  the same command with the same token.
- **`payload-mismatch`**: the file you passed is not the file the request bound.
  Re-request; a grant approves bytes.

## Cleaning up

```sh
cd .. && rm -rf /tmp/approval-agentmail-demo
unset AGENTMAIL_API_KEY INBOX DRAFT TOKEN HASH
```

Delete the demo's AgentMail keys from the dashboard when you are done. A key with
`message_send` that outlives the reason it was created is exactly the standing
authority this project exists to remove.
