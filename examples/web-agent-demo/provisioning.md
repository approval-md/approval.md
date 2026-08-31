# Provisioning the demo gate

The web-agent demo runs against its own gate instance at `~/demo-gate`, outside
any repository. Rehearsals append to that instance's log and to nothing else, so
this project's `.approval/log/events.jsonl` is untouched by every run of the
demo. The last section proves it.

**One rule makes the separation hold: run every verb with `~/demo-gate` as the
working directory.** `--dir` scopes policy discovery only. The log path, and with
it `.approval/env`, `.approval/vault.enc` and the payload store, resolve against
the current directory unless `--log` names something else. `approval doctor --dir
~/demo-gate` run from inside this repo reads the demo policy against the *repo's*
log and reports an attestation failure for its trouble (observed; see
[Verified against a scratch instance](#verified-against-a-scratch-instance)).
`cd` first, and the whole instance lines up.

Prerequisites: Node 20 or newer, this repository built (`npm run build`), a
Telegram bot from @BotFather, and an app-specific SMTP password for a mail
account you control.

## 1. Scaffold the instance

```sh
export APPROVAL_MD=~/dev/approval-md
approval() { node "$APPROVAL_MD/dist/src/cli/main.js" "$@"; }

mkdir -p ~/demo-gate
approval init --dir ~/demo-gate
cd ~/demo-gate
```

`init` does **not** create the directory it is pointed at: `--dir` on an absent
path exits 4 with `APPROVAL.md could not be written: ENOENT` and writes nothing.
The `mkdir -p` above is required, not decorative.

`init` is fully non-interactive: no prompts, no flags beyond `--dir`, `--json`
and `--help`. It writes `APPROVAL.md` (the canonical scaffold policy),
`.approval/log/` (empty), `.approval/QUEUE.md` and `.gitignore`, never overwrites
an existing file, and re-running it is a no-op that exits 0.

```
approval.md v0.1.0

approval: scaffolded /Users/you/demo-gate
  wrote    APPROVAL.md
  wrote    .approval/log/
  wrote    .approval/QUEUE.md
  wrote    .gitignore

Next steps:
  1. Edit APPROVAL.md. …
```

Nothing is appended to the log here. The first attestation creates
`events.jsonl`.

## 2. Write the demo policy

Replace the scaffolded policy. `init` never overwrites, so delete it first.

````sh
rm ~/demo-gate/APPROVAL.md
cat > ~/demo-gate/APPROVAL.md <<'EOF'
# Approval policy — web-agent demo gate

This instance exists only to rehearse the web-agent demo. It is deliberately
separate from any repository: the log under `.approval/log/` here is the demo's
log, and nothing a rehearsal does reaches a project's own gate.

```yaml approval-policy
version: "0.1"

defaults:
  autonomy: manual
  channel: telegram
  approval_ttl: "10m"
  on_expiry: reject
  token_delivery: sealed

approvers:
  demo:
    channels: [telegram, cli]

classes:
  read.*:
    autonomy: autonomous
  exec.local:
    autonomy: manual
    approvers: [demo]
  communicate.email.external:
    autonomy: manual
    approvers: [demo]
    limits:
      max_pending: 3
  policy.edit:
    autonomy: manual
    approvers: [demo]

budgets:
  global:
    daily_actions: 25

channels:
  telegram:
    token_env: APPROVAL_TG_TOKEN
    chat_id_env: APPROVAL_TG_CHAT

vault:
  passphrase_env: APPROVAL_DEMO_VAULT_PASSPHRASE
```
EOF
````

The heredoc wraps a fenced block, which is why the shell fence around it is four
backticks.

What each part is doing:

- `token_delivery: sealed` (SPEC §10.4, APRV-105) makes `approval request` mint
  an ephemeral X25519 keypair per request, keep the private half beside the log,
  and publish the public half; the grant seals the raw token to it, and `approval
  wait --json` and `approval run` open it. The demo's web agent therefore needs
  no token pasted into a terminal.
- `approval_ttl: "10m"` is short on purpose: an abandoned demo request expires
  visibly while the audience is still watching, and `on_expiry: reject` is the
  only value the schema admits.
- `defaults.autonomy: manual` plus the three named classes means the demo asks
  before it runs a local command, sends external mail, or edits the policy. The
  named rules are not redundant with the default: they attach `approvers: [demo]`
  and read as the promise the demo makes.
- `budgets.global.daily_actions: 25` is the tight ceiling. `daily_actions` is an
  integer count; the sibling key is `daily_usd`.
- `read.*: autonomous` keeps the agent's reads out of the queue.

`limits.max_pending: 3` is policy vocabulary in v0.1 (enforcement lands with the
daemon). It is valid and it parses; drop it if you would rather the file
described only what runs today.

Confirm the file loads before signing it. If the policy were unparseable, every
class would answer `manual` and this check would still print `manual` for the
email class, so check a class the policy makes permissive:

```sh
cd ~/demo-gate
approval policy check read.files --reversible true
approval policy check communicate.email.external --reversible false
```

```
winner: read.* -> autonomous (strictly the most specific match)
final: autonomous
-> autonomous
```

```
winner: communicate.email.external -> manual (strictly the most specific match)
irreversibility floor (SPEC §7): outcome was already manual; the floor changed nothing
final: manual
-> manual
```

## 3. Attest

```sh
cd ~/demo-gate
approval policy attest --as human:demo
```

```
attested /Users/you/demo-gate/APPROVAL.md at seq 1: sha256 97b814341e3c…
```

`policy attest` is non-interactive and scriptable: identity comes from `--as
human:<id>` or `APPROVAL_HUMAN`, and there is no prompt. It hashes the bytes, it
does not require them to parse, and it is what creates `events.jsonl` at seq 1.
Edit `APPROVAL.md` afterwards and every gate operation refuses with
`hash-mismatch` until you attest again.

## 4. Credentials: three interactive verbs

These prompt, and they are meant to. Each refuses with exit 2 when stdin is not a
terminal, prints the exact by-hand commands instead, and writes nothing. Run them
from `~/demo-gate`, after the policy, because each reads the variable *names* out
of it and each writes into this directory's `.approval/env`.

```sh
cd ~/demo-gate
approval setup identity                       # APPROVAL_HUMAN=human:demo
approval setup vault --as human:demo          # mints the passphrase, records where it lives
approval setup channel telegram --as human:demo
eval "$(approval env)"
approval setup adapter email --as human:demo  # after the eval: it reads the passphrase from this shell
```

**`setup identity`** asks for a `human:<id>`. A bare `demo` is accepted and
recorded as `human:demo`; an `agent:` or `system:` answer is refused in one line
and the question comes back.

**`setup vault`** generates 32 random bytes, stores them in the OS keystore as
`approval-vault-passphrase`, and writes the source line for the variable the
policy names — here `APPROVAL_DEMO_VAULT_PASSPHRASE`. The passphrase is never
printed. If `.approval/vault.enc` already exists it warns and defaults to no.

**`setup channel telegram`** collects the bot token, proves it with `getMe`,
long-polls up to 90 seconds for a message you send the bot, reads the chat id
back (confirming, or offering a numbered pick if several chats appear), offers a
test message, and writes both variables. On macOS the token is collected by
`security`'s own no-echo prompt (Apple's wording: `password data for new item:`,
then `retype password for new item:` — paste the BotFather token at both); on
Linux `secret-tool` plays the same part; with neither helper it is offered as a
plaintext literal in `.approval/env` on a typed `yes`. Stop any running
`approval channel telegram listen` first: this verb's `getUpdates` calls carry no
offset, but a running listener competes for the same updates.

**`setup adapter email`** fills the **vault**, not the keystore and not
`.approval/env`. It asks for five values, declared by the adapter itself:

```
  smtp.host (config) — the submission server this runtime connects to
  smtp.port (config) — the TCP port: 587 for STARTTLS submission, 465 for implicit TLS
  smtp.security (choice) — how the connection is protected; this adapter never guesses it
  smtp.user (config, optional) — the login name, when the relay wants one
  smtp.password (secret, optional) — the login secret, required exactly when a username is given
```

It then offers a probe: the same SMTP session a send runs, stopped at AUTH, with
no message on the wire. A rejected answer says which part it did not like and
asks again. A failed probe keeps the values and prints `approval vault remove
<name>` as the undo.

The division between the two stores is the design: `.approval/env` says where the
values that unlock the machine come from, and the vault holds the values a gated
adapter spends inside a verified token window.

Look before you evaluate — `approval env --check` prints names, statuses and
sources, and no values on any path:

```sh
approval env --check
```

```
NAME                            STATUS          SOURCE
APPROVAL_HUMAN                  UNSET           unset
                                                fix: run `approval setup identity` …
APPROVAL_TG_TOKEN               UNSET           unset
APPROVAL_TG_CHAT                UNSET           unset
APPROVAL_DEMO_VAULT_PASSPHRASE  UNSET           unset
```

That is the shape before setup runs. After the four verbs and the `eval`, every
row reads `SET` or names its keystore item.

### The non-interactive path, if you need one

The setup verbs print these themselves when stdin is not a terminal. On macOS:

```sh
security add-generic-password -a "$USER" -s approval-vault-passphrase -U -w
security add-generic-password -a "$USER" -s approval-tg-token -U -w
printf '%s\n' 'APPROVAL_HUMAN=human:demo' 'APPROVAL_TG_TOKEN=keychain:approval-tg-token' 'APPROVAL_TG_CHAT=<id>' 'APPROVAL_DEMO_VAULT_PASSPHRASE=keychain:approval-vault-passphrase' >> ~/demo-gate/.approval/env
chmod 600 ~/demo-gate/.approval/env
```

Then, with the passphrase in this shell, the five vault values. The value is
never a command-line argument: `--value-env` names a variable set for that one
call.

```sh
cd ~/demo-gate
eval "$(approval env)"
V='smtp.example.net' approval vault set smtp.host --value-env V --as human:demo
V='587'              approval vault set smtp.port --value-env V --as human:demo
V='starttls'         approval vault set smtp.security --value-env V --as human:demo
V='you@example.net'  approval vault set smtp.user --value-env V --as human:demo
V="$(security find-generic-password -a "$USER" -s approval-demo-smtp-password -w)" \
  approval vault set smtp.password --value-env V --as human:demo
```

## 5. Doctor, green

```sh
cd ~/demo-gate
APPROVAL_HUMAN=human:demo approval doctor
```

Green is **`0 failed` and exit 0**. Rows marked `–` are states, not faults, and a
check that does not apply never fails the verb. Any `✗` exits 1.

The `identity` check reads `APPROVAL_HUMAN` from the shell, and `policy attest`
took its identity from `--as`, so run doctor after `setup identity` and the
`eval`, or export it for the run. With `APPROVAL_HUMAN` unset the row is a hard
failure (`APPROVAL_HUMAN is unset: the human-only verbs … will refuse`) and
doctor exits 1. Run straight after step 3, with the identity exported and no
credentials yet, it reads:

```
✓ build-freshness        …/dist/src/cli/main.js built …, not older than the source tree
✓ identity               APPROVAL_HUMAN=human:demo (config-declared: the trust boundary is this machine, not cryptography)
✓ attestation            /Users/you/demo-gate/APPROVAL.md is attested at seq 1 (sha256 97b814341e3c…)
✓ log                    …/.approval/log/events.jsonl verifies: 1 record(s), head seq 1 ae8b6cdf8d27…
– telegram               APPROVAL_TG_TOKEN and APPROVAL_TG_CHAT are unset …
✓ web-port               127.0.0.1:4680 is free (bound and released; nothing was left listening)
✓ payload-store          …/.approval/payloads is not created until the first request --payload …
– audit-sampling         disabled (rate-absent) …
– envelope-integrity     no task folder at /Users/you/demo-gate/backlog/tasks …
– vault                  no credential vault at /Users/you/demo-gate/.approval/vault.enc …
– environment            /Users/you/demo-gate/.approval/env is absent …
– log-drift              …/events.jsonl is not inside a git repository, so there is no committed copy to compare it against
✓ reconciliation         no retrospective denial is waiting to be reconciled
– harness-hook-outcomes  no .claude/settings.json in /Users/you/demo-gate …
7 ok · 7 not applicable · 0 failed
```

After step 4 the `telegram`, `vault` and `environment` rows turn `✓` — the
Telegram check reaches the real Bot API, the vault check opens the vault and
counts the credentials in it (printing no name and no value), and the environment
check confirms every variable the policy names is resolvable from this shell. The
`log-drift` and `harness-hook-outcomes` rows stay `–` for the life of this
instance, and that is the point: `~/demo-gate` is not a git checkout and runs no
harness hook.

`envelope-integrity` turns `✓` once the demo's task files exist; point it at them
with `approval doctor --tasks <dir>` if they live outside `~/demo-gate`.

## 6. The repo log is untouched

Run a full rehearsal against `~/demo-gate`, then, from inside this repository:

```sh
git status --porcelain .approval/
```

Expected output: **nothing**, exit 0.

Why it holds: an instance is a directory. Every path the runtime writes —
`.approval/log/events.jsonl`, `.approval/QUEUE.md`, `.approval/payloads/`,
`.approval/env`, `.approval/vault.enc`, and the per-request private keys sealed
delivery keeps beside the log — resolves against the working directory (or an
explicit `--log`). A rehearsal whose working directory is `~/demo-gate` has no
path by which it could reach this repo's `.approval/`, and the demo policy names
no path inside it.

Two ways to break that, both avoidable:

- Running a demo verb from inside the repo with `--dir ~/demo-gate` and no
  `--log`. The policy comes from the demo instance, the log comes from the repo.
  `doctor` only reads, so it merely reports nonsense; a gate verb would append.
  `cd ~/demo-gate` instead, or pass `--log ~/demo-gate/.approval/log/events.jsonl`
  alongside `--dir`.
- Passing `--log` at a repo path. There is no reason to; do not.

Run the check from inside the repo, as written above. The `git -C <path>` form is
refused by this project's Claude Code hook as `hook-unclassified`.

## Verified against a scratch instance

Every non-interactive step above was run against a throwaway instance before this
was written, on `dist/` built from this tree:

| Step | Result |
| --- | --- |
| `approval init --dir <absent path>` | exit 4, `ENOENT`, nothing written — hence the `mkdir -p` |
| `approval init --dir <existing dir>` | exit 0, wrote the four targets |
| policy above written and `policy check` run | `read.files → autonomous`, `communicate.email.external → manual`; the policy parses against the real schema |
| `approval policy attest --as human:demo` | exit 0, seq 1, non-interactive |
| `APPROVAL_HUMAN=human:demo approval doctor` from inside the instance | `7 ok · 7 not applicable · 0 failed`, exit 0 |
| the same with `APPROVAL_HUMAN` unset | `6 ok · 7 not applicable · 1 failed`, exit 1 — the `identity` row |
| `approval doctor --dir <instance>` from outside | attestation `✗`, log read from the *caller's* directory — the reason for the `cd` rule |
| `setup channel telegram` / `setup vault` / `setup adapter email` with stdin closed | exit 2, `is interactive and stdin is not a terminal. Nothing was written.`, each printing its by-hand path |
| `git status --porcelain .approval/` in this repo, after all of the above | empty, exit 0 |

The interactive verbs in step 4 were not driven to completion: they require a
terminal by design, and a rehearsal that faked one would prove nothing about the
ceremony a human performs.
