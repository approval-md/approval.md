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
