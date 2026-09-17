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
| reads of anything but the two workspaces | Seatbelt `(deny file-read*)` with an allow-list of two roots (APRV-347's read jail) |
| ambient credentials | an environment ALLOW-list (`PATH`, `HOME`, `SHELL`, `USER`, `LANG`, `TERM` and a few more) applied after `core/child-env.ts`'s credential strip |
| credential material on disk | Seatbelt `denyRead` over the vault, the environment map and the sealing keys, emitted after the jail's allows so it is the last word |
| external egress | Seatbelt `(deny network-outbound)`, loopback included |
| mutable executor code | the broker, the CLI and the pinned Node live under the root-owned install root, which is on neither allow-list |

The read jail has exactly two roots, the disposable workspace and the canonical
workspace, and `core/sandbox.ts` adds the fixed runtime set and the running
command's own install prefix itself. A session has to READ the tree it is
reasoning about, which is why the canonical workspace is a root and why write
confinement rather than read denial is what stops it changing one. Everything
the operator's home holds beside it — other repositories, `~/.ssh`, the gate
home — is outside the jail and unreadable, and that is the half `denyRead` alone
could never cover: a deny-list has to have heard of a path to deny it.

Two properties are worth stating rather than implying. **There is no opt-out.**
`approval run` has `--no-sandbox`, because an operator holding a human's grant
may deliberately reach the world; a confined session has no such flag and no
unwrapped fallback, and a host with no sandbox mechanism REFUSES
(`sandbox-unsupported`) where `approval run` would record `unsupported` and
proceed. A session advertised as confined and not confined is worse than no
session. And **descendants are confined too**: Codex does not write files by
calling into this runtime, it spawns shells that do, so the proof that matters
is the one where the confined child's own `/bin/sh` grandchild is denied.

### Activation and rollback

The operator runbook lives in `docs/codex-activation.md`, under **Broker session
activation (Lane 4a)**: the ordered commands, which steps are human-only, and
how to roll back. That file also holds the native hook's trust ceremony, and the
two are deliberately separate claims — a green trust ceremony with no broker
enforces nothing, and a working broker with no Telegram proves nothing about
whether a decision can reach a human.

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

The read jail is a control over PATHS and has the same shape of limit: a secret
someone checked into the canonical workspace is inside a root the session may
read, and no sandbox rule will change that. What the jail buys is that
everything outside those two roots is unreadable whether or not anyone thought
to name it.
