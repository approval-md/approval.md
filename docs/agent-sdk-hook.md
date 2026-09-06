# The Agent SDK shim — `approval hook claude-code` from Python (APRV-242)

`approval hook claude-code` gates what the Claude Code harness runs directly,
and `approval hook cursor` does the same for Cursor. An application built on
`claude-agent-sdk` is neither. It is its own host: it starts the session, it
holds the permission mode, and nothing about it is a `.claude/settings.json`
file that a hook entry could be committed into.

The pattern such an application reaches for by default is the one SPEC.md §2
exists to criticize. Anthropic's commerce-agents blueprint (assessed in
`docs/integrations-considered.md`, verdict declined) runs
`permission_mode="dontAsk"` over an allow-list of tools and registers no
PreToolUse hook at all: permission is decided inside the host process, on a
static list, and an auditor afterwards has nothing to read. The host enforces
locally and keeps no record.

The Python SDK does not require that. It exposes hooks as callables registered
through `HookMatcher`, and a PreToolUse callback receives the same event a
`.claude/settings.json` hook reads on stdin and returns the same
`hookSpecificOutput` permission decision. So the whole integration is a shim:
serialize the event, spawn `approval hook claude-code`, return what it prints.
No new CLI surface, no Python client, no second implementation of anything.
The verdict comes from the same deterministic core, the decision arrives on the
same channel, and the same records reach the same log.

## The two shapes, and where they differ

What the SDK hands the callback, and what the CLI reads on stdin, are the same
object with one gap between them.

| Field | SDK `input_data` | read by `approval hook claude-code` |
| --- | --- | --- |
| `session_id` | yes | yes, as the loop-escalation bucket and a task-id segment |
| `transcript_path` | yes | never read |
| `cwd` | yes | yes, as half of the payload the grant binds to |
| `permission_mode` | yes | never read |
| `hook_event_name` | yes | yes, to dispatch pre-execution against post-execution |
| `tool_name` | yes | yes, and required |
| `tool_input` | yes | yes; `tool_input.command` is required for `Bash` |
| `tool_use_id` | **no: a separate positional argument** | yes, as the other task-id segment |
| `version` | no | optional, for harness provenance (APRV-227) |

One gap, and the shim closes it: `tool_use_id` reaches a Python callback as the
second positional argument rather than as a key of the event, so the shim
merges it in before writing stdin. Nothing else needs translating. `version` is
absent on this surface, which costs no verdict: the gate falls back to `claude
--version` and then to recording nothing (see `approval doctor`'s
`harness-version-unverified` row, and the limit below about whose version that
turns out to be).

The return direction has no gap at all. The CLI prints the nested PreToolUse
envelope on stdout, and that object is exactly what a Python PreToolUse
callback returns:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"autonomous: read.shell"}}
```

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"hook-opaque: bash runs a shell script (segment: bash -c 'git push --force'). Rewrite it as a command the classifier can read, or run the effect through `approval run` with a granted token."}}
```

Both are pinned as fixtures under `tests/fixtures/agent-sdk/`, and
`tests/agent-sdk-hook.test.ts` runs the real CLI on the pinned stdin and
asserts it still prints them. The reasons quoted there come from the policy
that test writes; yours will name your own classes.

## The recipe

Copy this file into your application as `approval_hook.py` (the wiring below
imports it under that name). It is `docs/agent-sdk-hook.py` in this repository,
and the block below is that file verbatim (a test fails if the two drift).

```python
"""approval.md's gate, in front of a Python Claude Agent SDK application (APRV-242).

Register `approval_gate` as a PreToolUse hook and every tool call the SDK is
about to make is classified and resolved against `APPROVAL.md` by the same
binary that gates Claude Code and Cursor. No new surface, no Python client:
the shim writes JSON to `approval hook claude-code` and reads a verdict back.

This file is documentation, and it is a fixture. It is copied verbatim into
`docs/agent-sdk-hook.md`, and `tests/agent-sdk-hook.test.ts` fails when the
two drift. Nothing here runs in CI: this repository executes no Python.

Four properties are load-bearing.

1. THE SHIM SUPPLIES `tool_use_id`. The SDK hands a hook callback three
   arguments: the event dict, the tool-use id, and a `HookContext`. The CLI
   hook reads ONE JSON object on stdin and looks for `tool_use_id` inside it,
   because that is where a `.claude/settings.json` hook finds it. So the shim
   merges the second argument into the first. Without it the gate's task id
   loses the segment that tells two calls in one session apart, and the
   post-execution event cannot find the task the pre-execution event opened.

2. THE CLI'S STDOUT IS ALREADY THE SDK'S RETURN SHAPE. `approval hook
   claude-code` prints the nested PreToolUse envelope Claude Code reads, and a
   Python callback returns that same `hookSpecificOutput` object. The mapping
   is a re-emission of three known keys, never a translation.

3. EVERY UNREACHABLE GATE IS A DENY. A spawn that fails, a wait that overruns,
   a non-zero exit, stdout that will not parse: each returns a deny carrying an
   `agent-sdk-shim-` code, deliberately outside the runtime's own frozen
   `hook-*` vocabulary so that a transcript says which side refused. Nothing on
   the PreToolUse path returns an empty dict; an empty return means "no
   decision" and the tool would run.

4. THE GATE DECIDES, NOT THE HOST. Leave `permission_mode` at `"default"`. The
   `permission_mode="dontAsk"` plus allow-list pattern of the commerce-agents
   blueprint (docs/integrations-considered.md) is exactly the "harness enforces
   locally, no record" arrangement SPEC.md §2 criticizes: it decides in the
   host process and leaves nothing an auditor can read afterwards.
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any

# The primary checkout whose committed log the daemon writes. Policy discovery
# AND the log both follow this flag; the gate is never pointed at a scratch
# directory, because a log created where a process happens to stand forks a
# chain off the real log's tail (APRV-101).
APPROVAL_DIR = os.environ.get("APPROVAL_DIR", os.getcwd())
APPROVAL_BIN = os.environ.get("APPROVAL_BIN", "approval")
APPROVAL_ACTOR = os.environ.get("APPROVAL_ACTOR", "agent:agent-sdk")

# How long the gate waits for a human on a manual class, in the CLI's own
# duration spelling. The subprocess deadline below must exceed it, or this
# process would give up on a question that is still live and deny a command a
# tap is about to grant.
APPROVAL_WAIT = os.environ.get("APPROVAL_WAIT", "9m")
SUBPROCESS_DEADLINE_SECONDS = 600.0

# The shim's own refusal vocabulary. Distinct by construction from the frozen
# `hook-*` codes in src/cli/hook.ts: a reason under this prefix was written
# here, by this file, because the gate could not be reached or read at all.
SHIM_DENY_PREFIX = "agent-sdk-shim"

PRE_TOOL_USE = "PreToolUse"
POST_TOOL_USE = "PostToolUse"


def _verdict(permission: str, reason: str) -> dict[str, Any]:
    """The one shape a PreToolUse callback returns."""
    return {
        "hookSpecificOutput": {
            "hookEventName": PRE_TOOL_USE,
            "permissionDecision": permission,
            "permissionDecisionReason": reason,
        }
    }


def _deny(code: str, detail: str) -> dict[str, Any]:
    return _verdict("deny", f"{SHIM_DENY_PREFIX}-{code}: {detail}")


def _stdin_payload(
    input_data: dict[str, Any],
    tool_use_id: str | None,
    event_name: str,
) -> dict[str, Any]:
    """The event the SDK gave us, in the shape the CLI hook reads on stdin.

    Copied rather than mutated: the SDK owns `input_data`, and other hooks in
    the same matcher list see it after this one.
    """
    payload = dict(input_data)
    payload.setdefault("hook_event_name", event_name)
    payload.setdefault("cwd", os.getcwd())
    if tool_use_id is not None:
        payload["tool_use_id"] = tool_use_id
    return payload


async def _run_hook(payload: dict[str, Any], wait: str | None) -> tuple[int, str, str]:
    argv = [
        APPROVAL_BIN,
        "hook",
        "claude-code",
        "--dir",
        APPROVAL_DIR,
        "--as",
        APPROVAL_ACTOR,
    ]
    if wait is not None:
        argv += ["--timeout", wait]
    process = await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(
            process.communicate(json.dumps(payload).encode("utf-8")),
            timeout=SUBPROCESS_DEADLINE_SECONDS,
        )
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()
        raise
    return process.returncode or 0, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


async def approval_gate(
    input_data: dict[str, Any],
    tool_use_id: str | None,
    context: Any,
) -> dict[str, Any]:
    """PreToolUse: ask the gate, and answer the SDK with what it says.

    `context` is the SDK's `HookContext`; nothing here reads it, and it is
    accepted only because the callback signature has three positional
    arguments.
    """
    payload = _stdin_payload(input_data, tool_use_id, PRE_TOOL_USE)
    try:
        code, out, err = await _run_hook(payload, APPROVAL_WAIT)
    except asyncio.TimeoutError:
        return _deny("timeout", f"the gate did not answer in {SUBPROCESS_DEADLINE_SECONDS:.0f}s")
    except OSError as cause:
        return _deny("unreachable", f"cannot run {APPROVAL_BIN}: {cause}")

    if code != 0:
        # Exit 2 is a misconfigured hook (an unknown flag, a bad identity), and
        # every classified or decided outcome is an exit 0. So a non-zero code
        # is never a verdict, and blocking is the correct reading of it.
        return _deny("exit", f"`{APPROVAL_BIN} hook claude-code` exited {code}: {err.strip()}")

    try:
        parsed = json.loads(out)
    except json.JSONDecodeError:
        return _deny("unreadable", f"stdout was not JSON: {out.strip()[:200]!r}")

    specific = parsed.get("hookSpecificOutput") if isinstance(parsed, dict) else None
    decision = specific.get("permissionDecision") if isinstance(specific, dict) else None
    if decision not in ("allow", "deny"):
        return _deny("unreadable", f"stdout carried no permission decision: {out.strip()[:200]!r}")

    reason = specific.get("permissionDecisionReason")
    return _verdict(decision, reason if isinstance(reason, str) else "")


async def approval_report(
    input_data: dict[str, Any],
    tool_use_id: str | None,
    context: Any,
) -> dict[str, Any]:
    """PostToolUse: tell the gate how the call it allowed turned out.

    The gate asks no permission question here, so this returns the empty dict
    (no decision) on every path, including failure. The run is a REPORT, and a
    shim that denied the next tool call because a report could not be delivered
    would be failing closed against the wrong event.

    Read `docs/agent-sdk-hook.md`'s limits before relying on this: the SDK's
    PostToolUse event is the completion path, and a Claude Code
    `PostToolUseFailure` has no SDK equivalent this recipe can register, so a
    failing tool call may reach the gate as nothing at all.
    """
    payload = _stdin_payload(input_data, tool_use_id, POST_TOOL_USE)
    try:
        await _run_hook(payload, None)
    except (asyncio.TimeoutError, OSError):
        pass
    return {}


def approval_hooks() -> dict[str, Any]:
    """The `hooks=` value for `ClaudeAgentOptions`.

    The matcher is the tool-name pattern the `.claude/settings.json` entry
    uses. If your SDK version matches tool names exactly rather than by
    pattern, register one `HookMatcher` per name instead; the callback is the
    same object either way.
    """
    from claude_agent_sdk import HookMatcher

    gated = "Bash|Edit|Write|MultiEdit|NotebookEdit"
    return {
        "PreToolUse": [HookMatcher(matcher=gated, hooks=[approval_gate])],
        "PostToolUse": [HookMatcher(matcher=gated, hooks=[approval_report])],
    }
```

## Wiring it

```python
from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient

from approval_hook import approval_hooks

options = ClaudeAgentOptions(
    permission_mode="default",
    hooks=approval_hooks(),
)

async with ClaudeSDKClient(options=options) as client:
    await client.query("tidy up the changelog and push the branch")
```

Set `APPROVAL_DIR` to the primary checkout whose committed log the daemon
writes, and `APPROVAL_ACTOR` to the identity this application should appear
under (`agent:<something>`; it is the actor recorded on every event the run
produces). `APPROVAL_BIN` names the executable, and it is one argument rather
than a command line: to run an unpackaged build during development, point it at
an absolute path or at a small script that execs `node dist/src/cli/main.js`.

## Fail closed, on this surface too

| what happened | what the callback returns |
| --- | --- |
| the gate allowed | `allow`, with the gate's own reason |
| the gate denied | `deny`, with the gate's `hook-*` code |
| `approval` is not on `PATH` | `deny`, `agent-sdk-shim-unreachable` |
| the subprocess outlived its deadline | `deny`, `agent-sdk-shim-timeout` |
| a non-zero exit (a misconfigured hook, exit 2) | `deny`, `agent-sdk-shim-exit` |
| stdout was not a verdict | `deny`, `agent-sdk-shim-unreadable` |

The `agent-sdk-shim-` prefix is the point of the bottom four rows. A reason
under it was written in Python, by the shim, about a gate it could not reach,
and it is disjoint from the runtime's frozen `hook-*` vocabulary by
construction, so a transcript never leaves an auditor guessing which side
refused. Nothing on this path returns the empty dict: in the SDK's hook
protocol an empty return is "no decision", and a shim that answered that way
when the gate was unreachable would be silently permissive exactly when it
mattered.

## Limits

- **A failing tool call may reach the gate as nothing.** Claude Code dispatches
  failures to `PostToolUseFailure`, and this recipe registers `PostToolUse`
  only, because that is the event the Python SDK exposes. Where a failure is
  not delivered, `execution.started` stays open and the loop escalation of
  SPEC.md §10.2 does not count it. `approval doctor`'s
  `harness-hook-outcomes` row is where that shows up.
- **The recorded harness version is the CLI's, not the application's.** The SDK
  event carries no `version`, so provenance falls back to `claude --version`
  (APRV-227), which on a machine running an SDK application usually answers,
  because the SDK drives that same CLI. What lands in the record is therefore
  the Claude Code version underneath the application, and the application's own
  version is recorded nowhere. Read `harness_version` on these records
  accordingly.
- **The host still owns the process, and this surface has no organ ceremony.**
  A shim registered in the host's own code is only as binding as the host's own
  code: an application that removes the registration removes the gate. That is
  true of `.claude/settings.json` too, which is why that file is `policy.core`,
  why a human commits it, and why it can be attested as a gate organ. A Python
  module cannot be: `approval policy attest --organ` accepts the built-in
  organ paths only, and refuses anything else with `path-not-organ`. So the
  registration is held by code review and by the CI-side
  `scripts/protected-path-guard.mjs` on whatever repository carries it, and by
  nothing this runtime enforces. Extending the organ set to a declared host
  module is the obvious follow-up and is not in this recipe.
- **MCP tool calls are not gated here.** The matcher above names the shell tool
  and the file tools, which are the tools this hook classifies. Adding `mcp__*`
  to it changes nothing: the hook answers "is not a gated tool" and allows,
  because a tool name it does not adapt is a tool whose effect it cannot read.
  An MCP tool with real-world effects is gated on its own side, by the server
  calling the runtime.

## What was verified, and what was not

The CLI side of every claim on this page is executed:
`tests/agent-sdk-hook.test.ts` spawns the real binary on the pinned stdin and
asserts the printed verdicts, and the recipe above is asserted byte-identical
to `docs/agent-sdk-hook.py`.

The SDK side is read from the API and not from a live run. No Python runs in
this repository's CI, `claude-agent-sdk` is not a dependency here, and the
worktree this page was written in had no network. So three statements rest on
the SDK's documented interface rather than on an observed call, and the first
is the one to check first if the recipe misbehaves:

1. the three-argument callback signature `(input_data, tool_use_id, context)`,
   and therefore the whole reason the shim merges `tool_use_id` into the event;
2. that `input_data` carries `session_id`, `cwd`, `permission_mode` and
   `transcript_path` alongside `tool_name` and `tool_input` (the shim defaults
   `cwd` and `hook_event_name` when they are absent, so a version that omits
   them degrades instead of failing);
3. that `HookMatcher(matcher=...)` takes the same tool-name pattern the
   settings file takes, rather than an exact name.

Where a future SDK release differs, the fixtures under
`tests/fixtures/agent-sdk/` are where the difference gets written down, and the
CLI side does not move.
