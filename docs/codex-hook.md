# The Codex hook: `approval hook codex`

`approval hook codex` is an opt-in adapter for native Codex `PreToolUse` and
`PostToolUse` events. It places the deterministic approval.md gate in front of
Codex shell commands and patches matched as `Bash|apply_patch`. The hook returns
Codex's nested `hookSpecificOutput` decision with an explicit `allow` or `deny`.
It never returns `ask`.

Codex defines the event envelope, matcher, command-handler, trust, timeout, and
tool-coverage contracts in its [official hooks
documentation](https://learn.chatgpt.com/docs/hooks).

> **Status for Codex CLI 0.152.1:** a bounded scratch run verified hook loading,
> shell denial, and the observed fail-open crash, timeout, and malformed-output
> paths. `PostToolUse` is diagnostic only and does not close execution outcomes.
> The follow-up run verified identity allow responses, stable Pre/Post
> correlation, and shell and patch denial. It also found that a non-default Bash
> working directory is absent from the hook event. Scope-safe activation is
> blocked until the adapter can bind or constrain the real execution directory.

This integration is not ready for normal Codex sessions. Its current supported
use is experimental direct-patch evaluation: the required full
`Bash|apply_patch` matcher refuses every matched Bash call, including gate-self
shell commands. Everyday activation remains blocked.

The direct-patch path uses the same policy, verified log, budget, and approval core as
the other harness hooks. Codex's own sandbox and approval mode remain an
independent control. Installing this hook does not widen that sandbox or grant
Codex any permission.

The autonomy table describes direct `apply_patch`; Bash always takes the
contract refusal described below.

| resolved autonomy | PreToolUse result | log effect |
|---|---|---|
| `autonomous` | allow | the deterministic hook path records only what the core requires |
| supervised | allow after the required registration | the core records the supervised path |
| manual | wait up to nine minutes for the configured human decision, then allow or deny | request and decision records use the normal gate path |
| human-only, malformed, unknown, or unreachable gate | deny | no invented authorization |

The hook process defaults to a nine-minute gate wait. The native command-hook
entry has a ten-minute (`600` second) outer timeout. Keep the outer timeout
longer than the gate wait so the adapter can return a machine-readable denial
instead of being killed while a human is deciding.

## Supported input

The adapter accepts exact `Bash` and `apply_patch` events with a string command,
stable session and tool-use identifiers, and an event cwd that agrees with the
hook process's actual cwd. Patch input must use strict `*** Begin Patch` and
`*** End Patch` framing, and every changed path must be relative and confined
to that cwd.

Every Codex allow repeats the exact gated command bytes as
`updatedInput.command`, as required by the native hook contract. A deny does not
include an input update. Configure no other hook that rewrites input for the
covered tools: concurrently matching native hooks can transform tool input, and
an additional rewrite would invalidate the bytes approval.md classified and
bound.

Codex 0.152.1 does not include an explicitly selected Bash tool working
directory in `tool_input`, and both the event cwd and hook process cwd remain
the session root. The bounded native probe observed the effect run in that
hidden nested directory. The current adapter cannot distinguish that call from
one executed at the session root, so it is not safe to activate for sessions
that can select a different per-call working directory.

The adapter therefore denies every native Bash PreToolUse before policy,
open-window, gate-self, carryover, or execution-start handling. A native focus
run sent an `apply_patch` heredoc through `exec_command`; Codex reported that
route as Bash, so it receives the same denial. Direct `apply_patch` remains a
separate bounded surface and does not make shell execution available.

## Future installation by human review

Do not run this installation procedure with Codex 0.152.1. It is retained for
a future native contract that exposes the effective working directory and a
reliable success/failure outcome. The checked-in example remains useful for
reviewing the intended configuration without activating it.

The checked-in [example](../examples/codex-hooks.example.json) is inert. Codex
does not load it from `examples/`. Installation writes a gate configuration and
requires a human to review the exact executable and primary-checkout paths.

From the primary checkout, first resolve stable absolute paths:

```sh
command -v approval
git rev-parse --show-toplevel
codex --version
```

Copy the inert example, replace both placeholders with those absolute paths,
then inspect the resulting bytes:

```sh
mkdir -p .codex
cp examples/codex-hooks.example.json .codex/hooks.json
nano .codex/hooks.json
sed -n '1,220p' .codex/hooks.json
approval doctor --dir /absolute/path/to/primary-checkout
```

Do this in a human-controlled terminal under the repository's policy for gate
configuration. Do not place secrets, tokens, or environment values in the hook
command. Use the primary checkout for `--dir`: policy discovery and the one
append-only log must not split across agent worktrees.

Start a new Codex session, run `/hooks`, inspect the exact `PreToolUse` and
`PostToolUse` definitions, and declare them trusted in Codex only after they
match the reviewed file. File presence and a green doctor row establish
configuration on disk. They do not establish trust, loading, or execution.
Codex binds trust to the current hook definition, so a later edit requires a
new review.

Codex also accepts hook tables inside `.codex/config.toml`. This runbook uses
one JSON representation. `approval doctor` reports TOML presence but does not
interpret inline TOML tables, and Codex merges multiple hook sources. Keep one
representation per project layer so the effective hook set stays reviewable.

## Roll back

Rollback is a reversible rename performed by the human who controls the
project configuration:

```sh
mv .codex/hooks.json .codex/hooks.json.disabled
approval doctor --dir /absolute/path/to/primary-checkout
```

Start a new Codex session and use `/hooks` to confirm the project hooks are no
longer active. The rename does not alter the approval log and does not change
Codex's sandbox. If `.codex/config.toml` or a user, managed, or plugin layer also
defines hooks, remove or disable that separately after reviewing its source.

## Future morning phone smoke test

This procedure is unavailable on Codex 0.152.1 because the current adapter
refuses every Bash call. Retain it for a future Codex version only after native
evidence verifies both the effective working-directory input and a reliable
success/failure outcome contract. At that point, run it only after the primary
daemon and Telegram channel are healthy and `/hooks` shows the reviewed
definitions as trusted. The ceremony uses a loopback-only HTTP witness so
denial and one granted side effect can be checked without external network
access.

In terminal one, start the dependency-free witness. Wait for its `ready` line
and leave it running. It prints the random loopback port, exact Codex command,
and scratch marker path:

```sh
node examples/codex-morning-witness.mjs
```

In terminal two, copy the printed URL into these checks. The policy check must
report `manual` for `network.call` before continuing:

```sh
approval hook classify -- curl -X POST http://127.0.0.1:<port>/probe
approval policy test network.call
approval doctor --dir /absolute/path/to/primary-checkout
```

In Codex, ask for the exact printed `curl -X POST` command once and deny it on
the phone. Confirm the marker path is absent, the server still reports zero
requests, and the refusal is machine-readable. In terminal two, replace the
placeholder with the path printed by the server and check it directly:

```sh
test ! -e <marker-path>
```

Ask once more, grant that single action, and confirm the server reports one
request, writes the marker, and exits. Then run `test -f <marker-path>` in
terminal two. Inspect the log with the normal verified read to confirm the
request and decision records. Do not infer an execution outcome from a
`PostToolUse` event until the native probe has established a stable
success/nonzero discriminator; the current adapter leaves an unreadable outcome
append-free.

The desktop trust flow and this phone ceremony are pending manual verification.
Do not report everyday activation from source, example, doctor, or unit-test
evidence alone.

## Coverage and failure boundary

The hook entry deliberately matches shell and patch calls only. Official Codex
documentation says a later `write_stdin` call transports input to or polls an
already-approved unified execution and does not receive another `PreToolUse`.
Hosted tools, including hosted web search, do not use the local function-hook
path. Connectors, browser or computer-use paths, and specialized tools may be
outside it. Nested code-mode local tool calls are documented to receive hook
decisions, but still require a native compatibility check for this adapter.

A command-hook crash, timeout, or malformed stdout proceeded in the bounded
Codex 0.152.1 native run; a launch failure was not exercised. `PostToolUse`
cannot undo an effect. The native APRV-310 probe is the evidence source for
exact behavior in the supported CLI version. Identity allow and denial passed;
execution-directory binding failed. Activation, outcome parsing, desktop trust,
and phone behavior remain pending. Coverage is limited to the named
local paths. It does not
establish strict Claude parity or an exhaustive security boundary.

`approval doctor` checks the on-disk JSON for both events, the exact
`Bash|apply_patch` matcher, synchronous command handlers, `approval hook codex`,
and the `600` second outer timeout. Its harness provenance row compares the
installed `codex --version` with the latest hook-written Codex provenance when
such a record exists. A match is informational and never lowers scrutiny.
