# Codex activation and rollback (APRV-315)

The human half of the Codex integration: what Carter trusts, what that trust
does and does not buy, how to undo it, and the one bounded ceremony that proves
a Telegram rejection and a Telegram approval reach a Codex tool call.

`docs/codex-hook.md` is the adapter's reference. This file is the runbook.
Read the warning first; it decides whether the rest of the page applies.

## Read this before trusting anything

**The hook you would be trusting is fail-open, and the observed Codex version
cannot support everyday use.** Both facts come from the reviewed native probes
in `docs/codex-hook-probe.md` against `@openai/codex` 0.152.1, which is the
version installed on this machine today.

1. **The command hook fails open.** In the bounded native runs, a hook process
   that crashed, that exceeded its timeout, and that wrote malformed stdout each
   produced a visible hook failure in Codex, after which the scratch command
   proceeded and its effect landed. Codex has no setting that makes a failed
   command hook deny. So this hook is a control that works when it works, and it
   is not an enforcement boundary. Nothing about the trust ceremony changes that.
2. **Native Bash is refused outright.** Codex 0.152.1 honours a per-call shell
   working directory that appears in no field of the hook event: `tool_input`
   carries `command` alone, and both the event `cwd` and the hook process `cwd`
   stay at the session root. The adapter therefore denies every native Bash
   `PreToolUse` with `hook-unsupported-execution-context`, before policy, the
   open window, gate-self handling, grant carryover, and execution start. A
   patch dispatched through the shell is reported as Bash and takes the same
   denial.
3. **`PostToolUse` records no outcomes.** An exit 0 and an exit 7 shell call
   raise the same event with the same empty-string `tool_response`, and Codex
   has no counterpart to Claude Code's `PostToolUseFailure`. The adapter prints
   one machine-readable line naming the `execution.started` it left open, and
   appends nothing.

**Therefore: trusting this hook does not enable everyday Codex use, and neither
does a successful phone test.** The ceremony in this file is a bounded
demonstration in a scratch directory, and step 6 removes it again. Leaving it
installed would put a fail-open control in front of a harness whose shell calls
are all refused anyway.

## What the trust ceremony covers

| surface | after trust |
|---|---|
| direct `apply_patch` | gated through the primary's policy, log, budgets and waits; experimental |
| shell, including patches dispatched through it | denied, every call, `hook-unsupported-execution-context` |
| `PostToolUse` | diagnostic only; `post-tool-io` or `post-tool-unreadable-outcome` on stderr, nothing appended |
| hosted tools, `write_stdin` polls, connectors, browser and computer-use paths | outside the local hook path; not covered |
| a crashed, timed-out or malformed hook process | Codex proceeds; not covered |

## 1. Install the hook file (scratch only)

Window: a terminal on the primary machine. The daemon may stay up; nothing here
writes to the log.

The file Codex trusts is `<session directory>/.codex/hooks.json`. Codex loads it
from the directory the session runs in, so putting it in a scratch directory
keeps everyday sessions on the primary untouched.

```sh
export WITNESS="${TMPDIR%/}/aprv-315-witness"
mkdir -p "$WITNESS/.codex"
cp /Users/carter/dev/approval-md/examples/codex-hooks.example.json "$WITNESS/.codex/hooks.json"
command -v approval
```

Open `$WITNESS/.codex/hooks.json` in an editor and replace both placeholders:

- `/absolute/path/to/approval` becomes the path `command -v approval` printed;
- `/absolute/path/to/primary-checkout` becomes `/Users/carter/dev/approval-md`.

Both entries must keep `"matcher": "Bash|apply_patch"`, `"type": "command"` and
`"timeout": 600`. The outer timeout stays longer than the adapter's nine-minute
gate wait, so a decision that takes eight minutes returns a verdict instead of
being killed mid-wait.

Then read the bytes back and check the profile:

```sh
sed -n '1,220p' "$WITNESS/.codex/hooks.json"
approval doctor --dir "$WITNESS"
```

Expected visible result: a `codex-hook-wiring` row reading `CONFIGURED on disk`
and naming `Bash|apply_patch` and the 600 second outer timeout. That row is
about a file. It says nothing about trust, loading, or execution, and the row's
own text says so.

`codex-hook-wiring` is the only row to read here. The scratch directory is not a
checkout, so `attestation`, `audit-sampling` and `identity` will fail and a dozen
rows will be skipped. That is expected. `approval doctor` writes nothing: it
creates no `.approval` directory and appends no record, verified on an empty
scratch directory while writing this runbook.

> **On the primary checkout, this row can never read `pass`.** The repository
> carries `.codex/config.toml` for the MCP entry, Codex merges hook sources, and
> doctor does not interpret inline TOML hook tables. With both files present the
> row reports the merge and leaves the effective configuration undetermined.
> That is one more reason the hook belongs in a scratch directory rather than in
> the primary.

## 2. The trust tap (human only)

Window: the same terminal, now running Codex interactively.

```sh
cd "$WITNESS" && codex
```

Inside the session:

```
/hooks
```

Expected visible result: the `PreToolUse` and `PostToolUse` definitions, shown
with the exact command string from step 1. Compare them against the file
character by character, then confirm trust in that screen. Trust is bound to the
current hook definition, so any later edit of `hooks.json` requires a fresh
review.

Never use `--dangerously-bypass-hook-trust` for this. It exists for one-shot
reviewed automation, and the whole point of step 2 is that a person looked at
the command Codex is about to run on every tool call. Never use
`--dangerously-bypass-approvals-and-sandbox` at all.

Codex's own sandbox and approval mode remain a separate control. Trusting this
hook widens neither.

## 3. Prepare the ceremony

Stay in the Codex session from step 2 and open a second terminal for the checks.

The ceremony gates one direct `apply_patch` that adds a file under
`.github/workflows/` inside the scratch directory. That path resolves to
`policy.edit.ci` through the primary's `protected_paths`, and `policy.edit.ci`
is `manual`, so the decision goes to Telegram. The effect is a text file in a
temporary directory and nothing else.

In terminal two, confirm the class and the channel before asking for anything:

```sh
cd /Users/carter/dev/approval-md && approval policy test policy.edit.ci
```

Expected visible result: a resolution ending `final: manual`. The channel comes
from `defaults.channel` in `APPROVAL.md`, which is `telegram`. If the class
resolves to anything but `manual`, stop: the ceremony proves nothing about a
phone if the class never reaches one. Confirm the daemon is up and the Telegram
listener is healthy the usual way (`approval up`, then `approval status`) before
continuing.

## 4. The rejection

In the Codex session, ask for exactly this, once:

```
Apply a patch that adds the file .github/workflows/aprv-315-witness.yml
containing the single line "# APRV-315 witness". Use the apply_patch tool
directly. Do not use the shell, and do not retry if it is denied.
```

Expected visible result, in order:

1. Codex shows the `PreToolUse` hook running.
2. A Telegram card arrives naming class `policy.edit.ci`, the task
   `hook:codex:<digest>:<digest>`, and the patch bytes.
3. Reject it on the phone.
4. Codex reports the tool call denied, with a reason beginning `hook-rejected:`.

In terminal two:

```sh
test ! -e "$WITNESS/.github/workflows/aprv-315-witness.yml" && echo "absent, as expected"
cd /Users/carter/dev/approval-md && approval log tail -n 20
```

Record **the `seq` of the `approval.rejected` record**. That is the first of the
two numbers this task asks for. Confirm no `execution.started` record follows it
for the same task.

### If the hook denies with `hook-unsupported-execution-context`

Codex routed the patch through the shell instead of calling `apply_patch`
directly. That refusal is the adapter working as designed, and it is the outcome
native v7 observed for a shell-dispatched patch. Note it in the task, ask again
with the wording above, and if Codex keeps dispatching through the shell, record
that the ceremony is unreachable on this Codex version and stop. Do not reword
the request into anything that runs a shell command.

## 5. The approval

Ask for the same patch again, once, with the same wording.

Expected visible result:

1. A second Telegram card for a new task id.
2. Grant it on the phone.
3. Codex reports the tool call allowed, with a reason beginning `granted:`, and
   applies the patch.

In terminal two:

```sh
test -f "$WITNESS/.github/workflows/aprv-315-witness.yml" && echo "present, exactly once"
cd /Users/carter/dev/approval-md && approval log verify && approval log tail -n 20
```

Record **the `seq` of the `approval.granted` record**. That is the second
number. `approval log verify` must exit 0.

The `PostToolUse` half writes one line to Codex's hook debug output reading
`post-tool-unreadable-outcome` and naming the open task. That is expected: the
execution stays open because Codex reports no outcome this runtime can read. Do
not treat the absent outcome as a failure of the ceremony, and do not close the
execution by hand.

## 6. Roll back

Rollback is two independent halves, and both are needed.

**Remove the hook entry.** A reversible rename, from terminal two:

```sh
mv "$WITNESS/.codex/hooks.json" "$WITNESS/.codex/hooks.json.disabled"
approval doctor --dir "$WITNESS"
```

Expected visible result: the `codex-hook-wiring` row returns to
`NOT CONFIGURED on disk`, the same line a project that never installed the hook
gets, and Codex is no longer listed as a registered harness. Renaming the file
back restores the `CONFIGURED` row. This exact sequence is pinned by a
regression test, `the documented rollback returns Codex doctor to NOT
CONFIGURED, and is reversible` in `tests/cli-doctor-codex.test.ts`, which builds
the same fixture in a temporary directory.

**Drop the trust.** Start a fresh Codex session in the scratch directory and run
`/hooks`. With the file renamed away there is nothing left to load, so the
project hooks must no longer be listed. Codex binds trust to a hook definition
rather than to a path, so a definition that no longer exists cannot be loaded by
that trust.

The rename changes nothing in the approval log and nothing in Codex's sandbox.
If a user-level, managed, or plugin hook layer also defines hooks, review and
disable that separately; this runbook only covers the project layer.

Finally, delete the scratch directory:

```sh
rm -rf "$WITNESS"
```

## What to write back into APRV-315

- AC1: the trust tap happened, against which file, and that the rollback in
  step 6 was exercised.
- AC2: the two seqs from steps 4 and 5, and that the effect was absent after the
  rejection and present exactly once after the approval.
- AC3: the `approval log verify` exit code, and the `post-tool-unreadable-outcome`
  line with the task it named. Configuration alone is not completion, and
  neither is a green doctor row.

Everyday Codex activation stays blocked regardless of how this ceremony goes.
Reopen it when a Codex release exposes the effective per-call execution
directory and a success or failure contract, which is APRV-311's remaining
scope.

## Broker session activation (Lane 4a)

This is a **different boundary** from the trust ceremony above, and the two
prove different things. Everything before this section is about the native
Codex hook and the Telegram transport: that a tap happened, that a rejection and
an approval reached a person, that the log recorded both. None of that is
evidence about enforcement. This section is the enforcement half: the workspace
broker (APRV-325.2) and the confined session (APRV-325.3). A green trust
ceremony with no broker enforces nothing, and a working broker with no Telegram
proves nothing about whether a decision can reach a human. Keep the two claims
apart when you write either one up.

Reference: `docs/codex-workspace-broker.md` for the broker,
`docs/codex-enforced-session.md` for the room and what it does not cover.

Human-only steps are marked. Nothing an agent runs performs them.

1. **(human)** Install the package and the reviewed bundle under a root-owned
   install root, per `approval codex prepare` and `setup --check`. No install
   script does this; a person or an MDM workflow does.
2. **(human)** Create the three service principals the manifest names.
3. Verify the host. It fails closed, and every finding is a reason not to
   activate:

   ```sh
   approval codex doctor --strict --manifest /opt/approval/instance.json --json
   ```

   `trusted-path-acl-unproven` is reported unconditionally, because POSIX
   ownership and mode say nothing about ACLs.

4. Verify the room. With no `--` it reports and runs nothing, so an operator
   checking a host does not have to start Codex to learn whether it can host a
   confined session:

   ```sh
   approval codex start --manifest /opt/approval/instance.json --json
   ```

   Expect `"egress":"denied"`, a `write_allow` of exactly one path that is not
   the canonical workspace, and a `read_allow` of exactly two roots — the
   disposable workspace and the canonical workspace — with the gate home in
   neither. An unsupported host refuses here with `sandbox-unsupported` rather
   than running the shell and calling it confined.

5. **(human)** Point the Codex host at the strict server, whose invocation the
   manifest pins:

   ```sh
   approval codex serve --manifest /opt/approval/instance.json
   ```

   It publishes exactly one tool, `codex_workspace_apply`. **Do not add the
   broad `approval mcp serve` beside it** — that server's catalog is the whole
   verb registry and includes `run`, which is the surface the broker exists to
   replace.

6. Run the session's shell work through the room:

   ```sh
   approval codex start --manifest /opt/approval/instance.json -- <command>
   ```

### Roll back the broker session

Subtraction, and it needs no new state.

1. Stop `codex serve` and stop starting shells through `codex start`. Each
   session's disposable workspace is removed when the session ends, so there is
   nothing to clean up.
2. **(human)** Remove the Codex host's MCP entry pointing at the strict server.
3. If a brokered change was interrupted:

   ```sh
   approval codex recover --manifest /opt/approval/instance.json --json
   ```

   It reports `before`, `after` or `mixed` and **repairs nothing**. Exit 1 means
   `mixed`: neither the approved before-state nor the approved after-state, and
   a person's to resolve with `approval execution reconcile`. Rolling it forward
   would guess which half was approved; rolling it back would delete the half
   that committed.
4. **(human)** Nothing under `.approval/` or `APPROVAL.md` is touched by any of
   this, so there is no policy to restore. The log keeps every brokered change
   that happened, which is the point.

### What this activation does not buy

The confinement covers processes this runtime spawns and their descendants, on
macOS. A Codex desktop application a person starts **outside** `codex start` is
not in the room, and `docs/codex-boundary-probe.md` holds what was measured
about it. Linux refuses rather than running unconfined. Inbound sockets are not
denied.

Read scoping IS part of it, since APRV-347's jail landed, and its limit is worth
saying plainly: the jail is a control over paths, so a secret someone committed
inside the canonical workspace is inside a root the session may read and no
sandbox rule changes that. What it buys is that everything outside the two roots
is unreadable whether or not anyone thought to name it.
