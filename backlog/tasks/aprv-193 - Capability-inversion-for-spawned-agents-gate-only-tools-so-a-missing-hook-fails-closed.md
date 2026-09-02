---
id: APRV-193
title: >-
  Starve the code: egress-sandboxed allowed exec and credential custody, so
  laundered side effects fail closed
status: In Progress
assignee:
  - 'agent:opus-lane-k'
created_date: '2026-09-01 03:21'
updated_date: '2026-09-02 03:33'
labels:
  - security
  - dogfood
  - design
dependencies: []
priority: high
ordinal: 163000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Reframed after discussion with Carter (2026-09-01). Arbitrary code execution is capability-complete: gate the communicate.email.external verb and an agent can reimplement it in code, so a gate on named actions with ungated exec underneath is advisory. The direct route is already chokepointed (the hook classifies shell commands and fails closed on unknowns), and APRV-151/192 cover the hook-absent session. The remaining hole is laundered exec: allowed commands that run mutable project code (npm test, node/tsx scripts inside the repo) execute whatever the agent just wrote, and the command name no longer describes its effect. No command classifier can close that.

The fix is to starve the code, and to leave editing alone. Editing stays free: a file that never runs sends nothing, and gate-routed editing would push bulk coding actions through the transparency log (a database problem the log should not inherit). Exec stays classified as today. What changes: (1) allowed-class exec runs inside an OS-level sandbox whose outbound network is denied except loopback to the gate daemon (macOS sandbox-exec/seatbelt; Claude Code sandboxed-bash where available), so laundered code executes into a room with no doors; (2) credential custody stays absolute (vault secrets sealed, released only via approval run) so authenticated effects are impossible without a grant regardless of network; (3) approval run, executing post-grant outside the sandbox, remains the only door to the world. The APPROVAL.md contract is then enforced by capability, and a missing hook means no egress instead of free egress.

Deliverables: the sandbox profile and spawn wiring for dev-fleet agent sessions, a laundering demonstration (an allowed command attempting SMTP/webhook egress, blocked), measurement of what legitimate allowed exec breaks (test suites needing localhost, package installs) with documented carve-outs, and drafted SPEC/CLAUDE.md amendment text for human sign-off (protected: the agent does not apply it). Original rung-4 framing (gate-only MCP tools replacing built-in editors) is recorded here as considered and rejected for the dev fleet: right polarity, wrong layer, real ergonomic cost. It remains the correct posture for audience-facing runners (the web-agent demo already does it).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A sandbox profile denies outbound network for allowed-class exec (loopback to the gate daemon excepted), wired into how dev-fleet agent sessions run commands; profile and wiring committed
- [ ] #2 Laundering demo: an allowed command (npm test or node script) attempting an SMTP send and a webhook POST is blocked by the sandbox, shown in a test or recorded transcript
- [ ] #3 Credential-starvation confirmed: the same laundered code cannot read vault material or .approval/env from an agent session, tested
- [ ] #4 Legitimate-exec survey: what allowed commands need network (installs, localhost test servers), each with a carve-out or a documented refusal
- [ ] #5 SPEC and CLAUDE.md amendment text drafted for human sign-off, not applied
- [ ] #6 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. DESIGN LANE ONLY: produce design + standalone prototype; the wiring is a later build task after Carter signs off. Protected paths (SPEC.md, CLAUDE.md, APPROVAL.md, .approval/, .claude/, src/core/gate.ts, src/core/execute.ts, .github/) are not touched.
2. Read the enforcement path as it stands: src/cli/execute.ts commandRun (spawnSync with NO env option, so the child inherits the whole parent environment), src/adapters/contract.ts (CredentialProvider, ExecutionGrant, scopeCredentials, requiredCredentials/APRV-169), src/core/command-class.ts (APRV-194 credential rules), SPEC 7 / 10.4 / 11 / 11.2, the daemon (log-file IPC, no socket).
3. Prior-art survey with concrete mechanisms: macOS sandbox-exec/SBPL, Linux bwrap --unshare-net / unshare -n / seccomp-bpf socket filtering / Landlock ABI4 / firejail / nsjail, Deno --allow-net and Node --permission (no network permission, stated as the reason we cannot self-sandbox in-process), Claude Code sandbox mode, Codex sandbox_mode x approval_policy, Docker --network=none and iptables egress allowlists. Portability and operator-setup cost for each.
4. Proposed design, written to design/aprv-193-starve-the-code.md: enforcement at the spawn site with two callers of one module; class-derived egress CEILING intersected with an envelope-declared NARROWING (invariant 4: a self-report may narrow and may never widen); credential custody with the vault passphrase held only by the daemon's environment and never present in an agent session; platform fallback recommendation; drafted SPEC amendment text for 7, 10.4, 11.1 and 11.2 flagged '(Amended APRV-193, pending sign-off.)'.
5. Prototype scripts/sandbox-probe.mjs: detect the primitive (sandbox-exec on macOS, bwrap then unshare -n on Linux, none elsewhere), --json report, 'run --' wrapper, clean 'sandbox unavailable' exit. Wire NOTHING into the gate.
6. Test tests/sandbox-probe.test.ts, spawning the script the way tests/classify-tier.test.ts spawns classify-tier.mjs: skip cleanly where the primitive is missing; otherwise prove a file write succeeds inside and that egress is DENIED rather than merely slow, using a non-routable RFC 5737 address as the always-on leg and an opt-in curl https://example.com leg for the recorded demonstration.
7. Decomposition into build tasks (titles, ACs, dependencies, sizes) and the human sign-off questions, both into the implementation notes. Lint and build clean, npm test green. Leave the task In Progress.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
DESIGN LANE (opus, lane K, worktree agent-a3c9c9fc09e714b7c), 2026-09-01. This lane produced the design and a standalone prototype. Nothing is wired into the gate: no file under src/ was touched, no protected path was touched, and the prototype is imported by nothing.

ARTIFACTS
- design/aprv-193-starve-the-code.md — prior-art survey, the proposed design, the drafted SPEC 7 / 10.4 / 11.1 / 11.2 and CLAUDE.md amendment text (all flagged '(Amended APRV-193, pending sign-off.)'), the legitimate-exec survey with carve-outs, the build decomposition, and the six sign-off questions.
- scripts/sandbox-probe.mjs — the prototype: detect / run / connect, macOS sandbox-exec with an SBPL profile, Linux bwrap then unshare, clean 'sandbox unavailable' with exit 69 (EX_UNAVAILABLE) where the primitive is missing.
- tests/sandbox-probe.test.ts — 10 cases, 10 pass on this machine, skipping cleanly by design where the primitive is absent.

THE HOLE, LOCATED IN THE CODE. src/cli/execute.ts commandRun calls spawnSync(command, args, { cwd, stdio, encoding }) with NO env option, so Node hands the child a copy of the entire parent environment: APPROVAL_TG_TOKEN, whatever the policy names in vault.passphrase_env, everything. That is the credential half of the laundering hole, and APRV-194 could not reach it because the classifier sees 'npm test' while the reading happens in TypeScript. The egress half is the same spawn with ambient network capability.

WHAT THE PROTOTYPE PROVED, with numbers rather than claims.
- Egress is DENIED, not slowed: a connect to 192.0.2.1:443 (RFC 5737 TEST-NET-1, routed nowhere) returns EPERM in 2ms inside the sandbox and times out at 3004ms outside it. The suite asserts BOTH, so a no-op sandbox fails rather than passes.
- curl -sS --max-time 8 https://example.com inside the sandbox exits 7, 'Failed to connect to example.com port 443 after 55 ms'. The leg runs under SANDBOX_PROBE_EXTERNAL=1 and is opt-in so npm test makes no external request in anyone's CI; it was executed once in this lane and is green.
- A file write inside succeeds; a --deny-read subpath is 'Operation not permitted'.
- Environment starvation works, and the CONTROL is the load-bearing half: without --strip-env the child reads APPROVAL_TG_TOKEN out of the parent, which is today's approval run behaviour, pinned so closing it is a visible change.
- Fail-closed is pinned on every platform via SANDBOX_PROBE_FORCE_UNAVAILABLE=1: no sandbox means exit 69 and the command is NOT run, asserted by a witness file that must not exist.

TWO SEATBELT BEHAVIOURS VERIFIED RATHER THAN ASSUMED, each of which would otherwise ship a profile that silently protects nothing. (1) network-outbound covers AF_UNIX connects as well as AF_INET, so a bare (deny network-outbound) kills local IPC and the process dies before it can prove anything; the unix exception is mandatory. (2) subpath filters match the kernel's RESOLVED path, so a profile naming /tmp/x on macOS denies nothing at all because the process opens /private/tmp/x. The prototype resolves every path before writing it into a profile.

THE FINDING THAT BLOCKS THE BUILD: 'approval hook classify -- "sandbox-exec -f /tmp/p.sb node --version"' and the bwrap equivalent are both UNCLASSIFIED, so the hook denies them, while the unsandboxed form of the same command is allowed. Today the hook actively penalises running something safely. A classifier rule for the wrappers (APRV-193a in the decomposition) is a hard prerequisite, and it must classify a wrapper as the class of its INNER argv, or the wrapper becomes a laundering device of its own.

THE SIMPLIFICATION NOBODY ELSE GETS: the gate's IPC is a FILE. src/daemon/ opens no socket; the daemon polls .approval/log/events.jsonl. So a network-only sandbox leaves the gate fully reachable with zero plumbing, and the 'one door' the prior art builds an egress proxy for already exists as an append to a file. That is why the design denies the network and leaves the filesystem alone. The one caveat is src/channels/web.ts binding 127.0.0.1:4680: Seatbelt can allow localhost back in, a Linux network namespace cannot, because its lo is a different and empty loopback.

DESIGN IN ONE PARAGRAPH. Enforcement is at the spawn site, through one module (src/core/sandbox.ts) with two callers: approval run for the per-action half and a new 'approval sandbox --' verb for the session half the fleet launches under. The default is egress denied for autonomous and supervised exec. An allowance is a class-derived CEILING (computed by the runtime, so not self-reported) intersected with an optional envelope-declared NARROWING, which is exactly the shape SPEC 11.1 invariant 4 requires: the declaration can only raise scrutiny, and because it sits inside the payload the grant binds to, the approver approved those hosts and a post-grant change is payload-mismatch through the existing path. A declaration outside the ceiling refuses envelope-invalid at registration, an existing code on an existing surface, so only ONE new refusal code is proposed. Custody moves the vault passphrase out of every agent session: the daemon holds it, sessions are launched with an allowlisted environment, approval run spawns with an explicit env, and adapter-declared requiredCredentials (APRV-169) are injected under their own names inside the consumed-token window.

GLOBAL INVARIANTS TOUCHED (CLAUDE.md requires saying so). Invariant 4, self-reported fields never reduce scrutiny: the egress declaration is authored by the party under oversight and is therefore intersection-only, and the design says so in the SPEC draft rather than only in code. Invariant 6, refusal unions are frozen public API: the design ADDS sandbox-unavailable to execute_refusal_codes, which is a deliberate widening, comes with a drafted 11.2 registry row, and is sign-off question 4. A new invariant 10 ('allowed execution is starved by default') is drafted for 11.1 and mirrored into the CLAUDE.md invariant list, per the rule that a cross-cutting safety property must live in both places.

PLATFORM FALLBACK, RECOMMENDED: fail closed. A policy key exec.sandbox with values required (default) and advisory; under required a machine with no working primitive refuses sandbox-unavailable before the token is spent and appends nothing, so the same token executes once the primitive is available; under advisory the execution proceeds and execution.started records sandbox: 'unavailable' so audit sees exactly which runs were unprotected. The argument: ambiguity resolves to the stricter path, the default governs the deployment nobody configured, and an advisory-only posture is absent exactly where nobody is watching while a doctor row is a thing operators learn to scroll past. The loosening belongs to a person, so it is an attested policy line rather than a runtime shrug. The cost, stated fairly for Carter: Windows and hardened Linux kernels with user namespaces disabled lose the exec path until someone writes a mechanism for them.

VERIFICATION: npm run lint clean, npm run build clean, node scripts/run-tests.mjs --only sandbox-probe 10/10 with the external leg on and 9 pass / 1 skip with it off. Full npm test result recorded separately below.

FULL SUITE (2026-09-01, this worktree): npm test, 2646 tests, 2644 pass, 1 skip (the opt-in external curl leg), 1 fail. The failure is the known lane-only ci-guard case 'every production dependency's engines.node admits the Node floor', ENOENT on node_modules/@modelcontextprotocol/sdk/package.json, which is this worktree lacking installed production deps and is recorded as lane-only in APRV-185's notes. It classifies nothing and spawns nothing. npm run lint and npm run build clean.

Commit a0db1e0 on branch aprv-193-design. Not pushed, no PR, no merge. The task stays In Progress: it closes when the build lands, and the build is APRV-193a..h in the decomposition above, to be filed after Carter answers the six sign-off questions in design/aprv-193-starve-the-code.md section 6.
<!-- SECTION:NOTES:END -->
