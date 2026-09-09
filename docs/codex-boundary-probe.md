# Codex native command sandbox probe

APRV-325 includes a bounded offline diagnostic for one native Codex boundary:
the macOS command runner reached through `codex sandbox`. The probe uses the
built-in `:read-only` permission profile and controlled paths below a new
temporary directory. It invokes no model, never requests credential contents,
does not inspect authentication files, changes no Codex configuration, and
makes no network request. The Codex CLI may load its ordinary configuration to
resolve the built-in permission profile.

Run it outside an existing Seatbelt sandbox. Nested Seatbelt initialization is
unsupported in the observed environment and is a probe failure, not a denial:

```sh
node scripts/probes/codex-boundary.mjs --out /private/tmp/aprv-325-codex-boundary-001
```

The script first runs each exact path without the sandbox and requires the
write to succeed. It removes that controlled effect, runs the same attempt via
`codex sandbox -P :read-only`, and requires all of the following:

- the sandbox preflight child actually started;
- each write-attempt child actually started and exited `23` after its controlled
  operation failed;
- the direct Node, nested shell, and symlink-resolved sibling artifacts are
  absent;
- the sandbox runner did not report a Seatbelt application failure or timeout.

The symlink and its target are both created inside the new scratch root. The
target is a sibling of the probe workspace, which checks resolved-path behavior
without touching any real protected path. Child processes receive a fixed
environment allowlist. Credential-bearing prefixes and `APPROVAL_HUMAN` are
removed. The sanitized JSON printed to stdout is also written to
`<scratch>/result.sanitized.json`; it contains exit codes, child-start markers,
artifact checks, byte counts, and normalized failure categories, with no raw
child output or environment names.

## Observed Codex 0.152.1 behavior

The installed version reports `codex-cli 0.152.1`. Its supported macOS spelling
is `codex sandbox [OPTIONS] [COMMAND]...`; `codex sandbox macos --help` treats
`macos` as the command to execute and exits `71` because no such executable
exists.

Within the current desktop command sandbox, a nested invocation failed before
the child started: Seatbelt reported `sandbox_apply: Operation not permitted`
and exited `71`. This is not enforcement evidence. Running the exact scratch
probe outside that enclosing sandbox allowed Seatbelt to initialize. The
controlled Node child then started, its file open failed with `EPERM`, it exited
nonzero, and the artifact remained absent. The checked-in script repeats that
distinction for all three paths and fails rather than skipping or falling back.

The reviewed native run on 2026-09-09 used
`/private/tmp/aprv-325-codex-boundary-002` and produced:

| Case | Positive control | `:read-only` attempt | Observed effect |
|---|---:|---:|---|
| Direct Node write | exit `0` | exit `23` | denied artifact absent |
| Nested shell write | exit `0` | exit `23` | denied artifact absent |
| Symlink-resolved sibling write | exit `0` | exit `23` | denied artifact absent |

All three sandboxed children emitted their controlled start marker and reported
an operation denial. The sandbox preflight exited `0`. A separate invocation
from inside the desktop Seatbelt sandbox exited `1` overall because the inner
preflight exited `71` before its child started; the result classified this as
`sandbox-apply-failed` rather than an operation denial.

## Boundary of the result

A passing result establishes denial only for commands launched through this
exact native `:read-only` sandbox runner. It does not establish a mandatory
approval gate, approval.md policy evaluation, grant authenticity, or a sole
trusted executor. It does not cover native `apply_patch`, MCP tools, desktop
tools, browser or computer control, direct capabilities outside this command
runner, or network denial. Generic MCP execution also has declared-class and
broad-write escape surfaces, so this diagnostic does not justify activating it
as a complete enforcement boundary. A trusted executor or approval bridge needs
separate architecture and adversarial proof before activation.
