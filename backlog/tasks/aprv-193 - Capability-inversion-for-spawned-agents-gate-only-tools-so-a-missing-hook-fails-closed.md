---
id: APRV-193
title: >-
  Starve the code: egress-sandboxed allowed exec and credential custody, so
  laundered side effects fail closed
status: In Progress
assignee:
  - '@opus-193'
created_date: '2026-09-01 03:21'
updated_date: '2026-09-06 12:14'
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
- [x] #1 A sandbox profile denies outbound network for allowed-class exec (loopback to the gate daemon excepted), wired into how dev-fleet agent sessions run commands; profile and wiring committed
- [x] #2 Laundering demo: an allowed command (npm test or node script) attempting an SMTP send and a webhook POST is blocked by the sandbox, shown in a test or recorded transcript
- [x] #3 Credential-starvation confirmed: the same laundered code cannot read vault material or .approval/env from an agent session, tested
- [x] #4 Legitimate-exec survey: what allowed commands need network (installs, localhost test servers), each with a carve-out or a documented refusal
- [x] #5 SPEC and CLAUDE.md amendment text drafted for human sign-off, not applied
- [x] #6 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
BUILD LANE (opus-193). The design lane (design/aprv-193-starve-the-code.md, commit a0db1e0) settled the shape; this lane builds it on macOS and states Linux as follow-up.
1. Re-read the design, scripts/sandbox-probe.mjs, tests/sandbox-probe.test.ts, and the enforcement path as it stands: src/cli/execute.ts commandRun (spawnSync with the APRV-205 childEnvironment), src/cli/hook.ts (decides, never spawns), src/core/child-env.ts, src/core/vault.ts and src/core/env-file.ts for the custody paths.
2. src/core/sandbox.ts: detectSandbox() probing rather than inferring; an SBPL profile denying network-outbound with the mandatory AF_UNIX exception and every path realpath-resolved; sandboxWrap() building the wrapped argv; deny-read of the credential material (vault.enc, .approval/env, keys/) rather than the whole approval home; an optional loopback carve-out. Pure parts unit-tested without spawning.
3. Wire approval run: for a class whose autonomy resolves autonomous or supervised, the granted child spawns under the profile. --no-sandbox is the opt-out and is RECORDED on execution.started (sandbox: opted-out); an unavailable primitive means the command is NOT run and execution.failed says so (fail closed, no token on those paths). Manual-class grants (network.call, deps.add, release.publish) keep egress: approval run stays the one door to the world.
4. approval sandbox -- <argv>: the session launcher the fleet starts a harness under, so every command the hook allows inherits the denial. Verb surface: dispatch, help (25-line cap + reference anchor), verb registry entry, docs/cli-reference.md section.
5. Hook half: the classifier unwraps sandbox wrappers (sandbox-exec -f p <argv>, approval sandbox -- <argv>, node cli.js sandbox -- <argv>) to the class of the INNER argv, so running safely is not penalised and the wrapper is not a laundering device; unreadable wrapper forms stay unclassified. Plus APPROVAL_HOOK_REQUIRE_SANDBOX=1, default OFF, which denies autonomous/supervised exec when a real capability probe shows egress is still open (a strictness increase only, so a forged marker cannot widen anything).
6. Tests: tests/sandbox.test.ts with loopback SMTP and HTTP stubs. The laundering script (an allowed node script) reaches both stubs unsandboxed and is refused under the profile, so the test proves the profile does the blocking; the same script cannot read the vault, .approval/env, or a credential-bearing variable. Plus the classifier cases and the approval run record.
7. docs/sandboxed-exec.md: the legitimate-exec survey as a table (installs, localhost test servers, git/gh, channels, DNS), each row with a carve-out or a documented refusal, and the fleet runbook. docs/proposals/aprv-193-amendments.md carries the SPEC 7/10.4/11.1/11.2 and CLAUDE.md text for human sign-off; SPEC.md and CLAUDE.md are NOT touched.
8. npm run build, lint, typecheck, and the execute/hook/adapter/classifier suites plus the new ones. One commit, task file included, task left In Progress.
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

BUILD LANE (opus, worktree agent-ac91475ba4619e461), 2026-09-06. Two sessions: a build session cut off by a rate limit mid-verification, and a finishing session that assessed the uncommitted diff against the ACs, closed what was unfinished, and ran the matrix. One commit, task file included, task left In Progress.

WHAT SHIPPED (21 files).
- src/core/sandbox.ts (new). detectSandbox() PROBES, by applying a trivial profile to /usr/bin/true, rather than inferring from a binary on disk. seatbeltProfile() writes an allow-default SBPL profile that denies network-outbound, excepts AF_UNIX (mandatory: Seatbelt counts a unix connect as network-outbound, and a bare deny kills local IPC before the process can do anything), and denies reads of the vault, the .approval/env source map and the sealing keys, every path realpath-resolved (a profile naming /tmp/x denies nothing, because the kernel matches /private/tmp/x). resolveExecutable() does the PATH lookup up front, so a command that cannot be found never becomes sandbox-exec's exit 71 recorded as the child's own code. sandboxPosture() is a total pure function over (opted-out, granted, detection) returning apply, skip or refuse, and the ORDER of its branches is the policy: a broken mechanism refuses before an opt-out is considered.
- src/cli/sandbox.ts (new). approval sandbox [--allow-loopback] [--log p] -- cmd: denies egress, scrubs the credential-bearing environment through core/child-env.ts, exits with the child's own code, appends NOTHING (it removes a capability rather than authorizing anything), and refuses with 127 on a machine with no mechanism.
- src/cli/execute.ts. approval run spawns an UNTOKENED child under the profile; --no-sandbox is the opt-out; the posture is decided BEFORE execution.started, so the record states what was measured. A mechanism present and broken refuses before any append: nothing runs, nothing is written, the token is unspent.
- src/core/execute.ts and src/core/token.ts. The sandbox field on execution.started, on BOTH start paths (the manual path's start event is written by consumeToken), with values egress-denied, granted-egress, opted-out, unsupported.
- src/core/command-class.ts. Sandbox wrappers are unwrapped to the class of the INNER argv, with a per-segment marker: runtime (approval sandbox, whose profile this runtime writes) or external (a hand-written sandbox-exec -f profile, trusted for nothing). Both directions matter: a wrapper with a class of its own would launder everything as gate.self, and a wrapper that stayed unclassified meant the hook denied the safe spelling of a command it allowed unwrapped. CODE_EXECUTING_RULES names the three rules that hand control to code this runtime did not author.
- src/cli/hook.ts. The deny code hook-sandbox-required plus APPROVAL_HOOK_REQUIRE_SANDBOX (default OFF), placed below the human-only deny and above everything that appends, so a refused command leaves the log as it found it.
- docs. sandboxed-exec.md (mechanism, the three surfaces, the survey, the fleet runbook, and the stated limits), cli-reference.md (a sandbox section and a rewritten run paragraph), claude-code-hook.md and cursor-hook.md (the wrapper rule and the new deny row), and proposals/aprv-193-amendments.md, which carries the SPEC 7 / 10.4 / 11.1 / 11.2 and CLAUDE.md text NOT applied, plus the four questions only Carter can answer.
- tests. sandbox.test.ts (26 cases: the profile as text, the posture table, the classifier, the hook requirement, the laundering demonstration against loopback SMTP and HTTP stubs, and the approval run record), the hook cases in cli-hook.test.ts, the record shape in cli-run.test.ts, and an amended sandbox-probe control (the design lane asserted a TIMEOUT outside the sandbox, which is a fact about one machine's routing; it now asserts the absence of Seatbelt's EPERM signature, which is the discriminating property).

WHAT THE FINISHING SESSION ADDED. (1) HOOK_HELP now prints hook-sandbox-required: the closed-vocabulary test over HOOK_DENY_CODES was failing, and the deny list was re-wrapped so the verb stays inside the 25-line cap. (2) verb-registry.ts: run declares --no-sandbox and an exit-127 row and says in its purpose which room a child runs in, because the machine-readable contract an agent reads must not omit a flag the parser accepts.

DIVERGENCES FROM THE AC TEXT, named rather than quietly satisfied.
- AC1 says loopback to the gate daemon excepted. The build denies loopback WITH the rest, because there is nothing to except: the daemon opens no socket, it polls events.jsonl, so the gate stays fully reachable from inside the room. --allow-loopback is the carve-out for the one legitimate case the survey found, a suite that starts its own server. This is stricter than the AC asked for.
- AC1's wiring into how dev-fleet sessions run commands is the two spawn sites plus a hook requirement that is DEFAULT OFF (question 3 in the proposal). A session-wide sandbox is not possible with this mechanism: an agent harness needs the model API, which is exactly what is denied, and Seatbelt cannot express an allowlist by hostname. That is the largest gap between the design and what is buildable today, and it is recorded in the proposal.
- The token, not the resolved class, is what keeps the network. A manual grant delivered SEALED presents no --token and therefore runs egress-denied, which is the strict direction and the wrong answer for a granted network.call: pass the token, or take the recorded opt-out. Question 1 in the proposal is where that gets settled.

GLOBAL INVARIANTS TOUCHED (CLAUDE.md requires saying so).
- Invariant 4, self-reported fields never reduce scrutiny. Both environment variables (APPROVAL_SANDBOX_REQUIRED, APPROVAL_HOOK_REQUIRE_SANDBOX) are read in the strict direction only and can only ever refuse more; the sandbox field is computed at the spawn site from what the machine can do; the single loosening is holding a token, which is a secret a human minted rather than a claim the executing party authors about itself.
- Invariant 6, refusal unions are frozen public API. Deliberately NOT widened: sandbox-unavailable is drafted for sign-off with its 11.2 registry row, and until then the refusal is a stderr message and exit 127 with nothing appended, which is correct behaviour with an inferior vocabulary.
- Fail closed. A present-but-broken mechanism refuses on both surfaces, and the refusal is pinned on every platform through APPROVAL_SANDBOX_FORCE_UNAVAILABLE with a witness file that must not exist.
- The log is append-only, and nothing new reads it back: the sandbox field is informational, no decision turns on it, and log verify runs green inside the new tests.
- Draft invariant 11, allowed execution is starved by default, is proposed for 11.1 and mirrored into the CLAUDE.md list in the proposal document. It is NOT applied: the property does not exist until a human writes it into both places.

SCHEMA, stated because it is a write boundary. execution.started.payload.sandbox is written but not constrained in schema/event.schema.json (that payload object is open, so the records validate and verify). Constraining it with an enum is its own task per CLAUDE.md, and the proposal's gap table names it.

VERIFICATION (this worktree, macOS 15 on arm64, 2026-09-06).
- npm run build clean, npm run lint clean, npm run typecheck clean.
- node scripts/run-tests.mjs --only sandbox: 26 tests, 26 pass, 0 fail.
- Targeted matrix (sandbox-probe, cli-hook, cli-run, cli-instructions, command-class): 505 tests, 503 pass, 1 skip, 1 fail before the HOOK_HELP fix; cli-hook, cli-long-help and cli-help re-run after it, 125 tests, 125 pass, 0 fail.
- npm test: 3659 tests, 3657 pass, 1 skip, 1 fail. The skip is the opt-in external curl leg of sandbox-probe (SANDBOX_PROBE_EXTERNAL), which makes no external request in anyone's CI. The failure is the known lane-only ci-guard case, every production dependency's engines.node admits the Node floor, ENOENT on node_modules/@modelcontextprotocol/sdk/package.json. This worktree has NO node_modules at all (tsc and oxlint resolve upward to the primary checkout); the test reads package.json plus node_modules under the repo root; package.json is untouched by this diff; running that suite alone reproduces 31 tests, 30 pass, 1 fail. It is the same failure the design lane recorded and it classifies nothing and spawns nothing.
- Exercised by hand as well as by the suite: approval sandbox -- npm run lint and approval sandbox -- npm run typecheck both exit 0 inside the profile, which is the survey row claiming ordinary development survives; approval hook classify reads approval sandbox -- npm install left-pad as deps.add marked runtime, sandbox-exec -f p.sb node --version as files.write.workspace marked external, and the -p spelling as unclassified.

NO PROTECTED PATH TOUCHED. SPEC.md, CLAUDE.md, AGENTS.md, APPROVAL.md, .approval/ and .claude/ are unmodified; the amendment text lives in docs/proposals/ and waits for a human.
<!-- SECTION:NOTES:END -->
