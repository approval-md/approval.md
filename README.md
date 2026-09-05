# approval.md

[![ci](https://github.com/approval-md/approval.md/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/approval-md/approval.md/actions/workflows/ci.yml)

**Human approval for agent actions.**

Your agent is about to send the email, spend the money, delete the folder, or
publish the post. A bad diff is revertible, so coding agents have a safety net.
Once an agent leaves the repository that net disappears: a sent message has no
revert, and the action carries your name.

The permissions section in an AGENTS.md file is prose: two lists, one headed
"allowed without prompting" and one headed "require approval first", written for
an agent trusted to obey them. Nothing checks. approval.md is the layer that
checks:

- **A policy file you wrote.** `APPROVAL.md` is human-authored markdown at the
  root of your project, declaring which classes of side effect an agent may take
  on its own, which need you, and under what budgets.
- **The approve button on your phone.** A request arrives over Telegram (the
  reference channel) carrying what the runtime computed, what the agent claimed,
  and the exact bytes about to leave. You tap Approve or Reject.
- **A single-use execution token**, minted at one site in the codebase, only as a
  human decision is recorded, spent once, stored nowhere. Adapters holding real
  credentials answer to nothing else.
- **A log that cannot be quietly rewritten.** Every proposal, decision, and
  execution is an append-only, hash-chained JSONL record, and `approval log
  verify` answers for the chain.

Not everything is worth a tap: a class declared `supervised` runs immediately,
and a policy-declared fraction of those runs is sampled for your retrospective
review, using a secret the agent cannot read.

Spec site: https://approval.md · Specification: [SPEC.md](SPEC.md)

## How the gate holds

- **Credentials live in an encrypted vault**, never in the policy file and never
  in the agent's environment. `APPROVAL.md` carries the *name* of an environment
  variable, and there is no `approval vault get`.
- **Adapters answer only to tokens.** The email adapter opens the vault inside a
  verified token window, sends, closes it. An agent without a token reaches no
  credential.
- **Tokens are minted at one site**, in the path that records a human decision,
  and the log holds only their SHA-256. A second spend is refused
  `token-consumed`.
- **The log makes tampering evident.** Each record chains to the previous one,
  and projections rebuild from it and never write back.
- **The harness hook covers the direct-shell path.** `approval hook claude-code`
  classifies the commands a coding agent runs on its own (`git push`, `npm
  install`, `curl`) and answers allow or deny, fail-closed.

The honest posture, from [SPEC.md](SPEC.md) section 11: this is an oversight
layer for broadly cooperative agents, with hard enforcement at the adapter
boundaries that hold the credentials. Identity in v0.1 is config-declared, so
the trust boundary is the machine rather than cryptography.
["Can't the agent just go around it?"](#cant-the-agent-just-go-around-it) works
through each evasion and says where the boundary actually is.

The design mantra is **files are the interface, the log is the truth, the
database is a cache**. Routing, gating, budget math, and chain verification are
deterministic code. Models propose, and the runtime decides.

## Install

```sh
npm install -g approval-md
```

(Publishing is imminent. Until it lands, `git clone`, `npm ci`, `npm run build`,
`npm link` in the checkout gives you the same `approval` binary.)

Six commands take an empty directory to a machine that will tell you what it is
missing. `init` authorizes nothing, `policy attest` is what makes a policy
operative, and `doctor` reports and repairs nothing.

```sh
mkdir -p /tmp/approval-demo && cd /tmp/approval-demo
approval init                    # APPROVAL.md, .approval/log/, QUEUE.md, .gitignore
approval setup identity          # writes where APPROVAL_HUMAN comes from
eval "$(approval env)"           # put the resolved variables in this shell
approval policy attest           # a human signs for these exact policy bytes
approval doctor                  # can this machine run the system at all?
```

```
attested /tmp/approval-demo/APPROVAL.md at seq 1: sha256 cff55216c7be9bfbf35a7d980b6a0c75d250ebc039d7584cb9b3aa3bf25b2f91
```

`doctor` prints one line per check and a tally. Three of the eleven lines from a
fresh directory, plus that tally:

```
✓ identity            APPROVAL_HUMAN=human:alice (config-declared: the trust boundary is this machine, not cryptography)
✓ log                 /tmp/approval-demo/.approval/log/events.jsonl verifies: 1 record(s), head seq 1 0f3c4a19187a…
✗ audit-sampling      disabled (secret-env-unnamed): APPROVAL.md sets audit.supervised_sample_rate to 0.1 but names no audit.sampling_secret_env. …
    fix: approval policy attest --as human:<id> — after setting audit.supervised_sample_rate and audit.sampling_secret_env in the policy; then export the named variable where the daemon runs
6 ok · 4 not applicable · 1 failed
```

The checks run in the order their failures cascade, from build freshness through
identity, attestation, the log chain, the channels, the payload store, audit
sampling, envelope integrity, the vault, and the environment source map behind
`approval env`. Each carries a `fix:` line you run yourself, and that one failure
is real and intended: the scaffolded policy samples supervised actions for audit,
sampling needs an operator-held secret the policy only names, and a control that
looks like it is running while the party under oversight can steer it is worse
than one that is visibly off. What `init` scaffolds is the canonical example
policy of SPEC.md section 5.1, which names an approver you are probably not. Read
every class before you sign for it, then attest again.

## Gate your coding agent

`approval run` gates the commands an agent hands to the runtime. It cannot gate
the ones the harness runs directly, and those are most of them. Two surfaces
close that gap, a PreToolUse hook for Claude Code and an MCP server for any
harness that speaks MCP, both resolving against the same policy and appending to
the same log as the CLI.

**1. See how a command classifies.** This touches nothing, and it is the fastest
way to understand a verdict.

```
$ approval hook classify -- npm install left-pad
class     rule                 command
deps.add  npm-install-package  npm install left-pad

classes: deps.add
```

Every segment of a command line is classified and the command takes the union, so
`git status && curl -d … ` is gated as `network.call`.

**2. Install the hook.** It lives in `.claude/settings.json`, and a human commits
that file: an agent that could write its own hook entry could write itself out
of it.

```json
{ "hooks": { "PreToolUse": [ {
  "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit",
  "hooks": [ { "type": "command", "timeout": 600,
    "command": "approval hook claude-code --dir <primary checkout> --as agent:claude-code --timeout 9m" } ]
} ] } }
```

`--dir` resolves the policy and the log together, so a session inside a linked
worktree still writes to the one log. Keep `--timeout` (how long the hook waits
for a human) comfortably below `timeout` (Claude Code's cap on the process). The
harness now asks before it acts.

**3. Watch a verdict.** An `autonomous` class allows and logs nothing, a
`supervised` class allows and records `task.registered`, a `manual` class waits
for your decision, and anything the classifier cannot read denies. There is no
"ask" answer by design: a decision taken outside the log is a decision nothing
can audit. The deny reason is `<code>: <detail>`, the codes frozen
(`hook-unclassified`, `hook-opaque`, `hook-rejected`, `hook-timeout`, and kin).

**4. Know the three sharp edges.** The hook never creates a log: pointed at a
path with no log it denies `hook-log-unreachable` rather than forking a second
chain, because hash chains do not survive a merge. A wait that runs out withdraws
its request, so nobody is pinged about a question whose asker has left. And a
hook grant mints no token: the harness runs the command, `approval token` reports
`none minted: harness-executed`, and `approval run` refuses with the same code.
Full account: [docs/claude-code-hook.md](docs/claude-code-hook.md).

**5. Or connect the MCP server instead.** `approval mcp serve` is a foreground
stdio server publishing the agent's verbs as tools, built from the same registry
`approval instructions --schemas` prints.

```sh
claude mcp add approval -- \
  node /path/to/approval-md/dist/src/cli/main.js mcp serve \
    --as agent:claude-code \
    --dir /path/to/project
```

Ask the client for its tool list. `register`, `request`, `wait`, `run`, `queue`,
`status`, `log_verify` and the rest of the agent's surface are there; `grant`,
`reject`, `revoke`, `policy attest` and `vault set` are not, and their absence is
the design. SPEC.md section 11 makes the agent the untrusted policy and the human
the trusted overseer, an MCP client is the agent's harness, and a `grant` tool on
it would hand the untrusted policy the overseer's pen. **Grant never travels over
MCP**, and neither does the token it mints. The identity is fixed at startup and
`--as` is deleted from every published input schema, so a tool call cannot name
an actor. Provoke `unknown tool "grant"` once, deliberately, so you have seen it.
Walkthrough: [examples/mcp-demo.md](examples/mcp-demo.md).

A harness that can simply run commands needs neither surface: `request`, `wait`,
`run` is how sessions in this repository take manual-class actions
([docs/dogfood-cutover.md](docs/dogfood-cutover.md)).

## Put approvals on your phone

**1. Create a bot and let setup do the rest.** Message **@BotFather** with
`/newbot`, then:

```sh
approval setup identity          # APPROVAL_HUMAN, validated
approval setup channel telegram  # token into the keystore, getMe, chat discovery
eval "$(approval env)"           # put them in this shell
```

`setup` writes `.approval/env`, the environment source map: the secret goes into
the OS keystore (macOS Keychain, or `secret-tool` on Linux) and the file records
only where it lives. It is interactive by refusal (a pipe or `--json` exits 2 and
prints the non-interactive commands), because a setup a CI job could drive would
be a way for a CI job to declare a human identity. `approval env` is the only
command that reads that file, and evaluating it is a step a human takes. Full
walkthrough: [examples/telegram-demo.md](examples/telegram-demo.md).

**2. Bind a request to exact bytes.** The payload lives in a file, the envelope
declares its `payload_hash`, and `--payload` supplies the bytes at request time:

```sh
approval payload hash payload.json    # the binding the envelope declares
approval register task-demo.md --as agent:drafter
approval request task-demo --action task-demo:chaser --payload payload.json --as agent:drafter
```

```
registered task-demo at seq 2: 1 action(s)
requested task-demo task-demo:chaser at seq 3 (manual)
```

Material that hashes to something else is refused `payload-mismatch`, and nothing
is stored and nothing is appended. Class, cost, and reversibility come from the
registered envelope rather than from flags, so an agent cannot rename its own
class between registering and asking. An approval is about specific bytes, never
about a description of them.

**3. Start the runtime and read the message.** `approval up` prints
`notified task-demo:chaser (message 501)` and your phone has it. That one
foreground process is the whole gate: the daemon loop that records envelope
drift, expires what lapsed and regenerates the queue, plus every channel the
policy configures. A channel whose credential variable is unset is not started,
says so in the words `approval doctor` uses, and the daemon runs anyway; a
channel that falls over is restarted with a doubling backoff while the loop keeps
ticking. `approval daemon run` and `approval channel telegram listen` still run
the halves separately and behave identically, and `approval setup service` writes
the launchd or systemd user unit that starts the runtime at login (printing the
whole unit for you to read first, naming variables and never copying a value).
The message shows the action key, a **COMPUTED** block the runtime derived (class,
task, state, binding, budget verdicts, chain head), a **CLAIMED** block naming the
agent and marked unverified, the **FULL PAYLOAD**, and two buttons. It also says
how long an answer still has: `waiting: requested 4 min ago · expires 13:07 UTC
(clock)`, or, for a request some process is blocked on, `requester waits until
13:07 UTC`, the deadline that actually applies to you.

A payload the runtime recognises by shape is laid out so a human can read it: an
email-shaped payload (recipients, subject, body) is rendered field by field with
real line breaks, and the canonical JSON and its bound hash sit underneath
unchanged. Detection is structural and never reads a self-declared type, because
a field the requesting agent authored must not choose its own presentation.
Agent-authored text is HTML-escaped, so markup stays inert.

**4. Tap Approve.** The prompt rewrites itself in place. The buttons go away and
the text becomes the outcome:

```
✓ APPROVED
task-demo:chaser

by human:alice at 10:20 UTC (seq 4)
```

One edit call carries the annotation and the disarming together, so there is no
window in which the message reads "approved" and still offers a tap. Rejections,
revocations, expiries and withdrawals settle the same way with their own
headline, a decision taken at another surface annotates the prompt on the next
poll cycle, and a tap on a stale button is answered with a toast and records
nothing.

**5. Take the token from the terminal, not the chat.** The grant mints a
single-use execution token, printed once, in a panel, at whichever surface
recorded the decision:

```
granted task-demo:chaser at seq 4 by human:alice
─────────────────────────────────────────────────────────────
  execution token   task-demo:chaser
  516670320878e97dede99cf84bc48025fc80b7cf14bd9e9782bb1cfd0d92a787
  single-use · stored nowhere · copy it now
─────────────────────────────────────────────────────────────
```

For a tap on your phone the same panel appears on the terminal running the
runtime, and its last line reads `not sent to Telegram`. Delivery differs per channel on
purpose: a chat transcript lives on servers you do not control and is readable by
anyone later added to that chat, so a credential does not go there, while the
local **web** channel shows the raw token once in the response page for the grant
that minted it, served over loopback, generated per request, persisted nowhere,
and gone on reload: there the browser is already the surface the human is looking
at. In both cases the log holds only the token's SHA-256, it never appears in a
URL, and nothing can recover it. Lose it, revoke the grant, and request again.

**6. Spend it.** `approval run <action> --token "$TOKEN" -- <command>` appends
`execution.started` before spawning the child and
`execution.completed` after, and exits with the child's own exit code, so it
composes with `make`, CI, and `&&` as an unwrapped command would. Run it before
the approval and it refuses `token-required` at exit 5, writing nothing. Run it
twice and it refuses:

```
✗ token-consumed  action task-demo:chaser already executed: execution.started at seq 5 spent this token. A token is single-use and the log is the proof.
```

A request is not owed an answer forever, either. `approval withdraw` lets the
party that opened one take it back while it is pending, and `approval wait
--withdraw-on-timeout` does it for you when your own wait elapsed.

**7. Read the whole story.** Two actors, one clean chain:

```
1	2026-08-19T19:03:58.381Z	policy.updated	human:alice	-
2	2026-08-19T19:03:58.585Z	task.registered	agent:drafter	task-demo
3	2026-08-19T19:03:58.767Z	approval.requested	agent:drafter	task-demo
4	2026-08-19T19:04:31.192Z	approval.granted	human:alice	task-demo
5	2026-08-19T19:04:41.371Z	execution.started	agent:drafter	task-demo
6	2026-08-19T19:04:41.499Z	execution.completed	agent:drafter	task-demo
```

That is `approval log tail` piped, fields tab-separated for `cut` and its kin; on
a terminal it aligns and colours its columns. `approval log verify` answers for
the chain: `clean: 6 record(s), head seq 6 843705c6bbea…`.

## Define what needs approval

A policy is a fenced `yaml approval-policy` block inside a markdown file named
`APPROVAL.md`. The prose around the block is for you; the runtime parses the
block and ignores the rest. That is the point of the format: the thing you sign
for is text you read.

**1. Name the classes.** A class is a dotted path from the side-effect taxonomy
of SPEC.md section 7 (`communicate.email.external`, `financial.spend`,
`public.post`, `data.delete`, `read.*`). Matching is most-specific-first, `*` is
a single-segment wildcard, a trailing `.*` matches any depth, and at equal
specificity the strictest rule wins.

**2. Pick an autonomy for each.** Three values, strictest first: `manual` (a
human decides before execution), `supervised` (executes immediately, a sampled
fraction escalated for retrospective review), `autonomous` (executes freely). An
email is `reversible: false`, which engages section 7's irreversibility floor:
the class resolves to `manual` even where the policy says `supervised`, because
retrospective sampling cannot un-send a message.

**3. Set the budgets.** Class `limits` and the `budgets` scopes are conjunctive,
so an action must pass both, and consumption is computed from the log over
rolling windows rather than from a mutable counter. An action whose class matches
no rule takes `defaults.autonomy`, and a policy that does not parse resolves every
class to `manual`: unattested and unparseable are both strict, never permissive.

**4. Widen the protected paths.** `APPROVAL.md`, the agent instruction files,
`.approval/`, the harness settings and the release configuration are protected by
the runtime whatever a policy says. `protected_paths` adds repo-relative literals
(an exact file, `SPEC.md`, or a directory prefix, `design/`), so a project can put
its own governing documents behind the gate that already stands in front of its
policy. The key can only widen, and globs are a schema violation.

**5. Attest it.** `approval policy attest` is what makes a policy operative. An
attestation records that a human saw these exact bytes, and it records their
SHA-256 rather than their text. Edit `APPROVAL.md` afterwards and every gated
operation refuses `hash-mismatch` until you attest again. Attestation is
human-only, and identity in v0.1 is config-declared, so what one proves is that
*someone with local control* signed off.

**6. Amend it with the verb, not by hand.** Changing a policy is two facts that
have to land together, the new bytes and a human's attestation of them, and
`approval policy amend` owns the whole ceremony (`--dry-run` reports only,
`--require-load` refuses to attest a policy that does not load, `--commit` lands
the two files as one commit). It prints a **semantic diff** (class resolutions,
approver changes, defaults, limits) rather than a text diff, so you see what
changed in meaning; the baseline comes from `HEAD:<policy>` and is used only when
its SHA-256 equals the attested hash, and otherwise the verb drops loudly to
hash-only mode. Then it prints a **load advisory**: whether the edited policy
actually parses. Attesting one that does not is still allowed, since attestation
records bytes and not correctness, but such a policy fails closed to all-manual.

### Why this verb exists: seq 2

Read this repository's own log. At **seq 2** a policy amendment was attested at
11:56:07. It was **superseded** seven minutes later, at seq 3 at 12:03:35,
because the edit broke a pinned assertion and nobody found out until the test
suite ran against it. The operator attested bytes whose consequences had never
been shown to them.

This account originally said eleven minutes. The log says seven, and the log
won: the figure was corrected against the chain after being misremembered, which
is the whole thesis of keeping one.

That is the failure the load advisory is for. Had `approval policy amend` existed
that morning, the load failure would have been on screen while the human was
deciding, and `--require-load` would have refused to attest at all. The incident
is cited by number on purpose: it is in the log, it is checkable, and the log is
the truth.

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

**1. The two stores divide cleanly.** `.approval/env` says where the values that
unlock the machine come from, and `approval setup vault` writes the passphrase
line under whatever name `vault.passphrase_env` declares. The SMTP password is an
adapter credential, so it goes in the vault instead, where a gated adapter spends
it inside a verified token window.

**2. Setup fills the vault and proves it.** `approval setup adapter email` reads
the credential manifest the adapter declares, then probes the server without
sending anything; a partial re-run probes the **merged** configuration.

**3. A credential's only journey is into an adapter.** `approval vault set`
stores one credential in `.approval/vault.enc`, encrypted under a passphrase the
policy names and never carries. The value comes from stdin or `--value-env
<VAR>`; there is no `--value` flag, because a secret on a command line is a
secret in the shell history and in `ps` output. There is no `approval vault get`
and will not be; `approval vault list` shows the names.

**4. The send happens inside the token window.** `approval adapter email` verifies
the token, re-hashes `message.json` against the binding the grant recorded,
appends `execution.started`, opens the vault, reads the five SMTP settings inside
the window, sends over STARTTLS, closes the window, and appends
`execution.completed`. The credential exists for one send and appears in no
event, no output, no error message. Nothing about the vault is ever a log entry:
a list of the credentials an operator holds is a map of the machine's reach.

**5. Check two properties in your own mailbox.** The bytes that left are the
bytes you approved, since the hash the token spend verified is the hash of the
payload your phone displayed. And the `Message-ID` is derived from the action
key, the payload hash and the sender, so the header in a mailbox and the binding
in the chain identify each other months later.

### The same grant over AgentMail

`communicate.email.external` has a second adapter. Where the email adapter opens
an SMTP session, `approval adapter agentmail` calls the AgentMail API, and the
mail an agent has already composed as a Draft leaves only when a grant says so.
The walkthrough is [examples/agentmail-demo.md](examples/agentmail-demo.md).

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
in the vault, where the adapter reads it inside the verified token window. The
agent then composes all day and cannot send at all: an ungated send attempt is
refused by AgentMail itself, `agentmail-unauthorized`, before this runtime is
involved. Without that split, an AgentMail key sitting in the agent's
environment is a full bypass of the gate, which is why `AGENTMAIL_` is withheld
from every child `approval run` spawns.

**A draft is mutable, so the grant binds its bytes.** `approval payload
agentmail-draft` snapshots the draft's recipients, subject and text at request
time, and that snapshot is what the payload hash binds and what your phone
displays. Before it sends, the adapter re-fetches the draft and compares; a
draft edited after the grant refuses `agentmail-draft-drifted`, sends nothing,
and names which fields differ without quoting text nobody approved. Approving a
draft id alone would be approving whatever the agent wrote into it last.

## The APPROVAL.md dictionary

Every key that can appear in the policy block. The schema is closed at every
level: an unrecognised key fails validation, which fails the policy closed to
all-manual, because a key the runtime did not understand is a rule its author
believed was in force. Full semantics: SPEC.md section 5.

| key | what it says |
| --- | --- |
| `version` | Policy format version, quoted (`"0.1"`). The only required key (§5.1). |
| `defaults.autonomy` | Autonomy for an action matching no class rule. `manual` is the fail-closed choice (§5.2). |
| `defaults.channel` | Channel name requests surface on by default; expected to name a key of `channels` (§5.1). |
| `defaults.approval_ttl` | How long a pending request stays actionable. Duration string, `24h` (§5.1). |
| `defaults.on_expiry` | What happens when the TTL lapses. `reject` is the only value (§5.1). |
| `payload_retention` | How long payload bytes are kept after their action is terminal. Absent means nothing is ever pruned (§5.2). |
| `protected_paths` | Repo-relative files and directory prefixes whose edit is classified `policy.edit`. Additive only, no globs (§5.2). |
| `approvers.<name>.channels` | The channels one approver can decide on. At least one: an approver reachable nowhere can never grant (§5.1). |
| `classes.<pattern>.autonomy` | Required on every class rule: `manual`, `supervised`, or `autonomous` (§5.2). |
| `classes.<pattern>.approvers` | Approver ids permitted to decide this class (§5.1). |
| `classes.<pattern>.limits` | Per-class ceilings, every value a positive number: `per_action_usd`, `daily_usd`, and the request-volume counts `max_pending` and `requests_per_hour` (§5.1, §5.2). |
| `budgets.global.daily_usd` | Repo-wide spend ceiling per rolling day, computed from the log (§5.1). |
| `budgets.global.daily_actions` | Repo-wide count of side-effecting actions per rolling day (§5.1). |
| `budgets.global.max_pending` | Simultaneously pending requests across the scope; excess is refused `queue-full` (§5.2). |
| `budgets.<scope>` | Any other named scope, same three keys. Budgets are conjunctive with class limits (§5.2). |
| `audit.supervised_sample_rate` | Fraction of `supervised` actions escalated for retrospective review, in [0, 1] (§5.2). |
| `audit.sampling_secret_env` | Name of the variable holding the operator's HMAC sampling secret. Unnamed means sampling is off and says so (§5.2, §11). |
| `audit.skew_tolerance` | How far a gate-typed event's timestamp may step back before verification reports an anomaly. Report-only; default 2 seconds (§8). |
| `daemon.read_proof` | Which prefix proof a long-lived reader runs before reusing a cached prefix: `full` (the default, re-hash the whole prefix on every read) or `incremental` (hash only the appended bytes, re-proving in full on a cadence). One-shot processes, the Claude Code hook and `approval log verify` prove in full regardless (§5.2, APRV-217). |
| `daemon.full_reproof_every` | Reads one full re-proof may cover under `incremental`, the anchoring read included. Default 50 (§5.2). |
| `daemon.full_reproof_after` | Wall clock one full re-proof may cover under `incremental`. Duration string, default `60s` (§5.2). |
| `vault.passphrase_env` | Name of the variable holding the vault passphrase. Absent means `APPROVAL_VAULT_PASSPHRASE` (§5.2, §10.4). |
| `channels.telegram.token_env` | Name of the variable holding the bot token. Default `APPROVAL_TG_TOKEN` (§5.1). |
| `channels.telegram.chat_id_env` | Name of the variable holding the approver chat id. Default `APPROVAL_TG_CHAT` (§5.1). |
| `channels.telegram.delivery` | `paced` (the default) shows one summary line and the oldest pending request, then the next one after a decision, `/skip` or `/next`; `burst` sends every pending request the listener has not sent yet (§10.3). |
| `channels.web.port` | TCP port for the local approval UI, bound on loopback only (§5.1). |
| `channels.<other>` | An unknown channel name is accepted as an object, so a third-party transport does not fail the whole policy closed (§10.3). |

Every key ending in `_env` carries a variable's *name* and never its value:
agents may read `APPROVAL.md`, so a secret it carried would be a secret they
hold. Where those values live is recorded in `.approval/env`, which a single verb
reads, `approval env`, whose output is an export block a human evaluates.

## How this compares

Three kinds of thing already exist in this space, and each solves a different
part of the problem.

**Harness-native permission prompts** (Claude Code permission rules and hooks,
Cursor auto-run, Codex CLI approval modes) enforce inside the one harness they
ship with. That enforcement is real: a Claude Code PreToolUse deny holds even
under its bypass mode, and Codex backs its gate with an OS-level sandbox, a
defense layer this project does not attempt. What they lack is a durable record
and portability. None writes an append-only log of what was asked, who decided,
and what ran; the decision reaches a human only as a synchronous terminal
prompt; and the mechanism does not travel to any other harness. approval.md's
own Claude Code hook is built on top of that PreToolUse mechanism and adds the
two missing pieces: the decision comes from an attested policy file rather than
the session, and it lands in a verifiable log.

**AGENTS.md permissions prose** states the policy in English and trusts the
agent to obey. Nothing parses it, nothing blocks a call against it, and no
record exists when it is violated. approval.md is the enforcement layer that
convention is missing, and treats it as an input: the permissions section of
this repository's own CLAUDE.md is the first import fixture.

**Framework interrupts** (LangGraph `interrupt()`, CrewAI human input, AutoGen
`UserProxyAgent`, the OpenAI Agents SDK's `needsApproval`, Temporal signal
approvals) give a developer a pause-and-resume primitive and leave policy,
audit format, the human channel, and the credential boundary entirely to them.
They also require adopting the framework. Temporal deserves its credit: its
event history is a genuine append-only execution record with crash recovery
this project does not claim, though it lives in Temporal's storage as a replay
log rather than as policy-attested files in your repo.

**Hosted approval platforms** (HumanLayer, gotoHuman, Permit.io's access
requests) are the closest relatives: multi-channel human routing, review UIs,
and in Permit.io's case a real authorization engine richer than autonomy
classes. Their model is a third-party service in the decision path, with the
audit trail in the platform's backend, and the agent's own process still
choosing to honor the returned verdict. They bring things a file convention
cannot: hosted infrastructure, escalation and team routing, compliance
certifications.

The differentiation is the combination rather than any single feature: policy
as a hash-attested markdown file in your repo; an append-only, hash-chained log
you can verify locally with one command; and an execution boundary where the
credential is inert until a single-use token is minted at the moment a human
decides. Every framework primitive and every hosted API above ultimately relies
on the agent's process honoring a returned decision. Here the thing the agent
needs (the credential) answers only to the thing it cannot make (the token).
The tradeoffs are equally plain: you run the daemon and listener yourself,
there is no OS-level sandbox, no compliance certification, and the reference
phone channel is one app, Telegram.

## Can't the agent just go around it?

**Edit the policy?** An attestation records the SHA-256 of the policy's bytes,
and every gated operation refuses `hash-mismatch` when the live file disagrees
with it. An unattested policy refuses too, and attesting is human-only. Under the
harness hook the edit itself is classified `policy.edit` before it happens,
because `APPROVAL.md` is in the built-in protected set no policy can narrow.

**Fabricate or rewrite the log?** Each record chains to the previous one's hash,
so an edited or reordered record breaks the chain and `approval log verify` says
so. Appends go through compare-and-append against the head, and projections
(`QUEUE.md`, the SQLite index) rebuild from the log and never write back to it.
Tampering is made evident, which is what an audit trail is for.

**Mint its own token, or reuse one?** Tokens are minted at one site, inside the
path that records a human decision, and the log stores only the hash. No verb and
no tool returns a token for a grant it did not just record, and a hook grant
mints none at all. A token is single-use: the second spend is refused
`token-consumed`, naming the seq of the `execution.started` that spent it, and no
second record is appended.

**Call the adapter or the credential directly?** Credentials live in
`.approval/vault.enc` under a passphrase the policy names and never carries, and
an adapter opens the vault only inside a verified token window. There is no
`approval vault get`. An agent that never held a token never reaches a
credential, which is where the hard enforcement in this system lives.

**Run the side effect from its own shell?** That is what the PreToolUse hook is
for: it classifies the command text, resolves the class, and answers allow or
deny before the harness runs anything, fail-closed and with no "ask". The
classifier reads shell text without being a shell, so parameter expansion,
aliases and wrapper binaries are gaps, and each resolves toward denial or the
stricter class. `bash -c`, `eval`, `sudo`, `xargs` and `node -e` deny as
`hook-opaque`.

**POST straight at the web queue?** It can. `approval channel web` binds
`127.0.0.1` with the host hard-coded and no `--host` flag, because with no
authentication the loopback interface is the entire access control, and every
decision the page collects is recorded against the human the runtime was started
with: it proves "someone with access to this machine approved" and never "that
specific person approved". The page says so on itself. There is no CSRF token in
v0.1, deliberately: a CSRF token defends a session, and with no session and
nothing to authenticate against, anything that can open a socket to
`127.0.0.1:4680` can POST with or without one. The same-origin check that rejects
a POST naming a non-loopback `Origin` allows one carrying neither header, since
`curl` and older browsers send neither: treat it as a speed bump rather than a
control. A session, or a wider bind address, would need a real anti-CSRF token.

**Lie in its self-report?** Self-reported fields never reduce scrutiny (SPEC.md
section 11.1, invariant 4). They may raise it, inform display, or feed
retrospective analysis, and they can never downgrade a resolved autonomy level or
shortcut a refusal path. The approval prompt keeps them visually apart: a
COMPUTED block the runtime derived, and a CLAIMED block marked unverified.

**So what is left?** A fully adversarial agent on a machine it controls. Identity
in v0.1 is config-declared, so anyone who can set that variable and write to the
log is inside the trust boundary, and cryptographic identity is future work
rather than a v0.1 claim. What holds regardless of what the harness believes it
is running: the vault, the adapter boundary, and the single-use token. Keep
`manual` floors on irreversible classes, which SPEC.md section 7 does for you.

## Running the checks

```
npm run check:changed        # classify the working tree, then run that tier
npm run check:tier -- <path> # classify the given paths and print the tier
```

Checks come in three tiers.

| Tier | Chosen when every changed path is | What runs |
| --- | --- | --- |
| light | `README.md`, `docs/**/*.md`, `examples/**/*.md` | the documentation guard (`tests/docs-guard.test.ts`) |
| records | `backlog/**`, `MILESTONES.md` | the tests that read records (`milestones-guard`, `backlog-fixtures`, `docs-guard`), on Node 20 |
| full | anything else, or a mix of the above | the whole suite in three shards plus `npm run lint`, on Node 22; the Node 20 floor runs the same three shards on the merge queue and on pushes to `main` |

A denylist forces the full tier regardless of file extension: `APPROVAL.md`,
`CLAUDE.md`, `.claude/**`, `SPEC.md`, `schema/**`, `**/fixtures/**`,
`backlog/**`, `scripts/**`, `.github/**`, the packaging files, and `cli.js`.

`backlog/**` sits on both that denylist and the records list, which is what
makes the records tier all-or-nothing: a task file mixed with any other path
takes the full tier. Task files are markdown by extension and behavior by
effect, since their acceptance criteria are instructions to future agents. That
earns them every check which can observe a task file, and the records tier is
exactly those; it does not earn them a matrix of ~1800 tests on two Node
majors, none of which reads one. `MILESTONES.md` rides along because the
milestones guard checks the two against each other.

Classification is computed from the changed paths by
`scripts/classify-tier.mjs`, never asserted by the author of the change. Every
merge to `main` runs the full suite unconditionally, and anything ambiguous, an
empty path set included, resolves to full.

A full-tier CI job compiles once. It builds, then runs `node
scripts/run-tests.mjs` over what it built, because `npm test` and `npm run
typecheck` would each recompile the same tree and neither pass can fail where
the build passed. `npm test` keeps its build-then-run shape for anyone running
it by hand. `scripts/run-tests.mjs --shard <k>/<n>` takes shard `k` of the
sorted file list, where the file at position `i` belongs to shard `(i mod n) +
1`, so the shards of a matrix are a partition of the suite: every file in
exactly one shard, and the matrix covers all of them. An out-of-range index, an
empty shard, and `--shard` combined with `--only` are refused rather than run.
The Node 20 floor moved to the merge queue and to pushes to `main` because the
queue candidate is what stands between a change and the branch, and a pull
request now gets its verdict from the shards alone. The floor leg is sharded
three ways too, so it proves the same whole suite in roughly a third of the
wall clock it took as one run.

## Exit codes

An agent branches on the exit code before it ever reads stdout, so these numbers
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

Code 1 and code 4 are kept apart deliberately. "I could not read the file" and
"the file has been tampered with" are different facts about the world, and
conflating them either cries wolf over a permission bit or lets real tampering
read as a filesystem hiccup. Code 3, a torn tail, is the signature of a crashed
write rather than of tampering, and nothing is ever repaired automatically:
truncating a torn line is a human decision. A gate refusal is exit 1 and never 2,
since the command was well-formed and the answer is no, so branch on
`error.code` under `--json` rather than retrying with different flags.

## Where to look next

[SPEC.md](SPEC.md) is the source of truth for every design decision, and this
README defers to it wherever the two could be read differently.
[CLAUDE.md](CLAUDE.md) describes how this repository builds itself, including
where it starts running behind its own gate.

Every command carries its own instructions, so this README shows no verb
inventory. `approval --help` lists them grouped by what they are for. `approval
<command> --help` gives one command's flags, refusal codes, and JSON shape, and
`--help --long` appends that verb's reasoning from
[docs/cli-reference.md](docs/cli-reference.md). `approval instructions` is the
agent-facing guide, and `--schemas` prints the verb registry as JSON.

Every external adapter, harness, updater or gateway this project has weighed
for integration has an entry in
[docs/integrations-considered.md](docs/integrations-considered.md): what it
exposes, how it fits, the verdict, and the next step, so the question is
answered once.

One of those entries has a runbook of its own.
[examples/grok-bot-connector/runbook.md](examples/grok-bot-connector/runbook.md)
puts a Grok Bot agent on the far end of `approval mcp serve --http --guest`,
behind a tunnel that is itself gated, and rehearses both halves of the story: the
agent asking for a branch push and an email and a human deciding them on a phone,
then the agent skipping the gate entirely. What holds when it does is the point.
Credentials answer only to single-use tokens, so the send it was never granted
stays impossible, and `approval coverage` reports every observed effect with its
evidence seq or `none`.

## License

MIT. See [LICENSE](LICENSE).
