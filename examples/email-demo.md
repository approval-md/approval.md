# End-to-end demo: an agent's chaser, approved from a phone, sent as real mail

A scripted twin of this walkthrough lives in `tests/e2e-email-demo.test.ts` and
runs in CI against a local mock Bot API and a local mock SMTP server. That test
proves the runtime: the gate, the binding, the vault, the token window, the
wire format, and the chain. It cannot prove the network, the phone, or the
mailbox.

This document is the walkthrough a human runs once against **real Telegram and a
real mail provider**, so that the things a mock cannot check are checked by a
person: a message arrives on a phone, a thumb taps Approve, and an email lands in
somebody's inbox because of it.

`examples/telegram-demo.md` is the same story ending at `approval run` and
`echo`. This one ends at an irreversible side effect in the world.

Everything below happens in a scratch directory. Nothing here touches the
repository's own `APPROVAL.md` or `.approval/`.

## What the demo shows

1. `approval init` scaffolds a working directory and appends nothing.
2. A human attests a policy and fills the credential vault. Five credentials,
   none of them ever on a command line.
3. An agent drafts SPEC.md section 6.1's deposit chaser, binds it with
   `approval payload hash`, registers the task, and requests the action.
4. `approval doctor` goes green, which is the checkpoint before anything leaves
   the machine.
5. The Telegram listener delivers the full payload to your chat.
6. You tap Approve. The grant lands in the log and mints a single-use execution
   token, printed on the listener's terminal and nowhere else.
7. `approval adapter email` spends that token, opens the vault inside the token
   window, authenticates over STARTTLS, and sends the exact approved bytes.
8. The mail arrives. Its `Message-ID` is recomputable from the log.
9. Spending the same token twice is refused, and no second message is sent.
10. `approval log verify` reports a clean chain over the whole story.

## What only this run proves

The scripted test proves everything mechanical. What a person has to see once,
because no mock can assert it:

- a real Bot API delivers the message and a real thumb resolves the button;
- a real provider accepts the STARTTLS session, the login, and the message;
- the mail that arrives is readable mail: the subject renders, the `£` survives
  quoted-printable, the Cc recipient is there and no Bcc is;
- the credential in the vault is a credential the provider actually accepts,
  which is the one fact `vault set` deliberately cannot check for you.

## Prerequisites

- Node 20 or newer, and this repository built (`npm run build`).
- A Telegram bot. Create it with **@BotFather** exactly as
  `examples/telegram-demo.md` describes. The chat id and the two variables that
  carry the bot are established by `approval setup channel telegram` in
  [Configure the environment](#configure-the-environment) below;
  `docs/dogfood-cutover.md` names the same variables for the live runtime.
- **An app-specific password for a mail account you control.** Every major
  provider issues these: a separate password, scoped to one client, revocable on
  its own, and usable with SMTP submission on port 587 with STARTTLS. Use one.
  Do not put your account password in a vault, and do not use an account whose
  outbound mail you would mind a scripted demo touching.

A vault passphrase is *not* a prerequisite: `approval setup vault` generates one
(32 random bytes) and stores it for you, and no verb in this CLI ever prints it.

`APPROVAL.md` carries only the *names* of the bot's and the vault's variables and
never their values (SPEC.md sections 5.1 and 5.2). There is no flag that puts a
bot token, a passphrase, or an SMTP password into a shell history or a process
listing.

**Identity caveat (SPEC.md section 11).** Human identity in v0.1 is
config-declared: `APPROVAL_HUMAN` or `--as human:<id>`, declared and not proved.
Every decision the listener records is recorded against `APPROVAL_HUMAN`
regardless of which Telegram account tapped the button, so anyone who can reach
your approval chat can approve as you, and anyone who can read your environment
can open your vault. The trust boundary is the local machine.

## The walkthrough

```sh
export APPROVAL_MD=~/dev/approval-md
approval() { node "$APPROVAL_MD/dist/src/cli/main.js" "$@"; }

mkdir -p /tmp/approval-email-demo && cd /tmp/approval-email-demo
approval init
```

```
approval: scaffolded /tmp/approval-email-demo
  wrote    APPROVAL.md
  wrote    .approval/log/
  wrote    .approval/QUEUE.md
  wrote    .gitignore

Next steps:
  1. Edit APPROVAL.md. …
```

`init` appends nothing and attests nothing. The first `approval policy attest` is
what creates `events.jsonl`.

### Step 1: write the policy

This demo replaces the scaffolded policy with a smaller one carrying the Telegram
channel configuration and the vault's passphrase variable, so delete the
scaffolded file first (`init` never overwrites, and refusing here would be its
whole point):

````sh
rm APPROVAL.md
cat > APPROVAL.md <<'EOF'
# Approval policy (M7 demo)

```yaml approval-policy
version: "0.1"
defaults:
  autonomy: manual
  approval_ttl: "1h"
  on_expiry: reject
  channel: telegram
approvers:
  alice:
    channels: [telegram, cli]
classes:
  read.*:
    autonomy: autonomous
  communicate.email.external:
    autonomy: manual
    approvers: [alice]
    limits:
      per_action_usd: 1
channels:
  telegram:
    token_env: APPROVAL_TG_TOKEN
    chat_id_env: APPROVAL_TG_CHAT
vault:
  passphrase_env: APPROVAL_DEMO_VAULT_PASSPHRASE
```
EOF
````

The policy block inside the heredoc is itself a fenced block, which is why the
command is wrapped in four backticks.

### Configure the environment

Three interactive verbs and one command. They come after the policy, because
each of them reads the variable *names* out of it, and they run in the demo
directory, because `.approval/env` is per-directory.

```sh
approval setup identity          # APPROVAL_HUMAN=human:alice
approval setup vault             # mints the passphrase, stores it, records where
approval setup channel telegram  # token, getMe, chat discovery, both variables
eval "$(approval env)"
```

What each one does:

- **`setup identity`** asks for a `human:<id>` and validates it against the same
  `^human:.+` pattern the human-only verbs enforce. A bare id is enough: type
  `alice` and it is recorded as `human:alice`, because the prompt has already
  shown you the prefix and retyping it proves nothing. An `agent:` or `system:`
  answer is refused in one line and the question comes back, as does any other
  answer that does not fit. It is the one subcommand that is not human-only,
  because it is what declares the identity that check reads.
- **`setup vault`** generates 32 random bytes, stores them in the OS keystore as
  `approval-vault-passphrase`, and writes the source line for
  **the variable your policy names**. The policy above says
  `vault.passphrase_env: APPROVAL_DEMO_VAULT_PASSPHRASE`, so that is the line it
  writes; with no `vault:` block it would write `APPROVAL_VAULT_PASSPHRASE`. The
  passphrase is not printed here or anywhere else. If `.approval/vault.enc`
  already exists the verb warns first and defaults to no: a vault cannot be
  re-keyed by changing a variable, and every credential in it would become
  unreadable.
- **`setup channel telegram`** stores the token, proves it with `getMe`, asks you to
  message the bot, reads the chat id back, and writes both variables. On macOS
  the token is collected by `security`'s own no-echo prompt (Apple's wording:
  `password data for new item:`, then `retype password for new item:`; paste the
  BotFather token at both), so it is never typed into this process; on Linux
  `secret-tool` plays the same part; with neither, it
  is offered as a plaintext literal in `.approval/env` on a typed `yes`. Every
  `getUpdates` it makes carries no offset, so a tap waiting for a running
  listener stays where it is. Stop `approval channel telegram listen` first.

All three refuse when stdin is not a terminal, or when `--json` is given, and
print the exact non-interactive commands instead: a setup a pipe could drive
would let a CI job declare a human identity and store a credential.

`approval env` is the only command that reads `.approval/env`. Nothing loads that
file implicitly, because human identity is one of the values it carries and a
working-tree file any process read on its own would let anything able to write it
act as you (SPEC.md section 11.1, invariant 7). Look before you evaluate:

```sh
approval env --check     # NAME / STATUS / SOURCE, with no values on any path
```

#### What setup does for you (or: by hand)

The same three secrets, placed by hand. Each `-w` with no value prompts for the
secret and reads it without echoing it, and the value never reaches an argument:

```sh
security add-generic-password -a "$USER" -s approval-demo-smtp-password -w
security add-generic-password -a "$USER" -s approval-vault-passphrase -w
security add-generic-password -a "$USER" -s approval-tg-token -w
```

(On Linux, `secret-tool store --label <name> approval <name>`; on a machine with
neither helper, the values go into `.approval/env` in plaintext, which
`approval env --check` and `approval doctor` then report as plaintext forever
after.) Generate a passphrase rather than inventing one: `openssl rand -base64 32`.

Then either record the sources in `.approval/env`, naming the variables your
policy names. The passphrase line here is `APPROVAL_DEMO_VAULT_PASSPHRASE`
because that is what the demo policy declares:

```sh
printf '%s\n' \
  'APPROVAL_HUMAN=human:alice' \
  'APPROVAL_TG_TOKEN=keychain:approval-tg-token' \
  'APPROVAL_TG_CHAT=123456789' \
  'APPROVAL_DEMO_VAULT_PASSPHRASE=keychain:approval-vault-passphrase' \
  >> .approval/env
chmod 600 .approval/env
```

or export the four variables directly, which is what every step below actually
depends on:

```sh
export APPROVAL_HUMAN='human:alice'
export APPROVAL_TG_TOKEN="$(security find-generic-password -a "$USER" -s approval-tg-token -w)"
export APPROVAL_TG_CHAT='123456789'
export APPROVAL_DEMO_VAULT_PASSPHRASE="$(security find-generic-password -a "$USER" -s approval-vault-passphrase -w)"
```

A variable already set in this shell wins over the file: `approval env` reports
it as `set-in-environment` and does not consult the line.

The SMTP app password is deliberately absent from all of that. It is an
**adapter credential**, and adapter credentials live in the vault
(`.approval/vault.enc`), not in `.approval/env`. This is the one place the two
stores meet, and the division is the whole design: `.approval/env` says where the
values that unlock the machine come from, and the vault holds the values a
gated adapter spends inside a verified token window. Step 3 puts the password
there, with `approval setup adapter email`, which reads the passphrase out of
this shell and so must come after the `eval` above.

### Step 2: attest it

```sh
approval policy attest --as human:alice
```

```
attested /tmp/approval-email-demo/APPROVAL.md at seq 1: sha256 f29bac7b373e…
```

Attestation records that a human saw these policy bytes. Edit `APPROVAL.md`
afterwards and every gate operation refuses with `hash-mismatch` until you attest
again.

### Step 3: fill the vault

Five credentials, all of them in the vault rather than in `.approval/env`: they
are what the adapter spends. One verb asks for all five, because the email
adapter declares what it needs and the setup verb reads that declaration:

```sh
approval setup adapter email --as human:alice
```

The passphrase that opens the vault is already in this shell, from
`eval "$(approval env)"`; with it unset, this verb stores nothing and creates no
vault. What the conversation looks like:

```
approval setup adapter email — the SMTP settings `approval adapter email` reads inside the verified-token window.
The values go into the VAULT (SPEC.md §10.4), not into the OS keystore and not
into .approval/env: what this verb stores is what a gated adapter spends inside
a verified-token window. Nothing here appends to the log or attests anything.

It will ask for 5 value(s), all of them into /tmp/approval-email-demo/.approval/vault.enc:
  smtp.host (config) — the submission server this runtime connects to
  smtp.port (config) — the TCP port: 587 for STARTTLS submission, 465 for implicit TLS
  smtp.security (choice) — how the connection is protected; this adapter never guesses it
  smtp.user (config, optional) — the login name, when the relay wants one; leave empty for a relay that does not
  smtp.password (secret, optional) — the login secret, required exactly when a username is given

SMTP host: smtp.example.net
SMTP port [587]: 58x
  the vault's smtp.port is not a TCP port number (1-65535)
SMTP port [587]:

transport security — how the connection is protected; this adapter never guesses it:
  1. implicit — TLS from the first byte (the submissions port, 465)
  2. starttls — plaintext, then a mandatory STARTTLS upgrade (port 587) (default)
  3. none — plaintext throughout; the adapter refuses to AUTH over it
which one? [1-3]: 4
  "4" is not one of 1-3
which one? [1-3]:
SMTP username: you@example.net
SMTP password (not echoed):
open an SMTP session to smtp.example.net:587 to check it? Nothing is sent [Y/n] y

verified: smtp.example.net:587 answered over starttls, and accepted the credential over AUTH PLAIN.
No message was sent: the session ran to AUTH and then QUIT.

stored 5 value(s) in /tmp/approval-email-demo/.approval/vault.enc: smtp.host, smtp.port, smtp.security, smtp.user, smtp.password
```

The two wrong answers above are deliberate: a prompt that does not like your
answer says which part it did not like, in one line, and asks again. The
sentence about the port is the adapter's own, the one a send would print at you
later. Ctrl-C or Ctrl-D leaves the verb with nothing stored, and five wrong
answers in a row to one question ends it the same way.

The probe is the same SMTP session a send runs, stopped at AUTH: it proves the
host answers, that the transport security you chose is the one the server offers,
and that the credential is accepted. It proves nothing about delivery, and it
puts no message on the wire. Decline it and the values are stored and reported
as unverified.

A port that is not a port, a security setting outside the three words, and a
username with no password are all refused here, in the words the adapter itself
would have used at send time. A failed probe keeps the values: a laptop behind a
captive portal is not a reason to type five things again, and the undo it prints
is `approval vault remove <name>`.

#### By hand (what setup does for you)

The same five, one `vault set` each. Host, port and security are configuration;
the user and the password are the secret, and the secret never appears as an
argument:

```sh
V='smtp.example.net' approval vault set smtp.host --value-env V --as human:alice
V='587'              approval vault set smtp.port --value-env V --as human:alice
V='starttls'         approval vault set smtp.security --value-env V --as human:alice
V='you@example.net'  approval vault set smtp.user --value-env V --as human:alice
V="$(security find-generic-password -a "$USER" -s approval-demo-smtp-password -w)" \
  approval vault set smtp.password --value-env V --as human:alice
```

```
stored smtp.password in /tmp/approval-email-demo/.approval/vault.enc (5 credential(s); the value is not printed anywhere)
```

`vault set` also accepts the value on stdin, which is what a pipe from a password
manager wants. There is no `--value` flag and there is no `approval vault get`:
a verb that printed a credential would put it in a terminal, a scrollback buffer,
and a CI log. Check what you stored by name:

```sh
approval vault list --as human:alice
```

```
/tmp/approval-email-demo/.approval/vault.enc: 5 credential(s)
smtp.host
smtp.password
smtp.port
smtp.security
smtp.user
```

Nothing about a credential is a log entry. The log records actions the gate
authorized; a list of the credentials an operator holds is a map of the machine's
reach, and it does not belong in the one file this project promises never to
rewrite.

### Step 4: write the payload and its binding

An approval binds to specific bytes (SPEC.md section 6.2). Put the message in a
file. The `from` address is the address the mail is sent *as*; it does not have
to equal `smtp.user`, and the provider decides whether it will accept the
combination.

```sh
cat > message.json <<'EOF'
{
  "from": "you@example.net",
  "to": ["someone-you-know@example.com"],
  "cc": ["you@example.net"],
  "subject": "Deposit refund <second chaser> & scheme deadline",
  "body": "The £1,200 deposit has been due since 12 July.\n\nOne chaser was sent on 21 July with no reply. The protection scheme's\ndeadline has now passed. Please confirm the refund date by return.\n"
}
EOF

HASH=$(approval payload hash message.json)
echo "$HASH"
```

Send this to somebody who is expecting it, or to yourself. It is real mail.

The `cc` is worth keeping: it is how you see, in your own inbox, that the
envelope carried every recipient the payload declared.

### Step 5: write the task file

```sh
cat > task-042.md <<EOF
---
id: task-042
title: Chase deposit refund from letting agency
status: In Progress
approval:
  origin:
    app: example-capture
    created_by: "human:alice"
  route:
    assignee: "agent:claude-admin"
    confidence: 0.82
    rationale: "templated chaser, known counterparty, no negotiation"
  state: proposed
  actions:
    - class: communicate.email.external
      summary: "Send deposit chaser to the agency"
      reversible: false
      est_cost_usd: 0.02
      idempotency_key: "task-042:chaser:2026-08-04"
      payload_hash: "$HASH"
  budget:
    max_cost_usd: 0.50
    max_latency: "6h"
---

## Description
Deposit (£1,200) due back since 12 July. One polite chaser sent by me on
21 July, no reply. Agent should send a firmer follow-up citing the
deposit-protection scheme deadline.
EOF
```

`reversible: false` is the honest declaration for an email, and it engages
SPEC.md section 7's irreversibility floor: an action declared irreversible cannot
execute under `autonomous` or `supervised` no matter what the policy says.
Retrospective sampling cannot un-send a message. You can watch the floor do its
work by asking about a policy that says `supervised`:

```sh
approval policy test communicate.email.external --reversible false --policy some-supervised-policy.md
```

```
winner: communicate.email.external -> supervised (strictly the most specific match)
irreversibility floor (SPEC §7): reversible: false overrides communicate.email.external (supervised) -> manual
final: manual
-> manual (floor applied over communicate.email.external: supervised)
```

Against the policy written above the answer is already `manual` by rule, and the
verb says so plainly: `the floor changed nothing`.

### Step 6: doctor, all green

This is the checkpoint. Everything after it leaves the machine.

```sh
approval doctor
```

```
✓ build-freshness: …/dist/src/cli/main.js built …, not older than the source tree
✓ identity: APPROVAL_HUMAN=human:alice (config-declared: the trust boundary is this machine, not cryptography)
✓ attestation: /tmp/approval-email-demo/APPROVAL.md is attested at seq 1 (sha256 f29bac7b373e…)
✓ log: …/events.jsonl verifies: 1 record(s), head seq 1 c5250281dd91…
✓ telegram: getMe on https://api.telegram.org succeeded …
✓ web-port: 127.0.0.1:4680 is free (bound and released; nothing was left listening)
✓ payload-store: …
✓ vault: /tmp/approval-email-demo/.approval/vault.enc opens with the passphrase in $APPROVAL_DEMO_VAULT_PASSPHRASE and holds 5 credential(s) … No credential name or value is printed by this check
✓ environment: /tmp/approval-email-demo/.approval/env (mode 0600, and no verb loads it implicitly: `eval "$(approval env)"` is how a human puts these in a shell) … Every variable your policy names is available to the verbs run from this shell
```

The `environment` check is the one that reads the work of the setup verbs back.
It passes when every variable the policy names is set here or declared against a
keystore, fails on something that is wrong (a mode other than 0600, an env file
a `git add -A` would commit, a secret sitting in the working tree as a plaintext
literal, a declared source that did not resolve), and skips loudly, naming them,
when variables are merely unset. Every failure it prints comes with a
command first: `approval setup <thing>` where a setup verb owns the repair,
`approval env --check` where nothing does.

The vault check opens the vault and counts what is in it. It does not test the
SMTP credential: the only way to learn whether a password is accepted is to
authenticate with it, and doing that from a health check would send traffic to
your provider on every run. The first real proof of the credential is Step 10.

The Telegram check does reach the real Bot API, so this verb is the first thing
here that touches the network.

### Step 7: register and request

```sh
approval register task-042.md --as agent:claude-admin
approval request task-042 --action task-042:chaser:2026-08-04 \
  --payload message.json --as agent:claude-admin
approval queue
```

```
registered task-042 at seq 2: 1 action(s)
requested task-042 task-042:chaser:2026-08-04 at seq 3 (manual)
task-042:chaser:2026-08-04	task-042	communicate.email.external	$0.02	2026-08-18T00:55:08.497Z	3600s left
```

Class, cost, reversibility and binding come from the registered envelope rather
than from flags: an agent cannot rename its own class between registering and
asking. `--payload` supplies the concrete bytes, which must hash to the declared
`payload_hash` — anything else is refused `payload-mismatch`, and nothing is
stored or appended — and they are filed at `.approval/payloads/<hash>.json`,
which is where every channel reads them from.

### Step 8: start the listener and pick up your phone

```sh
approval channel telegram listen
```

```
notified task-042:chaser:2026-08-04 (message 502)
```

The message shows the action key, a **COMPUTED** block (class, resolved autonomy,
budget verdict, attestation, binding, TTL, chain head) derived by the runtime, a
**CLAIMED** block naming `agent:claude-admin` and marked unverified, and the
**FULL PAYLOAD** with the recipients, subject and body, above Approve and Reject.

Check the subject on the phone: `Deposit refund &lt;second chaser&gt; &amp;
scheme deadline` renders as `Deposit refund <second chaser> & scheme deadline`.
The angle brackets and the ampersand arrived intact and did not become markup,
because an agent that could inject markup into an approval prompt could reshape
what you think you are approving.

### Step 9: tap Approve

```
granted task-042:chaser:2026-08-04 (seq 4) by human:alice via telegram
execution token for task-042:chaser:2026-08-04: aceea22f…
approval: that token is single-use, stored nowhere, and was NOT sent to Telegram — copy it now
```

Copy the token. It was never sent to Telegram (a chat transcript is not a secrets
store) and the log holds only its SHA-256, so nothing can recover it. If you lose
it, revoke the grant and request again.

**If you restarted the listener between Steps 8 and 9, tap the newest message.**
The button-to-action mapping lives in the listener process and nowhere else
(SPEC.md section 10.3), so a restarted listener re-sends everything still pending
with fresh buttons and the older message's buttons stop resolving. A duplicate on
the phone is the deliberate trade for never having a request nobody sees.

Stop the listener with Ctrl-C.

### Step 10: send the mail

```sh
export TOKEN=aceea22f…     # what the listener printed
approval adapter email task-042:chaser:2026-08-04 --token "$TOKEN" \
  --payload message.json --as agent:claude-admin
echo "exit=$?"
```

```
sent task-042:chaser:2026-08-04 through the email adapter: execution.started at seq 5, execution.completed at seq 6
exit=0
```

What just happened, in order: the token was verified, the payload was re-hashed
and checked against the binding the grant recorded, `execution.started` was
appended, the vault was opened and the five credentials were read **inside the
token window**, the SMTP session was opened and upgraded with STARTTLS, the login
succeeded, the message was sent, the window closed, and `execution.completed` was
appended. The credential existed in memory for the length of one send and appears
in no event, no output, and no error message.

Add `--json` for the machine-readable form, which reports the `message_id`, the
`payload_hash`, whether the session was `secure`, the auth mechanism, the SMTP
reply code and a step-by-step transcript.

### Step 11: confirm the mail arrived

Open the mailbox you sent to, and the one you Cc'd. Check four things:

1. The subject reads `Deposit refund <second chaser> & scheme deadline`.
2. The `£` renders as a pound sign rather than as mojibake. The body is
   quoted-printable on the wire (`=C2=A3`) and your reader decodes it.
3. `To:` and `Cc:` both appear, and the Cc copy actually arrived: the envelope
   named every recipient the approved payload declared.
4. The `Message-ID` header. It is derived from the action key, the payload hash
   and the sender, so it is **recomputable from the log**: the header in a
   mailbox and the binding in the chain identify each other.

### Step 12: try to send it twice

```sh
approval adapter email task-042:chaser:2026-08-04 --token "$TOKEN" \
  --payload message.json --as agent:claude-admin
echo "exit=$?"
```

```
approval: token-consumed: action task-042:chaser:2026-08-04 already executed: execution.started at seq 5 spent this token. A token is single-use and the log is the proof.
exit=1
```

No second `execution.started` was appended, and no SMTP session was opened at
all: the refusal happens before any socket. A retried agent cannot double-send.

### Step 13: read the log out, and record it

```sh
approval log tail -n 6
approval log verify
approval status
```

```
1	2026-08-18T00:55:18.432Z	policy.updated	human:alice	-
2	2026-08-18T00:55:20.365Z	task.registered	agent:claude-admin	task-042
3	2026-08-18T00:55:20.555Z	approval.requested	agent:claude-admin	task-042
4	2026-08-18T00:55:21.195Z	approval.granted	human:alice	task-042
5	2026-08-18T00:55:21.431Z	execution.started	agent:claude-admin	task-042
6	2026-08-18T00:55:21.679Z	execution.completed	agent:claude-admin	task-042
clean: 6 record(s), head seq 6 835ebcb576f1…
health: ok
```

Six records: policy attested, task registered, action requested by an agent,
granted by a human from a phone, execution started, execution completed. The
closing claim of the demo is the chain's own.

**Record the run.** This walkthrough is evidence only if somebody can find it
later. Put the `seq` range (here `1–6`), the head hash, the date, and the
`Message-ID` of the mail that arrived into the implementation notes of the
Backlog task that asked for the run (APRV-70). The scratch log is deleted in the
next step; the note is what survives it.

## Cleaning up

```sh
cd .. && rm -rf /tmp/approval-email-demo
unset APPROVAL_TG_TOKEN APPROVAL_TG_CHAT APPROVAL_HUMAN TOKEN HASH V
unset APPROVAL_DEMO_VAULT_PASSPHRASE

security delete-generic-password -a "$USER" -s approval-demo-smtp-password
security delete-generic-password -a "$USER" -s approval-vault-passphrase
security delete-generic-password -a "$USER" -s approval-tg-token
```

Deleting the directory takes `.approval/env` with it, and that file held only the
*sources*. The two items above are where `approval setup` put the values, under
the service names it documents (`approval setup --help` lists all three). On
Linux the same two are `secret-tool clear approval approval-vault-passphrase`
and `secret-tool clear approval approval-tg-token`.

Revoke the app-specific password with your mail provider. If the bot was created
only for this walkthrough, revoke its token with BotFather (`/revoke`) or delete
the bot (`/deletebot`). Deleting the scratch directory deletes the vault with it;
the credentials inside it are unrecoverable, which is the intended property.

## When something goes wrong

The Telegram-side failures are tabulated in `examples/telegram-demo.md`. These
are the ones specific to the vault and the mail hop.

| Symptom | Cause |
| --- | --- |
| `APPROVAL_DEMO_VAULT_PASSPHRASE is unset or empty` at exit 2 | The passphrase variable the policy names is not set in *this* shell. The policy names the variable; nothing carries the value. `approval env --check` says whether a source is recorded for it; `eval "$(approval env)"` puts it in the shell. |
| `approval setup vault` wrote a variable the adapter does not read | The policy's `vault.passphrase_env` changed after the line was written. `setup vault` writes whatever the policy names at the moment it runs; re-run it, or rename the line in `.approval/env` by hand. |
| `vault-unreadable` at exit 1 | The ciphertext did not authenticate: the passphrase is wrong, or the file was altered. The two are deliberately not distinguished. There is no recovery path; re-create the vault and store the credentials again. |
| `vault-absent` or `credential-absent` at exit 1 | No vault, or nothing under that name. `approval vault list` says which. |
| `email-config-invalid` naming `smtp.security` | The stored value is not `implicit`, `starttls` or `none`. The adapter refuses to guess a transport security setting. |
| `email-config-invalid` naming a missing half of the login | The vault holds `smtp.user` without `smtp.password` or the reverse. Sending unauthenticated because half a credential is missing would put the message on a path nobody configured. |
| `a credential was supplied for a session with security "none"` | `smtp.security` is `none` and a login is stored. The adapter will not send a password over a cleartext socket. Use `starttls`. |
| `smtp-tls-failed` | The provider's certificate did not verify. Certificate verification is not relaxable from the CLI, and that is deliberate. |
| `smtp-535` (or another `smtp-<code>`) | The provider refused the login or the message. The reply code is the provider's; an app-specific password that was never enabled for SMTP is the usual cause. |
| `smtp-timeout` | The session exceeded its budget. Check the host and port: port 465 is implicit TLS (`smtp.security: implicit`) and port 587 is STARTTLS. |
| `email-payload-invalid` naming an address | The adapter accepts plain `local@domain` only: no display names, no angle brackets, no internationalized addresses. A display name that looks like an address is a way to make a human read the wrong recipient. |
| `token-consumed` from the adapter | The token was already spent. One grant authorizes one send. |
| `payload-mismatch` from the adapter | `message.json` changed after the grant. A grant approves specific bytes. |
| The adapter succeeded and no mail arrived | The provider accepted it and dropped it later. Check the provider's outbound log and your spam folder; `--json` reports the SMTP reply that accepted it and the `Message-ID` to search for. |

Exit codes are the ones in `examples/telegram-demo.md`, unchanged: the adapter
shares `approval run`'s table. A refused *send* is exit 1 and not 5 — the command
was well-formed, the token was good, and the answer from the world was no.
