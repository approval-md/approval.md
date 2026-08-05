# approval.md

[![ci](https://github.com/approval-md/approval.md/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/approval-md/approval.md/actions/workflows/ci.yml)

**Human approval for agent actions.**

Your AGENTS.md says "require approval first". approval.md enforces it, and
puts the approve button on your phone.

Spec site: https://approval.md · Specification: [SPEC.md](SPEC.md)

## What this is

approval.md is a file-based convention and a reference runtime for gating the
agent actions that have real-world side effects: sending messages, spending
money, deleting data, posting publicly, writing to calendars. Coding agents
already have a safety net, because a bad diff is revertible. Once an agent
leaves the repository that net disappears. A sent email has no revert, so the
artifact a human reviews stops being the plan and becomes the side-effect
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
and an agent can read with `cat`. Every state transition is an immutable event;
markdown views and any index are projections rebuilt from the log, and they
never write back to it. Routing, gating, budget math, and chain verification are
deterministic code. Models propose, and the runtime decides.

[SPEC.md](SPEC.md) is the source of truth for every design decision here, and
this README defers to it wherever the two could be read differently. Security
posture is stated honestly in SPEC.md section 11: this is an oversight layer for
broadly cooperative agents, with hard enforcement at the adapter boundaries that
hold the credentials. [CLAUDE.md](CLAUDE.md) describes how this repository builds
itself, including the point at which it starts running behind its own gate.

Three ceremonies belong to the human. Attesting a policy, amending it, and
deciding a request. Everything below is one of those three.

## Ceremony one: the first attestation

A policy is a fenced `yaml approval-policy` block inside a markdown file named
`APPROVAL.md`. There is no `approval init` verb yet, so write the file by hand.
That is the point of the format: the thing you are signing for is text you read.

````sh
mkdir -p ~/approval-demo && cd ~/approval-demo

cat > APPROVAL.md <<'EOF'
# Approval policy

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
```
EOF
````

Attestation is human-only, so the runtime needs to know which human. Identity in
v0.1 is config-declared and not proved (SPEC.md section 11): the trust boundary
is the local machine, and anyone who can set this variable and write to the log
is inside it.

```sh
export APPROVAL_HUMAN='human:you'
approval policy attest
```

```
attested /home/you/approval-demo/APPROVAL.md at seq 1: sha256 b9388aeb...
```

That single record is what makes the policy operative. An attestation records
that a human saw these exact bytes, and it records their SHA-256 rather than
their text. Edit `APPROVAL.md` afterwards and every gated operation refuses with
`hash-mismatch` until you attest again. Unattested is not the same as permissive:
the runtime fails closed.

Then confirm the world is sane before you trust anything it tells you:

```sh
approval doctor
```

`doctor` runs seven checks in the order their failures cascade: build freshness,
identity, attestation, log chain, Telegram reachability, the web port, and the
payload store. It
appends nothing, sends no message, and repairs nothing. Each failure comes with a
concrete fix string you run yourself. It exists because a real ceremony lost time
twice to a stale `dist/` and an unbuilt checkout, neither of which was a runtime
bug and neither of which anything was in a position to say out loud.

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
The baseline for that diff is recovered from `HEAD:<policy>` and used only when
its SHA-256 equals the attested hash, because a baseline nobody can verify is not
a baseline. When it cannot be verified the verb drops loudly to hash-only mode
and says so instead of faking the assurance.

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

## Ceremony three: approving from your phone

The Telegram channel is the reference adapter. Create a bot by messaging
**@BotFather** with `/newbot`, message your new bot once so it can answer you,
and read your chat id out of `getUpdates`. The full walkthrough, with the exact
commands and the expected output at every step, is in
[examples/telegram-demo.md](examples/telegram-demo.md).

```sh
export APPROVAL_TG_TOKEN='1234567890:AA...'   # from BotFather
export APPROVAL_TG_CHAT='123456789'           # your chat id
export APPROVAL_HUMAN='human:you'
```

`APPROVAL.md` carries only the *names* of those first two variables and never
their values. No flag puts a bot token into a shell history or a process listing.

An approval binds to specific bytes. The payload lives in a file, the envelope
declares its `payload_hash`, and `--payload` supplies the bytes at request time:

```sh
approval payload hash payload.json               # the binding the envelope declares
approval register task-demo.md --as agent:drafter
approval request task-demo --action task-demo:chaser --payload payload.json \
  --as agent:drafter
```

Bytes that do not hash to the declared binding are refused `payload-mismatch`,
and nothing is stored or appended. Class, cost, and reversibility come from the
registered envelope rather than from flags, so an agent cannot rename its own
class between registering and asking.

### The payload store

Accepted payloads land in `.approval/payloads/`, one file per binding, named by
its own hash. Treat that directory as data, not as scratch space. `QUEUE.md`
regenerates and `index.sqlite` reindexes, both from the log; the payload store is
the one cache a rebuild cannot recreate, because the log records the hash a
request bound to and never the material itself. Delete the store and those bytes
are gone. The binding survives, which is what makes the loss visible rather than
silent: every affected manual request renders `payload-unavailable` instead of
showing an approver bytes no hash ever bound. `approval status` reports the store
in every run and `approval doctor` fails when it exists and cannot be written.

Some material is deliberately kept out of it. `--payload-dir` (CLI and web
channels) and `--payloads` (Telegram) let an operator serve payload bytes from
somewhere they chose: a vault, an encrypted volume, any location where the rule
is that these bytes never rest beside the log. The tagger re-hashes whatever
those flags supply and compares it against the recorded binding, so the
authoritative answer stays the log's either way and an override cannot put
different bytes in front of an approver. Retiring the flags now that the store
exists is deferred to M6, pending exactly this use case.

Now start the listener and pick up your phone:

```sh
approval channel telegram listen
```

The message shows the action key, a COMPUTED block the runtime derived, a CLAIMED
block naming the agent and marked unverified, the full payload, and two buttons.
Tap Approve. The grant lands in the log and mints a single-use execution token,
which the listener prints **on its own terminal**:

```
granted task-demo:chaser (seq 4) by human:you via telegram
execution token for task-demo:chaser: 9c92f89a...
approval: that token is single-use, stored nowhere, and was NOT sent to Telegram
```

Copy it, and spend it:

```sh
approval run task-demo:chaser --token "$TOKEN" --payload-hash "$HASH" \
  --as agent:drafter -- echo sent
```

`run` appends `execution.started` before spawning the child and
`execution.completed` after, and it exits with the child's own exit code, so it
composes with `make`, CI, and `&&` exactly as an unwrapped command would. Running
it before the approval refuses `token-required` at exit 5 and writes nothing.
Running it a second time with the same token refuses `token-consumed`, so a
retried agent cannot double-send.

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

Four rules hold this together. Classification is computed from the changed
paths by `scripts/classify-tier.mjs`, never asserted by the author of the
change, human or agent. Every merge to `main` runs the full suite
unconditionally, so the light tier is a fast local signal and not a way into
the trunk. Review applies identically to both tiers. And anything ambiguous,
including an empty path set, an unreadable git state, or a path shape the
classifier does not recognise, resolves to full.

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

Every command carries its own instructions. Start with `approval --help`, then
`approval <command> --help` for flags, refusal codes, and the exit mapping that
command uses.

## License

MIT. See [LICENSE](LICENSE).
