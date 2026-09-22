# Gating Hermes Agent

`approval hook hermes` answers Hermes Agent's `pre_tool_call` hook in Hermes's
own dialect. It resolves every command through the same deterministic core as
`approval hook claude-code`, `cursor`, `codex`, `grok` and `muse`: same
classifier, same policy, same log, same refusal codes. What differs is the wire
format, the event names, and one thing no previous adapter has had.

Read the next three sections before you commit anything.

> ## THE HOOK IS FAIL-CLOSED, MEASURED, AND ONLY ABOVE A VERSION FLOOR
>
> The probe has run (2026-09-21, 60 envelopes, APRV-398's notes). On Hermes
> `main` at `118984d7` a per-entry `fail_closed: true` **BLOCKED all three ways a
> hook can be broken**: the armed crash was refused, the armed garbage was
> refused, and the armed hang was refused at exactly 300s, the per-entry cap. So
> `approval hook hermes` is the first adapter since Claude Code that is a **gate**
> rather than a backstop.
>
> **The floor: a build at or after `main` `118984d7` of 2026-09-20.** `v0.21.3`
> (build `2026.9.14`) does not know the key and **fails open silently** — the same
> three trials all proceeded on it — and `hermes hooks list` renders no
> `fail_closed` flag on either build, so the listing cannot be used to tell them
> apart. Both builds report the same semver, so the floor is compared on the
> BUILD DATE and the upstream commit that `hermes --version` prints:
>
> ```text
> Hermes Agent v0.21.3 (2026.9.14) · upstream 913d4098    <- fails open, silently
> ```
>
> `approval doctor`'s `harness-version-unverified` row reads that line and fails
> when the installed build is below the floor. It is the only surface that
> notices, because a hook cannot report from inside a failure that did not stop
> anything.
>
> **A `post_tool_call` event is NOT evidence the tool ran.** It fired 29ms after
> an exit-2 deny and again after the refused hang. Hermes reports the end of its
> own dispatch, not the end of an execution, so the post half reads an outcome
> from the event's result and treats a result it cannot read as unreadable rather
> than as a completion.
>
> What is still **UNPROBED** is listed under "Still UNPROBED" below, five items,
> each with what would settle it. Nothing in this document is a guess
> about a field's NAME: those came from the published source of
> [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) on
> 2026-09-20 and the live run confirmed them.

## The fail-CLOSED hook, measured, which no harness since Claude Code has

This is why the adapter exists at all, and it is the thing the probe was pointed
at.

Every hook entry takes a per-entry `fail_closed`. With it set, three hook
failures become a **block** rather than a shrug. The right-hand columns are the
live run rather than the dispatcher's source:

| The hook… | `fail_closed: true` on `main` `118984d7` | On `v0.21.3` (2026.9.14) | Without the key |
| --- | --- | --- | --- |
| cannot be spawned (armed `crash`) | **blocked** | proceeded | proceeds |
| exceeds its `timeout` (armed `hang`) | **blocked at 300s** | proceeded | proceeds |
| prints stdout that is not a JSON object (armed `garbage`) | **blocked** | proceeded | proceeds |

Grok Build and Muse Code fail open on all three with no setting to change it
(`docs/grok-hook.md`, `docs/muse-hook.md`), so both adapters are enforcement only
while healthy. This one is a gate in the SPEC.md §11.1 sense, above the floor.

**Four caveats, and none of them is small.**

1. **The version floor.** `v0.21.3` ignores the key with no warning of any kind:
   it is not an error, not a startup complaint, and not visible in
   `hermes hooks list`. A deployment that pins an older build has a backstop while
   believing it has a gate. `approval doctor` is the check.
2. **The default is `false`.** An entry without the key fails open on every build.
   Set it on every entry; `approval hook hermes --help` prints a block that does.
3. **It does not cover a hook that exits non-zero having printed NOTHING.** The
   condition requires a non-empty stdout, so a crash with no output slips past
   it. That gap is covered here rather than by the key: **this adapter's deny
   exits 2**, which Hermes treats as an unconditional block, so every refusal it
   reaches blocks on the exit code alone, including the ones where the body never
   made it out.
4. **A hook Hermes never registered cannot fail either way.** See "The silent
   no-op" below. It is still the most dangerous thing in this document.

One thing the run showed that no reading of the dispatcher would have: **after a
block, the model retries the same effect through another tool or another path.**
The refused crash write reappeared as a second `write_file` under
`$HERMES_HOME/cache/scratch`, and the refused garbage write reappeared as a
`terminal` command. That is the reason every gated tool is covered by the
working-directory refusal below rather than the shell tool alone.

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
`harness-version-unverified` row reads `$HERMES_HOME/config.yaml`, reports whether
this checkout's hook is registered anywhere at all (APRV-398 gave the same row to
`grok` and `muse`, which had never had one), and since APRV-415 also reports a
build below the fail-closed floor.

The gateway pass added one fact to this section: **the hooks DO fire for gateway
sessions**, pre and post, when consent was recorded earlier from a TTY. What is
still unprobed is first use with no prior TTY approval, which is the sandbox case,
and that is precisely why one of the three settings above is mandatory rather than
convenient.

## The dialect: one form each way, and the allow is not what you would guess

Hermes's shell-hook parser accepts two block dialects, tried in this order. Every
row below was measured one trial at a time under `fail_closed: true`:

| Form | Blocks? |
| --- | --- |
| `{"action":"block","message":"…"}` | **yes**, observed (its own) |
| `{"decision":"block","reason":"…"}` | **yes**, observed (Claude-compatible) |
| exit code 2, with nothing on stdout | **yes**, observed, on `pre_tool_call` only |
| every dialect at once (`deny-mixed`) | **yes**, observed — Hermes tolerates a superset |
| `{}`, or an empty stdout | allows, observed |
| an invented `{"action":"allow"}` | allows, observed (it falls through as an unrecognised directive) |

**This adapter emits the native form, at exit 2, and nothing else.**

The native form over the compatible one because it is the shape the parser tries
first and the one least likely to be dropped by a release that tidies up a
compatibility layer. One form rather than both because of Muse: there, a verdict
carrying a key the harness did not support was itself unparseable, an unparseable
hook was a failed hook, and a failed hook failed open — so being *more* explicit
made the refusal *weaker*.

**Hermes is not Muse on that point, and the mixed payload blocked here.** One
dialect is kept anyway, and the reason is now the smaller one: the tolerance is a
property of one release, and a verdict whose meaning depends on how much of it the
harness understood is a verdict a reader cannot check. The measurement is in the
table so that a future task weighing the same question starts from it rather than
from this paragraph.

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

**Both halves are measured.** The `allow-empty-object` trial created its file
under `fail_closed: true`, which licenses `{}`; `allow-action-allow` also created
its file, which is the invented spelling working *by falling through*, and is
exactly why it is not shipped.

## Installing it

The file a human commits is **`$HERMES_HOME/config.yaml`**, and it is not in the
repository. Hermes has no project-local configuration directory: `HERMES_HOME`
comes from a context override, then the environment variable, then a default this
page deliberately does not build on.

**Name the home, and spell its last segment `.hermes`.** On this machine there is
one home, under the Hermes checkout rather than under `$HOME`, and every example
below uses it:

```sh
export HERMES_HOME=/Users/carter/dev/hermes/.hermes
```

Two reasons, and the first is enforcement rather than tidiness. The classifier is
pure and reads no environment, so it cannot know what `HERMES_HOME` points at: it
recognises the organ by a **`.hermes` path segment**. A home whose last segment is
spelled anything else — `/Users/carter/dev/hermes/home`, which is what the
2026-09-20 install created before it was renamed — holds the same `config.yaml` and
the same allowlist, and a write to it classifies as an ordinary workspace or
out-of-scope write rather than `policy.core`. The rule generalizes: any
`HERMES_HOME` is fine as long as its last segment is `.hermes`
(`/srv/tenant-7/.hermes`), and nothing else gets this protection.

The second reason is that a home nobody named is whatever `$HOME` resolves to in
the process that happens to start Hermes, and the live run caught a gateway service
and a terminal disagreeing about exactly that.

With the last segment right, the organ is recognised wherever it sits.
`.hermes/config.yaml`, `.hermes/agent-hooks/`,
`.hermes/shell-hooks-allowlist.json` and `.hermes/hooks*` are `policy.core` at any
path position, so `/Users/carter/dev/hermes/.hermes/config.yaml` and a
repository-relative `.hermes/config.yaml` both match: the classifier's segment walk
was already position-agnostic and nothing was extended for this. An agent that
could write any of them could write itself out of the gate, and the allowlist is
the sharpest of the four — an agent that could edit it could pre-consent itself to
a hook command of its own.

`$HERMES_HOME/.env` and `$HERMES_HOME/auth.json` are a different class again:
`account.credential`, human-only, because what leaves the machine there is the
secret rather than the rule. That is the same split `.approval/env` has.

```yaml
plugins:
  hook_callback_timeout: 600
hooks_auto_accept: true
hooks:
  pre_tool_call:
    - command: "approval hook hermes --dir /path/to/repo --timeout 4m --harness-cap 300s"
      timeout: 300
      fail_closed: true
  post_tool_call:
    - command: "approval hook hermes --dir /path/to/repo"
      timeout: 300
```

Five things about that shape:

- **The event is a mapping KEY, not an `event:` field.** `hooks:` maps an event
  name to a list of entries. An operator who copied another harness's
  `- event: pre_tool_call` shape would produce a file that configures nothing.
- **`--dir` is not optional.** It names the checkout whose policy and log the hook
  resolves against. Without it the hook resolves them from wherever Hermes happens
  to be running, and on this harness that is not the project: a gateway session's
  `cwd` was the user's home. See "The working directory is not where you think"
  below.
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

### The effective window: 240s once you say so, and refused until you do (APRV-423)

The 300s cap above is a ceiling on the hook PROCESS, and before APRV-423 it was
a fact this runtime was never told. When Hermes killed the hook the request it
had opened stayed pending, so a tap arriving afterwards was recorded as a grant
on a tool call nobody was holding: two records about one request, disagreeing
(APRV-410). The fix is to make the question end before its asker does.

The runtime judges every request the hook opens against the **shorter** of:

| | |
| --- | --- |
| the policy's `defaults.approval_ttl` | what the operator declared |
| the harness cap minus a **60s margin** | what this harness leaves room for |

The harness cap is what `--harness-cap` states. **Without the flag this adapter
assumes 30s**, Hermes's default `plugins.hook_callback_timeout`, because that is
the bound a Hermes install runs under until an operator raises it, and 30s does
not clear the margin: every manual-class call is refused
`hook-harness-cap-too-short` with the repair in the message, and nothing is
registered, requested or sent to a phone. (The first pass of APRV-423 assumed the
300s per-entry maximum instead, which on a default install asserted a T+240s
deadline for a hook Hermes kills at 30s: APRV-410 again, with a fictional
deadline. The review caught it; the stricter default is the fix.)

**The recommended config states both values and the flag.** Raise
`plugins.hook_callback_timeout` above the per-entry `timeout`, then pass
`--harness-cap` with the smaller of the two. The config above pairs
`hook_callback_timeout: 600` with `timeout: 300` and `--harness-cap 300s`, and
the effective approval window is then **240s**, four minutes rather than five,
unless the policy's TTL is shorter, in which case the policy wins. A stated cap is
still clamped to the observed 300s per-entry maximum (the probe above armed a
hang and Hermes refused it at exactly 300s), so `--harness-cap 10m` reads as
300s: stating one can only shorten the window, never lengthen it (SPEC.md §11.1
invariant 4). The post half opens no question, so the flag is inert there.

The margin is a constant in `src/core/harness-wait.ts` (`HARNESS_CAP_MARGIN_MS`),
and it is 60s because the daemon's TTL sweep runs on a 30s interval: two intervals
of room mean the `approval.expired` record lands while Hermes is still listening in
the common case. It is the common case and not a guarantee: the daemon skips a
sweep when the previous tick is still running, and the request's `ts` trails the
hook's spawn by intake latency, so a slow enough tick can put the record after the
kill. What keeps a late tap safe regardless is the lazy refusal: the gate judges
the lapse by arithmetic whether or not the record exists, refuses the tap
`expired`, and writes the record then. The margin buys the ordering; the refusal
is what makes the grant impossible.

Three things follow, and they matter here more than on any other adapter
because this is the harness with the smallest ceiling:

- **Say what you configured.** An entry written with `timeout: 120` under a
  raised `hook_callback_timeout` passes `--harness-cap 120s`; an entry at
  `timeout: 300` under `hook_callback_timeout: 200` passes `--harness-cap 200s`.
  The flag is the smaller of the two numbers Hermes will kill the hook at, and a
  flag that overstates it is a window the process will not live to see.
- **`approval.expired` is the runtime's record, never the hook's.** The daemon's
  sweep appends it, or `approval grant` on a lapsed request appends it before
  refusing. A tap after the window is refused with the gate's existing `expired`
  code, lands on the channel as `audit.decision_refused` carrying that code, and
  is never a grant.
- **A cap that does not clear 60s is refused** with `hook-harness-cap-too-short`
  before anything is registered or requested, and on this adapter the deny says
  exactly what to do: raise `plugins.hook_callback_timeout` above the per-entry
  `timeout`, then pass `--harness-cap` with the smaller of the two.

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
session root, so a relative path resolves the way the shell will resolve it. What
the live run added is that having the field is not the same as being sent it, which
is the next section.

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
   is **still UNPROBED and is the highest-risk unknown about this harness**: if
   they do not, one `execute_code` call is an unbounded bypass of this entire
   adapter. The live run cannot settle it, and the reason is the refusal working:
   both `execute_code` calls were refused before they ran (the model asked twice),
   so no inner call was ever made. Settling it means arming the probe to ALLOW one
   `execute_code` call in a scratch project and watching whether a tool call from
   inside the kernel produces an envelope. Until somebody does that, refusing the
   tool is the only answer available to a hook that cannot see inside it.

The code is distinct from its two nearest neighbours because the repairs differ.
`hook-opaque` says a command line carried a construct the classifier could not
read, and its repair is to write the command differently — there is no rewriting
of an `execute_code` call. `hook-unsupported-execution-context` says the harness
did not say *where* a call would run, and on this harness its repair is available
to the session itself (the next section) — here there is no path, argv or directory
to expose at all. The repair for this one is to do the work through `terminal`,
where the words are visible, or through `approval run` with a granted token.

## The working directory is not where you think, and unbound calls are refused

This is the finding of APRV-415, it came from the live run rather than from the
source, and it changes what a session may send.

Three facts, and the trouble is in how they combine:

1. **the envelope's `cwd` is the Hermes PROCESS directory** (`Path.cwd()` in its
   payload builder), not the session's working directory and not the project;
2. **`terminal` keeps a per-session recorded working directory** that a `cd` in an
   earlier call moves, and **no field of the event reports it**;
3. **all four file tools resolve a RELATIVE path against that same recorded
   directory** (`tools/file_tools_paths.py`, `_resolve_path_for_task`).

So a call that does not name an absolute directory would be classified against one
directory and executed in another. Two observations of that, both from the run: a
session launched in the scratch project wrote into
`$HERMES_HOME/cache/scratch`, and a Telegram gateway session's `cwd` was the user's
**home**, where its file landed. And the model sent no `workdir` at all on the
probe's shell call, so this is the ordinary case rather than an edge one.

**The answer is a refusal, and it names its own repair:**

| The call | Answered with |
| --- | --- |
| `terminal` with an absolute `workdir` | classified normally, the existing gate path |
| `terminal` with no `workdir`, or a relative one | `hook-unsupported-execution-context` |
| `write_file`, `patch`, `read_file`, `search_files` with an absolute `path` | classified normally |
| the same tools with a relative `path`, or with none | `hook-unsupported-execution-context` |

The reason text tells the model exactly what to send instead — set `workdir` to an
absolute path, or spell the path in full from `/` — so a session repairs itself on
the next call rather than stalling. That matters more here than it would elsewhere,
because the run also showed what a blocked model does: **it retries the same effect
through another tool or another path.** A refusal that covered only `terminal` would
have moved the work into `write_file`, which is why every gated tool is covered.

Three things worth being explicit about:

- **a missing path is refused like a relative one.** On Claude Code, a `Glob` with
  no path means the workspace, which is inside the gate root by construction. On
  Hermes it means that same unreported recorded directory, so the pass-through
  allow other adapters give it would be an unbounded read here;
- **the fallback other adapters use is not available.** On Muse a non-absolute
  `workdir` falls back to the event `cwd`, which on that harness IS the session
  root. Here the event `cwd` does not even contain the work, so there is no
  directory to fall back to and a fallback would be a guess (SPEC.md §11.1:
  ambiguity resolves to the stricter path, and a self-reported field never lowers
  scrutiny);
- **the refusal is above the policy.** It is answered before the policy is loaded,
  before the log is read and before an open window is looked up, because none of
  those can supply a fact the call does not carry. `approval hook classify` is
  unaffected: it reads command text and no directory.

The probe has a `modify-workdir` trial for the one thing that could retire this
refusal. Hermes documents `{"action":"modify", args}` beside `block`; if a hook may
rewrite a call's `workdir`, the adapter could PIN the directory it classified the
way the Codex adapter pins exact command bytes through `updatedInput`, and the
session would never see a refusal. **UNPROBED:** the trial was added after the live
round and has not been run.

**The post half prints nothing on stdout.** A verdict there would be a permission
decision about a call that has already run. Exit 2 is Hermes's blocking code, so
the post half always exits 0 as well, and the diagnostic goes to stderr. It reads
an outcome from the event's result where one is present — an `exit_code` decides a
shell call, an `error` decides anything, an interrupt is **unreadable** rather
than assumed either way.

**A post event is NOT evidence the tool ran, and this is the correction the live
run forced.** `post_tool_call` fired 29ms after an exit-2 deny, and it fired again
after the armed hang was refused at the 300s cap. Hermes reports the end of its own
dispatch, not the end of an execution. So an envelope carrying **no readable
result** is now treated as unreadable rather than as a completion: crediting a
completion on the event name alone would clear a failure streak (amended SPEC.md
§10.2) for a call that may have been blocked. A blocked call usually has no
`execution.started` to close, because the pre half appended nothing; the case this
protects is the one where the pre half ALLOWED and something later in Hermes's own
executor — `approvals.mode`, a guardrail, a tool-scope check — stopped the call
anyway.

**UNPROBED:** which key a real post event's result arrives under. The capture holds
post envelopes but the round did not enumerate their result keys, so the reader is
shape-only over `exit_code`/`exitCode`/`returncode`, `error` and `status`. A result
object naming none of those is read as a completion, which is the one place this
reader still leans generous, and the repair is one more key here once a capture
names it.

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
- MCP tools register into the same tool registry, so they *should* flow through
  the same dispatch. Not traced end to end.
- A tool Hermes adds in a later release. An unknown tool takes the path it took
  before, which is not a gated one — the alternative would break a session on an
  upgrade.
- The events this hook is not registered for. Hermes has some forty hook events;
  this adapter speaks two.

### Still UNPROBED, and what would settle each

The live round of 2026-09-21 settled the fail-closed question, the dialects, the
envelope shape, the tool names and the working directory. These five it did not,
and each one says what a next round would have to do. Nothing on this list is a
guess dressed as a fact: where the adapter had to choose, it chose the refusing
side.

1. **`execute_code`'s in-process tool calls.** Whether a tool call made from inside
   the persistent kernel re-fires `pre_tool_call`. Arm the probe to ALLOW one
   `execute_code` call in the scratch project and see whether an envelope appears
   for the inner call. The highest-risk unknown here.
2. **First-use consent with no TTY.** The gateway pass ran with consent already
   recorded from a terminal, so it proves the hooks fire for gateway sessions and
   nothing about the sandbox case. Clear
   `$HERMES_HOME/shell-hooks-allowlist.json`, run headless with and without
   `hooks_auto_accept`, and see whether the hook registers.
3. **The `modify` directive.** `arm modify-workdir`, ask for the artifact through
   the shell, and read WHERE it lands. If honoured, the refusal above could become
   a pin the session never sees.
4. **The post event's result keys.** Enumerate the keys a real `post_tool_call`
   carries for a shell call, a write and a failure, so the outcome reader stops
   leaning on shapes.
5. **Subagents.** `delegate_task` can run a child agent in an isolated worktree,
   and whether that child inherits this `HERMES_HOME` and its hooks is untested. A
   child with a different config is a session this gate never sees. Ask for a
   delegated task and look for its envelopes.

## Running the probe

The runbook, verbatim, so it survives without the conversation it was written in.
It has been run once (2026-09-21) and it is written to be run again: the findings
it settled are marked as such in the sections above, and the five it did not are
listed under "Still UNPROBED". Carter runs it; no agent runs `hermes`.

**TWO WINDOWS, and which one needs a restart.** The probe is driven from a shell
while Hermes runs in another, and the two have different rhythms:

- **`arm` needs no restart.** It writes a control file the hook reads on the next
  call, so arm a trial in window A and type the prompt in the already-running
  Hermes in window B;
- **`fail-closed on|off` DOES need a restart.** It rewrites `config.yaml`, and
  Hermes reads that at startup. Quit and relaunch Hermes after every switch, or the
  trial runs under the previous setting and the pair is worthless;
- one arm, one call. It is consumed by the next pre event, so a crash or a hang
  leaves nothing armed behind.

In window A, this saves typing the path forty times:

```sh
probe() { node /Users/carter/dev/approval-md/scripts/probes/hermes-hook.mjs "$@"; }
```

Everything below is written as `probe <verb>` on the assumption that function is
defined.

**A live model is needed first**, because the probe measures TOOL CALLS and only a
model makes them. The home is the one "Installing it" names, and its last segment
must stay `.hermes` or the classifier stops recognising the organ:

```sh
export HERMES_HOME=/Users/carter/dev/hermes/.hermes
hermes --version        # check the fail-closed floor BEFORE anything else
hermes setup            # the wizard: pick a provider and paste a key
hermes setup --portal   # or Nous Portal specifically
hermes model            # change the provider or model later
```

**Check `hermes --version` first.** A build before `main` `118984d7` of 2026-09-20
ignores `fail_closed` silently, which is what made the first round of this probe
measure the wrong thing for a day (`hermes update` fixes it).

Point it at the cheapest small model the provider lists. The five prompts below
are one-line tool calls, so capability is irrelevant and spend is the only axis
that matters. Nous's own documentation names no specific cheap id, so pick one
from `hermes model`'s list rather than from this page. Keys live in
`$HERMES_HOME/.env`, which this repository's classifier treats as
`account.credential`, human-only, and which no agent reads.

**Step 1 — install the hook block and get the prompts.** One command:

```sh
probe setup \
  --home /Users/carter/dev/hermes/.hermes \
  --captures /Users/carter/dev/hermes/probe
```

It appends its block to that `config.yaml` between named markers, backs the
original up once to `config.yaml.aprv398-backup`, and **refuses outright** if the
file already carries a top-level `hooks:`, `plugins:` or `hooks_auto_accept:` key,
printing the block to merge by hand and touching nothing. YAML forbids duplicate
top-level keys, and a config Hermes cannot parse starts with **no hooks at all**,
which looks identical to a probe that never fired. Captures land in
`--captures`, which is where the findings outlive the scratch root.

**With `--home` the REAL home is used**, and the banner says so: the block sits
between the markers, the backup holds what was there before, and the scratch
project is the whole of the control. With no `--home` it builds a scratch
`HERMES_HOME` of its own instead, which is what the test suite drives, and the
banner says that instead. It never assumes a default home: an install directed
elsewhere would leave the probe writing a config nothing reads.

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
once without; **the pair is the finding**, and pass B is what shows the key is what
caused pass A's blocks. The 2026-09-21 round ran pass A only, so the report labels
the two and says which one is missing. `hang` blocks past the 600s timeout: let it,
and do not interrupt it.

```sh
probe fail-closed on        # then QUIT AND RELAUNCH hermes
  probe arm crash           # then: create a file named crash-failclosed-probe.txt containing x
  probe arm hang            # then: hang-failclosed-probe.txt
  probe arm garbage         # then: garbage-failclosed-probe.txt
probe fail-closed off       # then QUIT AND RELAUNCH hermes again
  probe arm crash           # then: crash-failopen-probe.txt
  probe arm hang            # then: hang-failopen-probe.txt
  probe arm garbage         # then: garbage-failopen-probe.txt
```

`fail-closed` rewrites only the region between the markers; everything else in
that config is the operator's and is left alone. The restart is not optional: the
config is read at startup, while an `arm` is read on the next call.

**Read the report's PRESENT artifacts twice.** After a block the model retries the
same effect through another tool or path, and a retry can create the very file whose
absence was the measurement. That happened twice on the live round, so the report
now names any later call that mentioned the same path and says to read that envelope
before concluding.

**Step 4 — the dialect trials, with `fail_closed` ON.** The first two are the
forms the shipped adapter emits; if either is the wrong answer, nothing else
matters.

```sh
probe fail-closed on        # then QUIT AND RELAUNCH hermes
# then arm each of, one prompt per trial, creating <trial>-failclosed-probe.txt:
#   deny-action-exit2   allow-empty-object
#   deny-action   deny-decision   deny-exit2   deny-mixed
#   allow-empty   allow-action-allow
```

`deny-mixed` is the one trial that is deliberately not single-variable: it prints
every dialect at once, which is the payload that failed OPEN on Muse. It blocked
here, so Hermes tolerates a superset. `allow-action-allow` prints the invented
`{"action":"allow"}` and also allowed, which is the spelling working by falling
through, and is why the adapter does not ship it.

**Step 4b — the `modify` trial, which has not been run.**

```sh
probe arm modify-workdir
# then, in hermes: run the shell command: touch modify-workdir-failclosed-probe.txt
```

It reads differently from every trial above: the answer is WHERE the artifact
landed. In `modify-target/` means Hermes **honoured** the hook's `workdir`, in the
project root means it **ignored** it, and in neither means the call never ran. A
honoured directive is the one result that could retire the unbound-directory
refusal, so it is worth a second confirming round before anything depends on it.

**Step 5 — the report.**

```sh
probe report
```

Its first section is the fail-closed answer, with both passes labelled. Paste the
whole thing into the task.

## For Agent Village

Agent Village v2 (Edge City Goa, October to November 2026) runs every resident
agent on Hermes Agent inside a Railway sandbox, one tenant per resident. Its
design document names an optional approval.md Hermes skill as the Sprint 3
deliverable. The adapter is the part this repository owns; the skill and the
hosted daemon are not.

What follows from the sections above, for that deployment:

- **One `HERMES_HOME` per tenant, and start that tenant's gateway from it.** The
  hook config, the consent allowlist and the provider key all live there, so
  per-tenant isolation is per-directory isolation. Export `HERMES_HOME` explicitly
  in each sandbox, spell its last segment `.hermes`
  (`/srv/tenant-7/.hermes`), and launch `hermes gateway run` with that variable in
  its environment rather than inheriting whatever `$HOME` is in a container. A
  gateway started from the wrong home reads the wrong consent allowlist and the
  wrong hooks block, and neither mistake announces itself.

  On this machine that matters today rather than in October: the 2026-09-20
  install's launchd service (`ai.hermes.gateway-<id>`) runs against the DEFAULT home
  under `$HOME`, not against `/Users/carter/dev/hermes/.hermes`, so it is a gateway
  this repository's hooks block does not cover. It had to be stopped for the gateway
  pass of the probe and was restarted afterwards.
- **`--dir` on every entry.** The gateway pass showed a session whose envelope `cwd`
  was the user's HOME, so a hook without `--dir` would resolve its policy and log
  from there. In a sandbox that is the tenant's container root, which holds neither.
- **`hooks_auto_accept: true` or `HERMES_ACCEPT_HOOKS=1` is mandatory.** A sandbox
  has no TTY, and without one of these the hook is silently never registered. This
  is the single most likely way a tenant ends up ungated while looking gated. The
  gateway pass ran with consent already recorded from a terminal, so the headless
  first-use case is still unprobed and this line is still the load-bearing one.
- **`fail_closed: true` on every entry, above the version floor.** Plus, on the
  `pre_tool_call` entry, all three of: `plugins.hook_callback_timeout` raised
  above the entry's `timeout` (the config above uses 600 over 300), `--timeout`
  under 300s, and `--harness-cap` set to the smaller of the two (`--harness-cap
  300s` for that config). Without the flag the hook assumes Hermes's 30s default
  callback timeout and refuses every manual-class call
  `hook-harness-cap-too-short`, so a tenant whose hook command omits it is gated
  shut rather than gated. With it the effective answering window the resident
  gets is 240s: the 300s cap less APRV-423's 60s margin, which is what keeps the
  `approval.expired` record inside the cap in the common case (the lazy `expired`
  refusal covers the rest). Pin the Hermes build at or after `main` `118984d7`: an
  older image ignores the key and every tenant on it has a backstop rather than a
  gate.
- **Absolute paths, or a refusal.** A tenant's agent that sends a `terminal` call
  with no `workdir`, or a relative path, gets
  `hook-unsupported-execution-context` and a reason telling it to retry absolutely.
  Residents should be told this once rather than discovering it as a wall.
- **`execute_code` is refused**, so a resident's agent cannot run arbitrary Python
  through this gate at all. That is a real loss of capability and it is the honest
  trade while its in-process tool calls are unverified.
- **Reaching the hosted daemon from a sandbox is still unsolved here.** The hook
  writes to a log and reads a policy; a sandboxed tenant has neither locally.
  APRV-383 has since landed the part of that a tenant reads: every record the
  hosted daemon appends names the daemon instance that wrote it, and the tenant's
  attested policy may list which daemon ids may write at all
  (`design/hosted-daemon-identity.md`). What it deliberately did NOT do is give a
  sandbox a route to that daemon, so per-tenant deployment still waits on the
  transport, the process isolation and the token scoping that document lists as out
  of scope.

What a future skill would install: the `hooks:` block above with the tenant's own
`--dir`, the consent setting, and whatever route to the hosted daemon that work
settles on. Filed as its own task rather than sketched here. What it can already
rely on: a record a resident's grant produces carries the id of the daemon that
wrote it, so a resident reading their own log can tell which village process acted
for them.

## SPEC status: two hunks PROPOSED, with the evidence, for a human to apply

SPEC.md is still **unamended** by this task, because an agent may not edit it. What
has changed since APRV-398 wrote this section is the condition it was waiting on.
That task's AC5 said: amend only if the probe shows fail-closed enforcement. **The
probe showed it** — crash, garbage and hang all refused on `main` `118984d7`, three
of three, the trials and their artifacts recorded in APRV-398's notes. So the two
hunks below are proposed for Carter to apply, not deferred again, and the evidence
each rests on is named beside it.

This is where the Hermes entry parts company with `docs/grok-hook.md` and
`docs/muse-hook.md`. Those two say a row would be FALSE: their harnesses fail open,
so the SPEC's gate language does not describe them. Here the gate language fits, and
fits with a measurement behind it.

**Hunk 1 — the §10.1 verb listing gains one line.** Evidence: the dialect trials and
the fail-closed trials, plus `tests/cli-hook-hermes.test.ts`'s one-dialect
assertion.

```
approval hook hermes               # gate a Hermes Agent session: snake_case
                                   #   pre_tool_call/post_tool_call JSON in, ONE
                                   #   dialect out ({action,message}), deny at
                                   #   EXIT 2 which blocks unconditionally. A
                                   #   per-entry fail_closed BLOCKS on hook
                                   #   crash, timeout and unparseable output
                                   #   (observed on main 118984d7; its default
                                   #   is false, and v0.21.3 ignores it
                                   #   silently). execute_code is refused
                                   #   outright, and so is any call whose
                                   #   effective directory the event does not
                                   #   carry. See docs/hermes-hook.md
```

**Hunk 2 — the §11.1 organ list gains three paths that are not repository-relative:**
`$HERMES_HOME/config.yaml`, `$HERMES_HOME/agent-hooks/` and
`$HERMES_HOME/shell-hooks-allowlist.json`, with `$HERMES_HOME/.env` and
`$HERMES_HOME/auth.json` as `account.credential` beside them. Evidence:
`approval hook classify` answers `policy.core` for a write to the config at any path
position and `account.credential` for a read of the env file, quoted in
[docs/integrations-considered.md](integrations-considered.md).

This is the hunk worth a human's attention rather than a nod, for two reasons.
Every other organ this project protects sits in a checkout, so the sentence that
describes the set has to change shape to admit one that does not. And the protection
is **conditional on the spelling**: the classifier recognises these by a `.hermes`
path segment, so the SPEC text should say that a home whose last segment is spelled
otherwise is not protected, rather than implying the set is closed under any
`HERMES_HOME`.

A third hunk is now arguable and is still deliberately not drafted: a §6.3 statement
that a harness hook can be enforcement rather than a backstop, which was true of
exactly one harness and is now true of two. It is a change to a general claim rather
than an added row, so it wants its own task and its own reading of §6.3.

## Related

- [docs/muse-hook.md](muse-hook.md) — the dialect lesson this adapter is built on,
  and the fail-open harness it is the counterexample to.
- [docs/grok-hook.md](grok-hook.md) — the other fail-open harness, and the SPEC
  precedent both of them set.
- [docs/codex-hook.md](codex-hook.md) — the harness whose contract withholds the
  per-call working directory, which is the fact `terminal` supplies here.
- [docs/claude-code-hook.md](claude-code-hook.md) — the original adapter, and the
  classifier tables every adapter shares.
- [docs/codex-hook.md](codex-hook.md) again, for the refusal this one is modelled
  on: `hook-unsupported-execution-context` on a `Bash` call whose directory the
  native contract withholds. Same code, same defect, different repair — there the
  fix is upstream, here the session sends an absolute path.
- [docs/integrations-considered.md](integrations-considered.md) — the register
  entry, **adopted with caveats** since the probe ran.
- `scripts/probes/hermes-hook.mjs` — the probe, and `tests/probe-hermes-hook.test.ts`
  the suite that makes it safe to run once.
