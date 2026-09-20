# Gating Hermes Agent

`approval hook hermes` answers Hermes Agent's `pre_tool_call` hook in Hermes's
own dialect. It resolves every command through the same deterministic core as
`approval hook claude-code`, `cursor`, `codex`, `grok` and `muse`: same
classifier, same policy, same log, same refusal codes. What differs is the wire
format, the event names, and one thing no previous adapter has had.

Read the next two sections before you commit anything.

> ## EVERY FACT BELOW IS DOCUMENTED AND UNVERIFIED UNTIL THE PROBE RUNS
>
> This adapter was built from the published source of
> [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) — its
> tool registrations, its shell-hook dispatcher, its config parser — read on
> 2026-09-20 against `main` (`pyproject.toml` at `0.21.3`). That is better
> provenance than a vendor page, and it is still not a running session.
>
> `docs/muse-hook.md` is the argument for why the difference matters: on Muse,
> three of the facts that shaped the adapter were in no source at all, and one
> third-party claim that turned out correct sat beside another that turned out
> wrong. The two halves of THIS document that a live run could overturn are
> marked **UNVERIFIED** where they appear. The probe is
> `scripts/probes/hermes-hook.mjs` and "Running the probe" below is its runbook;
> when it has run, the register entry in
> [docs/integrations-considered.md](integrations-considered.md) moves from parked
> and every **UNVERIFIED** mark in this file is either deleted or corrected.
>
> Nothing here is a guess about a field's NAME. Those were read off the source.
> What is unverified is BEHAVIOUR: what the harness does with a hook that breaks,
> and which spelling of an answer it honours.

## Hermes documents a fail-CLOSED hook, which no harness since Claude Code has

This is why the adapter exists at all, and it is the finding the probe is pointed
at.

Every hook entry takes a per-entry `fail_closed`. With it set, three hook
failures become a **block** rather than a shrug:

| The hook… | With `fail_closed: true` | Without it (the default) |
| --- | --- | --- |
| cannot be spawned | **blocks** | proceeds |
| exceeds its `timeout` | **blocks** | proceeds |
| prints non-empty stdout that is not a JSON object | **blocks** | proceeds |

Grok Build and Muse Code fail open on all three with no setting to change it
(`docs/grok-hook.md`, `docs/muse-hook.md`), so both adapters are enforcement only
while healthy. If the table holds, `approval hook hermes` is a gate in the
SPEC.md §11.1 sense.

**Three caveats, and none of them is small.**

1. **The default is `false`.** An entry without the key fails open. Set it on
   every entry; `approval hook hermes --help` prints a block that does.
2. **It does not cover a hook that exits non-zero having printed NOTHING.** The
   condition requires a non-empty stdout, so a crash with no output slips past
   it. That gap is covered here rather than by the key: **this adapter's deny
   exits 2**, which Hermes treats as an unconditional block, so every refusal it
   reaches blocks on the exit code alone, including the ones where the body never
   made it out.
3. **A hook Hermes never registered cannot fail either way.** See "The silent
   no-op" below. It is the most dangerous thing in this document.

**UNVERIFIED.** The table is read from the dispatcher, not measured. The probe's
`crash`, `hang` and `garbage` trials each run twice, once per setting, and the
pair is the finding.

## The silent no-op, which is worse than an error

The first time a hook command runs, Hermes prompts on a TTY — *"Hermes is about
to register a shell hook that will run a command on your behalf… Commands run
with your full user credentials"* — and remembers the answer in
`$HERMES_HOME/shell-hooks-allowlist.json`.

**With no TTY and no consent setting, Hermes silently skips registering the
hook.** Not an error, not a warning that stops anything: the hook simply never
fires, and the session runs ungated with nothing saying so. A sandboxed tenant is
exactly that case.

So one of these must be set, and a deployment that forgets it has no gate:

- `hooks_auto_accept: true` in `$HERMES_HOME/config.yaml`, or
- `HERMES_ACCEPT_HOOKS=1` in the environment, or
- `--accept-hooks` on the command line.

`approval doctor` is the check that catches the omission after the fact: its
harness-version row now reads `$HERMES_HOME/config.yaml` and reports whether this
checkout's hook is registered anywhere at all (APRV-398 gave the same row to
`grok` and `muse`, which had never had one).

## The dialect: one form each way, and the allow is not what you would guess

Hermes's shell-hook parser accepts two block dialects, tried in this order:

| Form | Blocks? |
| --- | --- |
| `{"action":"block","message":"…"}` | yes (its own) |
| `{"decision":"block","reason":"…"}` | yes (Claude-compatible) |
| exit code 2, whatever stdout said | yes, unconditionally, on `pre_tool_call` only |

**This adapter emits the native form, at exit 2, and nothing else.**

The native form over the compatible one because it is the shape the parser tries
first and the one least likely to be dropped by a release that tidies up a
compatibility layer. One form rather than both because of Muse: there, a verdict
carrying a key the harness did not support was itself unparseable, an unparseable
hook was a failed hook, and a failed hook failed open — so being *more* explicit
made the refusal *weaker*. Hermes may well tolerate a superset; being right about
one dialect costs nothing and the other bet costs a session.

Exit 2 **as well as** the body, which is the one place Muse's lesson does not
carry over, and the difference is in Hermes's own code rather than in taste.
Hermes defines a blocking exit code, applies it to `pre_tool_call` and to no
other event, and states the precedence itself: the call is blocked whatever
stdout said, and the message is taken from the stdout directive first, from
stderr second, and from a default third. The body and the exit code are therefore
not two accounts of one answer that the harness has to reconcile — they agree by
its own rule. And exit 2 is what closes caveat 2 above.

**THE ALLOW IS `{}`.** Hermes has no allow directive. Its parser returns "no
directive" for an empty stdout, for `{}`, and for any JSON object naming no
directive key, and no directive means the call proceeds. So:

- `{}` rather than an empty stdout, because a human reading a log can tell a hook
  that decided from a hook that printed nothing — and under `fail_closed: true`
  those two are meant to mean opposite things;
- `{}` rather than an invented `{"action":"allow"}`, because that would be an
  allow only by falling through the parser's unrecognised-directive path, and a
  verdict that works by not being understood is one release away from being a
  block. Under `fail_closed: true` a parse failure blocks, so the invented
  spelling would stop a session rather than permit it.
- The allow therefore carries **no reason in the body**. It goes to stderr
  instead (`approval hook hermes: allow — …`), naming the classes authorized and
  the loop floor's own words when one stood. Hermes reads stderr only as a block
  message at the blocking exit code, which an allow never uses.

**UNVERIFIED.** The probe's `allow-empty-object` trial is what licenses `{}`, and
`allow-action-allow` measures the invented spelling so the choice is recorded
rather than asserted.

## Installing it

The file a human commits is **`$HERMES_HOME/config.yaml`**, and it is not in the
repository. Hermes has no project-local configuration directory: `HERMES_HOME`
comes from a context override, then the environment variable, then `~/.hermes`.

That makes this the first gate organ that lives in the user's home, and the
classifier follows it there. `.hermes/config.yaml`, `.hermes/agent-hooks/`,
`.hermes/shell-hooks-allowlist.json` and `.hermes/hooks*` are `policy.core`
wherever they sit — `.hermes/config.yaml`, `/Users/x/.hermes/config.yaml` and
`~/.hermes/config.yaml` all match, because the classifier's segment walk was
already position-agnostic and nothing was extended for this. An agent that could
write any of them could write itself out of the gate, and the allowlist is the
sharpest of the four: an agent that could edit it could pre-consent itself to a
hook command of its own.

`$HERMES_HOME/.env` and `$HERMES_HOME/auth.json` are a different class again:
`account.credential`, human-only, because what leaves the machine there is the
secret rather than the rule. That is the same split `.approval/env` has.

```yaml
plugins:
  hook_callback_timeout: 600
hooks_auto_accept: true
hooks:
  pre_tool_call:
    - command: "approval hook hermes --dir /path/to/repo --timeout 4m"
      timeout: 300
      fail_closed: true
  post_tool_call:
    - command: "approval hook hermes --dir /path/to/repo"
      timeout: 300
```

Four things about that shape:

- **The event is a mapping KEY, not an `event:` field.** `hooks:` maps an event
  name to a list of entries. An operator who copied another harness's
  `- event: pre_tool_call` shape would produce a file that configures nothing.
- **`matcher` is optional and is omitted here.** It is a regex (full match) on the
  tool name, supported on the two tool events only. Omitting it matches every
  tool, which is what a gate wants.
- **Register both events.** The pre half answers the verdict; the post half closes
  the `execution.started` records the pre half wrote, so the harness scopes of
  SPEC.md §10.2 have a failure signal to accrue. Only `pre_tool_call` can block.
- **Attest it.** It is a gate organ, so after editing it:
  `approval policy attest --organ <path> --as human:<id>` (APRV-272).

### Two timeouts bound the wait, and the shorter one wins

This is the subtlety most likely to bite, because the two numbers are in
different parts of the file and the smaller default belongs to the one nobody
would think to look for.

| Setting | Default | Maximum | What it bounds |
| --- | --- | --- | --- |
| the entry's `timeout` | 60s | **300s** | that one shell hook's process |
| `plugins.hook_callback_timeout` | **30s** | 600s | the whole hook dispatch, and it **fails closed** on `pre_tool_call` by itself |

Consequences, in order of how much they cost:

1. **Leave `hook_callback_timeout` alone and every manual-class call blocks at
   30s**, before a human has looked at their phone. Raise it.
2. **`--timeout` must be under 300s.** No entry may wait longer than the
   per-entry cap, so the 9m default wait does not fit this harness at all. The
   config above pairs `timeout: 300` with `--timeout 4m`.
3. A human therefore has **under five minutes** to answer, or the call is
   refused and the agent retries. That is a real reduction in the window this
   project's other adapters give an approver, and it is a property of the
   harness rather than a choice made here.

## What is gated

Tool names and argument keys are Hermes's own, read off its tool registrations:

| Tool | Role | Path carried in |
| --- | --- | --- |
| `terminal` | shell | `command`, with a **per-call `workdir`** |
| `write_file` | file write | `path` (plus `content`) |
| `patch` | file edit | `path` (plus `old_string`, `new_string`, `mode`, `replace_all`) |
| `read_file` | read | `path` (plus `offset`, `limit`) |
| `search_files` | read | `path`; its `target` enum selects a grep or a name search |
| `execute_code` | **refused outright** | nothing — see below |

**`terminal` carries a per-call working directory**, which Codex does not
(APRV-310). The command is classified against `tool_input.workdir` rather than the
session root, so a relative path resolves the way the shell will resolve it. A
`workdir` that is not absolute is ignored in favour of the session `cwd`: a
self-reported field may raise scrutiny, never lower it.

**`search_files` is both readers behind one enum, and it names ONE path.** There
is no `glob`, no `grep` and no `list_files` on this harness, and **no tool takes a
list of paths** — which is the one way it is simpler than Muse, whose `search`
names an array and needed list handling. A `paths` array arriving in a later
release would fall to that same handling with no change, because the read gate
reads both shapes.

**`execute_code` is refused before anything else looks at it**, with its own
machine-readable code `hook-hermes-execute-code-unbound`. Two reasons, and the
second is the stronger one:

1. The call carries a `code` string and nothing else — no path, no argv, no
   working directory. There is nothing for the classifier to read and nothing a
   payload could bind, so a verdict over it would authorize a program this runtime
   never parsed. SPEC.md §11.1 resolves ambiguity to the stricter path.
2. `execute_code` runs in a persistent kernel whose scripts can call Hermes's
   other tools **in-process**. Whether those inner calls re-fire `pre_tool_call`
   is **UNVERIFIED and is the highest-risk unknown about this harness**: if they
   do not, one `execute_code` call is an unbounded bypass of this entire adapter.
   Refusing the tool is the only answer available to a hook that cannot see
   inside it.

The code is distinct from its two nearest neighbours because the repairs differ.
`hook-opaque` says a command line carried a construct the classifier could not
read, and its repair is to write the command differently — there is no rewriting
of an `execute_code` call. `hook-unsupported-execution-context` says the harness
did not say *where* a call would run, and its repair is a harness contract that
exposes the directory — here there is no path, argv or directory to expose. The
repair for this one is to do the work through `terminal`, where the words are
visible, or through `approval run` with a granted token.

**The post half prints nothing on stdout.** A verdict there would be a permission
decision about a call that has already run. Exit 2 is Hermes's blocking code, so
the post half always exits 0 as well, and the diagnostic goes to stderr. It reads
an outcome from the event's result where one is present — an `exit_code` decides a
shell call, an `error` decides anything, an interrupt is **unreadable** rather
than assumed either way — and falls back to the event name, which is Hermes saying
which of its own code paths ran.

**UNVERIFIED:** which key the post event's result arrives under. The reader is
shape-only and falls back to the event name, so a result it cannot read closes the
start on the weakest honest evidence rather than on a guess.

### The hook runs BEFORE Hermes's own approval prompt

Hermes has its own consent system, `approvals.mode` (`manual` by default, plus
`smart` and `off`), with dangerous-pattern detection and a TTY prompt. The
documented order inside its executor is: tool-scope check, then `pre_tool_call`
hooks, then its own guardrails and prompt.

So this adapter's verdict lands first and can block before Hermes's own UI ever
appears. That is the right order for a gate, and it means the two systems stack
rather than race. It also means turning `approvals.mode: off` does not turn this
off.

### What the adapter cannot cover

- Anything Hermes does without a tool call: the prompt, the context it attaches,
  its own model calls.
- The session's reads *before* the first hook fires.
- `execute_code`'s in-process tool calls, if those bypass the hook. Refused
  rather than covered.
- **Subagents.** `delegate_task` can run a child agent in an isolated worktree,
  and whether that child inherits this `HERMES_HOME` and its hooks is
  **UNVERIFIED**. A child with a different config is a session this gate never
  sees.
- MCP tools register into the same tool registry, so they *should* flow through
  the same dispatch. Not traced end to end.
- A tool Hermes adds in a later release. An unknown tool takes the path it took
  before, which is not a gated one — the alternative would break a session on an
  upgrade.
- The events this hook is not registered for. Hermes has some forty hook events;
  this adapter speaks two.

## Running the probe

The runbook, verbatim, so it survives without the conversation it was written in.
Carter runs it; no agent runs `hermes`.

**A live model is needed first**, because the probe measures TOOL CALLS and only a
model makes them. If the install has no provider configured:

```sh
export HERMES_HOME=/Users/carter/dev/hermes/home
hermes setup            # the wizard: pick a provider and paste a key
hermes setup --portal   # or Nous Portal specifically
hermes model            # change the provider or model later
```

Point it at the cheapest small model the provider lists. The five prompts below
are one-line tool calls, so capability is irrelevant and spend is the only axis
that matters. Nous's own documentation names no specific cheap id, so pick one
from `hermes model`'s list rather than from this page. Keys live in
`$HERMES_HOME/.env`, which this repository's classifier treats as
`account.credential`, human-only, and which no agent reads.

**Step 1 — install the hook block and get the prompts.** One command:

```sh
node scripts/probes/hermes-hook.mjs setup \
  --home /Users/carter/dev/hermes/home \
  --captures /Users/carter/dev/hermes/probe
```

It appends its block to that `config.yaml` between named markers, backs the
original up once to `config.yaml.aprv398-backup`, and **refuses outright** if the
file already carries a top-level `hooks:`, `plugins:` or `hooks_auto_accept:` key,
printing the block to merge by hand and touching nothing. YAML forbids duplicate
top-level keys, and a config Hermes cannot parse starts with **no hooks at all**,
which looks identical to a probe that never fired. Captures land in
`--captures`, which is where the findings outlive the scratch root.

With no `--home` it builds a scratch `HERMES_HOME` of its own instead, which is
what the test suite drives. It never assumes `~/.hermes`: an install directed
elsewhere with `--hermes-home` would leave the probe writing a config nothing
reads.

**Step 2 — the baseline.** In the scratch project the setup names, with
`HERMES_HOME` exported, run `hermes` and type these five prompts separately:

```text
1. run the shell command `ls -la` here
2. create a file named probe.txt containing the word hello
3. change the word hello in probe.txt to goodbye
4. read README.md and tell me its first line
5. run some python code that prints 2+2      <- this one SHOULD be refused before it runs
```

**Step 3 — the fail-closed trials. The point of the whole probe.** Each of
`crash`, `hang` and `garbage` runs **twice**, once with `fail_closed: true` and
once without; the pair is the finding. Quit `hermes` between trials. `hang` blocks
past the 600s timeout: let it, and do not interrupt it.

```sh
node scripts/probes/hermes-hook.mjs fail-closed on
  node scripts/probes/hermes-hook.mjs arm crash     # then: create a file named crash-failclosed-probe.txt containing x
  node scripts/probes/hermes-hook.mjs arm hang      # then: hang-failclosed-probe.txt
  node scripts/probes/hermes-hook.mjs arm garbage   # then: garbage-failclosed-probe.txt
node scripts/probes/hermes-hook.mjs fail-closed off
  node scripts/probes/hermes-hook.mjs arm crash     # then: crash-failopen-probe.txt
  node scripts/probes/hermes-hook.mjs arm hang      # then: hang-failopen-probe.txt
  node scripts/probes/hermes-hook.mjs arm garbage   # then: garbage-failopen-probe.txt
```

`fail-closed` rewrites only the region between the markers; everything else in
that config is the operator's and is left alone. Restart `hermes` after each
switch so it re-reads the file.

**Step 4 — the dialect trials, with `fail_closed` ON.** The first two are the
forms the shipped adapter emits; if either is the wrong answer, nothing else
matters.

```sh
node scripts/probes/hermes-hook.mjs fail-closed on
# then arm each of, one prompt per trial, creating <trial>-failclosed-probe.txt:
#   deny-action-exit2   allow-empty-object
#   deny-action   deny-decision   deny-exit2   deny-mixed
#   allow-empty   allow-action-allow
```

`deny-mixed` is the one trial that is deliberately not single-variable: it prints
every dialect at once, which is the payload that failed OPEN on Muse.
`allow-action-allow` prints the invented `{"action":"allow"}`, to find out whether
an unrecognised directive *value* still falls through to an allow or is a parse
failure — and under `fail_closed: true` a parse failure is a block.

**Step 5 — the report.**

```sh
node scripts/probes/hermes-hook.mjs report
```

Its first section is the fail-closed answer. Paste the whole thing into the task.

## For Agent Village

Agent Village v2 (Edge City Goa, October to November 2026) runs every resident
agent on Hermes Agent inside a Railway sandbox, one tenant per resident. Its
design document names an optional approval.md Hermes skill as the Sprint 3
deliverable. The adapter is the part this repository owns; the skill and the
hosted daemon are not.

What follows from the sections above, for that deployment:

- **One `HERMES_HOME` per tenant.** The hook config, the consent allowlist and the
  provider key all live there, so per-tenant isolation is per-directory isolation.
  Set `HERMES_HOME` explicitly in each sandbox rather than relying on `~/.hermes`,
  which in a container is whatever `$HOME` happens to be.
- **`hooks_auto_accept: true` or `HERMES_ACCEPT_HOOKS=1` is mandatory.** A sandbox
  has no TTY, and without one of these the hook is silently never registered. This
  is the single most likely way a tenant ends up ungated while looking gated.
- **`fail_closed: true` on every entry**, and `plugins.hook_callback_timeout`
  raised, and `--timeout` under 300s. The five-minute ceiling is the resident's
  answering window.
- **`execute_code` is refused**, so a resident's agent cannot run arbitrary Python
  through this gate at all. That is a real loss of capability and it is the honest
  trade while its in-process tool calls are unverified.
- **Reaching the hosted daemon from a sandbox is unsolved here.** The hook writes
  to a log and reads a policy; a sandboxed tenant has neither locally. APRV-383 is
  that work, and this adapter cannot be deployed per-tenant until it lands.

What a future skill would install: the `hooks:` block above with the tenant's own
`--dir`, the consent setting, and the daemon reach APRV-383 defines. Filed as its
own task rather than sketched here.

## SPEC status

SPEC.md has **not** been amended for this adapter, and the reason is different
from the reason `docs/grok-hook.md` and `docs/muse-hook.md` give.

Those two say a row would be false: their harnesses fail open, so the SPEC's gate
language does not describe them. Here a row might well be **true** — a harness
with a documented fail-closed hook is the first one since Claude Code that the
gate language fits. But it is not yet *established*, and a SPEC that asserted a
fail-closed gate on documentation alone would be the confident-stale
documentation this project exists to avoid. The condition in APRV-398's own AC5 is
explicit: amend only if the probe shows fail-closed enforcement.

So the hunks below are proposed, not applied, for a human to decide on **after**
the probe. Two of them:

The §10 verb listing gains one line:

```
approval hook hermes               # gate a Hermes Agent session: snake_case
                                   #   pre_tool_call/post_tool_call JSON in, ONE
                                   #   dialect out ({action,message}), deny at
                                   #   EXIT 2 which blocks unconditionally. The
                                   #   harness documents a per-entry
                                   #   fail_closed that BLOCKS on hook crash,
                                   #   timeout and unparseable output, whose
                                   #   default is false; execute_code is refused
                                   #   outright. See docs/hermes-hook.md
```

The §11.1 organ list gains `$HERMES_HOME/config.yaml`, `$HERMES_HOME/agent-hooks/`
and `$HERMES_HOME/shell-hooks-allowlist.json`, which is the first entry in that
list that is **not repository-relative**. That is the part worth a human's
attention rather than a nod: every other organ this project protects sits in a
checkout, and the sentence that describes the set would have to change shape to
admit one that does not.

If the probe confirms the fail-closed table, a third hunk becomes arguable and is
deliberately not drafted here: a §6.3 statement that a harness hook can be
enforcement rather than a backstop, which is currently true of exactly one
harness and would become true of two.

## Related

- [docs/muse-hook.md](muse-hook.md) — the dialect lesson this adapter is built on,
  and the fail-open harness it is the counterexample to.
- [docs/grok-hook.md](grok-hook.md) — the other fail-open harness, and the SPEC
  precedent both of them set.
- [docs/codex-hook.md](codex-hook.md) — the harness whose contract withholds the
  per-call working directory, which is the fact `terminal` supplies here.
- [docs/claude-code-hook.md](claude-code-hook.md) — the original adapter, and the
  classifier tables every adapter shares.
- [docs/integrations-considered.md](integrations-considered.md) — the register
  entry, parked pending the probe.
- `scripts/probes/hermes-hook.mjs` — the probe, and `tests/probe-hermes-hook.test.ts`
  the suite that makes it safe to run once.
