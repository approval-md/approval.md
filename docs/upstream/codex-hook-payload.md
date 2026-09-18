# Draft upstream issue for openai/codex (not filed: every ask already had one)

APRV-348. This file was the issue text, ready to paste. It was NOT posted.
GitHub's duplicate check on 2026-09-18 turned up open issues for all three
asks, so the operator commented our 0.152.1 evidence on the canonical one for
each instead, and this draft stays as the source of those comments:

- ask 1, the per-call execution directory on the shell pre-event:
  [openai/codex#32360](https://github.com/openai/codex/issues/32360)
  ([our comment](https://github.com/openai/codex/issues/32360#issuecomment-5723563802));
  later duplicates #33986, #34855, #37251, #40348.
- ask 2, an outcome on the post-event:
  [openai/codex#34289](https://github.com/openai/codex/issues/34289)
  ([our comment](https://github.com/openai/codex/issues/34289#issuecomment-5723571873));
  #24907 proposes the `PostToolUseFailure` shape.
- ask 3, opt-in fail-closed:
  [openai/codex#41979](https://github.com/openai/codex/issues/41979)
  ([our comment](https://github.com/openai/codex/issues/41979#issuecomment-5723583661));
  #45293 is one specific fail-open case.

No agent session in this repository posts publicly. The body below is kept
verbatim so the asks stay readable in one place.

---

**Title:** `hooks`: `Bash` `PreToolUse` omits the per-call execution directory,
and `PostToolUse` carries no outcome

## Summary

I have been building a hook-based approval layer on top of the Codex hooks
contract, and two payload omissions stop it at the shell. Both look like small
additions to the event payload, and I would be glad to send a PR for either or
both if the direction sounds right.

1. A `Bash` `PreToolUse` event carries `tool_input.command` and nothing that
   says where that command will run. When the model selects a working directory
   for the call, the event `cwd` and the hook process's own cwd both stay at the
   session root, so the hook sees `rm data.json` with no way to tell
   `<session root>/data.json` from `<session root>/vendor/upstream/data.json`.
2. A `PostToolUse` event carries no success or failure signal. A command that
   exits 0 and a command that exits 7 raise the same event with the same
   `tool_response`, and there is no `PostToolUseFailure` counterpart to the
   `PreToolUse` event, so the event name is not a reading either.
3. Separately from the payload: a command hook that crashes, times out, or
   prints output the harness cannot parse is reported as a hook failure and the
   tool call then proceeds. There is no way to ask for the opposite.

These are three independent asks and I have kept them separate below so any one
of them can be taken on its own.

## Ask 1: put the effective execution directory on the shell pre-event

**What I would like:** the directory the shell call will actually run in,
carried on the `PreToolUse` event for `Bash` (and for unified execution), as
`tool_input.cwd`.

**Why `tool_input` rather than a new top-level field:** the pre-event's
`tool_input` is the object a hook is allowed to echo back as
`updatedInput`, so it is already the place the contract treats as "the bytes of
this call". A relative path in `tool_input.command` is only half of an action.
The other half is the directory, and today that half is not in the payload at
all.

**Why it matters:** a hook that cannot locate a command cannot decide about it.
The same `command` string means different things in different directories, and
the difference is exactly the one an approval layer exists to catch: a write
that is ordinary inside a scratch directory is not ordinary inside a
configuration directory one level up. Because the omission is silent (the event
does carry a `cwd`, it is just the session root rather than the call's), a hook
author who does not run the nested-directory case will believe they have bound
the action when they have not. My own adapter now refuses every native `Bash`
pre-event unconditionally for this reason, which is a poor experience I would
much rather replace with a decision.

## Ask 2: put an outcome on the post-event

**What I would like:** on `PostToolUse` for `Bash` and unified execution, the
exit status of the call. Either of these shapes would work:

- a structured `tool_response` for shell calls, for example
  `{"exit_code": 7, "success": false, "stdout": "...", "stderr": "..."}`; or
- a top-level `outcome` object alongside `tool_response`, for example
  `{"status": "failure", "exit_code": 7}`, which leaves the existing
  `tool_response` value untouched for anything already reading it.

I would also like the call identifier's behaviour written down. On 0.152.1 the
`tool_use_id` of a call's `PreToolUse` event and of its `PostToolUse` event are
identical, and distinct calls carry distinct values. That is exactly the
property an auditor needs and I rely on it, but I could not find it stated in
the documentation, so today it is an observation rather than a contract.

**Why it matters:** an approval layer records what was authorized and what then
happened. An outcome it cannot read is an outcome it cannot record, and the
honest alternative is to record nothing, which is what my adapter does: its
post-event handler appends no result and prints a diagnostic saying why. Any
outcome it inferred from the current payload would be fabricated.

## Ask 3: let a hook fail closed

**What I would like:** an opt-in setting, per hook entry or per event, that
makes a hook failure deny the call instead of allowing it. Something like
`on_failure = "deny"` on the hook entry, defaulting to today's behaviour so
nothing existing changes.

**Why it matters:** a hook that decides whether a command may run is a control,
and a control whose failure mode is "proceed" is not one. Crash, timeout and
unparseable output are the three ways a hook can fail, and all three currently
resolve in favour of running the command. For a hook that renders a status line
the current default is right. For a hook that answers `deny`, an operator
should be able to say that silence means no.

## Reproduction

Against `@openai/codex` 0.152.1 on macOS, with `features.hooks=true`, a hook
registered for `PreToolUse` and `PostToolUse` with matcher `Bash|apply_patch`,
and a command handler that appends the event it receives on stdin to a file.

Do it in a scratch directory with a nested subdirectory in it, and ask the
session for one shell call that runs in the nested subdirectory and writes a
file there, then for one shell call that exits nonzero, then for one that exits
zero.

### Observation 1: the pre-event has no per-call directory

Top-level keys on every `PreToolUse` event, at this version:

```
cwd, hook_event_name, model, permission_mode, session_id,
tool_input, tool_name, tool_use_id, transcript_path, turn_id
```

`tool_input` keys on every `Bash` event, at this version:

```
command
```

There is no `cwd` and no `workdir` in `tool_input`. The nested call's effect
landed only in the nested directory, so the call did run there, while the
event's `cwd` and the hook process's own cwd both stayed at the scratch root.

The same holds for a patch sent as an `apply_patch` heredoc through unified
execution: that call is reported as `tool_name: "Bash"` with the whole heredoc
in `tool_input.command`, again with no directory of its own, and the patch
landed in the nested directory.

### Observation 2: the post-event has no outcome

Top-level keys on a `PostToolUse` event are the pre-event's keys plus
`tool_response`. For a shell call that succeeded and for a shell call that
exited 7, `tool_response` was the same empty string, and no other top-level
field differed in a way that distinguishes them. There was no
`PostToolUseFailure` event.

### Observation 3: hook failure proceeds

A command handler that crashed, one that exceeded its `timeout`, and one that
printed output the harness could not parse each displayed a hook failure. In
all three cases the shell command then ran and its effect was on disk
afterwards, and a `PostToolUse` event followed.

### Evidence in the open

The sanitized captures and the probe runbook are checked in, if they are useful
to a maintainer:

- `docs/codex-hook-probe.md` in `<this repository>`: the runbook, the exact
  invocation, and the native evidence status section, including the
  hook-failure observations.
- `tests/fixtures/codex-hook/native-v6.sanitized.jsonl` and
  `native-v7-patch-workdir.sanitized.jsonl`: the captured events, with session,
  turn and tool-use identifiers replaced by stable hash pseudonyms and every
  uncontrolled string redacted. The `tool_input_keys`, `tool_input_cwd_type`
  and `tool_input_workdir_type` fields in each record are the raw form of
  observation 1.
- `docs/codex-hook.md` and `tests/cli-hook-codex.test.ts`: the adapter and its
  tests, including the unconditional `Bash` refusal ask 1 would remove.

## Minimal payload diff proposed

```diff
  PreToolUse, tool_name "Bash":
    {
      "hook_event_name": "PreToolUse",
      "session_id": "...",
      "turn_id": "...",
      "tool_name": "Bash",
      "tool_use_id": "...",
      "cwd": "<session root>",
      "tool_input": {
-       "command": "printf x > out.txt"
+       "command": "printf x > out.txt",
+       "cwd": "<session root>/nested"
      }
    }

  PostToolUse, tool_name "Bash":
    {
      "hook_event_name": "PostToolUse",
      ...
      "tool_use_id": "...",            // already stable; please document it
-     "tool_response": ""
+     "tool_response": "",
+     "outcome": { "status": "failure", "exit_code": 7 }
    }
```

And for ask 3, on the hook entry:

```diff
  [[hooks.PreToolUse]]
  matcher = "Bash"
    [[hooks.PreToolUse.hooks]]
    type = "command"
    command = "..."
    timeout = 600
+   on_failure = "deny"   # default "proceed", today's behaviour
```

## Offer

I am happy to send a PR for any of the three, with tests, if a maintainer says
which shape is preferred. Ask 1 and ask 2 look additive to me, so existing
hooks should be unaffected; ask 3 is a new option with today's behaviour as its
default.

For context on where this comes from: I maintain an open file-based convention
and runtime that puts a human approval in front of agent actions with real
side effects, and the Codex hook is one of several harness adapters it carries.
Everything above is about the hook payload rather than about that project.
