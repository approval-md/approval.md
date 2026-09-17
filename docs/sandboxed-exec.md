# Sandboxed exec — starving allowed commands of the network

APRV-193. What the sandbox is, what it costs, and how the fleet runs under it.

The one-line version: **a command nobody was asked about runs with no way out
to the network.** `approval run` applies it to the children it spawns,
`approval sandbox` applies it to a command the harness runs on its own, and the
hook can be told to insist on the second.

## Why the gate needed this

The gate classifies a command by its TEXT. `npm test` runs whatever an agent
wrote a minute ago, so for laundered execution the command's name has stopped
describing the effect, and no classifier over shell strings can close that. Gate
`communicate.email.external` and an agent can reimplement it in twenty lines of
`node:net`; the gate on the named action is then advisory, and the interesting
question is not what the agent typed but what the code can reach.

So the fix is not a better classifier. It is to take away the capability:
outbound network denied, credential-bearing variables scrubbed
(`core/child-env.ts`, APRV-205), credential material on disk unreadable. The
code still runs. It runs into a room with no doors.

This costs the gate nothing to keep working, because **the gate's IPC is a
file**: the daemon polls `.approval/log/events.jsonl` and opens no socket. Other
agent sandboxes deny egress and then build a local proxy to leave one door open;
here the door already exists, as an append to a file.

## The mechanism

macOS `/usr/bin/sandbox-exec` with a Sandbox Profile Language profile
(`src/core/sandbox.ts`). It ships with the OS, needs no privilege, no daemon and
no kernel configuration.

```
(version 1)
(allow default)
(deny network-outbound)
(allow network-outbound (regex #"^/"))          ;; AF_UNIX: local IPC is not egress
(deny file-read* (literal "/…/.approval/vault.enc"))
(deny file-read* (literal "/…/.approval/env"))
(deny file-read* (subpath "/…/.approval/keys"))
```

Three behaviours are measured rather than assumed, and each of them, got wrong,
ships a profile that silently protects nothing:

1. `network-outbound` covers **AF_UNIX** connects as well as AF_INET. A bare
   `(deny network-outbound)` kills local IPC, mDNSResponder included, and the
   process dies before it can do anything. The unix exception is mandatory.
2. `subpath` and `literal` match the kernel's **resolved** path. On macOS `/tmp`
   is a symlink to `/private/tmp`, so a profile naming `/tmp/x` denies nothing
   at all. Every path is realpath-resolved before it is written into a profile,
   and `tests/sandbox.test.ts` pins the unresolved spelling as the no-op it is.
3. `sandbox-exec` execs through `execvp`, so a lookup that FAILS exits **71**,
   which would be recorded as the child's own exit code. The command is resolved
   to an absolute path first, and one that does not resolve is never wrapped.

### The read jail (APRV-347)

The profile above is a deny-LIST: allow by default, deny the network and the
credential files. That stays the default, byte for byte, and
`tests/sandbox-read-jail.test.ts` pins it — a profile built without a read jail
is identical to the profile this runtime produced before the jail existed, so no
deployment that did not ask for one pays anything for it.

A policy that declares a `read_scope` block (SPEC.md §5.2) flips file reads to
deny-default for `approval run` and `approval sandbox`:

```
(deny file-read*)
(allow file-read* (subpath "/Users/…/dev/muse"))       ;; the gate root
(allow file-read* (subpath "/usr/lib"))                ;; the runtime set, fixed
(allow file-read* (subpath "/System"))
…
(allow file-read-metadata (literal "/Users"))          ;; stat the way down
(deny file-read* (literal "/…/.approval/vault.enc"))   ;; last word wins
```

Three things about it are load-bearing:

- **Order is the policy.** SBPL takes the LAST matching rule, so the roots open
  the filesystem and the credential denials close it again afterwards. A vault
  inside an allowed root stays unreadable because its denial is written after
  the allow that contains it, and the test asserts the ordering rather than the
  presence.
- **The runtime set is compiled in** (`RUNTIME_READ_PATHS` in
  `src/core/sandbox.ts`): dyld and the shared cache, `/usr/lib`, `/System`,
  `/Library`, `/dev`, the standard binary directories, `/etc`, the temp roots,
  and this process's own resolved `node`. A caller cannot widen it. A jail whose
  runtime set could be extended by the party under oversight is not a jail.
- **The temp roots come from the CALLER, not from the profile builder.**
  `approval run` and `approval sandbox` build their roots with
  `resolveReadRoots`, which includes the session scratchpad and the system temp
  root, so both are open in an ordinary jailed run and build tooling keeps
  working. Two consequences, and the second is why this is a bullet rather than
  a footnote. Material an agent parks in the system temp directory is readable
  from inside such a jail, whoever put it there, so do not treat temp as
  private. And a caller that passes narrower roots gets a narrower jail: the
  temp allowance is a default, not a floor, which is exactly what
  `tests/sandbox-read-jail.test.ts` relies on to demonstrate a real denial with
  its fixtures sitting under temp.
- **The root directory is readable, as a listing.** `(allow file-read*
  (literal "/"))` is in every jailed profile because without it a process dies
  with SIGABRT before `main`; measured, not reasoned. Every directory between
  `/` and an allowed root gets `file-read-metadata` and nothing more, so a path
  can be resolved without its contents being readable.
- **`node_modules` is not special.** Dependencies inside the gate root are
  covered by the root. Dependencies OUTSIDE it — a linked package, a shared
  store, or a git worktree whose `node_modules` lives up in the primary
  checkout — are refused, and that is the one way the jail breaks an ordinary
  project. The fix is a `read_scope.roots` entry naming that directory, which is
  what the key is for. The refusal and the fix are both pinned as tests.

`approval sandbox --read-jail` turns it on for one command whether the policy
declares a block or not. There is no flag that turns it OFF where the policy
asked for it: a flag an agent can pass must only ever make the room smaller.

**Linux is not implemented in this build.** `bwrap --unshare-net` and
`unshare --net` are the mechanisms (both need unprivileged user namespaces,
which hardened kernels disable, so availability has to be probed rather than
inferred from the binary existing), and `detectSandbox()` reports
`supported: false` there with that reason. See "Platforms" below for what
happens meanwhile. Windows has no mechanism on the list at all.

## The three surfaces

| Surface | What it protects | Default |
|---|---|---|
| `approval run <key> -- <cmd>` | the child of a gated execution | egress denied when no token was presented; `--no-sandbox` opts out and is RECORDED on `execution.started` |
| `approval sandbox -- <cmd>` | one command a harness runs on its own | egress denied, always; the verb refuses rather than running unsandboxed |
| `approval hook claude-code` / `cursor` | the harness's own tool calls | nothing, unless `APPROVAL_HOOK_REQUIRE_SANDBOX=1`, which then DENIES unwrapped code execution and names the spelling that works |

The hook cannot apply the sandbox itself: a `PreToolUse` verdict is allow or
deny and cannot rewrite a command into a wrapper. So the wrapper is a spelling
the command is written in, and the classifier reads
`approval sandbox -- npm test` as `npm test`: same class, same gate, same
verdict. Before APRV-193, `sandbox-exec …` was `hook-unclassified` and denied
while the bare command was allowed: the hook actively penalised the safe
spelling.

A hand-written `sandbox-exec -f mine.sb <cmd>` is classified honestly (by its
inner argv, marked `external`) and satisfies the hook requirement for nothing:
a profile whose only line is `(allow default)` denies nothing, and a requirement
a caller can meet by writing their own permission is not a requirement.

## What `approval run` records

`execution.started` carries `sandbox`:

| Value | Means |
|---|---|
| `egress-denied` | the child ran with no outbound network |
| `granted-egress` | a token was presented: a human approved these exact bytes, and `approval run` on a grant is the one door to the world |
| `opted-out` | `--no-sandbox`. Recorded because an opt-out nobody can see afterwards is an opt-out that costs nothing to take |
| `unsupported` | no mechanism on this platform; the execution ran UNPROTECTED and this is how an auditor finds every run that did |

The token is what separates the first two, and it is read before the append
rather than re-resolving the class after it. It widens nothing an agent can
reach alone: a token that does not verify runs no command at all, so the
loosening needs something a human minted (SPEC.md §11.1 invariant 4).

One rough edge, stated rather than hidden: a manual action whose token was
delivered SEALED (APRV-105) rather than passed on the command line presents no
`--token`, so it runs `egress-denied` like any untokened child. That is the
strict direction and it is the wrong answer for a granted `network.call`. Pass
the token, or take the recorded `--no-sandbox`. Question 1 in
`docs/proposals/aprv-193-amendments.md` is where this gets settled.

## The survey: what egress denial actually costs

Every row is a case where denying the network costs something real. A row is
either a carve-out (with the mechanism) or a refusal (with the reason).

| Case | Under the sandbox | Carve-out, or refusal |
|---|---|---|
| `npm ci`, `npm install` | **breaks**: the registry is unreachable | **Carve-out.** These classify `deps.install` / `deps.add`, which the reference policy holds manual, so they go to a human and run through `approval run` with a token: `granted-egress`, network intact. An install that is NOT going through the gate does not get the network back. |
| `npm test`, `npm run build`, `tsc`, `oxlint`, `node script.mjs` | **work**: they touch the filesystem and nothing else | No carve-out needed. Verified on this repository: `approval sandbox -- npm run typecheck` and `approval sandbox -- npm run lint` both exit 0 inside the profile, and `tests/sandbox.test.ts` runs node scripts inside it throughout. |
| A suite that starts its own localhost server | **breaks**: loopback is denied with everything else | **Carve-out.** `approval sandbox --allow-loopback -- npm test`. It is a real widening (a port is a port, and anything listening on one is reachable from inside), so it is a flag a human types rather than a default. |
| A suite that reaches an external service | **breaks**, deliberately | **Refusal.** A test that needs the internet is a test the gate should see. Route it through `approval run` on a grant, or make it a fixture. |
| `git fetch`, `git push`, `gh pr create` | **break** if you wrap them, or run them through `approval run` with no token; untouched otherwise | **Carve-out through the gate.** All three already classify (`read.vcs.remote`, `vcs.push.*`, `vcs.pr.*`) and reach the policy. Run them unwrapped under the hook, or through `approval run` with the grant they need. They are not `CODE_EXECUTING_RULES`, so `APPROVAL_HOOK_REQUIRE_SANDBOX` does not ask them to wear a room. |
| The Telegram channel's long poll, the daemon | **must not be sandboxed** | **Refusal to sandbox.** They are the gate's own transport, launched by the human outside any wrapper. Nothing in this build wraps them. |
| The web channel on `127.0.0.1:4680` | reachable only with `--allow-loopback` | **Documented.** The log file is the transport that always works; the web channel is a convenience for a human at the same machine. |
| DNS | resolution still works (mDNSResponder is an AF_UNIX socket), the connect that follows does not | Nothing to carve out. Failures surface as connect errors, which is the correct signal. |
| An agent HARNESS (`claude`, `cursor-agent`) | **breaks**: it needs the model API | **Refusal, and the honest limit of this build.** A whole-session sandbox needs an egress allowlist reaching one host, which Seatbelt cannot express by hostname; the prior art solves it with a local proxy. Until that exists the unit protected is the COMMAND, not the session. |
| `approval` itself (`register`, `request`, `wait`, `log verify`) | **works** | The gate's IPC is a file. This is the simplification the whole design rests on. |

## Platforms

| Platform | `detectSandbox()` | `approval run` | `approval sandbox` |
|---|---|---|---|
| macOS with a working `sandbox-exec` | available | denies egress | denies egress |
| macOS where the profile is refused | `supported`, not `available` | **refuses**: nothing runs, nothing is appended, the token is unspent | refuses |
| Linux, Windows (no mechanism in this build) | not `supported` | proceeds, records `sandbox: "unsupported"` | **refuses** |
| Anywhere, with `APPROVAL_SANDBOX_REQUIRED=1` | unchanged | refuses instead of proceeding | refuses |

The asymmetry is deliberate and it is the one place this build is not maximally
strict. `approval run` on a platform with no mechanism proceeds, because
refusing there would take the whole execution path away from every operator not
on macOS, and it records `unsupported` on every such execution so the gap is
visible in the log rather than in someone's memory. `approval sandbox` refuses,
because it makes exactly one promise and a command it ran anyway would be a
command an operator believes is starved and is not.

The proper form of this switch is a policy key (`exec.sandbox: required |
advisory`) that a human attests, which is drafted in
`docs/proposals/aprv-193-amendments.md` and is not implemented here: policy keys
live in `APPROVAL.md`, which agents do not edit. `APPROVAL_SANDBOX_REQUIRED=1`
is the interim, and it is safe as an environment variable for the same reason
`APPROVAL_HOOK_REQUIRE_SANDBOX=1` is: both can only ever refuse MORE, and
nothing readable from an environment loosens anything.

## Running the fleet under it

1. Nothing to install. `sandbox-exec` ships with macOS.
2. Write code-running commands as `approval sandbox -- <command>`:
   ```
   approval sandbox -- npm test
   approval sandbox --allow-loopback -- npm run test:integration
   ```
   The hook classifies these exactly as the bare command, so no policy changes.
3. To make it mandatory rather than a habit, set
   `APPROVAL_HOOK_REQUIRE_SANDBOX=1` in the environment the harness's hook runs
   in. Unwrapped `npm test` / `node x.mjs` / `tsc` then deny with
   `hook-sandbox-required`, and the deny text names the spelling that works.
   Everything else (`git`, `gh`, `mkdir`, `cat`, an edit) is untouched.
4. Leave the daemon and the channels outside. They are the gate's transport and
   the human launches them.
5. **To confine what those commands may READ** (APRV-347, wired here by
   APRV-193), declare a `read_scope` block in the gate's `APPROVAL.md`. Both
   `approval run` and `approval sandbox` then build the deny-default read
   profile above from the gate root plus whatever the block adds, so a command
   that goes looking outside the project gets EPERM rather than a file. Try it
   on one command first: `approval sandbox --read-jail -- npm test` applies the
   same jail without touching the policy, which is the cheap way to find the
   directory your build reads and nobody remembered (usually a `node_modules`
   outside the root, or a global cache).

**Why the policy and not a flag.** The jail is turned on by a key in the file a
human writes and attests, and there is no flag that turns it OFF where that key
asked for it. A flag an agent can pass must only ever make the room smaller
(SPEC.md §11.1 invariant 4), so `--read-jail` can add the confinement and
nothing can remove it. A gate whose policy declares no `read_scope` gets the
profile it got before, byte for byte.

**What this wires, and what it still does not.** Steps 2 and 5 protect a
COMMAND. They do not put the harness itself in the room: `claude` and
`cursor-agent` talk to a model over the network, which is exactly what the
profile denies, so `approval sandbox -- claude` is a session that cannot think.
Whole-session containment is APRV-351, below.

## Constrained model egress (APRV-351)

The design is `design/constrained-model-egress.md`. The outcome, stated here so
this file answers the question on its own: **recommended, opt-in, and the
`approval sandbox --harness <name>` mode lands only after the round trip below
passes.** `APPROVAL_HOOK_REQUIRE_SANDBOX` stays default off, unchanged.

Seatbelt cannot express a hostname allow-list. This is measured rather than
assumed: `sandbox-exec` refuses to compile a profile naming a host, with `host
must be * or localhost in network address`, and refuses a literal IP the same
way. The only postures available are all egress, no egress, or a port on
loopback. So the mechanism is a **pinning forwarding proxy on loopback**: it
accepts `CONNECT`, matches the authority against an exact allow-list, and
tunnels bytes without terminating TLS, while the profile admits only that one
port and everything the harness spawns keeps the ordinary no-network profile.

Everything the mechanism can enforce is proved offline against loopback stubs:

```bash
node scripts/probes/constrained-egress.mjs probe
```

Seven assertions, no internet, no credential, no model call. Exit 0 if all held,
1 if any failed, 69 (`EX_UNAVAILABLE`) on a machine with no Seatbelt, where
`tests/probe-constrained-egress.test.ts` skips rather than reporting a false
pass.

### Harness round trip

The one leg a probe cannot prove is a real harness completing a real model call
behind the proxy, because that needs a provider and a credential no agent
session may hold. **This command is the operator's.** Run it in a terminal where
your Claude Code credential already works, with the repository built:

```bash
node scripts/probes/constrained-egress.mjs proxy --allow api.anthropic.com:443 --port 8931 & \
  sleep 1 && HTTPS_PROXY=http://127.0.0.1:8931 NO_PROXY= \
  node dist/src/cli.js sandbox --allow-loopback -- claude -p "reply with the single word: confined"
```

Note `--allow-loopback`, not a per-port flag. The narrow single-port carve-out
the design calls for arrives with `--harness`, which has not shipped; today's
flag opens `localhost:*`, which is wider. That is deliberate and it is stated
rather than hidden: this round trip is measuring whether **the harness** works
through a pinned proxy at all, which is the open question. The profile's
narrowness is already measured separately, offline, by the probe above.

A pass is the word `confined` coming back, and the proxy's own line showing it
admitted `api.anthropic.com:443` and nothing else. A fail is either a hang (the
harness is not honouring `HTTPS_PROXY`) or the proxy logging a refusal naming a
host you did not pin (the harness has a second egress path, which is the finding
that matters most). Kill the backgrounded proxy afterwards.

Report the result on APRV-351. It decides whether `--harness` ships as designed
or ships narrower.

## What this does not claim

- **A sandboxed child can still write files**, including a file some later
  unsandboxed process runs. That is the same laundering one step removed, and it
  is why the requirement in step 3 above matters more than any single wrapper.
- **Inbound sockets are not denied.** A child could bind a port and wait to be
  contacted. That needs a peer able to reach this machine, and it is recorded
  here as a stated limit rather than an oversight.
- **Credential custody is bounded.** A credential injected into a granted
  child's environment is readable by that child and its descendants. What the
  design buys is that every OTHER process has nothing, where before every
  process had everything.
- **This is not isolation.** It is one capability removed from a process that
  otherwise has the ordinary powers of the session. A machine that is already
  compromised is not defended by any of this.
