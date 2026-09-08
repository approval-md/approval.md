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
- `prompt.txt`, requesting eight exact shell calls and two exact patches;
- `.gitignore`, excluding every generated marker and native event record.

Prepare also prints an exact `codex_argv` array with invocation-local `-c`
hook settings. It does not create `.codex/`, install hooks, or invoke Codex.

Each hook invocation appends one record to
`native-events.sanitized.jsonl`. The record replaces session, turn, and
tool-use identifiers with stable, domain-separated hash pseudonyms, replaces
model and working-directory values with labels, and omits `transcript_path`.
It retains only exact controlled commands/results, redacts every other string,
caps nesting and collection sizes, and records all top-level field names and
types. Controlled booleans relate the event cwd, hook process cwd, scratch root,
and nested test directory without storing the absolute paths.

The individual JSON files under `tests/fixtures/codex-hook/` are synthetic
native-shaped sanitizer inputs. `native-v5.sanitized.jsonl` and
`native-v6.sanitized.jsonl` are reviewed native Codex 0.152.1 evidence. The v5
file's older generic identifier placeholders cannot prove correlation; v6 uses
the stable pseudonyms. `native-v7-patch-workdir.sanitized.jsonl` is the focused
one-call shell-to-patch observation.

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

The prompt asks for exactly ten tool calls: eight shell calls, an allowed patch,
and a distinct denied patch. One shell call requests the exact controlled
`nested-cwd` as its tool working directory. A controller should impose its own
wall-clock deadline and terminate the Codex process if that deadline is
exceeded. `verify` exits `0` only when the allow and deny controls, crash,
timeout, malformed output, success, nonzero, nested-directory, and patch events
were all reached exactly as expected. The allowed markers and patch must exist,
the denied shell and patch markers must be absent, matching Pre/Post ids must
correlate, and separate calls must retain distinct pseudonyms. The nested effect
must land only in the nested directory, and the native event must expose that
directory through `tool_input.cwd`, `tool_input.workdir`, or an event cwd that
also equals the hook process cwd.
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

## Native evidence status (Codex 0.152.1)

The first executable invocation combined `--approve-for-me` with an explicit
`--sandbox workspace-write`. Codex exited `2` before any model or tool call and
reported that the two flags cannot be combined. The prepared command now keeps
`--approve-for-me`, whose CLI help says it routes automatic review through the
workspace-write sandbox.

The corrected invocation reached all eight requested scratch tool calls and
exited `0`, but wrote zero hook events. Every marker, including the denied
marker, was present. No hook ran in that attempt, so no deny decision existed.

A separate read-only `codex doctor --json` accepted the exact invocation-local
`features.hooks`, `hooks.PreToolUse`, and `hooks.PostToolUse` values and reported
the configuration loaded. A negative control with `hooks.PreToolUse=42`
reported that configuration could not be loaded. That establishes the inline
configuration's syntax. The official documentation says non-managed hooks
require review and trust.

The operator later authorized the dedicated one-shot hook-trust exception for
the bounded scratch probe. Native v5 exited `0`, verification exited `0`, and 15
sanitized events were reviewed. The deny response blocked its exact shell
effect and emitted no PostToolUse. Command-hook crash, timeout, and malformed
stdout each displayed a hook failure, then the scratch command proceeded and a
PostToolUse event followed. The prior allow response omitted the documented
identity `updatedInput.command`; Codex displayed that PreToolUse hook as failed
while still proceeding.

Successful and exit-7 Bash calls both emitted an empty-string `tool_response`.
The successful patch emitted an arbitrary string response. Those observations
do not support a success/failure parser, so the production PostToolUse adapter
remains diagnostic and appends no outcome. The v5 sanitizer used generic id
placeholders, so it also did not prove Pre/Post correlation. The next bounded
probe added identity allow responses, stable pseudonyms, a denied patch, and the
nested-directory binding check.

Native v6 accepted the documented identity allow without reporting a failed
PreToolUse hook. It recorded exactly one Pre and Post for the allowed Bash and
patch calls with matching stable pseudonyms, and distinct calls had distinct
tool-use pseudonyms. The exact shell and patch denials both blocked their
effects and emitted no PostToolUse. Successful and exit-7 Bash responses
remained identical empty strings, and the top-level Post fields exposed no
status or exit code.

Verification still exited `1` on the execution-directory check. The controlled
nested command wrote only inside the requested nested tool working directory,
but its `tool_input` contained only `command`; the event cwd and hook process
cwd both remained the scratch root. The native event therefore did not expose
the directory where that Bash call actually ran. A hook that binds only the
observed cwd can approve different bytes from the effective `{command,
execution directory}` action. This blocks scope-safe activation until the
architecture supplies or constrains that directory independently.

Native v7 then ran one exact `apply_patch` heredoc through `exec_command` with
the nested workdir. Codex reported one PreToolUse as `Bash` with the full heredoc
command, no `cwd` or `workdir` in `tool_input`, and the same root event/process
cwd seen in v6. The focus hook returned the identity allow and the patch landed
in the nested directory, but no PostToolUse was observed. Verification exited
`1` on its Post/correlation and directory-exposure checks. The production
adapter's separately tested unconditional Bash refusal covers this observed
route. The native run does not
establish the working-directory contract of a direct `apply_patch` tool call.
