# `tests/fixtures/agent-sdk` — the Agent SDK hook shapes (APRV-242)

Four pinned JSON objects and one prose file. Together they say what a Python
Claude Agent SDK application hands the shim in `docs/agent-sdk-hook.py`, what
the shim hands `approval hook claude-code`, and what it returns to the SDK.
`tests/agent-sdk-hook.test.ts` asserts every one of them against the real CLI.

| File | What it pins |
| --- | --- |
| `pretooluse-input.json` | the `input_data` dict the SDK passes to a PreToolUse callback |
| `hook-stdin.json` | the JSON the shim writes to the CLI: the above plus `tool_use_id`, which the SDK passes as a separate positional argument |
| `sdk-return-allow.json` | the `HookJSONOutput` the callback returns on an allow, byte-for-byte the CLI's stdout |
| `sdk-return-deny.json` | the same on a deny, reason included |
| `sdk-return-unreachable.json` | what the shim synthesises when the gate cannot be reached at all, under its own `agent-sdk-shim-` prefix |

The two verdict fixtures quote reasons the CLI produces under the policy the
test writes (`read.*` autonomous, everything else manual). A wording change in
`src/cli/hook.ts` is meant to fail here: these are the bytes a reader of
`docs/agent-sdk-hook.md` will compare their own output against.

`sdk-return-unreachable.json` is the one object no CLI run produces. Its reason
is written by the Python, and the message after the colon is `OSError`'s own
text, which varies by platform; the test pins the code before the colon and
nothing after it.
