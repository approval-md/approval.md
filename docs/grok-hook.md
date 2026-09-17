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
is the read-only script that answers it. Until it runs, the register entry in
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
Claude Code's: `Bash` for shell, and `Edit` / `Write` / `MultiEdit` /
`NotebookEdit` for file writes. **This half is unverified**: it follows from
Grok Build's documentation and from the compatibility read, not from an
observed session. The probe records the tool names an actual Grok session
sends, and this list is corrected to match before the register entry moves from
parked.

Anything else passes through with `is not a gated tool`, at exit 0.

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
- `scripts/probes/grok-build-hook.mjs` — the read-only probe for AC1.
- `tests/cli-hook-grok.test.ts` — allow, deny at exit 2, unparseable input,
  post-event no-op, dialect precedence, and the `policy.core` path rule.
