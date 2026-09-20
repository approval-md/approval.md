# approval.md hosted

approval.md gates an agent's side effects behind a human's tap. Running it
today means running a daemon and a channel listener yourself. Hosted is the
version where we run them for you.

The shape:

- **One tenant directory per customer.** `APPROVAL.md` beside `.approval/`,
  exactly the layout `approval init` scaffolds. Nothing about a tenant is
  stored anywhere else.
- **One daemon process per tenant.** The daemon watches that directory, sweeps
  expired approvals, and regenerates `.approval/QUEUE.md`. Tenants do not share
  a process, so one tenant's log is never in another tenant's memory.
- **Decisions arrive on the customer's own Telegram bot.** The bot is theirs,
  created with @BotFather, and the policy carries only the *names* of the
  environment variables that hold the token and the chat id.
- **The log stays a file in the tenant's directory.** `.approval/log/events.jsonl`
  is a hash-chained append-only file the customer can copy, diff, and check with
  `approval log verify` on their own machine. Hosting it does not make it ours.

## What is real today

Three files, wrapping the runtime this repository already ships:

- `hosted/policy-builder/index.html` — a static page, no build step and no
  dependencies. It renders a valid `APPROVAL.md`: approver id, Telegram sender
  id, default autonomy, TTL, and a table of class rules. Copy or download.
- `hosted/tenant.mjs` — `node hosted/tenant.mjs <tenant-dir>`. Runs
  `approval init` if `.approval/` is absent, then starts `approval daemon run`
  and `approval channel telegram listen` against that directory, prefixing each
  line with the tenant name. Ctrl-C stops both.
- `hosted/README.md` — this file.

Everything underneath (the gate, the policy loader, the hash chain, the
Telegram channel, the token window) is the existing runtime, unchanged. These
files add no network surface of their own.

## What is next

- **Auth.** There is no account model here. A tenant directory is a directory on
  whoever's machine runs the script.
- **A multi-tenant control plane.** Today one process supervises one tenant.
  Provisioning, restart, and per-tenant health belong to a supervisor that does
  not exist yet.
- **VPS deploy.** No packaging, no service unit, no upgrade path. The daemon is
  deliberately foreground, so `systemd` or `launchd` is the right host for it.
- **Hermes agent integration.** The agent side of the demo is still typed by
  hand. Wiring an agent that registers, requests, waits, and runs through the
  granted token is the next slice.

## Demo in 3 minutes

1. Open `hosted/policy-builder/index.html` in a browser. Set the approver id and
   the Telegram numeric sender id, leave the seeded class rows alone.
2. Press **Download APPROVAL.md** and save it into a new tenant directory, for
   example `./demo-tenant/APPROVAL.md`.
3. `node hosted/tenant.mjs ./demo-tenant`. It scaffolds `.approval/`, starts the
   daemon, and starts the Telegram listener. If the bot variables are not
   exported it says which ones to export and keeps the daemon running.
4. Follow the agent-side commands in `examples/email-demo.md`: attest the
   policy, fill the vault, hash the payload, register the task, request the
   action.
5. Tap **Approve** on your phone. The grant lands in the log and mints a
   single-use token.
6. Spend it with `approval adapter email`. The mail is sent.
7. `approval log verify` reports a clean chain over the whole story.

Steps 4 through 7 are the existing walkthrough; `examples/email-demo.md` is the
authority on them, including the identity caveat in SPEC.md section 11. The
hosted slice replaces only the setup: writing the policy by hand and starting
two processes in two terminals.
