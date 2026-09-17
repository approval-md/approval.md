# Constrained Codex preparation

approval codex prepare creates a review bundle for a future constrained Codex
session. It is packaging and diagnostics, not activation.

The bundle pins one macOS/Codex version, distinct Codex, broker and runner
principals, disjoint active-worktree, primary-gate and root-owned installation
roots, and one exact MCP executable plus argument vector. Its requirements
template makes native Codex tools read-only, disables command network and the
browser, computer-use, plugin and web-search surfaces, and allowlists only the
strict MCP identity.

Preparation writes only a new output directory. approval codex setup --check
verifies the exact file set, SHA-256 index, instance schema and every generated
template byte. A passing check means the inert bundle is internally consistent.

approval codex doctor --strict --manifest PATH inspects host custody. It rejects
unsupported manifest platforms or version declarations, missing or overlapping principals,
overlapping roots, symlinks, path drift, non-root-owned or writable trusted
ancestors, invocation drift, missing executables and a workspace writable by
the Codex principal. APRV-325.1 also unconditionally reports broker-not-ready
and runner-not-ready. POSIX ownership and mode cannot prove the absence of
writable ACLs, so this slice executes no manifest-selected binary and reports
both installed runtime versions unchecked.

The package does not run a postinstall script, call sudo, edit Codex
configuration, create accounts, load services, access credentials, start a
model, or alter APPROVAL.md. A human or MDM system must eventually install and
own the reviewed artifacts.

## The broker has landed; the runner has not (APRV-325.2)

`approval codex apply` and the one-tool server `approval codex serve` now exist:
a bounded create/replace/delete/move proposal against the manifest's workspace,
one registered action per distinct path class, authorized through the real gate,
every leg started before any byte moves, then staged, journaled and applied
under a workspace lock, with the outcome taken from reading the workspace back.
`docs/codex-workspace-broker.md` is its reference.

That is a gate on workspace writes and nothing more. `approval codex start` still
refuses `codex-not-ready`, `codex doctor --strict` still reports
`runner-not-ready`, and the session is still not enforced: a shell that can write
the workspace by another route is not bounded by the broker, credentials and
egress are untouched, and no probe has yet shown that the alternate mutable
surfaces are constrained. APRV-325.3 owns that evidence, and until it lands
nobody should describe an installation as a mandatory boundary.
