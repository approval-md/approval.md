# Gating Grok Build

`approval hook grok` answers Grok Build's PreToolUse hook in Grok's own
dialect. It resolves every command through the same deterministic core as
`approval hook claude-code` and `approval hook cursor`: same classifier, same
policy, same log, same refusal codes. What differs is the wire format and one
number.

Read the next section before you commit anything.

## Grok Build fails open, and this adapter cannot change that

Grok Build's documented hook contract treats three conditions as "no opinion",
and in each of them the command runs:

- the hook exceeds its configured `timeout`,
- the hook process crashes or cannot be spawned,
- the hook prints output Grok cannot parse.

There is no documented setting that makes any of those block instead. Cursor
has `failClosed` on the hook entry; Grok Build does not.

**This contradicts the fail-closed invariant this project is built on**
(SPEC.md §11.1, and the "Fail closed" rule in CLAUDE.md). Everywhere else in
this system, a gate that cannot reach the policy, cannot read the log, or
cannot decide, denies. Under Grok Build, a gate that cannot run at all is a
gate that is not there, and the session proceeds exactly as if no hook were
installed.

The adapter is written to keep as much inside its own control as it can. It
denies on unparseable input rather than exiting non-zero without a body, it
denies on any internal throw, and it denies when the policy or the log is
unreachable. Those are the cases where the hook DID run. They are not the
cases this section is about.

### What the adapter cannot cover

| Condition | What Grok does | What the adapter can do |
| --- | --- | --- |
| Hook exceeds the entry's `timeout` | runs the command | nothing; the process is gone |
| Hook binary missing, or `approval` not on PATH | runs the command | nothing; it never started |
| Node or the CLI crashes before printing | runs the command | nothing |
| Grok cannot parse the verdict | runs the command | keep the output shape fixed and tested (`tests/cli-hook-grok.test.ts`) |
| Machine has no policy file | hook runs, denies | denies `hook-policy-unavailable` |
| Log unreachable | hook runs, denies | denies `hook-log-unreachable` |
| Any unexpected throw | hook runs, denies | denies `hook-io` |

So: a Grok Build session gated this way is gated while the hook works, and
ungated in every way the hook can fail to work. Treat that as the security
property, not as an implementation detail. An operator who needs a gate that
holds under harness failure should not run unsupervised side-effecting work in
Grok Build today.

## The compatibility hazard this adapter exists to remove

Grok Build states that it reads `.claude/settings.json` and
`.cursor/hooks.json` for compatibility. If that read fires a committed
`approval hook claude-code` entry inside a Grok session, the result is worse
than no hook:

1. Grok sends its camelCase envelope. The claude-code adapter looks for
   `tool_name`, finds nothing, and denies `hook-io`.
2. It prints that deny in the nested Claude envelope,
   `{"hookSpecificOutput":{"permissionDecision":"deny",…}}`.
3. It exits **0**, because that is how Claude Code expects a verdict.
4. Grok reads exit 0 as **allow**, and runs the command.

Every command appears gated. None of them is. `approval hook grok` closes that
by speaking the dialect Grok reads: the deny is exit 2, which Grok acts on.

Whether that compatibility read actually fires is unverified. APRV-243 AC1 is a
live probe on an installed Grok Build, and `scripts/probes/grok-build-hook.mjs`
is the script that answers it, in ONE command since APRV-418: see "Running the
probe" below. Until it runs, the register entry in
`docs/integrations-considered.md` stays **parked**.

## The dialect

| | Claude Code / Cursor / Codex | Grok Build |
| --- | --- | --- |
| Envelope keys | `tool_name`, `tool_input`, `session_id`, `hook_event_name` | `toolName`, `toolInput`, `sessionId`, `hookEventName`, plus `workspaceRoot` |
| Verdict | nested `hookSpecificOutput`, or Cursor's `{permission,…}` | `{"decision":"allow"\|"deny","reason":"…"}` |
| Deny exit code | 0 | **2** |
| Allow exit code | 0 | 0 |
| Post-execution exit | 2 makes stderr visible | always 0 (see below) |

Three details of the implementation are worth stating plainly.

**snake_case wins.** The Grok adapter reads `tool_name` first and falls back to
`toolName`. An envelope carrying both spellings therefore resolves the same way
for every harness, and cannot be used to show the classifier one command and
the harness another. The other adapters do not read camelCase at all: a Claude
Code event with the wrong spelling is a malformed event, and the strict answer
to a malformed event is the deny it already gets.

**`workspaceRoot` is ignored.** The classifier resolves relative paths against
the directory the command will actually run in, which is `cwd`. A workspace
root is a different fact, and reading it as if it were `cwd` would bind the
wrong paths.

**The post-execution event always exits 0.** On every other harness, a
post-execution hook that could not record its counterpart exits 2 so its stderr
line is visible. On Grok, exit 2 is a verdict, and a verdict about a tool call
that has already finished is meaningless at best. So the machine-readable line
still goes to stderr and the exit code stays 0. Whether Grok shows that line is
Grok's business; losing a debug line is a smaller harm than emitting a decision
the protocol will act on.

## Installing it

`approval hook grok --help` prints the file. It is `.grok/hooks/pre-tool-use.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "approval hook grok --dir /path/to/your/repo",
            "timeout": 600
          }
        ]
      }
    ]
  }
}
```

**The entry's `timeout` must exceed the adapter's `--timeout`** (default `9m`).
This is the one number in the file that can hurt you. A manual class puts the
command on a human's phone and waits; if Grok's own timeout expires first, Grok
abandons the hook, fails open, and runs the command **while the human is still
being asked about it**. The approver then taps Approve or Reject on something
that already happened. 600 seconds against a 9-minute wait is the margin this
pairing assumes; if you lengthen `--timeout`, lengthen the entry's `timeout`
further, in that order.

`.grok/hooks/` classifies `policy.core`, like `.cursor/hooks.json` and
`.claude/settings.json`. An agent that could write that directory could write
itself out of the gate, so the hook refuses to let one, and the human commits
the file by hand (`src/core/command-class.ts`, `protectedPathClass`).

The agent identity is `agent:grok` by default, so a log can be read back by
harness. `--as agent:<id>` overrides it.

## What is gated

The same tools Claude Code's adapter gates, because Grok's tool names follow
Claude Code's:

- `Bash` for shell;
- `Edit` / `Write` / `MultiEdit` / `NotebookEdit` for file writes;
- `Read` / `Glob` / `Grep` for reads, scoped by APRV-347's read jail.

A read inside the read roots keeps the pass-through allow it has always had. A
read outside them resolves `read.file.out_of_scope` through the policy like any
other class, which on this harness means a `{"decision":"deny"}` at **exit 2**.
A `Glob` or `Grep` carrying no path names no file and stays ungated.

Both directions of the read-tool guess are safe in the way APRV-347 makes them
safe. A name listed here that Grok never sends is inert: an unmatched tool
takes the path it took before. A name Grok sends that is NOT listed would be an
unscoped read, so the wider Claude Code set is the fail-closed guess. And a
read that arrives as a shell command through `Bash` is scoped by the classifier
regardless, which is the floor under all of it.

**The tool lists are unverified**: they follow from Grok Build's documentation
and from the compatibility read, not from an observed session. The probe
records the tool names an actual Grok session sends, and both lists are
corrected to match before the register entry moves from parked.

Anything else passes through with `is not a gated tool`, at exit 0.

Starting a Grok session from inside another gated session is itself a gated act
since APRV-354: `grok …` classifies `harness.launch.grok` with the argv bound
and `grok --version` classifies `read.shell`, and a grant of the launch class
covers the launch and never what the launched session then does, which is what
this adapter exists to bring back inside the gate. See
[docs/claude-code-hook.md](claude-code-hook.md#launching-an-agent-harness-aprv-354).

## Running the probe

APRV-243 AC1 is the one criterion still open, it is Carter's, and since APRV-418
it is **one command** rather than an afternoon of typed prompts. The probe follows
the driver convention in
[docs/probe-driver-convention.md](probe-driver-convention.md).

**Step 1 — install Grok Build and set a key, once.** The installer is opaque to
the classifier (`curl … | bash`), so a human runs it, and the harness's own setup
puts the key where the harness reads it. No agent touches either.

**Step 2 — one command, run by the operator.**

```sh
node scripts/probes/grok-build-hook.mjs run \
  --captures /Users/carter/dev/grok-probe
```

It reads `grok --version` before it writes anything, builds a scratch project,
registers **both** candidate hook files in it, drives six trials through the
harness's one-shot mode and prints the report. There is no fail-closed version
floor for this harness, because no build difference has been measured here, and
the driver says so rather than inventing one; an unreadable version line still
refuses before anything is written.

**What the classifier says about that command, and the one open question in it.**
Unlike the Hermes driver, which names a protected gate organ and therefore
classifies `policy.core`, this one names no protected path:

```text
$ approval hook classify -- "node scripts/probes/grok-build-hook.mjs run --captures /Users/carter/dev/grok-probe"
class                  rule         command
files.write.workspace  node-script  node scripts/probes/grok-build-hook.mjs run --captures /Users/carter/dev/grok-probe

classes: files.write.workspace
```

So the harness hook would ALLOW an agent to run it, and **an agent still must
not**, for a reason the class does not carry: the `grok` invocations inside it are
child processes the hook never sees, so a wrapper puts `harness.launch.grok`
outside the gate entirely, which is exactly what APRV-354 closed for the bare
command. This is recorded as an open question for a human rather than settled
here: the honest statement today is that the round is the operator's, and the
asymmetry with the Hermes command is a fact about paths rather than a decision
about drivers.

**It no longer asks anybody to edit this repository's own Claude settings file.**
The old runbook did, that file is `policy.core`, and a probe entry left behind in
a real checkout is a hook that answers nothing. Both registrations now go in the
scratch project, each naming its own `--config-id`, which is what lets one round
answer which file a session of this harness reads:

| registration | what it is |
| --- | --- |
| the project's Claude settings file | the compatibility read under test |
| `.grok/hooks/pre-tool-use.json` | the CONTROL. If neither fires, the round is inconclusive rather than reassuring |

**Step 3 — read the three answers**, which are the report's first three sections:
which registration fired, what the envelope carries, and what the harness does
with a Claude nested deny at exit 0. The six trials sit under them:

| trial | what it licenses or condemns |
| --- | --- |
| `hazard` | a deny in the NESTED Claude shape at **exit 0**, which is what a committed `approval hook claude-code` entry answers. If the artifact lands, the hazard above is real |
| `deny-grok-exit2` | the deny this adapter ships. If this does not block, the adapter is not even a backstop |
| `deny-grok-exit0` | the same body without the blocking exit code, so exit 2 is shown to be load-bearing or not |
| `allow` | the CONTROL. If this is withheld, the harness is blocking everything and no line above is a measurement |
| `crash`, `garbage` | the fail-OPEN cases this page opens with, measured rather than repeated |

**Correct this page from answer 2.** The tool lists under "What is gated" follow
this harness's Claude Code lineage rather than an observed session. A tool name in
the report that is not on those lists is an ungated call, which is the direction
that matters.

The hand-typed verbs (`setup`, `arm <trial>`, `report`) still work for a round
where somebody wants to watch one trial, and the report says which way the round
was run.

## SPEC status

SPEC.md has not been amended for this adapter, deliberately.

APRV-243 AC4 asks for a harness row in the SPEC "if behaviour matches cursor".
It does not match, in the one way that matters: Cursor's hook entry has
`failClosed`, so a Cursor hook that dies still blocks, and the SPEC's harness
language can describe it as a gate. Grok's cannot be made to block, so a row
asserting the same property would be false. There is also no harness table in
§6.3 today; the hook verbs are enumerated in the §10 verb listing.

The proposed hunk, for a human to decide on, is one line in that listing beside
the other three:

```
approval hook grok                 # gate a Grok Build session: camelCase
                                   #   PreToolUse JSON in, {decision} out,
                                   #   deny is EXIT 2. The harness FAILS OPEN
                                   #   on hook timeout, crash and malformed
                                   #   output, which §11.1's fail-closed
                                   #   invariant does not survive; see
                                   #   docs/grok-hook.md
```

An amendment that ships the row without that second sentence would be the
stale-confident documentation this project exists to avoid.

## Related

- `docs/cursor-hook.md` — the adapter this one is modelled on.
- `docs/claude-code-hook.md` — the original, and the settings file Grok reads.
- `docs/integrations-considered.md` — the register entry, parked until AC1.
- `docs/probe-driver-convention.md` — the driver shape, what the classifier says
  about a driver command and the credential options this probe follows.
- `scripts/probes/grok-build-hook.mjs` — the probe for AC1, one command.
- `tests/probe-grok-build-hook.test.ts` — the probe's own suite, driven with
  canned envelopes and a fake harness binary so AC1's script is verified before
  any install.
- `tests/cli-hook-grok.test.ts` — allow, deny at exit 2, unparseable input,
  post-event no-op, dialect precedence, the read jail, and the `policy.core`
  path rule.
- `conformance/vectors/hook-read-scope.v1.json` — the six `grok-*` vectors,
  which pin the exit code as well as the verdict, because a Grok deny printed
  at exit 0 is read by that harness as an allow.
