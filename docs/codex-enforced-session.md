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

That is a gate on workspace writes and nothing more. On its own a door beside an
open window is decoration, which is what APRV-325.3 below closes.

## The confined session (APRV-325.3)

`approval codex start --manifest <abs>` prepares the room a session's shell runs
in, and `-- <command>` runs something inside it. Five things the shell does not
get, and where each is enforced:

| withheld | enforced by |
|---|---|
| canonical workspace writes | Seatbelt `(deny file-write*)` with an allow-list naming only the disposable workspace |
| gate writes (log, policy, vault, keys) | the same deny; the gate home is not on the allow-list |
| ambient credentials | an environment ALLOW-list (`PATH`, `HOME`, `SHELL`, `USER`, `LANG`, `TERM` and a few more) applied after `core/child-env.ts`'s credential strip |
| credential material on disk | Seatbelt `denyRead` over the vault, the environment map and the sealing keys |
| external egress | Seatbelt `(deny network-outbound)`, loopback included |
| mutable executor code | the broker, the CLI and the pinned Node live under the root-owned install root, which is not on the write allow-list |

Two properties are worth stating rather than implying. **There is no opt-out.**
`approval run` has `--no-sandbox`, because an operator holding a human's grant
may deliberately reach the world; a confined session has no such flag and no
unwrapped fallback, and a host with no sandbox mechanism REFUSES
(`sandbox-unsupported`) where `approval run` would record `unsupported` and
proceed. A session advertised as confined and not confined is worse than no
session. And **descendants are confined too**: Codex does not write files by
calling into this runtime, it spawns shells that do, so the proof that matters
is the one where the confined child's own `/bin/sh` grandchild is denied.

### Activation

`docs/codex-activation.md` is the intended home for the operator runbook and did
not exist on `origin/main` when this section was written (Lane 4b owns it), so
the activation and rollback steps live here for now and should move when that
file lands.

Human-only steps are marked. Nothing an agent runs performs them.

1. **(human)** Install the package and the reviewed bundle under a root-owned
   install root, as `approval codex prepare` and `setup --check` describe above.
   No install script does this; a person or an MDM workflow does.
2. **(human)** Create the three service principals the manifest names.
3. Verify the host: `approval codex doctor --strict --manifest <abs> --json`. It
   fails closed. Every finding is a reason not to activate, and
   `trusted-path-acl-unproven` is reported unconditionally because POSIX
   ownership and mode say nothing about ACLs.
4. Verify the room: `approval codex start --manifest <abs> --json`. With no
   `-- <command>` it reports the disposable workspace, the canonical workspace,
   the mechanism, the write allow-list, the read denials and the count of
   withheld variables, and it runs nothing. An unsupported host refuses here.
5. **(human)** Point the Codex host at the strict server, whose invocation the
   manifest pins: `approval codex serve --manifest <abs>`. It publishes exactly
   one tool. Do not add the broad `approval mcp serve` beside it.
6. Run the session's shell work through `approval codex start -- <command>`.

### Rollback

Rollback is subtraction and needs no new state.

1. Stop the strict server (`codex serve`) and stop starting shells through
   `codex start`. Every confined session's disposable workspace is removed when
   the session ends, so there is nothing to clean up.
2. **(human)** Remove the Codex host's MCP entry pointing at the strict server.
3. If a brokered change was interrupted, `approval codex recover --manifest
   <abs>` reports whether the workspace is in the approved before-state, the
   approved after-state, or neither. It repairs nothing. A `mixed` result exits 1
   and is a person's to resolve with `approval execution reconcile`.
4. **(human)** Nothing under `.approval/` or `APPROVAL.md` is touched by any of
   this, so there is no policy to restore. The log keeps every brokered change
   that happened, which is the point.

### What is still not proven

The confinement evidence covers processes this runtime spawns and their
descendants, on macOS. It is not a claim about a Codex desktop application a
person starts outside `codex start`: that process is not in the room, and what
was measured about it is in `docs/codex-boundary-probe.md`. Linux has no
mechanism in this build (`core/sandbox.ts`'s stated gap), so a Linux host
refuses rather than running unconfined. Inbound sockets are not denied. The
environment allow-list is a control over NAMES and therefore best-effort by
construction; the load-bearing control beside it is that egress is denied, so a
secret that does reach the child has nowhere to go.
