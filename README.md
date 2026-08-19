# approval.md

[![ci](https://github.com/approval-md/approval.md/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/approval-md/approval.md/actions/workflows/ci.yml)

**Human approval for agent actions.**

Your AGENTS.md says "require approval first". approval.md enforces it, and
puts the approve button on your phone.

Spec site: https://approval.md · Specification: [SPEC.md](SPEC.md)

## What this is

Permissions sections in AGENTS.md files are prose: two lists, one headed
"allowed without prompting" and one headed "require approval first". They are
instructions an agent is trusted to obey, and nothing checks. approval.md is the
layer that checks, for the agent actions with real-world side effects: sending
messages, spending money, deleting data, posting publicly, writing to calendars.
Coding agents already have a safety net, because a bad diff is revertible. Once
an agent leaves the repository that net disappears. A sent email has no revert,
so the artifact a human reviews stops being the plan and becomes the side-effect
declaration.

Four pieces carry the whole idea. `APPROVAL.md` is a human-authored policy file
declaring which classes of side effect an agent may perform on its own, which
need a human, and under what budgets. The agentic envelope is one namespaced
YAML frontmatter key on ordinary [Backlog.md](https://github.com/MrLesk/Backlog.md)
task files, declaring a task's origin, routing, side effects, budget, and
approval state. An append-only, hash-chained JSONL event log is the
tamper-evident record of every proposal, decision, and execution. A CLI and
daemon route requests to pluggable channels (Telegram is the reference adapter)
and gate execution on grants that actually exist in the log.

The design mantra is **files are the interface, the log is the truth, the
database is a cache**. Policy and tasks are markdown you can read in any editor
and an agent can read with `cat`. Every state transition is an immutable event,
and markdown views and any index are projections rebuilt from the log that never
write back to it. Routing, gating, budget math, and chain verification are
deterministic code. Models propose, and the runtime decides.

[SPEC.md](SPEC.md) is the source of truth for every design decision here, and
this README defers to it wherever the two could be read differently. Security
posture is stated honestly in SPEC.md section 11: this is an oversight layer for
broadly cooperative agents, with hard enforcement at the adapter boundaries that
hold the credentials. [CLAUDE.md](CLAUDE.md) describes how this repository builds
itself, including the point at which it starts running behind its own gate.

## Quickstart

Six commands from an empty directory to a machine that will tell you what it is
missing. `init` scaffolds and authorizes nothing; `policy attest` is what makes
a policy operative; `doctor` reports and repairs nothing.

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

`doctor` prints one line per check, and the last line is the tally. Four of the
eleven lines from a fresh directory, plus that tally:

```
✓ identity            APPROVAL_HUMAN=human:alice (config-declared: the trust boundary is this machine, not cryptography)
✓ attestation         /tmp/approval-demo/APPROVAL.md is attested at seq 1 (sha256 cff55216c7be…)
✓ log                 /tmp/approval-demo/.approval/log/events.jsonl verifies: 1 record(s), head seq 1 0f3c4a19187a…
✗ audit-sampling      disabled (secret-env-unnamed): APPROVAL.md sets audit.supervised_sample_rate to 0.1 but names no audit.sampling_secret_env. …
    fix: approval policy attest --as human:<id> — after setting audit.supervised_sample_rate and audit.sampling_secret_env in the policy; then export the named variable where the daemon runs
6 ok · 4 not applicable · 1 failed
```

The checks run in the order their failures cascade: build freshness, identity,
attestation, log chain, Telegram reachability, the web port, the payload store,
audit sampling, envelope integrity, the vault, and the environment source map
behind `approval env`. Each failure carries a concrete `fix:` line you run
yourself. The one failure above is real and intended: the scaffolded policy
samples supervised actions for audit, and sampling needs an operator-held secret
the policy only names, so nothing is sampled until you name it. `doctor` exists
because a real ceremony lost time twice to a stale `dist/` and an unbuilt
checkout, neither of which was a runtime bug and neither of which anything was in
a position to say out loud.

What `init` scaffolds is the canonical example policy of SPEC.md section 5.1,
which names an approver you are probably not. Read every class before you sign
for it, then attest again.

Four ceremonies belong to the human. Attesting a policy, amending it, deciding a
request, and handing the resulting grant to an adapter that holds a real
credential. The four sections below are those, in order.

## Ceremony one: the first attestation

A policy is a fenced `yaml approval-policy` block inside a markdown file named
`APPROVAL.md`. The prose around the block is for you; the runtime parses the
block and ignores the rest. That is the point of the format: the thing you are
signing for is text you read.

The `policy attest` line the quickstart ran is what makes the policy operative.
An attestation records that a human saw these exact bytes, and it records their
SHA-256 rather than their text. Edit `APPROVAL.md` afterwards and every gated operation refuses with
`hash-mismatch` until you attest again. Unattested is not the same as permissive:
the runtime fails closed, and an unparseable policy resolves every class to
`manual`.

Attestation is human-only, so the runtime needs to know which human. Identity in
v0.1 is config-declared and not proved (SPEC.md section 11): the trust boundary
is the local machine, and anyone who can set that variable and write to the log
is inside it.

A policy governs the files it names. `APPROVAL.md` itself, the agent instruction
files, `.approval/`, the harness settings and the release configuration are
protected by the runtime whatever a policy says. `policy.protected_paths` widens
that set with repo-relative literals, an exact file (`SPEC.md`) or a directory
prefix (`design/`), so a project can put its own governing documents behind the
gate that already stands in front of its policy. The key can only widen, and
globs are a schema violation rather than a half-kept promise.

## Ceremony two: amending your policy

Changing a policy is two facts that have to land together: the new bytes, and a
human's attestation of them. `approval policy amend` owns the whole ceremony.

```sh
approval policy amend --dry-run          # report only, writes nothing
approval policy amend                    # diff, advise, confirm, attest
approval policy amend --require-load     # refuse to attest a policy that does not load
approval policy amend --commit           # land the two files as one commit
```

The verb prints a **semantic diff** (class resolutions, approver changes,
defaults, limits) rather than a text diff, so you see what changed in meaning.
The baseline is recovered from `HEAD:<policy>` and used only when its SHA-256
equals the attested hash, because a baseline nobody can verify is not a baseline;
when it cannot be verified the verb drops loudly to hash-only mode.

Then it prints a **load advisory**: whether the edited policy actually parses and
loads. Attesting a policy that does not load is still allowed, since attestation
records bytes and not correctness, but such a policy fails closed to all-manual
for every class. `--require-load` turns that advisory into a refusal, before the
confirmation prompt and before anything is appended.

Finally it closes the gap between the edit and its attestation. Without
`--commit` it prints the exact two-file `git add` and `git commit` that land the
policy and the log together; with `--commit` it runs them, after checking the
preconditions first so a refusal never leaves a half-finished amendment behind.

### Why this verb exists: seq 2

Read this repository's own log. At **seq 2** a policy amendment was attested at
11:56:07. It was **superseded** seven minutes later, at seq 3 at 12:03:35, because the
edit broke a pinned assertion and nobody found out until the repository's own
test suite ran against it. The operator attested bytes whose consequences had
never been shown to them.

This account originally said eleven minutes. The log says seven, and the log
won: the figure was corrected against the chain after being misremembered,
which is the whole thesis of keeping one.

That is the failure the load advisory is for. Had `amend` existed that morning,
the load failure would have been on screen while the human was deciding, and
`--require-load` would have refused to attest at all. The incident is cited by
number here on purpose: it is in the log, it is checkable, and the log is the
truth.

## Ceremony three: deciding from your phone

The Telegram channel is the reference push channel. Create a bot by messaging
**@BotFather** with `/newbot`, then let `approval setup` do the rest. The full
walkthrough, with the exact commands and the expected output at every step, is in
[examples/telegram-demo.md](examples/telegram-demo.md).

```sh
approval setup identity          # APPROVAL_HUMAN, validated
approval setup channel telegram  # token into the keystore, getMe, chat discovery
eval "$(approval env)"           # put them in this shell
```

`setup` is the writer of `.approval/env`, the environment source map: the secret
goes into the OS keystore (macOS Keychain, or `secret-tool` on Linux) and the
file records only where it lives. It is interactive by refusal (a pipe or
`--json` exits 2 and prints the non-interactive commands), because a setup a CI
job could drive would be a way for a CI job to declare a human identity.

`approval env` is the only command that reads that file, and evaluating it is a
step a human takes: nothing loads it implicitly, since human identity is one of
the values it carries. `approval env --check` prints the same table with no
values in it, one row per variable your policy names, each unresolved row
carrying its own `fix:` line. `APPROVAL.md` carries only the *names* of the bot's
two variables, so no flag puts a bot token into a shell history or a process
listing.

### An approval binds to specific bytes

The payload lives in a file, the envelope declares its `payload_hash`, and
`--payload` supplies the bytes at request time:

```sh
approval payload hash payload.json               # the binding the envelope declares
approval register task-demo.md --as agent:drafter
approval request task-demo --action task-demo:chaser --payload payload.json \
  --as agent:drafter
```

```
registered task-demo at seq 2: 1 action(s)
requested task-demo task-demo:chaser at seq 3 (manual)
```

Bytes that do not hash to the declared binding are refused, and nothing is
stored or appended:

```
✗ payload-mismatch  the payload material supplied for task-demo:chaser hashes to cb86907bf0c0ad9f9e22c5a42ec9e4d4734be5f4ea3ef5c8ade0c079a05d6a2a but the action declares 0000000000000000000000000000000000000000000000000000000000000000 (amended SPEC.md §6.2/§10). A grant approves specific bytes, so material that hashes to something else is not this request's payload: nothing was stored and nothing was appended.
```

That is the shape of every refusal: a glyph, the frozen machine-readable code,
and the reason. Argument errors carry a `fix:` line underneath. Gate refusals
carry none, because the command was well-formed and the answer is no, so there
is nothing to retype. Class, cost, and reversibility come from the registered
envelope rather than from flags, so an agent cannot rename its own class between
registering and asking.

Accepted payloads land in `.approval/payloads/`, one file per binding, named by
its own hash. Treat that directory as data, not as scratch space. `QUEUE.md`
regenerates and `index.sqlite` reindexes, both from the log; the payload store is
the one cache a rebuild cannot recreate, because the log records the hash a
request bound to and never the material itself. Delete it and those bytes are
gone, while the binding survives, which is what makes the loss visible: every
affected manual request renders `payload-unavailable` instead of showing an
approver bytes no hash ever bound.

Some material is deliberately kept out of it: `--payload-dir` (CLI and web
channels) and `--payloads` (Telegram) serve payload bytes from a location the
operator chose, and every channel re-hashes whatever those flags supply against
the recorded binding, so an override cannot put different bytes in front of an
approver.

### The decision, and the token it mints

```sh
approval channel telegram listen
```

The message shows the action key, a COMPUTED block the runtime derived, a CLAIMED
block naming the agent and marked unverified, the full payload, and two buttons.
A live prompt also says how long an answer still has: `requested 4 min ago ·
requester waits until 10:10 UTC`, which is the requester's own deadline rather
than the policy's TTL.

A payload the runtime recognises by shape is rendered so a human can read it. An
email-shaped payload (recipients, subject, body) is laid out field by field, with
real line breaks in the body, and the canonical JSON and its bound hash sit
underneath unchanged. Detection is structural and never reads a self-declared
type, because a field the requesting agent authored must not choose its own
presentation. The reading aid is above; the evidence is below. The prompt this
replaced arrived on a phone as one long line carrying literal `\n` sequences,
which was precisely the text a human was being asked to take responsibility for.

Tap Approve. The grant lands in the log and mints a single-use execution token,
printed once, in a panel, at whichever surface recorded the decision. From
`approval grant` at a terminal that is:

```
granted task-demo:chaser at seq 4 by human:alice
─────────────────────────────────────────────────────────────
  execution token   task-demo:chaser
  516670320878e97dede99cf84bc48025fc80b7cf14bd9e9782bb1cfd0d92a787
  single-use · stored nowhere · copy it now
─────────────────────────────────────────────────────────────
```

For a tap on your phone, the same panel appears on the listener's own terminal,
and its last line reads `not sent to Telegram`.

Copy it, and spend it:

```sh
approval run task-demo:chaser --token "$TOKEN" --payload-hash "$HASH" \
  --as agent:drafter -- echo sent
```

`run` appends `execution.started` before spawning the child and
`execution.completed` after, and it exits with the child's own exit code, so it
composes with `make`, CI, and `&&` exactly as an unwrapped command would. Running
it before the approval refuses `token-required` at exit 5 and writes nothing.
Running it a second time refuses, so a retried agent cannot double-send:

```
✗ token-consumed  action task-demo:chaser already executed: execution.started at seq 5 spent this token. A token is single-use and the log is the proof.
```

A request is not owed an answer forever. `approval withdraw <task> --action
<key>` lets the party that opened a request take it back while it is pending, and
`approval wait --withdraw-on-timeout` does it for you when your own wait elapsed.
Human attention is the audit budget, so a decision nobody can consume must not be
solicited. Withdrawal is requester-only and terminal, and a withdrawn action that
is still wanted is asked again as a new request.

Afterwards the log reads as the whole story, two actors and one clean chain:

```
1	2026-08-19T19:03:58.381Z	policy.updated	human:alice	-
2	2026-08-19T19:03:58.585Z	task.registered	agent:drafter	task-demo
3	2026-08-19T19:03:58.767Z	approval.requested	agent:drafter	task-demo
4	2026-08-19T19:04:31.192Z	approval.granted	human:alice	task-demo
5	2026-08-19T19:04:41.371Z	execution.started	agent:drafter	task-demo
6	2026-08-19T19:04:41.499Z	execution.completed	agent:drafter	task-demo
```

That is `approval log tail` piped, where fields are tab-separated for `cut` and
its kin. On a terminal the same command aligns its columns and colours them, as
`queue`, `status`, and `doctor` do. `approval log verify` answers for the chain
itself:

```
clean: 6 record(s), head seq 6 843705c6bbeab1d2b54b7164cc41eebb2b60794c0c2434969d18160c68efc7c9
```

Verification reports one thing it never enforces. A gate-typed event whose
timestamp disagrees implausibly with its gate-typed neighbours is an anomaly
`approval status` surfaces and the verdict ignores, because chain integrity is a
proof and clock skew is a judgment. The allowance is `audit.skew_tolerance` in
the policy, 2 seconds by default, and widening it hides evidence from a human
while permitting nothing.

## Ceremony four: sending mail from a phone approval

`echo sent` is a demo. The point of the gate is the send that cannot be undone,
and that means the runtime has to hold a credential the agent never sees. Four
commands carry the whole ceremony. The full walkthrough, against real Telegram
and a real mail provider, is in [examples/email-demo.md](examples/email-demo.md);
the scripted twin is `tests/e2e-email-demo.test.ts`.

```sh
approval setup vault           # mint the passphrase, store it, record where
approval setup adapter email   # the five SMTP settings, into the vault
eval "$(approval env)"         # the variable the policy names, in this shell
approval adapter email task-042:chaser --token "$TOKEN" \
  --payload message.json --as agent:claude-admin
```

The two stores meet here and divide cleanly. `.approval/env` says where the
values that unlock the machine come from, and `approval setup vault` writes the
passphrase line under whatever name the policy's `vault.passphrase_env` declares.
The SMTP password is an adapter credential, so it goes in the vault instead,
where a gated adapter spends it inside a verified token window.

`approval setup adapter email` fills the vault from the credential manifest the
adapter itself declares, then proves the result against the server without
sending anything. Rotating one value is the common case, so a partial re-run
offers to probe the **merged** configuration in the vault rather than refusing to
say anything: a probe reports the same way whichever set it ran over. If the
probe cannot run, the refusal names why and the values it did write stay written,
because a captive portal is not a reason to make you type five things again.

Underneath it, `approval vault set` stores one credential in
`.approval/vault.enc`, encrypted under a passphrase the policy names and never
carries. The value comes from stdin or from `--value-env <VAR>`; there is no
`--value` flag, because a secret on a command line is a secret in the shell
history and in `ps` output. There is also no `approval vault get`, and there will
not be one: `approval vault list` shows the names, and a credential's only
sanctioned journey is into an adapter.

`approval adapter email` is that journey. It verifies the token, re-hashes
`message.json` and checks it against the binding the grant recorded, appends
`execution.started`, opens the vault, reads the five SMTP settings **inside the
token window**, sends over STARTTLS, closes the window, and appends
`execution.completed`. The credential exists for the length of one send and
appears in no event, no output, and no error message. Nothing about the vault is
ever a log entry: the log records actions the gate authorized, and a list of the
credentials an operator holds is a map of the machine's reach.

Two properties are worth checking in your own mailbox. The bytes that left are
the bytes the human approved, since the hash the token spend verified is the hash
of the payload the phone displayed. And the `Message-ID` is derived from the
action key, the payload hash and the sender, so the header sitting in a mailbox
and the binding sitting in the chain identify each other months later.

An email is `reversible: false`, which engages SPEC.md section 7's
irreversibility floor: the class resolves to `manual` even where a policy says
`supervised`, because retrospective sampling cannot un-send a message.

## How an agent harness reaches the gate

Three surfaces, one gate. A harness that can run commands uses the CLI:
`approval request`, `approval wait`, `approval run`, which is what every ceremony
above shows, and which is how sessions in this repository take manual-class
actions ([docs/dogfood-cutover.md](docs/dogfood-cutover.md) is that runbook). The
other two put the gate in front of a harness that was never going to call the CLI
on its own.

### The Claude Code hook

`approval run` gates the commands an agent hands to the runtime. It cannot gate
the ones the harness runs directly, and those are most of them: `git push`, `gh
pr create`, `npm install`, `curl`. `approval hook claude-code` is a PreToolUse
hook: Claude Code hands it the pending tool call on stdin, and it classifies the
command, resolves the class against `APPROVAL.md`, and answers allow or deny. It
never answers "ask", because a decision taken outside the log is a decision
nothing can audit. `approval hook classify` prints the same verdict for any
command and touches nothing:

```
$ approval hook classify -- git push origin main
class          rule           command
vcs.push.main  git-push-main  git push origin main

classes: vcs.push.main
```

Four things about it are worth knowing before you install it, and the full
account is in [docs/claude-code-hook.md](docs/claude-code-hook.md).

**One root.** `--dir` (or, absent it, the primary checkout git reports) resolves
the policy and the log together, so a session inside a linked worktree still
writes to the one log. **The hook never creates a log.** Pointed at a path with
no log it denies with `hook-log-unreachable` and names what it looked for, rather
than scaffolding a second chain that forks from the real one's tail; hash chains
do not survive a merge.

**A wait that runs out withdraws its request.** On 2026-08-19 a `git commit
--amend` was classified manual, the hook waited nine minutes, got nothing, denied
the tool call and moved on. Half an hour later the human was pinged on their
phone and approved it, and the grant authorized nothing at all, because a retried
tool call files a new request. A person had spent attention on a question whose
asker had left. Now every exit from the wait that is not a decision withdraws:
the Telegram message is edited in place to say so, its buttons go away, and a tap
that beats the edit is told nothing was recorded. The withdrawal is best effort
and never changes the verdict, which stays `hook-timeout`.

**A hook grant mints no token.** The harness runs the command, so a token would
be a live credential with no spender. Such requests carry `execution: "harness"`,
`approval token` reports `none minted: harness-executed`, and `approval run`
refuses with the same code, so nobody hunts for a token that was deliberately
never created.

**A hook that cannot launch is an open gate.** Claude Code treats a failed hook
binary as a non-blocking error and the tool call proceeds, so install the CLI on
`PATH` before you trust the entry. The entry lives in `.claude/settings.json`,
which is `policy.edit` in the taxonomy: a human commits it, because an agent that
could write its own hook entry could write itself out of it.

### The MCP server

A harness that speaks MCP instead uses `approval mcp serve --as agent:<id>`, a
foreground stdio server publishing the agent's verbs as tools (`register`,
`request`, `wait`, `run`, `queue`, `log_verify`, …) built from the same verb
registry `approval instructions --schemas` prints. A tool call reaches the
function the CLI dispatches to, so there is no second implementation of any verb
and no answer the two surfaces can disagree about.

The identity is fixed at startup, and `--as` is deleted from every published
input schema, so a tool call cannot name an actor. Human-only verbs are not
tools: no `grant`, no `policy attest`, no `vault set`. SPEC.md section 11 makes
the agent the untrusted policy and the human the trusted overseer, an MCP client
is the agent's harness, and a grant tool on it would hand the untrusted policy
the overseer's pen. **Grant never travels over MCP**, and neither does the token
it mints; handing that over is the human's step.

What proves this path today is `tests/e2e-mcp-demo.test.ts`, which runs a real
server process, a real client from the official SDK, and a mock Bot API, and
asserts every hop against the log. The human walkthrough with a real client and a
real phone is written and not yet run: it is
[examples/mcp-demo.md](examples/mcp-demo.md).

## Two things stated plainly

### The token is delivered differently on each channel, on purpose

On Telegram the execution token is printed on the **listener's terminal** and is
never put into the chat. A chat transcript lives on servers you do not control
and is readable by anyone later added to that chat, so a credential does not go
there. On the local **web** channel the raw token is shown **once**, in the
response page for the grant that minted it. That page is served over loopback to
the human who is deciding, right now; the response is generated per request and
persisted nowhere; and reloading it shows nothing.

The asymmetry is deliberate rather than an inconsistency. On Telegram the
approver and the terminal are usually the same person a room apart. On the web
channel the browser **is** the surface the human is looking at, and sending them
off to hunt for a token on a daemon's stdout would push them toward copying
tokens out of log files, which is worse. In both cases the log holds only the
token's SHA-256, the token never appears in a URL, and nothing can recover it. If
you lose it, revoke the grant and request again.

### The web queue has no authentication, and its Origin check is a speed bump

`approval channel web` binds `127.0.0.1` with the host hard-coded. There is no
`--host` flag, and adding one would be a SPEC.md amendment rather than a feature,
because with no authentication the loopback interface is the entire access
control. Every decision the page collects is recorded against the human the
runtime was started with, so what it proves is "someone with access to this
machine approved" and never "that specific person approved". The page says so on
the page itself.

There is no CSRF token in v0.1, and that is a decision rather than an oversight.
A CSRF token defends a session, and here there is no session and no
authentication: anything that can open a socket to `127.0.0.1:4680` can POST
directly with or without one, because the trust boundary is the whole local
machine (SPEC.md section 11). A best-effort same-origin check rejects a POST
whose `Origin` or `Referer` names a non-loopback origin, and it allows a request
carrying neither, because `curl` and form posts from older browsers send neither
and refusing them would break the documented scripting path while buying nothing.
Treat that check as a speed bump and not as a control. If a future version grows
anything resembling a session, or widens the bind address, this stance needs a
real anti-CSRF token and a human revisiting it.

## Running the checks

```
npm run check:changed        # classify the working tree, then run that tier
npm run check:tier -- <path> # classify the given paths and print light or full
```

Checks come in two tiers. The **light** tier runs only the documentation guard
(`tests/docs-guard.test.ts`), and a change qualifies for it only when every
changed path is `README.md`, `docs/**/*.md`, or `examples/**/*.md`. The **full**
tier is the standing gate, `npm test && npm run lint && npm run typecheck`, and
a denylist forces it regardless of file extension: `APPROVAL.md`, `CLAUDE.md`,
`.claude/**`, `SPEC.md`, `schema/**`, `**/fixtures/**`, `backlog/**`,
`scripts/**`, `.github/**`, the packaging files, and `cli.js`. Backlog task
files are on that list because their acceptance criteria are instructions to
future agents: markdown by extension, behavior by effect.

Four rules hold this together. Classification is computed from the changed paths
by `scripts/classify-tier.mjs`, never asserted by the author of the change,
human or agent. Every merge to `main` runs the full suite unconditionally, so
the light tier is a fast local signal and never a way into the trunk. Review
applies identically to both tiers. And anything ambiguous, an empty path set
included, resolves to full.

CI earned its first catch on its second run: the Node 20 matrix job, the one
executor not shaped by our own environments, falsified two portability claims
at once. The test invocation leaned on `node --test` expanding its own glob
(Node 21 and later), and behind that mask the pinned better-sqlite3 major had
dropped Node 20 entirely. Discovery is now an explicit file list
(`scripts/run-tests.mjs`) that refuses to call an empty suite green, the pin
is back on a major that supports the floor, and a guard test now checks every
production dependency's `engines.node` against it.

## Exit codes

An agent branches on the exit code before it ever reads stdout, so these numbers
are a frozen part of the contract. Adding one is a spec change; changing the
meaning of an existing one is a breaking change.

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
truncating a torn line is a human decision.

A gate refusal is exit 1 and never 2. The command was well-formed and the answer
is no, so branch on `error.code` under `--json` rather than retrying with
different flags.

## Where to look next

Every command carries its own instructions, so this README shows no verb
inventory. `approval --help` lists them grouped by what they are for, with the
defaults, the exit codes, and the stances every verb inherits. `approval
<command> --help` gives one command's flags, refusal codes, and JSON shape, and
`--help --long` appends that verb's reasoning from
[docs/cli-reference.md](docs/cli-reference.md). `approval instructions` is the
agent-facing guide, and `--schemas` prints the verb registry as JSON.

## License

MIT. See [LICENSE](LICENSE).
