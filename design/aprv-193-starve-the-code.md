# APRV-193 — Starve the code

**Status: design, pending human sign-off. Nothing here is wired into the gate.**

Egress-sandboxed allowed exec and credential custody, so laundered side effects
fail closed. This document is the design lane's whole output apart from the
prototype (`scripts/sandbox-probe.mjs`, `tests/sandbox-probe.test.ts`) and the
implementation notes on the task. The build is a later, separate task.

---

## 1. The hole, stated precisely

The gate is advisory at the process boundary, in two distinct ways.

**Laundered egress.** `approval run` verifies a token, appends
`execution.started`, and then calls `spawnSync(command, args, { cwd, stdio })`
(`src/cli/execute.ts`, around line 452). The child is an ordinary process with
the ordinary ambient capabilities of the session: it can open a socket to
anywhere. So can every command the hook classifies `exec.local` and allows,
which includes `npm test` and `node scripts/*.mjs`. Those commands run code the
agent wrote moments earlier, so the command TEXT the classifier reads has
stopped describing the effect the command has. No classifier over shell text can
close that, because the classifier is reading a name and the effect is in a file.

**Laundered credentials.** That same `spawnSync` call passes no `env` option, so
Node hands the child a copy of the parent's entire environment. Every variable
the session holds, `APPROVAL_TG_TOKEN` and whatever the policy names in
`vault.passphrase_env` included, is readable by the child with
`process.env`. APRV-194 gated the shell commands that READ credential material
(`printenv APPROVAL_TG_TOKEN`, `cat .approval/vault.enc`) and that closed the
direct route. It could not close this one: the classifier sees `npm test`, and
the reading happens in TypeScript.

Both holes have the same shape. The gate decides which named actions may happen,
and the code it allows to run has capabilities the gate never granted it.
"Starve the code" is the proposal to remove the capabilities instead of
predicting their use.

Two framings are deliberately rejected here, and were rejected on the task
before this lane began. Gate-routed EDITING is rejected: a file that never runs
sends nothing, and pushing bulk coding through the transparency log would give
the log a database's problem. Gating exec more aggressively is rejected for the
same reason the hole exists: the name is not the effect.

---

## 2. Prior art

Concrete mechanisms, and what each costs in portability and operator setup.

### 2.1 macOS: `sandbox-exec` (Seatbelt)

`/usr/bin/sandbox-exec -f profile.sb -- argv` applies a Sandbox Profile Language
(SBPL, a TinyScheme dialect) profile to a process and its descendants. Rules are
`(allow …)` / `(deny …)` over operations, and the LAST matching rule wins, so an
egress denial with exceptions is written as `(allow default)`,
`(deny network-outbound)`, then the exceptions. Filters narrow an operation:
`(remote ip "localhost:*")` for loopback, `(subpath "/private/etc")` for
filesystem operations such as `file-read*`.

Costs: none in setup. The binary ships with every macOS and needs no privilege,
no daemon, and no kernel configuration. Costs in portability: the man page has
carried a deprecation notice since 10.14 and the profile language has no public
documentation, so a profile is written against observed behaviour and pinned by
tests. Apple's own supported successor is the App Sandbox entitlement system,
which requires code signing and does not apply to arbitrary argv. Every macOS
agent sandbox in the field, Chrome's renderer included, still uses Seatbelt.

Two behaviours this lane verified rather than assumed, both of which would
silently produce a profile that protects nothing:

- `network-outbound` covers AF_UNIX connects as well as AF_INET. A bare
  `(deny network-outbound)` kills local IPC along with egress, so a unix-socket
  exception is mandatory for the sandbox to be usable.
- `subpath` filters match the kernel's RESOLVED path. On macOS `/tmp` is a
  symlink to `/private/tmp`, so a profile naming `/tmp/x` denies nothing at all.
  The prototype resolves every path before writing it into a profile.

### 2.2 Linux: namespaces, seccomp, Landlock

- **bubblewrap** (`bwrap`, the Flatpak sandbox): `bwrap --unshare-net --dev-bind
  / / --die-with-parent -- argv` puts the child in a fresh network namespace with
  no interfaces up, while the filesystem passes through unchanged. It is the
  cleanest egress denial available on Linux. Setup cost: `bwrap` must be
  installed, and unprivileged user namespaces must be enabled. Debian and RHEL
  derivatives have historically shipped them off
  (`kernel.unprivileged_userns_clone=0`, `user.max_user_namespaces=0`), and
  container runtimes frequently disallow nesting them, so availability has to be
  PROBED by running something trivial rather than inferred from `which bwrap`.
- **`unshare --net --map-root-user`** (util-linux) is the same trick with no
  package to install, and the same user-namespace precondition. It is the
  fallback.
- **seccomp-bpf** can deny `socket(2)` by address family, allowing `AF_UNIX` and
  refusing `AF_INET`/`AF_INET6` with `EPERM`, with no namespaces and therefore no
  user-namespace precondition. This is the most surgical mechanism on the list
  and the least reachable from Node: installing a filter requires
  `prctl(PR_SET_NO_NEW_PRIVS)` plus `seccomp(2)` before `exec`, which means a
  small native helper binary or a native addon. Rejected for v1 on dependency
  cost (CLAUDE.md: minimal dependencies, each one justified), recorded as the
  right answer if the namespace preconditions prove too fragile in the field.
- **Landlock** (Linux 5.13+) is unprivileged and namespace-free, and ABI v4
  (Linux 6.7) added TCP bind and connect restrictions to what was a
  filesystem-only LSM. It is the future-proof native answer and has the same
  reachability problem from Node as seccomp.
- **firejail** (setuid-root, `--net=none`) and **nsjail** (Google, built from
  source) both work. firejail's setuid surface has produced repeated local
  privilege-escalation CVEs, which is a poor trade for a tool whose job is to
  reduce the blast radius of code you already do not trust.

### 2.3 Language runtimes

- **Deno** is deny-by-default with granular grants: `--allow-net=host:port`,
  `--allow-read`, `--allow-env=NAME`, `--deny-net` overriding an allow. This is
  the closest thing on this list to the design below, at the level of a runtime
  rather than a process, and it is exactly what approval.md cannot use, because
  the code being starved is `npm test`, `tsc`, `git`, and arbitrary argv.
- **Node's permission model** (`--permission`, stable in Node 24; `--allow-fs-read`,
  `--allow-fs-write`, `--allow-child-process`, `--allow-worker`) has **no network
  permission at all**. It cannot deny egress. It can deny `child_process`, which
  is a useful and completely different lever. Stated here because it is the first
  thing a reviewer of a Node project will ask about: we cannot self-sandbox
  in-process, and the enforcement has to be an OS primitive around the spawn.

### 2.4 Container and agent sandboxes

- **Claude Code's sandbox mode** uses Seatbelt profiles on macOS and namespaces
  on Linux, combined with a network posture that denies direct egress and routes
  permitted traffic through a local proxy the sandboxed process is allowed to
  reach. **Codex CLI** crosses `sandbox_mode` (`read-only`, `workspace-write`,
  `danger-full-access`) with `approval_policy`, implemented with Seatbelt on
  macOS and Landlock plus seccomp on Linux, with `network_access = false` the
  default under `workspace-write`. **Docker / devcontainers** get there with
  `--network=none`, or with a network plus an iptables egress allowlist, which is
  the pattern Anthropic's reference devcontainer uses.
- The generalizable idea across all three is the one this design adopts: **deny
  direct egress, leave exactly one door, and put the gate behind that door.**
  Container isolation is strictly stronger and costs a rebuilt development loop,
  bind-mount and uid mapping friction, and, on macOS, a virtual machine. That is
  the right posture for an audience-facing runner and the wrong one for the dev
  fleet, which is the same conclusion the task reached about gate-only MCP tools.

### 2.5 What approval.md gets for free that none of them have

The gate's IPC is a **file**. `.approval/log/events.jsonl` is polled by the
daemon; `src/daemon/` opens no socket. So a network-only sandbox leaves the gate
fully reachable with no plumbing whatsoever, and the "one door" the prior art
builds a proxy for already exists as an append to a file. This is the single
largest simplification available, and it is why the design below denies the
network and leaves the filesystem alone.

The one caveat: the web channel binds `127.0.0.1:4680`
(`src/channels/web.ts`). Seatbelt can allow `localhost:*` back in; a Linux
network namespace cannot, because its `lo` is a different, empty loopback. A
sandboxed process on Linux therefore cannot reach the web channel, and the
Telegram channel and the CLI are unaffected because they do not need the
sandboxed side to talk to them.

---

## 3. The proposed design

### 3.1 Which layer enforces

**The spawn site, through one module, with two callers.**

Not the adapter: adapters run in-process and already have the credential window
(§10.4, APRV-67/168/169). Not the hook alone: the hook returns allow or deny and
cannot be relied on to rewrite a command into a wrapper, and a hook verdict is a
decision rather than a capability.

`src/core/sandbox.ts` (new, pure and testable apart from the spawn):

- `detectSandbox()` returns the machine's mechanism, probed rather than assumed.
- `sandboxSpawn(argv, cwd, allowance, credentials)` builds the wrapped argv, the
  profile where the mechanism needs one, and the child's environment.

Its two callers:

1. **`approval run`** (`src/cli/execute.ts`), for the granted action. This is the
   per-action half, and it is where the allowance and the injected credentials
   apply.
2. **`approval sandbox -- <argv>`**, a new verb, for the session half. The
   operator launches the agent's harness under it, so every command the harness
   subsequently spawns inherits the denial, including the ones approval.md never
   sees. This is the half that actually closes laundering, and it is deliberately
   operator setup rather than runtime magic: approval.md cannot install itself
   into someone's shell.

`approval doctor` gains a row reporting the mechanism, whether the current
process is inside a sandbox, and the policy's requirement.

### 3.2 The default posture

**Egress denied for autonomous and supervised exec. Egress allowed only where a
grant says so.**

Concretely, by resolved class:

| Resolved class | Egress default |
|---|---|
| `exec.*` | denied |
| `read.*` (including `read.web`) | denied under autonomous, allowed under a grant |
| `files.*`, `vcs.commit.*`, `vcs.push.*` | denied |
| `deps.install`, `deps.add`, `deps.upgrade` | allowed to the registry hosts named in the policy |
| `network.call` | allowed, to the hosts the grant names |
| `release.publish` | allowed, to the registry hosts named in the policy |

`read.web` is the awkward row and it is worth calling out. `curl
https://example.com` classifies `read.web` today, which the reference policy
resolves `autonomous`, so a read of the whole internet is currently ungated. The
proposal is that an autonomous `read.*` runs egress-denied like everything else,
which converts a silent capability into a visible refusal an agent must request
through the gate. That is a real ergonomic change and it is one of the sign-off
questions in §6.

### 3.3 How a grant carries an egress allowance

A **class-derived ceiling, intersected with an envelope-declared narrowing.**

The class table above is the ceiling and it is computed by the runtime from the
resolved class, so it is not self-reported and cannot be moved by the party under
oversight. An action's envelope MAY additionally declare

```yaml
egress:
  allow: ["registry.npmjs.org:443"]
```

which is applied as an INTERSECTION with the ceiling. A declaration that names a
host outside the ceiling is refused at registration with `envelope-invalid`
(existing code, existing surface); it is never silently widened, and it is never
silently trimmed either, because trimming would let a caller learn the ceiling by
probing it.

This is the shape SPEC §11.1 invariant 4 requires. The declaration is authored by
the party under oversight, and it can only ever RAISE scrutiny by narrowing what
the action may reach. It cannot lower anything. And because the envelope's
declaration is inside the payload the grant binds to (§10.4, `payload_hash`), the
human who granted the action approved those exact hosts, and changing them after
the grant is a `payload-mismatch` on the existing path with no new machinery.

`execution.started` records the allowance that was actually applied and the
mechanism that applied it. An auditor can then see which executions ran with a
door open, which ran starved, and which ran with no sandbox at all.

### 3.4 Credential custody

Today the passphrase named by `vault.passphrase_env` lives in whatever
environment the human established (§11.1 invariant 7), and any agent session
started from that shell inherits it, and every child of that session inherits it
again. The vault's own documentation is honest about this: it "does not defend an
agent that can read the passphrase variable".

The proposal moves the passphrase out of the agent's environment entirely.

1. **The daemon is the only process that holds the passphrase.** It is launched
   by the human, from the human's shell, exactly as invariant 7 requires. Agent
   sessions are launched by `approval sandbox`, which builds the child's
   environment from an ALLOWLIST rather than by inheritance. APRV-194 already
   maintains the list of `APPROVAL_*` names known to hold no secret
   (`APPROVAL_HUMAN`, `APPROVAL_AGENT`, `APPROVAL_ASCII`, `APPROVAL_MD`,
   `APPROVAL_HOME`, `APPROVAL_DIR`); that list, plus `PATH`, `HOME`, `TMPDIR` and
   kin, is what a session gets. Anything else is a deliberate addition with a
   reviewer.
2. **`approval run` spawns with an explicit environment, never by inheritance.**
   This is a one-line change with a large blast radius on ergonomics, and it is
   the single most valuable line in the whole design: it converts "the child can
   read everything the session holds" into "the child holds what the grant said".
3. **Credentials reach a granted child by injection, inside the consumed-token
   window.** The action's adapter declares `requiredCredentials` (APRV-169); the
   runtime resolves them from the vault inside the window the contract already
   opens, and puts them in the child's environment under exactly those names.
   Resolution failure is `credential-unavailable` with nothing appended and the
   grant intact, which is the behaviour APRV-169 already specifies.
4. **Optionally, on Seatbelt, the approval home is also unreadable to the
   child.** The prototype demonstrates this with `--deny-read`. It is defence in
   depth over ciphertext rather than the load-bearing control, since the vault is
   encrypted and the passphrase is what matters. It is worth having on the one
   platform where it is free, and the design does not depend on it.

**Stated limits, because a custody claim that oversells is worse than none.** A
credential injected into a child's environment is readable by that child, by
every descendant of that child, and, on Linux, by anything running as the same
uid through `/proc/<pid>/environ`. That is inherent: the granted process is the
one that needs the value. What the design buys is that EVERY OTHER process has
nothing, where today every process has everything. A file-descriptor or
0600-temp-file handoff would narrow the descendant case and is recorded as a
follow-up rather than folded in here.

### 3.5 Platforms with no sandbox primitive

**Recommendation: fail closed by default, with an operator-declared, attested,
per-execution-logged exception. Not an advisory doctor row.**

The mechanism:

- A new policy key, `exec.sandbox`, with values `required` (the default) and
  `advisory`.
- Under `required`, an execution on a machine with no working primitive is
  refused with a new code, `sandbox-unavailable`, and nothing is appended.
- Under `advisory`, the execution proceeds and `execution.started` records
  `sandbox: "unavailable"`, so audit can see exactly which runs were unprotected
  and an operator cannot later be unsure.
- `approval doctor` carries the row under both settings.

The argument for fail-closed-by-default. This project's stated engineering
invariant is that ambiguity resolves to the stricter path, always, and the
default posture is the one that governs the deployment nobody configured. An
advisory default has the failure mode this whole task exists to remove: the
protection is absent exactly where nobody is watching, and a doctor row is a
thing an operator learns to scroll past. The choice belongs to a person, so it
is a policy key rather than a runtime shrug, and because it is a policy key it
goes through the amendment ceremony and is signed. That is the approval.md-shaped
answer to "we cannot enforce this here": say so out loud, make the loosening a
human's signature, and record every execution that used it.

The argument against, stated fairly, because it is the one Carter has to weigh.
Windows has no primitive on this list, so `required` makes approval.md's exec
path unusable on Windows until someone writes a Job Object or WFP-based
mechanism. Hardened Linux kernels with user namespaces disabled are in the same
position, and they are common in exactly the corporate environments most likely
to want this feature. `required` therefore trades reach for a guarantee. The
mitigation is that `advisory` is one attested policy line away and that the log
says which runs took it.

### 3.6 What legitimate exec breaks, and the carve-outs

The survey the task asks for. Every row is a case where egress denial costs
something real.

| Case | Effect | Carve-out |
|---|---|---|
| `npm ci` / `npm install` from the lockfile | breaks: needs the registry | `deps.install` carries a ceiling of the registry hosts the policy names. This is the one carve-out that has to exist. |
| `npm test` reaching a localhost server the suite starts | works on macOS with `--allow-loopback`; **breaks on Linux**, because `--unshare-net` gives an empty namespace whose `lo` is down | Bring `lo` up inside the namespace (`bwrap --unshare-net` plus a loopback setup), which keeps the suite's own loopback working while still denying the host's. Documented refusal otherwise. |
| A test suite reaching an external service | breaks, deliberately | No carve-out. A test that needs the internet is a test the gate should see. |
| `git fetch` / `git push` | breaks | These already classify (`read.vcs.remote`, `vcs.push.*`) and reach the gate. Grant carries the ceiling for the remote's host. |
| `gh pr create` | breaks | Same: `vcs.pr.*` is supervised, and a supervised grant carries an egress allowance for the GitHub API host. |
| The Telegram channel long-poll | must NOT be sandboxed | It is the gate's own transport and runs in the daemon, which is launched by the human outside the sandbox. |
| The web channel on `127.0.0.1:4680` | reachable on macOS with `--allow-loopback`, unreachable on Linux | Documented refusal on Linux. The log file is the transport that always works. |
| DNS | denied along with everything else | Nothing to carve out. Failures surface as connect errors, which is the correct signal. |
| Language servers, `tsc`, `oxlint`, `node` scripts | unaffected | They touch the filesystem and nothing else. Verified by the prototype. |

### 3.7 Findings from the prototype

Evidence, on this machine (macOS, `sandbox-exec`), from `npm test --only
sandbox-probe`:

- Egress is **denied, not slowed**. A connect to 192.0.2.1:443 (RFC 5737
  TEST-NET-1, routed nowhere) returns `EPERM` in 2ms inside the sandbox and times
  out at 3004ms outside it. The test asserts both, so a no-op sandbox fails the
  suite rather than passing it.
- `curl -sS --max-time 8 https://example.com` inside the sandbox exits 7,
  "Failed to connect to example.com port 443 after 55 ms". Run under
  `SANDBOX_PROBE_EXTERNAL=1`; the leg is opt-in so `npm test` makes no external
  request in anyone's CI.
- File writes inside the sandbox succeed, and reading a `--deny-read` subpath
  fails with "Operation not permitted".
- Environment starvation works, and the CONTROL is the important half: without
  `--strip-env` the child reads `APPROVAL_TG_TOKEN` from the parent, which is
  today's `approval run` behaviour, pinned by a test so that closing it is a
  visible change.
- **`sandbox-exec …` and `bwrap …` are both UNCLASSIFIED by the command
  classifier**, so `approval hook claude-code` denies them, while the unsandboxed
  form of the same command is allowed. Today the hook actively penalises running
  something safely. A classifier rule for the wrappers is a hard prerequisite of
  the build, and it must classify the wrapper as its INNER command rather than as
  a new class, or the wrapper becomes a laundering device of its own.

---

## 4. Refusal codes and drafted SPEC amendments

One new refusal code. The egress denial itself produces no refusal, because it is
enforced by the kernel and surfaces to the child as a socket error; the runtime
refuses only when it cannot provide the sandbox it promised. The envelope
declaration that exceeds its ceiling is refused with the existing
`envelope-invalid` at registration, which avoids widening a frozen union twice.

Adding `sandbox-unavailable` to `execute_refusal_codes` WIDENS a union that
§11.1 invariant 6 freezes as public API. That is a deliberate amendment and it is
one of the sign-off questions.

### Draft for §7 (side-effect taxonomy)

> Insert after the `account.credential` paragraph (APRV-194):
>
> `exec.*` names the execution of code the runtime did not author, so its class
> states what MAY happen and the runtime's sandbox states what CAN. An
> implementation SHOULD execute `exec.*`, and every class resolving to
> `autonomous` or `supervised`, with outbound network denied by the operating
> system, and SHOULD permit egress only where the resolved class carries an
> egress ceiling and a grant is in force. The ceiling is computed from the
> resolved class and is therefore not self-reported; an action's envelope MAY
> declare an `egress.allow` list, which is applied as an intersection with the
> ceiling and never as a widening of it, so §11.1 invariant 4 holds over it
> unchanged. A declaration naming a host outside the ceiling is refused
> `envelope-invalid` at registration. Because the declaration is part of the
> payload the grant binds to (§10.4), the approver approved those hosts, and a
> change after the grant is `payload-mismatch` on the existing path.
> (Amended APRV-193, pending sign-off.)

### Draft for §10.4 (adapters and hard enforcement)

> Insert after the APRV-169 / APRV-168 paragraph:
>
> The same custody applies to the process boundary. An implementation MUST NOT
> hand a spawned child its own environment by inheritance: the child's
> environment is built from an allowlist of names known to carry no secret, and
> the credentials an action's adapter declared in `requiredCredentials` are
> injected into it inside the consumed-token window and under those exact names.
> A credential that cannot be resolved refuses `credential-unavailable` with
> nothing appended and the grant intact, exactly as above. What this buys is
> bounded and is stated rather than implied: the granted process can read what it
> was given, and so can its descendants and anything running as the same uid, and
> every OTHER process on the machine has nothing. The vault passphrase itself is
> never among the injected names, and the process that decrypts the vault is the
> one a human launched.
>
> An implementation SHOULD spawn a granted argv inside an operating-system
> sandbox that denies outbound network except as §7's egress ceiling allows.
> `execution.started` records the allowance that was applied and the mechanism
> that applied it, so an auditor can distinguish an execution that ran starved
> from one that ran with a door open and from one that ran with no sandbox at
> all. A policy key, `exec.sandbox`, governs a machine with no usable sandbox
> primitive: under `required`, the default, execution is refused with
> `sandbox-unavailable` and nothing is appended; under `advisory`, execution
> proceeds and `execution.started` records `sandbox: "unavailable"`. The
> loosening is a policy declaration a human attests, never a runtime judgment.
> (Amended APRV-193, pending sign-off.)

### Draft for §11.1 (global invariants)

> Add as invariant 10:
>
> 10. **Allowed execution is starved by default.** A process the runtime spawns
>     receives no outbound network and no credential unless the grant in force
>     says otherwise. The environment is built from an allowlist rather than
>     inherited, the egress ceiling is computed from the resolved class rather
>     than declared by the executing party, and an envelope's egress declaration
>     may only narrow that ceiling. Where the platform offers no sandbox
>     primitive the execution is refused under the default policy and permitted
>     only under an attested `exec.sandbox: advisory`, with every such execution
>     recorded as unprotected (`tests/sandbox.test.ts`). (Amended APRV-193,
>     pending sign-off.)

### Draft for §11.2 (refusal-code registry)

> Add to the `execute_refusal_codes` table, in definition order after
> `budget-exceeded`:
>
> | `sandbox-unavailable` | The policy declares `exec.sandbox: required` and no working sandbox primitive was found on this machine. Probed rather than inferred, because an installed binary on a kernel with the feature disabled exists and fails. Evaluated before the token is spent and before anything is appended, so a machine that cannot protect an execution costs no authority: the same token executes once the primitive is available. |

### CLAUDE.md amendment (drafted, not applied)

> Add to the "Engineering invariants" list, after "Global invariants are implicit
> acceptance criteria":
>
> - **Allowed execution is starved.** A spawned child gets no egress and no
>   credential unless a grant says otherwise; environments are built from an
>   allowlist and never inherited. A diff that reintroduces an inherited
>   environment on a spawn path fails review.

---

## 5. Decomposition into build tasks

For the orchestrator to file after sign-off. Not created by this lane.

**APRV-193a — Classifier rules for sandbox wrappers (S).**
Depends on: nothing. Unblocks everything else.
- [ ] `sandbox-exec -f <profile> -- <argv>`, `bwrap … -- <argv>`, `unshare … -- <argv>` and `approval sandbox -- <argv>` classify as the class of the INNER argv, never as a class of their own
- [ ] A wrapper whose inner argv is unclassified stays unclassified; the wrapper never softens a refusal
- [ ] A wrapper with no `--` separator, or with flags the rule does not model, is unclassified rather than guessed
- [ ] `docs/claude-code-hook.md` and `docs/cursor-hook.md` carry the rows (the docs guard requires it)

**APRV-193b — `src/core/sandbox.ts`: detection and argv construction (M).**
Depends on: none (parallel with 193a).
- [ ] `detectSandbox()` probes rather than infers, returns mechanism, loopback support, and a reason when unavailable
- [ ] `sandboxSpawn` builds the wrapped argv and, on Seatbelt, a profile written 0600 with every path resolved
- [ ] Environment is built from an allowlist; there is no code path that spreads `process.env`
- [ ] Deterministic parts are unit-tested without spawning; the spawning parts skip cleanly where the primitive is absent
- [ ] Ports the prototype's findings: the AF_UNIX exception, the realpath resolution, the Linux loopback asymmetry

**APRV-193c — The egress ceiling and the envelope declaration (M).**
Depends on: 193b.
- [ ] A class-to-ceiling table, pure and exhaustively tested, with `deps.install`, `network.call` and `release.publish` the only rows carrying hosts
- [ ] `envelope.schema.json` gains an optional `egress.allow`; schema change is inside this task and stated in its notes
- [ ] A declaration outside the ceiling refuses `envelope-invalid` at registration, with nothing appended
- [ ] The declaration is inside the payload the grant binds to; a post-grant change is `payload-mismatch` through the existing path, pinned by a test
- [ ] Invariant 4 is pinned: a declaration can narrow and cannot widen

**APRV-193d — `approval run` spawns starved (M).**
Depends on: 193b, 193c. **Touches `src/cli/execute.ts`.**
- [ ] The spawn passes an explicit `env` built from the allowlist; the inheritance is gone
- [ ] Adapter-declared `requiredCredentials` are injected under their own names inside the consumed-token window; failure is `credential-unavailable`, nothing appended, grant intact
- [ ] `execution.started` records the applied allowance and the mechanism
- [ ] `sandbox-unavailable` is added to `execute_refusal_codes`, refuses before the token is spent, and appends nothing (this widens a frozen union: §11.1 invariant 6, called out in the notes)
- [ ] A laundering test: an action granted with no egress allowance spawns a script that attempts a connect, and the connect is refused

**APRV-193e — `exec.sandbox` policy key and the doctor row (S).**
Depends on: 193b.
- [ ] `exec.sandbox: required | advisory`, defaulting to `required` when absent, unparseable, or unrecognized
- [ ] Under `advisory`, `execution.started` records `sandbox: "unavailable"`
- [ ] `approval doctor` reports the mechanism, whether this process is inside one, and the policy's requirement, under both settings

**APRV-193f — `approval sandbox` session launcher and the fleet runbook (M).**
Depends on: 193b, 193a.
- [ ] `approval sandbox -- <argv>` launches a session egress-denied with a starved environment
- [ ] Refuses `sandbox-unavailable` under `exec.sandbox: required`
- [ ] `docs/sandboxed-sessions.md`: how the fleet launches under it, which carve-outs exist, what breaks on Linux
- [ ] The laundering demonstration recorded end to end: an allowed `npm test` whose test file attempts an SMTP send and a webhook POST, both blocked

**APRV-193g — Linux verification leg (M).**
Depends on: 193b, 193d. Needs a Linux machine or a CI job.
- [ ] `bwrap` and `unshare` paths exercised on a kernel with user namespaces enabled
- [ ] The loopback asymmetry measured and documented, and the `lo`-up carve-out decided
- [ ] Behaviour on a kernel with user namespaces DISABLED: the probe reports unavailable, and `required` refuses

**APRV-193h — SPEC and CLAUDE.md amendments applied (S).**
Depends on: all of the above. Human applies; the agent does not touch protected paths.

Sizes: S is a session, M is a session with a design decision in it. 193a and
193b are the two that can start immediately and in parallel.

---

## 6. The human sign-off questions

Only Carter can answer these.

1. **Default posture: does an autonomous `read.web` lose the internet?** The
   design says every autonomous and supervised execution runs egress-denied,
   which means `curl https://example.com` and `WebFetch`-shaped shell reads stop
   working without a grant. That is the honest reading of "starve the code", and
   it is a daily ergonomic cost on research-shaped work. The alternative is to
   carve `read.*` out of the denial, which leaves a GET-shaped door open through
   which anything can be exfiltrated in a query string. **Which?**

2. **Platform fallback: `required` or `advisory` as the shipped default?** §3.5
   argues for `required`, fail-closed, with `advisory` available as an attested
   policy line and every unprotected execution recorded. The cost is that
   approval.md's exec path does not work on Windows or on a hardened Linux kernel
   until someone writes a mechanism for it. **Is that the trade you want, or
   should v1 ship `advisory` with a doctor row and flip later?**

3. **Does custody change the vault format?** The design does NOT change it: the
   vault stays `.approval/vault.enc`, AES-256-GCM under a scrypt-derived key, and
   what moves is WHO holds the passphrase (the daemon, launched by you) and how a
   credential reaches a child (injected into an allowlisted environment). The
   alternative, which would change the format, is per-credential grants sealed to
   the granted execution so the daemon hands over one credential rather than
   decrypting the whole map. That is a bigger change with a migration. **Stay
   with the current format?**

4. **Widening a frozen union.** `sandbox-unavailable` adds a member to
   `execute_refusal_codes`, which §11.1 invariant 6 freezes as public API. It
   comes with a §11.2 registry row and a test pin. **Confirm the union may grow
   here.**

5. **Does the fleet actually launch under `approval sandbox`?** The per-action
   half is enforceable by the runtime; the session half is you changing how
   agents are started. Without it the laundering hole stays open for every
   command that is not an `approval run`. **Will the fleet's launcher change, and
   on what timeline?**

6. **Linux loopback.** A test suite that starts its own localhost server keeps
   working on macOS and breaks under `--unshare-net` unless the build brings `lo`
   up inside the namespace. Bringing it up is a small carve-out with a small
   widening. **Carve it out, or let those suites be a documented refusal?**
