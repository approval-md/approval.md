# approval.md

[![ci](https://github.com/approval-md/approval.md/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/approval-md/approval.md/actions/workflows/ci.yml)

**A harness-agnostic, open-source framework for approving agent actions with a
human in the loop.**

Your agent is about to send the email, push to main, spend the money, delete
the folder, or publish the post. A bad diff can be reverted. A sent message
cannot, and it carries your name.

approval.md puts a button between the agent and that action. You write a
short policy file saying which kinds of action need you. The agent runs freely
inside those lines. When it reaches one, a message arrives on your phone with
exactly what is about to happen, and nothing happens until you tap.

Two things people use it for first:

- **Signing off an email.** The agent drafts, you read the recipients, subject
  and body on your phone, you tap Approve, and the adapter sends it once with a
  credential the agent never held.
- **Watching a coding agent.** A hook classifies every command Claude Code or
  Cursor runs. Reads and edits go through; `git push origin main`, `npm
  install`, `curl -d`, `rm -rf` come to your phone first, and every decision is
  in a log you can verify.

Spec site: https://approval.md · Specification: [SPEC.md](SPEC.md) · Package:
`approval-md` on npm.

## Five minutes to a working gate

**1. Install.**

```sh
npm install -g approval-md
```

**2. Make a gate.** Three commands in the project directory. `init` writes a
starting policy that names an approver called alice; make it you, then sign for
the bytes.

```sh
approval init
sed -i '' 's/alice/yourname/g' APPROVAL.md     # Linux: drop the ''
approval policy attest --as human:yourname
```

```
attested /your/project/APPROVAL.md at seq 1: sha256 cff55216c7be9bfbf35a7d980b6a0c75d250ebc039d7584cb9b3aa3bf25b2f91
```

The gate is operative. Open `APPROVAL.md`: it is a page of YAML you can read in
a minute, and the classes marked `manual` are the ones that will ask you.

**3. Put the button on your phone.** Message **@BotFather** on Telegram with
`/newbot`, then:

```sh
approval setup channel telegram   # token into the keystore, chat discovery
eval "$(approval env)"            # the resolved variables, in this shell
approval up                       # the runtime: one foreground process
```

Leave `approval up` running. Everything below that needs a decision now
reaches your phone.

**4. Pick your first experience.**

- *A coding agent*: [gate your coding agent](#gate-your-coding-agent) is two
  more steps, a classification you can try immediately and a hook you paste
  into `.claude/settings.json`.
- *An email*: [hand a grant to a real credential](#hand-a-grant-to-a-real-credential)
  adds an SMTP or AgentMail credential to the vault, and
  [examples/email-demo.md](examples/email-demo.md) walks the whole send.

When something does not work, `approval doctor` prints one line per check with
a `fix:` line under each failure. It is described under [Running the
checks](#running-the-checks), and it is not a step you need on the way in.

## What it is made of

- **A policy file you wrote.** `APPROVAL.md` is markdown at the root of your
  project with one YAML block declaring which classes of side effect an agent
  may take on its own, which need you, and under what budgets. A human signs
  for its exact bytes; an edit makes it inoperative until someone signs again.
- **A message on your phone.** A request arrives over Telegram carrying what
  the runtime computed, what the agent claimed, and the exact bytes about to
  leave. You tap Approve or Reject. A local web page and the terminal are the
  other two channels.
- **A single-use execution token.** Minted at one place in the code, only as a
  human decision is recorded, spent once, stored nowhere. An adapter holding a
  real credential opens it only inside a verified token window.
- **A log nobody can quietly rewrite.** Every proposal, decision and execution
  is an append-only, hash-chained JSONL record. `approval log verify` answers
  for the chain.

Not everything is worth a tap. A class declared `supervised` runs at once, and
a fraction of those runs is sampled for your retrospective review using a
secret the agent cannot read, so you see one in a hundred `gh pr merge` calls
rather than all of them.

The design rule is **files are the interface, the log is the truth, the
database is a cache**. Routing, gating, budget math and chain verification are
deterministic code. Models propose; the runtime decides.

## How the gate holds

- **Credentials live in an encrypted vault**, never in the policy file and never
  in the agent's environment. `APPROVAL.md` carries the *name* of an environment
  variable, and there is no `approval vault get`.
- **Adapters answer only to tokens.** The email adapter opens the vault inside a
  verified token window, sends, and closes it. An agent without a token reaches
  no credential.
- **Tokens are minted at one site**, in the path that records a human decision,
  and the log holds only their SHA-256. A second spend is refused
  `token-consumed`.
- **The log makes tampering evident.** Each record chains to the previous one.
  Projections rebuild from the log and never write back.
- **The harness hook covers the direct-shell path.** `approval hook claude-code`
  classifies the commands a coding agent runs on its own and answers allow or
  deny, fail-closed.
- **The escape hatch is a recorded ceremony.** When the gate itself is broken, a
  human opens a time-boxed window with `approval gate open`: a terminal, a
  required `--reason`, and the typed word `understood`. Every call it lets
  through is logged as `gate.bypassed`, human-only classes stay refused, and
  `approval status` reports unhealthy until it closes
  ([docs/cli-reference.md#gate](docs/cli-reference.md#gate)).

This is an oversight layer for broadly cooperative agents, with hard
enforcement at the adapter boundaries that hold the credentials (SPEC.md
section 11). Identity in v0.1 is config-declared, so the trust boundary is the
machine rather than cryptography. ["Can't the agent just go around
it?"](#cant-the-agent-just-go-around-it) works through each evasion.

## Gate your coding agent

`approval run` gates the commands an agent hands to the runtime. It cannot gate
the ones the harness runs directly, and those are most of them. Two surfaces
close that gap: a PreToolUse hook for Claude Code and an MCP server for any
harness that speaks MCP. Both resolve against the same policy and append to the
same log as the CLI.

Codex support is opt-in while native compatibility and everyday activation are
still being verified. See the bounded [Codex hook operator
runbook](docs/codex-hook.md) before installing or trusting it.

**1. See how a command classifies.** This touches nothing.

```
$ approval hook classify -- npm install left-pad
class     rule                 command
deps.add  npm-install-package  npm install left-pad

classes: deps.add
```

Every segment of a command line is classified and the command takes the union,
so `git status && curl -d …` is gated as `network.call`.

**2. Install the hook.** It lives in `.claude/settings.json`, and a human
commits that file: an agent that could write its own hook entry could write
itself out of it.

```json
{ "hooks": { "PreToolUse": [ {
  "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit",
  "hooks": [ { "type": "command", "timeout": 600,
    "command": "approval hook claude-code --dir <primary checkout> --as agent:claude-code --timeout 9m" } ]
} ] } }
```

Register the same command under `PostToolUse` as well, without `--timeout`, so
the runtime learns how each command ended. `--dir` resolves the policy and the
log together, so a session inside a linked worktree still writes to the one
log. Keep `--timeout` (how long the hook waits for you) below `timeout` (Claude
Code's cap on the process).

**3. Watch a verdict.** An `autonomous` class allows and logs nothing. A
`supervised` class allows and records the action for sampling. A `manual` class
waits for your tap. Anything the classifier cannot read denies. There is no
"ask" answer: a decision taken outside the log is a decision nothing can audit.
The deny reason is `<code>: <detail>`, and the codes are frozen
(`hook-unclassified`, `hook-opaque`, `hook-rejected`, `hook-timeout` and the
rest in [docs/claude-code-hook.md](docs/claude-code-hook.md)).

**4. Know the sharp edges.** The hook never creates a log: pointed at a path
with no log it denies `hook-log-unreachable` rather than forking a second
chain. A wait that runs out keeps its question open for a short grace and then
withdraws it, so nobody is pinged about a question whose asker has left. A hook
grant mints no token: the harness runs the command itself.

**5. Or connect the MCP server.** `approval mcp serve` is a stdio server
publishing the agent's verbs as tools.

```sh
claude mcp add approval -- \
  node /path/to/approval-md/dist/src/cli/main.js mcp serve \
    --as agent:claude-code \
    --dir /path/to/project
```

`register`, `request`, `wait`, `run`, `queue`, `status` and the rest of the
agent's surface are there. `grant`, `reject`, `revoke`, `policy attest` and
`vault set` are not: an MCP client is the agent's harness, and a `grant` tool
on it would hand the agent the overseer's pen. Grant never travels over MCP,
and neither does the token it mints. The identity is fixed at startup and
`--as` is removed from every published schema, so a tool call cannot name an
actor. Walkthrough: [examples/mcp-demo.md](examples/mcp-demo.md).

A harness that can run commands needs neither surface: `request`, `wait`, `run`
is how sessions in this repository take manual-class actions
([docs/dogfood-cutover.md](docs/dogfood-cutover.md)). The task-file side of
that flow, on a Backlog.md board, is
[examples/backlog-md-project/README.md](examples/backlog-md-project/README.md).

## Put approvals on your phone

**1. Setup writes the environment map, not the secrets.** `approval setup
channel telegram` puts the bot token in the OS keystore (macOS Keychain, or
`secret-tool` on Linux) and records in `.approval/env` only where it lives. The
verbs are interactive by refusal: a pipe or `--json` exits 2 and prints the
non-interactive commands, because a setup a CI job could drive would let a CI
job declare a human identity. `approval env` is the only command that reads
that file, and evaluating it is a step a human takes. Full walkthrough:
[examples/telegram-demo.md](examples/telegram-demo.md).

**2. A request binds to exact bytes.** The payload lives in a file, the
envelope declares its `payload_hash`, and `--payload` supplies the bytes at
request time:

```sh
approval payload hash payload.json    # the binding the envelope declares
approval register task-demo.md --as agent:drafter
approval request task-demo --action task-demo:chaser --payload payload.json --as agent:drafter
```

```
registered task-demo at seq 2: 1 action(s)
requested task-demo task-demo:chaser at seq 3 (manual)
```

Material that hashes to something else is refused `payload-mismatch`, and
nothing is stored or appended. Class, cost and reversibility come from the
registered envelope rather than from flags, so an agent cannot rename its own
class between registering and asking. An approval is about specific bytes,
never about a description of them.

**3. The runtime delivers it.** `approval up` prints `notified
task-demo:chaser (message 501)` and your phone has it. That one foreground
process is the daemon loop (envelope drift, expiry, queue regeneration,
retrospective sampling) plus every channel the policy configures. A channel
whose credential is unset is not started and says so; a channel that falls over
is restarted with backoff while the loop keeps ticking. `approval setup service`
writes the launchd or systemd user unit that starts it at login, and prints the
whole unit for you to read first.

The message shows the action key, a **COMPUTED** block the runtime derived
(class, task, binding, budget verdicts, chain head), a **CLAIMED** block naming
the agent and marked unverified, the **FULL PAYLOAD**, and two buttons. It says
how long an answer still has: `waiting: requested 4 min ago · expires 13:07
UTC`, or, for a request a process is blocked on, `requester waits until 13:07
UTC`. An email-shaped payload is rendered field by field with real line
breaks, with the canonical JSON and its hash underneath. Detection is
structural and never reads a self-declared type. Agent-authored text is
HTML-escaped, so markup stays inert.

An optional gloss, a one-line plain-English reading of the payload by a model,
can sit above the computed block. It is marked unverified, it never changes a
verdict, and a failed gloss is omitted while delivery continues:

```sh
approval up --gloss-provider codex --gloss-model gpt-5.4-mini   # or the default, claude/haiku
```

**4. Tap Approve.** The prompt rewrites itself in place. The buttons go away and
the text becomes the outcome:

```
✓ APPROVED
task-demo:chaser

by human:alice at 10:20 UTC (seq 4)
```

One edit carries the annotation and the disarming together, so there is no
moment when the message reads "approved" and still offers a tap. Rejections,
revocations, expiries and withdrawals settle the same way, and a tap on a stale
button records nothing.

**5. The token stays off the chat.** The grant mints a single-use execution
token. With `defaults.token_delivery: sealed` the requesting process opens it
itself and no human ever sees it, which is how this repository releases. With
the default `manual` delivery it is printed once, in a panel, at the surface
that recorded the decision:

```
granted task-demo:chaser at seq 4 by human:alice
─────────────────────────────────────────────────────────────
  execution token   task-demo:chaser
  516670320878e97dede99cf84bc48025fc80b7cf14bd9e9782bb1cfd0d92a787
  single-use · stored nowhere · copy it now
─────────────────────────────────────────────────────────────
```

For a tap on your phone that panel appears on the terminal running the
runtime, and its last line reads `not sent to Telegram`: a chat transcript
lives on servers you do not control, so a credential does not go there. The
local **web** channel shows the token once in the response page for the grant
that minted it, served over loopback, gone on reload, because there the browser
is already the surface you are looking at. In every case the log holds only the
token's SHA-256. Lose it, revoke the grant, and request again.

**6. Spend it.** `approval run <action> --token "$TOKEN" -- <command>` appends
`execution.started` before spawning the child and `execution.completed` after,
and exits with the child's own exit code, so it composes with `make`, CI and
`&&`. Run it before the approval and it refuses `token-required` at exit 5.
Run it twice and it refuses:

```
✗ token-consumed  action task-demo:chaser already executed: execution.started at seq 5 spent this token. A token is single-use and the log is the proof.
```

A request is not owed an answer forever. `approval withdraw` lets the party
that opened one take it back while it is pending, and `approval wait
--withdraw-on-timeout` does it when your own wait elapses.

**7. Read the whole story.** Two actors, one clean chain:

```
1	2026-08-19T19:03:58.381Z	policy.updated	human:alice	-
2	2026-08-19T19:03:58.585Z	task.registered	agent:drafter	task-demo
3	2026-08-19T19:03:58.767Z	approval.requested	agent:drafter	task-demo
4	2026-08-19T19:04:31.192Z	approval.granted	human:alice	task-demo
5	2026-08-19T19:04:41.371Z	execution.started	agent:drafter	task-demo
6	2026-08-19T19:04:41.499Z	execution.completed	agent:drafter	task-demo
```

That is `approval log tail`, tab-separated for `cut` when piped, aligned and
coloured on a terminal. `approval log verify` answers for the chain: `clean: 6
record(s), head seq 6 843705c6bbea…`.

**8. Review what ran without you.** Supervised actions the sampler picks arrive
on the same chat as review cards, after the fact: what ran, when, and that the
runtime allowed it unasked. ✅ records that you looked, 🛑 twice records a
denial and opens a reconciliation obligation, and 👎 😐 👍 ❤️ leave a graded
reaction. `approval audit list` and `approval audit review` are the same
backlog at the terminal.

## The other half of the word

Everything above is control. The file carries your voice too. Below the policy
block, `APPROVAL.md` may hold one optional `yaml approval-values` block: what
you love, like and dislike in the work, what you want from an agent as
behaviour, and how you read and answer.

```sh
approval values      # the operator's block, or "the operator has declared no values here."
approval feedback    # the reactions and notes humans left on this log's actions
```

A retrospective review or a grant can carry a graded reaction (`disliked`,
`indifferent`, `liked`, `loved`; the two extremes need a note), and `approval
feedback` reads them back to the agent whose work they were about. Both verbs
print human-authored guidance behind a banner that says so, and neither reaches
enforcement: no verdict, sample, budget or token moves because of them (SPEC.md
section 11.1, invariant 10). They mirror `approval journal write`, the agent's
outlet the gate does not stand in front of. `approval import agents-md` drafts
the block from a "What I value" heading in an AGENTS.md.

## Define what needs approval

A policy is a fenced `yaml approval-policy` block inside a markdown file named
`APPROVAL.md`. The prose around the block is for you; the runtime parses the
block and ignores the rest. The thing you sign for is text you read.

**1. Name the classes.** A class is a dotted path from the side-effect taxonomy
of SPEC.md section 7 (`communicate.email.external`, `financial.spend`,
`public.post`, `data.delete`, `read.*`). Matching is most-specific-first, `*`
is a single-segment wildcard, a trailing `.*` matches any depth, and at equal
specificity the strictest rule wins.

**2. Pick an autonomy for each.** Six values, strictest first: `human-only` (a
person performs the action outside agent execution, and every gate verb refuses
an agent with `class-human-only`), `manual` (a human decides before execution),
`supervised-live` (a policy-declared fraction blocks on the gate exactly as
`manual` does, and the rest proceed, so the rule carries a `live_rate`),
`supervised-retro` (executes immediately, a sampled fraction escalated for
retrospective review), `supervised` (an alias of `supervised-retro`), and
`autonomous` (executes freely). An email is `reversible: false`, which engages
section 7's irreversibility floor: the class resolves to `manual` even where the
policy says `supervised`, because retrospective sampling cannot un-send a
message.

**3. Set the budgets.** Class `limits` and the `budgets` scopes are conjunctive,
so an action must pass both, and consumption is computed from the log over
rolling windows rather than from a mutable counter. An action whose class
matches no rule takes `defaults.autonomy`, and a policy that does not parse
resolves every class to `manual`: unattested and unparseable are both strict.

**4. Widen the protected paths.** `APPROVAL.md`, the agent instruction files,
`.approval/`, the harness settings and the release configuration are protected
by the runtime whatever a policy says. `protected_paths` adds repo-relative
literals (an exact file, `SPEC.md`, or a directory prefix, `design/`), so a
project can put its own governing documents behind the same gate. The key can
only widen, and globs are a schema violation.

An entry can also be an object, `{path, class}`, routing that path family to a
named `policy.edit` sub-class with its own autonomy and live rate. Four names
are reserved: `policy.edit.spec` (the governing specification),
`policy.edit.harness` (agent instruction files and harness configuration),
`policy.edit.ci` (continuous-integration and release configuration),
`policy.edit.design` (design documents and decision records). Any other
lowercase word may be minted beside them, and nothing outside `policy.edit` may
be named: a route to `policy.core` or `log.mutate` is refused. A route aimed at
a built-in protected path must land at least as strictly as the `policy.edit`
line itself, or the policy is refused at load with `protected-route-floor`.

**5. Attest it.** `approval policy attest` is what makes a policy operative. An
attestation records that a human saw these exact bytes, as their SHA-256. Edit
`APPROVAL.md` afterwards and every gated operation refuses `hash-mismatch`
until you attest again. Attestation is human-only, and identity in v0.1 is
config-declared, so what one proves is that someone with local control signed
off.

**6. Amend it with the verb, not by hand.** Changing a policy is two facts that
have to land together, the new bytes and a human's attestation of them, and
`approval policy amend` owns the ceremony (`--dry-run` reports only,
`--require-load` refuses to attest a policy that does not load, `--commit`
lands the two files as one commit and opens the pull request). It prints a
semantic diff (class resolutions, approver changes, defaults, limits) rather
than a text diff, then a load advisory saying whether the edited policy parses.
Attesting one that does not parse is allowed, since attestation records bytes
rather than correctness, and such a policy fails closed to all-manual.

### Why this verb exists: seq 2

Read this repository's own log. At **seq 2** a policy amendment was attested at
11:56:07. It was **superseded** seven minutes later, at seq 3, because the edit
broke a pinned assertion and nobody found out until the test suite ran against
it. The operator attested bytes whose consequences had never been shown to
them. (This account originally said eleven minutes. The log says seven, and
the log won.)

That is the failure the load advisory is for. Had `approval policy amend`
existed that morning, the load failure would have been on screen while the
human was deciding, and `--require-load` would have refused to attest at all.

## Hand a grant to a real credential

`echo sent` is a demo. The point of the gate is the send that cannot be undone,
so the runtime holds a credential the agent never sees. Four commands carry the
ceremony; the walkthrough against real Telegram and a real mail provider is
[examples/email-demo.md](examples/email-demo.md).

```sh
approval setup vault           # mint the passphrase, store it, record where
approval setup adapter email   # the five SMTP settings, into the vault
eval "$(approval env)"         # the variable the policy names, in this shell
approval adapter email task-042:chaser --token "$TOKEN" \
  --payload message.json --as agent:claude-admin
```

**1. Two stores.** `.approval/env` says where the values that unlock the
machine come from, and `approval setup vault` writes the passphrase line under
whatever name `vault.passphrase_env` declares. The SMTP password is an adapter
credential, so it goes in the vault, where a gated adapter spends it inside a
verified token window.

**2. Setup fills the vault and proves it.** `approval setup adapter email` reads
the credential manifest the adapter declares, then probes the server without
sending anything.

**3. A credential's only journey is into an adapter.** `approval vault set`
stores one credential in `.approval/vault.enc`, encrypted under a passphrase
the policy names and never carries. The value comes from stdin or `--value-env
<VAR>`; there is no `--value` flag, because a secret on a command line is a
secret in the shell history. There is no `approval vault get`; `approval vault
list` shows the names.

**4. The send happens inside the token window.** `approval adapter email`
verifies the token, re-hashes `message.json` against the binding the grant
recorded, appends `execution.started`, opens the vault, reads the SMTP
settings, sends over STARTTLS, closes the window, and appends
`execution.completed`. The credential exists for one send and appears in no
event, output or error message.

**5. Check two properties in your own mailbox.** The bytes that left are the
bytes you approved, since the hash the token spend verified is the hash of the
payload your phone displayed. And the `Message-ID` is derived from the action
key, the payload hash and the sender, so the header in a mailbox and the
binding in the chain identify each other months later.

### The same grant over AgentMail

`communicate.email.external` has a second adapter. Where the email adapter
opens an SMTP session, `approval adapter agentmail` calls the AgentMail API, and
a mail the agent has already composed as a Draft leaves only when a grant says
so. Walkthrough: [examples/agentmail-demo.md](examples/agentmail-demo.md).

```sh
approval setup adapter agentmail                  # inbox id + sending key, into the vault
approval payload agentmail-draft "$INBOX" "$DRAFT" > payload.json
approval adapter agentmail task-042:chaser --token "$TOKEN" \
  --payload payload.json --as agent:claude-admin
```

**Two keys, and the split is the enforcement.** AgentMail API keys carry
per-permission booleans, and `draft_create`, `draft_update` and `draft_read` are
separate from `draft_send` and `message_send`. Give the agent a key holding the
first three and none of the last two, and put a key holding the send permissions
in the vault. The agent composes all day and cannot send at all: an ungated
send is refused by AgentMail itself, `agentmail-unauthorized`, before this
runtime is involved. `AGENTMAIL_` is withheld from every child `approval run`
spawns, so a key in the agent's environment cannot ride into a command.

**A draft is mutable, so the grant binds its bytes.** `approval payload
agentmail-draft` snapshots the draft's recipients, subject and text at request
time, and that snapshot is what the hash binds and what your phone displays.
Before it sends, the adapter re-fetches the draft and compares; a draft edited
after the grant refuses `agentmail-draft-drifted`, sends nothing, and names
which fields differ without quoting text nobody approved. That comparison runs
before the token is spent, so the refusal costs no authority: restore the
approved text and the same token still sends.

### First-class zzz.bot messages

`approval adapter zzz` creates a thread or replies through zzz.bot's versioned
HTTP API. Put the invited write credential in the vault, then approve the
complete tagged payload. The environment, destination, body, metadata, tags and
references all sit inside the payload hash.

This adapter is available from a source checkout containing APRV-320 until the
next approval.md package release. The published npm `approval-md@0.1.0`
predates it, and this change does not publish a package.

```sh
approval setup adapter zzz
approval adapter zzz task-320:announce --token "$TOKEN" \
  --payload zzz-message.json --as agent:codex
```

Thread payload:

```json
{"environment":"production","operation":"create_thread",
 "room_id":"<room-id-from-GET-api-v1-rooms>",
 "title":"Release ready","body":"The verified build is ready for review.",
 "tags":["release"],"references":[]}
```

A reply uses `"operation":"create_reply"` and `"thread_id"` instead of
`room_id` and `title`. The adapter chooses only fixed production or preview
origins, rejects redirects, and derives zzz.bot's idempotency key from the
approval action key and payload hash.

Public writes require an invited credential with write scope. Private writes
also require active room membership and accepted, unexpired approval.md workflow
evidence. The setup probe performs one authenticated room-list GET. It proves
that zzz.bot accepts the credential and does not prove those write or private
room prerequisites. A local non-guest MCP server exposes the same adapter verb,
but MCP use is voluntary; custody is enforced only when the write credential is
kept solely in the approval.md vault.

### Build a third-party adapter

Adapter authors can import the supported ESM API from `approval-md/adapters`.
It exposes the shared execution contract, conformance runner, vault credential
provider, refusal unions, and TypeScript types without making internal package
paths public. See the [adapter API guide](docs/adapter-api.md).

## The APPROVAL.md dictionary

Every key that can appear in the policy block. The schema is closed at every
level: an unrecognised key fails validation, which fails the policy closed to
all-manual, because a key the runtime did not understand is a rule its author
believed was in force. Full semantics: SPEC.md section 5.

| key | what it says |
| --- | --- |
| `version` | Policy format version, quoted (`"0.1"`). The only required key (§5.1). |
| `defaults.autonomy` | Autonomy for an action matching no class rule. Five of the six levels are admitted: `supervised-live` is not, since it needs a `live_rate` that `defaults` has nowhere to hold. `human-only` is, and reserves every unnamed class to human hands. No default of its own, and `manual` is the fail-closed choice (§5.2, APRV-185). |
| `defaults.channel` | Channel name requests surface on by default; expected to name a key of `channels`, which is a runtime cross-check rather than a schema one. No default (§5.1, §10.3). |
| `defaults.approval_ttl` | How long a pending request stays actionable. Duration string, `24h`. No default; the scaffolded policy writes one (§5.1). |
| `defaults.token_delivery` | How a minted token reaches the process that will spend it. `manual` (the default, and what an absent key means): printed once on the granting surface and carried by a human. `sealed`: sealed to a per-request X25519 key so `approval wait` can hand it back, which addresses the token and never authorizes it (§10.4, APRV-105). |
| `defaults.on_expiry` | What happens when the TTL lapses. `reject` is the only value, and absent means `reject` (§5.1). |
| `payload_retention` | How long payload bytes are kept after their action is terminal. Absent means nothing is ever pruned (§5.2). |
| `protected_paths` | Repo-relative files and directory prefixes whose edit is classified `policy.edit`. A bare string is the whole entry. Additive only, no globs, and absent means the built-in protected set alone (§5.2, APRV-107). |
| `protected_paths[].path` | The path half of the object form: the same grammar as the bare string, an exact file (`SPEC.md`) or a directory prefix (`design/`) (§5.2, APRV-266). |
| `protected_paths[].class` | The class half: one lowercase segment under `policy.edit`. Four reserved names, `policy.edit.spec`, `policy.edit.harness`, `policy.edit.ci` and `policy.edit.design`, plus any word an author mints beside them. Nothing outside `policy.edit` may be named, and a route below the `policy.edit` line is refused `protected-route-floor`. No default: an entry that wants a sub-class states it (§5.2, APRV-266). |
| `approvers.<name>.channels` | The channels one approver can decide on. At least one: an approver reachable nowhere can never grant. No default (§5.1). |
| `classes.<pattern>.autonomy` | Required on every class rule, so it has no default. Six levels, strictest first: `human-only`, `manual`, `supervised-live`, `supervised-retro`, `autonomous`, and `supervised`, which is the pre-split spelling and an alias of `supervised-retro` (§5.2, APRV-127, APRV-185). |
| `classes.<pattern>.live_rate` | The fraction of a `supervised-live` class that blocks on the gate, in (0, 1]. Required there and refused everywhere else, so it has no default: a live mode with no fraction declares a control without saying how much of it runs. Selection is HMAC-SHA-256 over the payload hash under the operator's secret (§5.2, APRV-127). |
| `classes.<pattern>.retro_rate` | This class's retrospective sampling rate, in (0, 1], overriding `audit.supervised_sample_rate` for it alone. Optional on `supervised`, `supervised-retro` and `supervised-live`, refused on the rest. Absent means the global rate (§5.2, APRV-183). |
| `classes.<pattern>.approvers` | Approver ids permitted to decide this class. Absent restricts nobody, since the list is a narrowing and a narrowing nobody wrote narrows nothing; a named list refuses everyone else with `actor-not-approver` (§5.1). |
| `classes.<pattern>.limits` | Per-class ceilings, every value a positive number: `per_action_usd`, `daily_usd`, and the request-volume counts `max_pending` and `requests_per_hour`. Absent means this class carries no ceiling of its own (§5.1, §5.2). |
| `budgets.global.daily_usd` | Repo-wide spend ceiling per rolling day, computed from the log. Absent means no spend ceiling (§5.1). |
| `budgets.global.daily_actions` | Repo-wide count of side-effecting actions per rolling day. Absent means no count ceiling (§5.1). |
| `budgets.global.max_pending` | Simultaneously pending requests across the scope; excess is refused `queue-full`. Absent means no ceiling (§5.2). |
| `budgets.<scope>` | Any other named scope, same three keys. Budgets are conjunctive with class limits (§5.2). |
| `audit.supervised_sample_rate` | The FALLBACK fraction of supervised actions escalated for retrospective review, in [0, 1], for classes declaring no `retro_rate`. Absent means no fallback rate is configured (§5.2, APRV-183). |
| `audit.sampling_secret_env` | Name of the variable holding the operator's HMAC sampling secret. Unnamed means sampling is off and says so (§5.2, §11). |
| `audit.skew_tolerance` | How far a gate-typed event's timestamp may step back before verification reports an anomaly. Report-only; default 2 seconds (§8). |
| `audit.checkpoint_keys` | Public halves of the Ed25519 keys permitted to sign a `log.checkpoint`, base64 DER SPKI. The private halves live in the vault and never in this file. A list, so a retired key stays listed: a checkpoint signed by a key the list does not carry is refused. Absent, empty or unreadable means verification skips the checkpoint check with a reason and never reports it as a pass (§9, APRV-220). |
| `audit.checkpoint_every` | How long the log may go without a human-signed checkpoint before verification says one is due, and before the listener puts one `CHECKPOINT DUE` prompt on the approver's channel (`approval setup checkpoint` mints the key). Report-only at every layer: a due checkpoint is a warning and never a refusal. Absent means the cadence is off and nothing is ever reported as due (§9, APRV-220, APRV-257). |
| `daemon.read_proof` | Which prefix proof a long-lived reader runs before reusing a cached prefix: `full` (the default, re-hash the whole prefix on every read) or `incremental` (hash only the appended bytes, re-proving in full on a cadence). One-shot processes, the Claude Code hook and `approval log verify` prove in full regardless (§5.2, APRV-217). |
| `daemon.full_reproof_every` | Reads one full re-proof may cover under `incremental`, the anchoring read included. Default 50 (§5.2). |
| `daemon.full_reproof_after` | Wall clock one full re-proof may cover under `incremental`. Duration string, default `60s` (§5.2). |
| `vault.passphrase_env` | Name of the variable holding the vault passphrase. Absent means `APPROVAL_VAULT_PASSPHRASE` (§5.2, §10.4). |
| `channels.telegram.token_env` | Name of the variable holding the bot token. Default `APPROVAL_TG_TOKEN` (§5.1). |
| `channels.telegram.chat_id_env` | Name of the variable holding the approver chat id. Default `APPROVAL_TG_CHAT` (§5.1). |
| `channels.telegram.delivery` | `paced` (the default) shows one summary line and the oldest pending request, then the next one after a decision, `/skip` or `/next`; `burst` sends every pending request the listener has not sent yet. Neither mode changes what is pending: that is re-derived from the verified log on every cycle (§10.3, APRV-216). |
| `channels.web.port` | TCP port for the local approval UI, bound on loopback only. No default in the schema; the scaffolded policy names `4680`, and 0 is excluded because the policy must name a port a human can navigate to (§5.1). |
| `channels.<name>.prompt.rows` | Order only, for `telegram`, `web` and `cli`: the rows named here render in this order ahead of the rest, which keep their default relative order behind them. Never a whitelist, so a field added later cannot be lost to a list written before it existed. Absent means the layout the channel ships (§5.2, §10.3, APRV-218). |
| `channels.<name>.prompt.always` | Rows this channel renders only when abnormal, or not at all, render on every prompt instead. The anomaly mark stays a statement about the value, so a forced-on row shouts only when the value is in fact the reason to look. Absent means the channel's own visibility rules (§5.2, §10.3, APRV-218). |
| `channels.<name>.prompt.hide` | Rows this channel never renders. Refused for the rows required for a decision (`action_key`, `class`, `command_breakdown`, `protected_path`, `policy_diff`, `policy_load`) with `prompt-row-required`, and refused for a row `always` also names. Absent means nothing is hidden, and the canonical payload block is out of reach either way (§5.2, §10.3, APRV-218). |
| `channels.<other>` | An unknown channel name is accepted as an object, so a third-party transport does not fail the whole policy closed (§10.3). A `prompt` block written under such a name is still validated: a layout is checked wherever it appears. |

Every key ending in `_env` carries a variable's *name* and never its value:
agents may read `APPROVAL.md`, so a secret it carried would be a secret they
hold. Where those values live is recorded in `.approval/env`, which a single
verb reads, `approval env`, whose output is an export block a human evaluates.

## How this compares

Three kinds of thing already exist in this space, and each solves a different
part of the problem. A hosted daemon and reviewer layer is operated by
Bountify.ai; it is optional, and nothing in the format depends on it
([GOVERNANCE.md](GOVERNANCE.md)).

**Harness-native permission prompts** (Claude Code permission rules and hooks,
Cursor auto-run, Codex CLI approval modes) enforce inside the one harness they
ship with. That enforcement is real: a Claude Code PreToolUse deny holds even
under its bypass mode, and Codex backs its gate with an OS-level sandbox, which
this project does not attempt. What they lack is a durable record and
portability. None writes an append-only log of what was asked, who decided and
what ran; the decision reaches a human only as a terminal prompt; and the
mechanism does not travel to another harness. approval.md's Claude Code hook is
built on that PreToolUse mechanism and adds the two missing pieces: the
decision comes from an attested policy file, and it lands in a verifiable log.

**AGENTS.md permissions prose** states the policy in English and trusts the
agent to obey. Nothing parses it, nothing blocks a call against it, and no
record exists when it is violated. approval.md is the enforcement layer that
convention is missing, and treats it as an input: the permissions section of
this repository's own CLAUDE.md is the first import fixture.

**Framework interrupts** (LangGraph `interrupt()`, CrewAI human input, AutoGen
`UserProxyAgent`, the OpenAI Agents SDK's `needsApproval`, Temporal signal
approvals) give a developer a pause-and-resume primitive and leave policy,
audit format, the human channel and the credential boundary to them. They also
require adopting the framework. Temporal's event history is a real append-only
execution record with crash recovery this project does not claim, though it
lives in Temporal's storage rather than as policy-attested files in your repo.

**Hosted approval platforms** (HumanLayer, gotoHuman, Permit.io's access
requests) are the closest relatives: multi-channel human routing, review UIs,
and in Permit.io's case a real authorization engine richer than autonomy
classes. Their model is a third-party service in the decision path, with the
audit trail in the platform's backend, and the agent's own process still
choosing to honor the returned verdict. They bring hosted infrastructure,
escalation and team routing, and compliance certifications.

The difference is the combination: policy as a hash-attested markdown file in
your repo; an append-only, hash-chained log you verify locally with one
command; and an execution boundary where the credential is inert until a
single-use token is minted at the moment a human decides. Every framework
primitive and hosted API above relies on the agent's process honoring a
returned decision. Here the thing the agent needs, the credential, answers only
to the thing it cannot make, the token. The tradeoffs: you run the daemon and
listener yourself, there is no OS-level sandbox, no compliance certification,
and the reference phone channel is one app, Telegram.

## Can't the agent just go around it?

**Edit the policy?** An attestation records the SHA-256 of the policy's bytes,
and every gated operation refuses `hash-mismatch` when the live file disagrees
with it. An unattested policy refuses too, and attesting is human-only. Under
the harness hook the edit itself is classified `policy.edit` before it happens,
because `APPROVAL.md` is in the built-in protected set no policy can narrow.

**Fabricate or rewrite the log?** Each record chains to the previous one's
hash, so an edited or reordered record breaks the chain and `approval log
verify` says so. Appends go through compare-and-append against the head, and
projections (`QUEUE.md`, the SQLite index) rebuild from the log and never write
back to it.

**Mint its own token, or reuse one?** Tokens are minted at one site, inside the
path that records a human decision, and the log stores only the hash. No verb
and no tool returns a token for a grant it did not just record, and a hook
grant mints none at all. The second spend is refused `token-consumed`, naming
the seq of the `execution.started` that spent it.

**Call the adapter or the credential directly?** Credentials live in
`.approval/vault.enc` under a passphrase the policy names and never carries,
and an adapter opens the vault only inside a verified token window. There is no
`approval vault get`. An agent that never held a token never reaches a
credential. This is where the hard enforcement lives.

**Run the side effect from its own shell?** That is what the PreToolUse hook is
for: it classifies the command text, resolves the class, and answers allow or
deny before the harness runs anything, fail-closed and with no "ask". The
classifier reads shell text without being a shell, so parameter expansion,
aliases and wrapper binaries are gaps, and each resolves toward denial or the
stricter class. `bash -c`, `eval`, `sudo`, `xargs` and `node -e` deny as
`hook-opaque`.

**POST straight at the web queue?** It can. `approval channel web` binds
`127.0.0.1` with no `--host` flag, because with no authentication the loopback
interface is the entire access control, and every decision the page collects is
recorded against the human the runtime was started with: it proves "someone
with access to this machine approved". There is no CSRF token in v0.1,
deliberately: a CSRF token defends a session, and with no session anything that
can open a socket to `127.0.0.1:4680` can POST with or without one. The
same-origin check that rejects a POST naming a non-loopback `Origin` allows one
carrying neither header, since `curl` sends neither: treat it as a speed bump
rather than a control. A session, or a wider bind address, would need a real
anti-CSRF token.

**Lie in its self-report?** Self-reported fields never reduce scrutiny (SPEC.md
section 11.1, invariant 4). They may raise it, inform display, or feed
retrospective analysis, and they can never downgrade a resolved autonomy level
or shortcut a refusal path. The prompt keeps them apart: a COMPUTED block the
runtime derived, and a CLAIMED block marked unverified.

**So what is left?** A fully adversarial agent on a machine it controls.
Identity in v0.1 is config-declared, so anyone who can set that variable and
write to the log is inside the trust boundary; cryptographic identity is future
work ([docs/proposals/hardened-authorization.md](docs/proposals/hardened-authorization.md)).
What holds regardless of what the harness believes it is running: the vault,
the adapter boundary, and the single-use token. Keep `manual` floors on
irreversible classes, which SPEC.md section 7 does for you.

## Running the checks

```
npm run ci:local             # run the CI tier this diff would get, before pushing
npm run check:changed        # classify the working tree, then run that tier
npm run check:tier -- <path> # classify the given paths and print the tier
approval doctor              # the other check: this machine, not the code
```

`approval doctor` prints **28 rows** and a tally, in the order their failures
cascade: build freshness, identity, attestation, the log chain, the channels
(`telegram`, `web-port`), the payload store, audit sampling, envelope
integrity, the vault, the environment source map, then the rows that ask git
and the harness what happened (`log-drift`, `reconciliation`,
`harness-hook-outcomes`, `harness-hook-wiring`, `keychain-scope`,
`log-advance-cadence`, `dark-sessions`, `verified-snapshot`, `read-proof`,
`main-behind-origin`, `harness-version-unverified`, `live-draw`,
`values-block`, `checkpoint`, `gate-organs`, `sealed-keys`,
`codex-hook-wiring`). Each failure
carries a `fix:` line you run yourself. Doctor appends nothing, sends nothing
and repairs nothing, and no credential value appears in its output. Three
of the 28 lines from a fresh directory, plus the tally:

```
✓ identity            APPROVAL_HUMAN=human:alice (config-declared: the trust boundary is this machine, not cryptography)
✓ log                 /your/project/.approval/log/events.jsonl verifies: 1 record(s), head seq 1 0f3c4a19187a…
✗ audit-sampling      disabled (secret-env-unnamed): APPROVAL.md sets audit.supervised_sample_rate to 0.1 but names no audit.sampling_secret_env. …
    fix: approval policy attest --as human:<id> — after setting audit.supervised_sample_rate and audit.sampling_secret_env in the policy; then export the named variable where the daemon runs
9 ok · 18 not applicable · 1 failed
```

That one failure is expected on the scaffolded policy: it samples supervised
actions for audit, sampling needs an operator-held secret the policy only
names, and a control that looks on while the party under oversight could steer
it is worse than one that is visibly off. Name the secret when you want
sampling, or delete the `audit` block if one person's gate has no use for it.

**18 of the 28 report `not applicable` in a fresh directory**, and each names
the absence it skipped on: `telegram` (no bot variables), `envelope-integrity`
(no task folder), `vault` (no vault file), `environment` (no `.approval/env`),
`read-proof` (no `daemon` block), `live-draw` (no `supervised-live` class),
`checkpoint` (no `audit.checkpoint_keys`), `harness-hook-outcomes`,
`harness-hook-wiring`, `codex-hook-wiring`, `harness-version-unverified` and
`gate-organs` (no harness settings file), `verified-snapshot` (no daemon has
run), and
`log-drift`, `log-advance-cadence`, `dark-sessions`, `main-behind-origin` and
`sealed-keys` (not a git checkout). `sealed-keys` asks git what it tracks:
`.approval/payloads/` is tracked on purpose, and a sealed-delivery private key
swept in by a `git add` of that directory would open that action's token for
everyone holding the log. `gate-organs` is informational wherever it lands: it
lists the harness files whose current bytes carry no `approval policy attest
--organ` record, and never moves the exit code.

Checks come in three tiers.

| Tier | Chosen when every changed path is | What runs |
| --- | --- | --- |
| light | `README.md`, `docs/**/*.md`, `examples/**/*.md` | the documentation guard (`tests/docs-guard.test.ts`) |
| records | `backlog/**`, `MILESTONES.md` | the tests that read records (`milestones-guard`, `backlog-fixtures`, `docs-guard`), on Node 20 |
| full | anything else, or a mix of the above | the whole suite in three shards plus `npm run lint`, on Node 22; the Node 20 floor runs the same three shards on the merge queue and on pushes to `main` |

A denylist forces the full tier regardless of file extension: `APPROVAL.md`,
`CLAUDE.md`, `.claude/**`, `SPEC.md`, `schema/**`, `**/fixtures/**`,
`backlog/**`, `scripts/**`, `.github/**`, the packaging files, and `cli.js`.
`backlog/**` sits on both that denylist and the records list, so a task file
mixed with any other path takes the full tier. Classification is computed from
the changed paths by `scripts/classify-tier.mjs`, never asserted by the author
of the change, and every merge to `main` runs the full suite.

### Before the push: `npm run ci:local`

The merge queue is serial, so every red run there costs a slot and another
wait. `npm run ci:local` asks the same classifier the workflow asks and runs
the jobs `.github/workflows/ci.yml` declares for that tier: the docs guard for
light, the record-reading tests for records, the three shards plus lint for
full, and the protected-path grant cross-check on every tier when a merge base
is computable. `--base <ref>` picks the base, `--working-tree` and explicit
paths are the other path sources, `--dry-run` prints the plan, `--json` prints
it as data, and `--parallel` runs the tier's jobs concurrently. What it cannot
reproduce it says: the Node 20 legs need Node 20, and CI's runner is
`ubuntu-latest`. A green run locally is a prediction; the workflow is the
verdict.

`npm run check:changed` answers a different question: it classifies the
working tree and runs the tier in its own shape, which for full is `npm test`,
`npm run lint` and `npm run typecheck`. Use it while working, and `ci:local`
before pushing. `scripts/run-tests.mjs --shard <k>/<n>` takes shard `k` of the
sorted file list, so the shards of a matrix partition the suite.

## Exit codes

An agent branches on the exit code before it reads stdout, so these numbers
are frozen. Adding one is a spec change; changing a meaning is breaking.

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | integrity failure (corrupt log) |
| 2 | usage error |
| 3 | torn tail |
| 4 | I/O error |
| 5 | no valid execution token (approval run only) |
| 6 | timeout (approval wait only) |

Code 1 and code 4 are kept apart deliberately: "I could not read the file" and
"the file has been tampered with" are different facts, and conflating them
either cries wolf over a permission bit or lets tampering read as a filesystem
hiccup. Code 3, a torn tail, is the signature of a crashed write, and nothing
is repaired automatically: truncating a torn line is a human decision. A gate
refusal is exit 1 and never 2, since the command was well-formed and the answer
is no; branch on `error.code` under `--json`.

## Where to look next

[SPEC.md](SPEC.md) is the source of truth for every design decision, and this
README defers to it wherever the two could be read differently.
[CLAUDE.md](CLAUDE.md) describes how this repository builds itself behind its
own gate; the 0.1.0 release was published, tagged and pushed through three
grants from a phone.

Every command carries its own instructions. `approval --help` lists them
grouped by purpose, `approval <command> --help` gives one command's flags,
refusal codes and JSON shape, and `--help --long` appends that verb's
reasoning from [docs/cli-reference.md](docs/cli-reference.md). `approval
instructions` is the agent-facing guide, and `--schemas` prints the verb
registry as JSON.

Every external adapter, harness, updater or gateway this project has weighed
has an entry in
[docs/integrations-considered.md](docs/integrations-considered.md).
[examples/grok-bot-connector/runbook.md](examples/grok-bot-connector/runbook.md)
puts a Grok Bot agent on the far end of `approval mcp serve --http --guest`
and rehearses both halves of the story: the agent asking for a branch push and
an email and a human deciding on a phone, then the agent skipping the gate and
finding the credential inert.

Designs proposed and not yet built live under `docs/proposals/`.
[docs/proposals/solo-dev-quickstart.md](docs/proposals/solo-dev-quickstart.md)
and [docs/proposals/no-daemon-mode.md](docs/proposals/no-daemon-mode.md) are
the next step for the path at the top of this page: a three-question
`approval quickstart`, one `approval guard -- <command>` verb that replaces
the register, request, wait, run quartet, and a runtime that lives inside the
waiting command instead of a daemon.
[docs/proposals/hardened-authorization.md](docs/proposals/hardened-authorization.md)
works through what a grant in this log can and cannot prove to a service that
does not trust the operator, and what a stronger identity tier would have to
be.

## License and governance

Code: Apache 2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE). Specification
and schemas: CC0 1.0, so any language can implement the format without asking.
Who holds the specification and the name, the relationship to Bountify.ai's
hosted offering, and the plan for neutral governance:
[GOVERNANCE.md](GOVERNANCE.md). How to contribute, including the DCO sign-off:
[CONTRIBUTING.md](CONTRIBUTING.md).
