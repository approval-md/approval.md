# The Codex hook: `approval hook codex`

`approval hook codex` is an opt-in adapter for native Codex `PreToolUse` and
`PostToolUse` events. It places the deterministic approval.md gate in front of
Codex shell commands and patches matched as `Bash|apply_patch`. The hook returns
Codex's nested `hookSpecificOutput` decision with an explicit `allow` or `deny`.
It never returns `ask`.

Codex defines the event envelope, matcher, command-handler, trust, timeout, and
tool-coverage contracts in its [official hooks
documentation](https://learn.chatgpt.com/docs/hooks).

> **Status for Codex CLI 0.152.1:** native hook loading and the deny, timeout,
> crash, and malformed-output paths remain unverified. `PostToolUse` is
> diagnostic only for now and does not close execution outcomes. Everyday
> activation remains pending the reviewed trust and phone checks below.

The adapter uses the same policy, verified log, budget, and approval core as
the other harness hooks. Codex's own sandbox and approval mode remain an
independent control. Installing this hook does not widen that sandbox or grant
Codex any permission.

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

For compound shell commands, cwd tracking accepts absolute paths, `.`, `..`,
and paths beginning `./` or `../`. It follows at most 64 conservative cwd
candidates. An unsupported or ambiguous `cd` denies the command. Prefer an
explicit form such as `cd ./dir`.

## Install by human review

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

## Morning phone smoke test

Run this only after the primary daemon and Telegram channel are healthy and
after `/hooks` shows the reviewed definitions as trusted. This ceremony uses a
loopback-only HTTP witness so denial and one granted side effect can be checked
without external network access.

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

A command-hook crash, timeout, launch failure, or malformed stdout may fail
open in Codex. `PostToolUse` cannot undo an effect. The native APRV-310 probe is
the evidence source for exact behavior in the supported CLI version; until it
passes, errors, timeouts, outcome parsing, desktop trust, and phone behavior
remain pending. Coverage is limited to the named local paths. It does not
establish strict Claude parity or an exhaustive security boundary.

`approval doctor` checks the on-disk JSON for both events, the exact
`Bash|apply_patch` matcher, synchronous command handlers, `approval hook codex`,
and the `600` second outer timeout. Its harness provenance row compares the
installed `codex --version` with the latest hook-written Codex provenance when
such a record exists. A match is informational and never lowers scrutiny.
