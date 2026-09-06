---
id: APRV-242
title: >-
  Agent SDK hook recipe: `approval hook claude-code` from a Python HookMatcher
  callback, with JSON-shape conformance tests
status: In Progress
assignee:
  - '@opus-242'
created_date: '2026-09-02 20:55'
updated_date: '2026-09-06 07:56'
labels:
  - enhancement
dependencies: []
references:
  - docs/integrations-considered.md
  - docs/claude-code-hook.md
  - >-
    https://github.com/anthropics/commerce-agents/blob/main/merchant-agent/runtime-agent-sdk/merchant_agent_sdk/agent.py
priority: medium
ordinal: 193000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
M8 gates Claude Code (approval hook claude-code) and Cursor (approval hook cursor), but an application built on claude-agent-sdk is neither: the reference commerce-agents blueprint (github.com/anthropics/commerce-agents, assessed 2026-09-02 in docs/integrations-considered.md) runs permission_mode="dontAsk" with a tool allow-list and no PreToolUse hook, which is the "harness enforces locally, no record" pattern SPEC §2 critiques. The Python Agent SDK exposes hooks as async callables (HookMatcher) that receive the same PreToolUse input the Claude Code hook reads on stdin and return a hookSpecificOutput permission decision. A documented shim, spawning `approval hook claude-code --dir <primary> --as agent:<id>` with json.dumps(input_data) on stdin and mapping its verdict to the SDK return shape, makes every Agent SDK app gateable with no new surface and no Python client. The shapes must be verified against the SDK, not assumed; where they differ the recipe says so and a fixture pins both.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 docs/claude-code-hook.md (or a sibling doc it links) carries a Python recipe: a HookMatcher callback that runs `approval hook claude-code` and returns the SDK permission decision, with fail-closed behavior when the hook process cannot be reached
- [x] #2 A fixture pins the PreToolUse input shape the Python Agent SDK passes to a hook callback and the hookSpecificOutput shape it expects back, and a test asserts the hook output maps onto it (allow, deny with reason)
- [x] #3 SPEC §14 M8 sentence lists Agent SDK apps as reachable through the Claude Code hook surface, marked as an amendment for human sign-off
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read src/cli/hook.ts's PreToolUse contract (parseHookInput reads session_id, cwd, tool_name, tool_input, tool_use_id, hook_event_name, version, tool_response; decision() prints the nested hookSpecificOutput envelope, exit 0 always, exit 2 only for a misconfigured hook), the docs/cursor-hook.md sibling-doc precedent, and tests/cli-hook-cursor.test.ts's spawn-the-real-CLI harness.
2. Write the recipe once, as Python source at docs/agent-sdk-hook.py: an async HookMatcher callback that normalises the SDK's input_data into the stdin JSON the CLI reads (injecting tool_use_id, which the SDK passes as a separate positional argument and NOT inside input_data, plus cwd and hook_event_name fallbacks), spawns approval hook claude-code --dir/--as/--timeout, and maps the verdict onto the SDK return shape. Every failure to reach or read the gate returns a synthesised deny under an agent-sdk-shim- prefix; the shim never returns {}.
3. Write docs/agent-sdk-hook.md around it: the shape table, what the SDK adds and omits versus the settings.json hook, the fail-closed table, the PostToolUse limitation, and an explicit note of what could not be verified against a live SDK in this worktree (no network).
4. Pin the shapes as fixtures under tests/fixtures/agent-sdk/: pretooluse-input.json (what the SDK hands the callback), hook-stdin.json (what the shim writes to the CLI), hook-output-allow.json and hook-output-deny.json (the HookJSONOutput the SDK expects back, which is byte-identical to what the CLI prints).
5. Add tests/agent-sdk-hook.test.ts: spawn the real CLI on the pinned stdin in a scratch repo with an attested policy, assert stdout deep-equals the allow fixture and the deny fixture (deny with a reason); assert hook-stdin.json is pretooluse-input.json plus exactly the shim's additions; assert the recipe embedded in the doc is byte-identical to docs/agent-sdk-hook.py; assert the shim's deny vocabulary is disjoint from HOOK_DENY_CODES and that the source contains no empty-dict return.
6. Link the sibling doc from docs/claude-code-hook.md, and amend SPEC.md §14 M8 to list Agent SDK apps as reachable through this surface, marked (Amended APRV-242, pending sign-off.).
7. npm run build; node scripts/run-tests.mjs --only the hook and docs-guard suites; npm run lint; npm run typecheck.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## Implementation notes (APRV-242)

**What was built.** Three files carry the work: `docs/agent-sdk-hook.py` (the shim), `docs/agent-sdk-hook.md` (the argument, with the shim embedded verbatim), and `tests/agent-sdk-hook.test.ts` with fixtures under `tests/fixtures/agent-sdk/`. No src/ change: the whole point is that an Agent SDK application reaches the existing gate with no new surface, so `approval hook claude-code` is untouched.

**The one shape difference, and why it is the substance of the task.** The Python SDK hands a hook callback three positional arguments, `(input_data, tool_use_id, context)`, and `tool_use_id` is NOT a key of the event dict. The CLI hook reads one JSON object on stdin and looks for `tool_use_id` inside it, because that is where a settings.json hook finds it (parseHookInput, src/cli/hook.ts). So the shim merges the second argument into the first before writing stdin; without it the gate's task id loses the segment that tells two calls in one session apart and the post-execution event cannot find the task the pre-execution event opened. `hook-stdin.json` pins that merged object and a test asserts it is `pretooluse-input.json` plus exactly one key. The return direction has no difference at all: the CLI's stdout IS the `hookSpecificOutput` a Python callback returns, so the mapping is a re-emission of three known keys.

**Fail closed, in a vocabulary of its own.** Every path where the shim cannot reach or read the gate (spawn failure, deadline, non-zero exit including the exit-2 misconfigured-hook case, unparseable stdout) returns a deny under an `agent-sdk-shim-` prefix, deliberately disjoint from the runtime's frozen `hook-*` codes so a transcript says which side refused. The PreToolUse path never returns the empty dict, which in the SDK's protocol means 'no decision' and would let the tool run. Two tests hold this as text against the recipe: every `return` in `approval_gate` is a `_deny(...)` or a `_verdict(...)`, and no shim code collides with `HOOK_DENY_CODES`. The PostToolUse reporter is the one place an empty return is correct (no permission question is being asked) and it is asserted separately.

**Global invariants touched (CLAUDE.md's implicit criteria).** SPEC §11.1 invariant 4, self-reported fields: the recipe copies the SDK event rather than composing one, and the hook still ignores `description`; nothing the shim adds is read as authority. Invariant 3, secrets: the shim passes the event through unchanged and prints no tool output into the log; the `_deny` details it composes are its own text, truncated to 200 characters, and never reach the log at all (they go to the SDK, not to an append). Nothing here writes to the log, mints a verb, or touches a human-only class.

**What could NOT be verified live, and why.** No network in this worktree, `claude-agent-sdk` is not a dependency here, and no Python runs in CI. So the CLI side of every claim is executed by the new test against the real binary, and three SDK-side statements rest on the documented API rather than on an observed call: (1) the three-argument callback signature, which is the whole reason for the `tool_use_id` merge; (2) that `input_data` carries `session_id`/`cwd`/`permission_mode`/`transcript_path` alongside `tool_name`/`tool_input` (the shim defaults `cwd` and `hook_event_name` when absent, so a version that omits them degrades rather than fails); (3) that `HookMatcher(matcher=...)` takes a pattern rather than an exact tool name. All three are stated as unverified in the doc's closing section. A future session with the SDK installed should re-check them and amend the fixtures.

**Two claims corrected while writing.** A first draft told readers to attest the Python module as a gate organ; `isGateOrganPath` (src/core/command-class.ts) accepts only built-in `policy.core` paths outside `.approval/`, so that would refuse with `path-not-organ`. The limit now says plainly that this surface has no organ ceremony. A first draft also said adding `mcp__*` to the matcher would gate MCP tools twice; the hook adapts a shell tool and file tools only, so an `mcp__*` name gets the 'is not a gated tool' pass-through allow. Both corrections are in the Limits section.

**Verification.** `npm run build` clean. `node scripts/run-tests.mjs --only agent-sdk-hook cli-hook cli-hook-cursor cli-hook-scope cli-hook-rewrite cli-hook-scratch docs-guard`: 162 pass, 0 fail, exit 0. Re-run after the final doc edits, `--only agent-sdk-hook docs-guard`: 25 pass, 0 fail, exit 0. `npm run lint` exit 0, `npm run typecheck` exit 0. Full `npm test` was not run (not required by the brief).

**SPEC.** §14 M8 gains one sentence listing Agent SDK applications as reachable through the Claude Code hook surface, marked '(Amended APRV-242, pending sign-off.)'. It states no new behavior; the behavior is the hook that already shipped.
<!-- SECTION:NOTES:END -->
