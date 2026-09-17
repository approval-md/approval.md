# Gating Meta Muse Code

> ## A CONTRIBUTOR MODEL SHARES WHAT IT SEES. READ THIS FIRST.
>
> Meta sells two tiers of the Muse Spark family and marks the difference in the
> model id. The **Contributor** variant "trades a lower price for permission to
> train on your prompts and completions"; the **Standard** variant is documented
> as never trained on. A Muse Code session on a Contributor model therefore
> discloses every file it reads and every prompt it is sent.
>
> `approval hook muse` refuses **every tool call** when the envelope names a
> Contributor-tier model, with its own code `hook-muse-contributor-model`,
> regardless of what the policy says. No class resolution, no grant and no open
> gate window widens it.
>
> **What the guard cannot do.** A hook fires *after* the prompt has already been
> sent. By the time the adapter sees an event, the model has read the prompt and
> whatever context the harness attached to it. The guard stops the tool read or
> write that would come next; **it cannot recall what was already sent, and it
> cannot see the context the harness attached before the first tool call.** It
> is a backstop. The control is confirming the model in Muse's own picker before
> typing anything, and the setting lives in `~/.config/muse/settings.json` under
> `model`, with `muse --model <id>` per run and `/models` in session. Meta
> documents no project-level model setting, so no file in your repository can
> pin this for you.

Every fact in this document was observed on an installed `muse-bin-1.3.0-R3233.1`
in a live probe on 2026-09-18, not read off a vendor page. The probe is
`scripts/probes/muse-hook.mjs`; the register entry that preceded it
(`docs/integrations-considered.md`) recorded the two questions this settled.

## Muse Code fails open, and this adapter cannot change that

Stated first, after the model warning, because it bounds everything below.

Four failure modes were driven one at a time against a `write_file` the hook
refused. In every one, **the write completed anyway**:

| The hook… | Muse's behaviour | The write |
| --- | --- | --- |
| exits non-zero with no output (crash) | treated as a failed hook | **proceeded** |
| blocks past its configured timeout | waited exactly the configured 30s, then continued | **proceeded** |
| prints unparseable bytes | treated as a failed hook | **proceeded** |
| prints a verdict MIXING dialects, even at exit 2 | treated as a failed hook | **proceeded** in under 80ms |

The fourth is the one that shapes the adapter, and it is the counter-intuitive
one. An output carrying any key Muse does not support makes the **whole output
invalid**; an invalid hook is a failed hook; and a failed hook fails open,
overriding the exit code. So the belt-and-braces answer that satisfies several
harnesses at once satisfies this one **not at all**. Being more explicit made
the deny weaker.

So: this adapter is enforcement **only while it is healthy and answers in time**.
It is a real gate on a working machine and it is nothing at all on a broken one,
which is the opposite of the fail-closed invariant in SPEC.md §11.1. That is a
property of the harness, it is not fixable here, and the honest thing is to say
so rather than to imply a guarantee the runtime cannot keep.

### What follows from failing open

1. **The committed `timeout` must exceed `--timeout`.** The hook waits for a
   human on a manual class; Muse waits for the hook. If Muse's timeout expires
   first it abandons the call and, failing open, runs it **while a human is
   still deciding**. The config below uses 600s against a 9m default wait.
2. **A pending decision is answered as a deny, not by waiting past the
   deadline.** The adapter answers a well-formed refusal inside its own budget
   and the agent retries, exactly as the Claude Code adapter does at its wait
   ceiling. Holding the line open until Muse gives up converts a careful "not
   yet" into an unsupervised "yes".
3. **A crash is an allow.** Anything that can stop the hook process — a missing
   binary, an unreadable policy, a full disk — is an ungated session. Pair it
   with `approval doctor`.

## The dialect: exactly one form, and why this one

Five single-variable trials settled which refusals Muse honours:

| The hook printed | Exit | Blocked? |
| --- | --- | --- |
| `{"hookSpecificOutput":{"hookEventName":…,"permissionDecision":"deny",…}}` | 0 | **yes** |
| `{"decision":"block","reason":…}` | 0 | **yes** |
| nothing on stdout, reason on stderr | 2 | **yes** |
| `{"permission_decision":"deny",…}` (top-level snake_case) | 0 | no |
| all of the above in one object | 2 | no |

**The adapter emits the nested `hookSpecificOutput` form at exit 0, and nothing
else.** Of the three that block, it is the only one that carries a *reason the
model is shown*. That matters more than it looks: in the probe, an agent that
was refused without an explanation shelled out to `cat` the hook's own state
file and `ls /tmp/*.json` to work out why it had been blocked. A silent refusal
buys you an agent investigating your gate. An explained one buys you an agent
that moves on.

The cost of choosing one dialect is that this adapter's output is *specific to
Muse*. That is why it is its own verb rather than a flag on another one.

## Installing it

The file the human commits is `.muse/hooks.json`, in the project. It classifies
`policy.core`, beside `.cursor/hooks.json` and `.grok/hooks/`, because an agent
that could write it could write itself out of the gate.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "approval hook muse --dir /path/to/repo",
            "timeout": 600
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "approval hook muse --dir /path/to/repo",
            "timeout": 600
          }
        ]
      }
    ]
  }
}
```

Three things about that shape, each of which cost a probe round to learn:

- **The event-keyed object is required.** An array-of-events form is rejected at
  startup with `hooks.json: MalformedConfig: hooks must be an object` and
  `Hooks: 0 runnable · 1 warning`. Muse is loud about a malformed hooks file,
  which is the one genuinely helpful thing about its config handling: check that
  banner rather than assuming the hook ran.
- **No `matcher` key.** Claude Code's schema turns on it; Muse's does not use it.
- **`.muse/settings.json` and `.muse/hooks/hooks.json` do not work.** Both were
  written and neither ever fired on this build.

Register **both** events. The pre-execution half answers the verdict; the
post-execution half closes the `execution.started` records the first half wrote,
so the harness scopes have a failure signal to accrue.

## What is gated

Tool names are Muse's own, observed rather than guessed:

| Tool | Role | Path carried in |
| --- | --- | --- |
| `bash` | shell | `command`, with a **per-call `workdir`** |
| `write_file` | file write | `path`, **relative** to the session `cwd` |
| `read_file` | read | `path` (relative or absolute) |
| `search` | read | `paths`, an **ARRAY** |
| `submit_reminder_decision` | the harness's own bookkeeping | — |

**`bash` carries a per-call working directory**, which Codex does not. The
command is classified against `tool_input.workdir` rather than the session root,
so a relative path resolves the way the shell will resolve it. A `workdir` that
is not absolute is ignored in favour of the session `cwd`: a self-reported field
may raise scrutiny, never lower it.

**`search` names a list, and one out-of-scope entry gates the whole call.** A
search over five directories where one is outside the read scope is an
out-of-scope read; gating the first *in-scope* entry instead would let it
through. This is not hypothetical: the live capture caught a `search` reaching
clean out of the workspace, because **Muse applies no workspace confinement in
`permission_mode: "default"`**. In the same session, an operator pasted a
command by mistake and Muse read a file under `~/dev/approval-md` and ran it. The
read jail (APRV-347) is doing real work here.

**`submit_reminder_decision` passes through**, answered with an allow and never
gated. It fired 100 times in a 139-event capture; gating it would put a hundred
questions a turn on an approver's phone to authorize the harness thinking. The
contributor guard still applies to it, so there is no tool that escapes that.

**The post-execution half prints nothing on stdout.** Muse rejects a permission
field on a post event (`unsupported permission_decision in output`), and a
rejected hook is a failed hook. Diagnostics go to stderr. Muse's `bash`
post-event carries a JSON *string* with `exit_code` and `terminal_status`, so
this adapter reads a real outcome: a non-zero exit closes the start as a
failure, and a `terminal_status` that is not `completed` is unreadable rather
than assumed either way.

### What the adapter cannot cover

- Anything Muse does without a tool call: the prompt, the context it attaches,
  its own model calls.
- The session's reads *before* the first hook fires.
- A tool Muse adds in a later release. An unknown tool takes the path it took
  before, which is not a gated one.
- The harness failing open, per the table above.

## SPEC status

SPEC.md has not been amended for this adapter, deliberately, and for the same
reason `docs/grok-hook.md` gives.

A harness row asserting that this hook gates a Muse session would be **false in
the failure cases that matter**: the harness fails open on crash, timeout and
malformed output, so the SPEC's gate language does not describe it. There is
also no harness table in §6.3 today; the hook verbs are enumerated in the §10
verb listing.

The proposed hunk, for a human to decide on, is one line in that listing:

```
approval hook muse                 # gate a Meta Muse Code session: snake_case
                                   #   Pre/PostToolUse JSON in, ONE dialect out
                                   #   (nested permissionDecision, exit 0). The
                                   #   harness FAILS OPEN on hook timeout,
                                   #   crash and malformed output — including
                                   #   output that merely mixes dialects —
                                   #   which §11.1's fail-closed invariant does
                                   #   not survive. A Contributor-tier model is
                                   #   refused for every call; see
                                   #   docs/muse-hook.md
```

An amendment that shipped the row without the fail-open sentence would be the
stale-confident documentation this project exists to avoid.

## A note on where adapter state lives

The probe's own control file lived in a world-readable temp directory, and the
agent read it when it wanted to know why it had been blocked. Nothing was
compromised — it was a probe, its state was a trial name — but the shape of the
mistake is worth naming, because Muse has no workspace confinement and its
`bash` will go looking.

`approval hook muse` holds no such state. Its inputs are the attested policy and
the append-only log, both under the gate root, and both already reachable by an
agent that can read the repository: reading them reveals what the rules *are*,
which is the point of a policy a human attests in the open. Nothing the adapter
consults is a secret whose disclosure would widen what the agent may do. The
rule to keep is the general one — **adapter state that must not be read must not
sit where the gated agent can read it cheaply** — and the way this adapter keeps
it is by having none.

## Related

- `docs/grok-hook.md` — the other fail-open harness, and the SPEC precedent.
- `docs/claude-code-hook.md` — the original adapter.
- `docs/integrations-considered.md` — the register entry, now adopted with caveats.
- `scripts/probes/muse-hook.mjs` — the probe that established every fact here.
- `design/constrained-model-egress.md` — why Muse's egress is unresolved.
