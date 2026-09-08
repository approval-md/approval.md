# Codex hook compatibility probe

APRV-310 provides a bounded scratch probe for the native Codex hook contract.
It records only sanitized event structure and controlled probe strings. It does
not read a session transcript, copy authentication, change user configuration,
or invoke Codex on its own.

The probe was prepared against `codex-cli 0.152.1`, with the stable `hooks`
feature enabled. The authoritative behavior is the [official OpenAI hooks
documentation](https://learn.chatgpt.com/docs/hooks). It says that:

- `PreToolUse` and `PostToolUse` cover `Bash`/unified execution and
  `apply_patch`; `Bash` and `apply_patch` put their payload in
  `tool_input.command`.
- `PostToolUse` also runs after nonzero Bash outcomes. `tool_response` is a JSON
  value whose exact shape is tool-specific.
- a later `write_stdin` poll does not repeat `PreToolUse`, hosted tools do not
  use this hook path, and specialized paths may remain uncovered.
- command-hook crashes, invalid supported output, and timeouts are reported as
  hook failures. A failed hook is not a documented fail-closed enforcement
  boundary, so the probe records whether each scratch effect occurred.
- non-managed hooks require review and persisted trust. A one-shot automation
  may use `--dangerously-bypass-hook-trust` after separately reviewing the hook
  sources. This flag concerns hook-source trust only.

## Files and data boundary

`scripts/codex-hook-probe.mjs prepare` creates a non-empty-refusing child of a
temporary directory with:

- `hooks.example.json`, an inert review copy matching `Bash` and `apply_patch`
  for both tool events;
- `prompt.txt`, requesting seven exact shell calls and one exact patch;
- `.gitignore`, excluding every generated marker and native event record.

Prepare also prints an exact `codex_argv` array with invocation-local `-c`
hook settings. It does not create `.codex/`, install hooks, or invoke Codex.

Each hook invocation appends one record to
`native-events.sanitized.jsonl`. The record replaces session, turn, tool-use,
model, and working-directory values with placeholders. It omits
`transcript_path`, retains only exact controlled commands/results, redacts every
other string, caps nesting and collection sizes, and records whether the event
working directory matched the scratch root. The checked-in files under
`tests/fixtures/codex-hook/` are synthetic native-shaped inputs for sanitizer
tests. They are not observations from a live Codex process.

## Reviewed native runbook

Run prepare from the repository root, review `hooks.example.json` and the
printed `codex_argv`, then resolve the native invocation through the project
gate. The equivalent command is:

```sh
node scripts/codex-hook-probe.mjs prepare --out /private/tmp/aprv-310-native-0.152.1
codex exec --ignore-user-config --ephemeral --skip-git-repo-check --approve-for-me \
  -c 'features.hooks=true' \
  -c 'hooks.PreToolUse=[{matcher="Bash|apply_patch|Edit|Write",hooks=[{type="command",command="node /private/tmp/approval-codex-hook/scripts/codex-hook-probe.mjs hook --log /private/tmp/aprv-310-native-0.152.1/native-events.sanitized.jsonl --scratch /private/tmp/aprv-310-native-0.152.1",timeout=1,statusMessage="Running APRV-310 scratch probe"}]}]' \
  -c 'hooks.PostToolUse=[{matcher="Bash|apply_patch|Edit|Write",hooks=[{type="command",command="node /private/tmp/approval-codex-hook/scripts/codex-hook-probe.mjs hook --log /private/tmp/aprv-310-native-0.152.1/native-events.sanitized.jsonl --scratch /private/tmp/aprv-310-native-0.152.1",timeout=1,statusMessage="Running APRV-310 scratch probe"}]}]' \
  -C /private/tmp/aprv-310-native-0.152.1 - < /private/tmp/aprv-310-native-0.152.1/prompt.txt
node scripts/codex-hook-probe.mjs verify --out /private/tmp/aprv-310-native-0.152.1
```

`--ignore-user-config` prevents user hook/config loading, `--ephemeral` avoids
persisting this probe session, and `--approve-for-me` routes automatic review
through Codex's workspace-write sandbox. Codex 0.152.1 rejects an additional
explicit `--sandbox workspace-write` when `--approve-for-me` is present. The
initial invocation does not bypass hook trust. If
Codex 0.152.1 treats invocation-local hooks as untrusted and skips them, record
that result and review the exact hook before considering the dedicated
`--dangerously-bypass-hook-trust` option. Never use the broader
`--dangerously-bypass-approvals-and-sandbox` flag. The Codex invocation uses
the saved CLI authentication and may be a billable model call.

The prompt asks for exactly eight tool calls. A controller should impose its
own wall-clock deadline and terminate the Codex process if that deadline is
exceeded. `verify` exits `0` only when the allow and deny controls, crash,
timeout, malformed output, success, nonzero, and patch events were all reached;
the allowed marker and patch must exist, and the denied marker must be absent.
Crash, timeout, and malformed-output effects are reported separately as
observations, regardless of whether Codex blocked or continued them.

## Coverage boundary

This probe can establish native event names, canonical tool names, input shape,
working-directory behavior, response value type, deny behavior, and the
observed handling of three hook failures. It does not establish coverage for
hosted tools, `write_stdin` prechecks, every specialized tool path, nested code
mode calls, desktop activation/trust UX, phone approval UX, or everyday project
configuration. Those checks remain explicit follow-up work. A successful probe
does not make hooks an exhaustive security boundary.

## Native attempt status (Codex 0.152.1)

The first executable invocation combined `--approve-for-me` with an explicit
`--sandbox workspace-write`. Codex exited `2` before any model or tool call and
reported that the two flags cannot be combined. The prepared command now keeps
`--approve-for-me`, whose CLI help says it routes automatic review through the
workspace-write sandbox.

The corrected invocation reached all eight requested scratch tool calls and
exited `0`, but wrote zero hook events. Every marker, including the denied
marker, was present. This does not show that Codex ignored a deny: no hook ran,
so no deny decision existed.

A separate read-only `codex doctor --json` accepted the exact invocation-local
`features.hooks`, `hooks.PreToolUse`, and `hooks.PostToolUse` values and reported
the configuration loaded. A negative control with `hooks.PreToolUse=42`
reported that configuration could not be loaded. That establishes the inline
configuration's syntax, while leaving hook trust or loading as the unresolved
boundary. The official documentation says non-managed hooks require review and
trust. Whether to use the dedicated one-shot hook-trust exception for this
scratch probe or complete trust review interactively remains a human decision;
no trust bypass has been run.
