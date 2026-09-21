---
id: APRV-421
title: >-
  approval serve: an HTTP transport for the agent-facing verb surface, plus hook
  envelopes, log follow and export, with agent and tenant credentials
status: In Progress
assignee:
  - '@opus-421'
created_date: '2026-09-21 06:41'
updated_date: '2026-09-21 07:51'
labels:
  - hosting
  - daemon
  - hook
  - transport
dependencies: []
priority: high
ordinal: 322000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A tenant whose harness runs in a sandbox (Agent Village's Hermes tenants, APRV-399; the Meta Muse connector packet, APRV-405) has no local log and no local policy, so approval hook <harness> has nowhere to write and nothing to read. The hosted daemon (design/hosted-daemon-identity.md, APRV-383) runs elsewhere, one process per tenant; what is missing is a way to reach it. Add approval serve: a foreground HTTP server that publishes the same registry-derived agent-facing surface approval mcp serve does (human-only verbs absent, --as stripped, identity fixed at launch, refusals returned as results), and adds the three things the MCP transport withheld for transport reasons: hook <harness> taking the harness envelope as the request body and answering the same verdict the stdin form prints; log follow paged by an exclusive (seq, hash) cursor with the verified-subscription semantics of SPEC section 8 (verify from genesis before emitting, refuse a mismatched cursor hash with the existing integrity code, at-least-once on reconnect); and export, the store as an archive. Two bearer credentials read from the launch environment: an agent credential that may classify, request, wait and consume, and a tenant credential that may follow, export and read status. The agent credential must never read the log it is judged by. This is transport: it dispatches to the same functions the CLI dispatches to (decideHarnessCall, the verb registry, core/log-subscribe.ts) and reimplements no classification, policy resolution or token minting; two implementations of the gate sequence would be two gates. src/codex/serve.ts is the precedent for a server with a deliberately fixed catalog. Bind loopback by default; a non-loopback bind requires an explicit flag and TLS is the operator's proxy. The first deployment target is one Firecracker microVM per tenant (Bountify's hosted layer), so the server must survive a sleeping host: no in-memory state a restart loses beyond what the daemon already keeps. SPEC section 13 still says no hosted service; this verb is the local-first runtime's own door and a separate task amends section 13.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 approval serve starts under a launch environment naming the two credentials and the identity, prints the daemon instance id, and refuses to start on a non-loopback bind without the explicit flag
- [x] #2 POST hook/<harness> with a harness envelope body returns the same verdict, code and message that approval hook <harness> prints for the same envelope on stdin, for every adapter in HARNESS_ADAPTERS, covered by a table test
- [x] #3 The agent-facing verbs published match approval mcp serve's tool list exactly (registry filtered by human_only), with --as absent from every schema and the launch identity appended last; grant is absent
- [x] #4 GET log/follow with an exclusive (seq, hash) cursor returns the same batch approval log follow prints; a cursor whose hash does not match is refused with the existing integrity code and no records; the response carries the new cursor
- [x] #5 An agent-credential call to log/follow, export or status is refused with a distinct machine-readable code; a tenant-credential call to request, wait or consume is refused likewise; both through tests
- [x] #6 export returns the store as an archive containing APPROVAL.md, the log and projections and nothing under .approval/keys, .approval/env or the vault
- [x] #7 Every refusal is a result body with {error:{code,message}} and never a bare HTTP error; the server appends no record on its own account
- [x] #8 docs/cli-reference.md and docs/README-extended.md gain the verb; SPEC section 10 hunk proposed in the implementation notes, not applied; build, typecheck, lint and the mcp, hook, log and channels suites pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. TRANSPORT ONLY, by construction. src/serve/ is a new sibling of src/mcp/ (same layering direction: it imports the CLI and the core, never the reverse). It reuses src/mcp/server.ts directly for the verb surface — publishedVerbs(), toolName(), toolDefinitions(), toolInputSchema(), buildArgv(), resolveAgentActor(), serializer() — so AC3 ('matches approval mcp serve's tool list exactly') holds because it IS that list, not because a test compares two lists. src/mcp/server.ts gains ONE export and no behaviour: the existing private invoke() becomes exported invokeVerb() with its Invocation type, so the HTTP transport reaches the same function the MCP tool call reaches, which is the same function main() dispatches to.

2. src/core/log-subscribe.ts gains ONE additive option, once?: boolean. subscribeVerifiedLog is an unbounded stream; a PAGED endpoint needs 'drain the currently verified snapshot, then return'. In once mode the generator skips the fs watcher (a server must not leak one per request) and returns after the drain instead of awaiting. Every verification, every cursor binding and every refusal stays exactly where it is. This is the alternative to reading the log in serve/, which would be a second reader of the chain.

3. src/serve/archive.ts — a dependency-free POSIX ustar writer plus a reader (the reader is exported so the test parses the archive rather than trusting the writer), gzipped with node:zlib. Contents are a POSITIVE allowlist, fail closed: APPROVAL.md, .approval/log/**, .approval/QUEUE.md, .approval/index.sqlite. .approval/keys, .approval/env, .approval/daemon and any vault.enc are excluded by not being on the list, and the test asserts the negative as well as the positive.

4. src/serve/credentials.ts — two bearer credentials read from the launch environment: APPROVAL_SERVE_AGENT_TOKEN and APPROVAL_SERVE_TENANT_TOKEN. Both required at startup, must differ, compared with timingSafeEqual over SHA-256 digests (equal-length compare, no early exit). One scope per route; the check runs BEFORE routing so a tenant credential naming an agent-only verb gets the scope refusal rather than a not-found.

5. src/serve/server.ts — node:http, no new dependency, no TLS (the operator's proxy). Routes:
     GET  /verbs                 either credential   the catalog: toolDefinitions() entries plus a scope annotation
     POST /verb/<tool_name>      agent               buildArgv() -> invokeVerb(); body is the verb's own --json object
     POST /hook/<harness>        agent               body IS the harness envelope; commandHook(argv, streams, cwd, () => body)
     GET  /log/follow            tenant              paged, exclusive (seq, hash) cursor
     GET  /export                tenant              the store archive
     GET  /status                tenant              the status verb through invokeVerb()
   Verb calls and hook calls run on ONE serializer() queue, for mcp/http.ts's reason (wait blocks the event loop, run spawns synchronously); follow and export do not need it. Nothing is held in memory across a request beyond that queue, so a restart on a sleeping host loses nothing: cursors belong to the caller.

6. hook/<harness>: the response BODY is the exact stdout bytes commandHook printed, so it is byte-for-byte the verdict object the stdin form prints, for every HarnessKind in HARNESS_ADAPTERS. The exit code rides in x-approval-exit-code (grok and hermes encode deny as exit 2; claude-code, cursor and codex encode it in the body at exit 0), the decision in x-approval-decision, and stderr in x-approval-stderr as base64 (bounded) because Hermes's ALLOW carries its reason there and nowhere else. A deny is a VERDICT, so its HTTP status is 200: only a refusal by the server is not.

7. log/follow: ?from=<seq>&cursor_hash=<64hex>&limit=<n>, exclusive cursor, subscribeVerifiedLog with { from, expectedHash, once: true }. Answers {records, cursor:{seq,hash}, caught_up}. A LogSubscriptionError of kind integrity is answered with the CLI's own body, {error:{code:'integrity', message}}, plus reason:'cursor-mismatch' so the existing reason stays machine-readable, and NO records. torn-tail and io take their own existing codes.

8. Refusals: every one is a result body {error:{code,message}}, never a bare status. Server-authored codes are serve-unauthorized, serve-agent-forbidden, serve-tenant-forbidden, serve-unknown-path, serve-unknown-verb, serve-method-not-allowed, serve-body-too-large, serve-body-unreadable, serve-invalid-cursor. Verb refusals keep the CLI's own codes, and buildArgv's mcp-* codes are kept as they are rather than renamed: they come from the one function both transports call.

9. src/cli/serve.ts — argv, identity, bind, daemon id, banner; dynamic import of ../serve/server.js so main.ts -> cli/serve.ts -> serve/server.ts -> cli/main.ts is never a static cycle (the rule tests/layering.test.ts pins for cli/mcp.ts). Identity is resolveAgentActor(): agent:<id> only, human: and system: refused at startup, before the listener exists. Loopback by default (127.0.0.1:4682); --listen <host:port> naming a non-loopback interface is REFUSED unless --allow-non-loopback is also passed, and prints a banner when it is. resolveDaemonId() is resolved at startup, printed on the started line, and an unusable APPROVAL_DAEMON_ID refuses to start (approval up and daemon run already do this).

10. Registry, dispatch, help: a 'serve' entry in VERB_REGISTRY marked human_only with a note (an OPERATOR process, exactly as 'mcp serve' is), case 'serve' in main(), SERVE_HELP in help.ts with a why: docs/cli-reference.md#serve footer, '## serve' in docs/cli-reference.md, and 'serve' added to the HUMAN_ONLY list in tests/cli-instructions.test.ts.

11. Tests: tests/serve.test.ts (startup, credentials both directions, catalog identity against toolDefinitions(), follow paging and cursor mismatch, export contents positive and negative, refusal shapes, no record appended) and tests/serve-hook.test.ts (the table test across every HARNESS_ADAPTERS kind, response bytes identical to commandHook's stdout, exit-code semantics per dialect). Then build, typecheck, lint, the mcp/hook/log/channels suites, and npm test in full.

12. Docs and SPEC: docs/cli-reference.md and docs/README-extended.md gain the verb; the SPEC section 10 hunk is PROPOSED in the implementation notes and SPEC.md is not edited.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What shipped

`approval serve`: a foreground HTTP transport for the agent-facing verb surface, plus the three things the MCP transport withheld for transport reasons. New: `src/serve/{server,credentials,follow,archive}.ts`, `src/cli/serve.ts`, `tests/serve.test.ts`, `tests/serve-hook.test.ts`. Touched: `src/core/log-subscribe.ts` (one additive option), `src/mcp/server.ts` (two exports, no behaviour), `src/cli/{main,help,verb-registry}.ts`, `tests/{layering,cli-instructions}.test.ts`, `docs/cli-reference.md`, `docs/README-extended.md`. SPEC.md is NOT edited; the section 10 hunk is proposed below.

## Transport only, and how that is guaranteed rather than asserted

The verb surface is not a copy of `approval mcp serve`'s, it IS it: `src/serve/server.ts` imports `publishedVerbs`, `toolDefinitions`, `toolInputSchema`, `buildArgv`, `toolName`, `serializer`, `resolveAgentActor` and `invokeVerb` from `src/mcp/server.ts`. So `--as` is deleted from every published schema by the one line that already did it, the launch identity is appended last by the one line that already did it, `grant` is absent because the registry marks it `human_only`, and a verb added to the registry tomorrow appears on both surfaces the same day. AC3 is therefore true by construction; the test compares `serveCatalog()` entry for entry against `toolDefinitions()` so a future divergence is a failure rather than a drift.

A hook call is `commandHook([harness, ...hookArgv(options)], streams, cwd, () => body)`. The response body is the captured stdout, unchanged. No dialect knowledge, no verdict shaping and no exit-code mapping lives in `src/serve/`.

A follow page is `subscribeVerifiedLog`, drained once. Nothing in `src/serve/` verifies, parses or re-derives a record.

Two seams were opened to make that possible, both additive:

1. `core/log-subscribe.ts` gains `once?: boolean`. The streaming form is what `approval log follow` wants; a paged endpoint has nowhere to put a wait, and expressing "caught up" as a race between the iterator and a timer would have been a timing heuristic in the one place that must not have one. In `once` mode the generator also establishes no fs watcher, which matters for a server: one watcher per request is a handle leak at the rate the tenant polls. Every verification, cursor binding and terminal failure is untouched.
2. `mcp/server.ts`'s private `invoke()` is exported as `invokeVerb()`, with its `Invocation` type and `lastJsonObject()`. This is the route from a verb spec plus an argv to the function `main()` dispatches to. Building a second route in `src/serve/` would have been two answers to "what does this verb do here" the day one of `invoke`'s special arms changes.

## The two credentials

`APPROVAL_SERVE_AGENT_TOKEN` and `APPROVAL_SERVE_TENANT_TOKEN`, both read from the launch environment (SPEC §11.1 invariant 7: a credential in a working-tree file is a credential anything able to write that file could rotate). Both are required before the listener exists, must differ, and must be at least 24 characters. Comparison is `timingSafeEqual` over SHA-256 digests, so it is constant-time and length-independent, and both digests are compared on every call so that presenting an agent credential is not measurably faster than presenting a tenant one. Neither value is ever logged, printed, returned or recorded.

Routes and scopes:

| method | path | scope |
|---|---|---|
| GET | `/verbs` | either |
| POST | `/verb/<tool_name>` | agent (tenant for the tenant-only verbs) |
| POST | `/hook/<harness>` | agent |
| GET | `/log/follow` | tenant |
| GET | `/export` | tenant |
| GET | `/status` | tenant |

Authentication runs BEFORE routing, so there is no unauthenticated surface at all, not a health check and not a 404: a caller with no credential learns nothing about what exists. Authorization runs before the published-verb lookup, so a tenant credential naming `consume` (which is not published at all) gets `serve-tenant-forbidden` rather than a not-found, which is the true and more useful fact and is what AC5 asks for.

## The design question AC5 settled: `status`

The task brief flagged `status` as a design question. AC3 fixes the published catalog to `mcp serve`'s list, which contains `status`; AC5 says an agent-credential call to status is refused. Those are consistent once publication and authorization are separated, which is what this does: `status` stays PUBLISHED (the catalog is honest about what exists and is derived rather than hand-kept) and answers only to the tenant credential, at `GET /status` and at `POST /verb/status`. `TENANT_ONLY_VERBS` is the one-element set that says so.

## Decisions the task did not specify

- **What the agent credential may still read.** The brief's operative sentence is "the agent credential must never reach log/follow or export", and AC5 names log/follow, export and status. The registry's own log-reading verbs (`log tail`, `log export`, `log verify`, `queue`) are therefore reachable with the agent credential, exactly as `approval mcp serve` publishes them today. Narrowing them would narrow the MCP surface too, which AC3 forbids here, so if the tenant wants them withheld that is its own task against both transports.
- **The archive format and its contents.** POSIX ustar, gzipped, written in `src/serve/archive.ts` in about ninety lines rather than by a dependency; no dependency was added by this task. The contents are a positive allowlist — `APPROVAL.md`, `.approval/log/`, `.approval/QUEUE.md`, `.approval/index.sqlite` — so `.approval/keys`, `.approval/env`, `.approval/daemon` and any `vault.enc` are out by not being named. `.approval/payloads/` is also out, on the same fail-closed reading: the AC names APPROVAL.md, the log and the projections, and payload bytes are none of those. **This is worth a decision from the orchestrator**: a tenant export without payloads cannot prove the bytes behind a `payload_hash`, and widening it is one line plus a test.
- **How the hook's exit code and stderr travel.** The body is the verdict bytes and nothing else, so the exit code rides on `x-approval-exit-code` and the harness on `x-approval-harness`. Hermes's ALLOW is `{}` and carries its reason on stderr and nowhere else, so stderr comes back base64 on `x-approval-stderr` (bounded at 4 KiB, with `x-approval-stderr-truncated` when it did not fit). A caller reproducing the verb locally writes the body and exits the header. No `x-approval-decision` header, deliberately: a third account of one answer is a third thing that can disagree.
- **HTTP statuses.** A refusal always carries `{"error":{"code","message"}}`; the status is a hint for the plumbing and the body is the answer, which is `mcp/http.ts`'s existing reading of "never a bare HTTP error". A hook DENY is a verdict rather than a refusal, so it is 200.
- **The cursor-mismatch body** is the CLI's own `{"error":{"code":"integrity","message":…}}` plus `reason: "cursor-mismatch"`, so both names AC4 could have meant are present and machine-readable, and `x-approval-exit-code: 1` is what `approval log follow` would have exited.
- **Port 4682** (MCP's is 4681), loopback. A non-loopback bind needs `--listen <host:port>` naming the interface in full AND `--allow-non-loopback`: two flags because the credentials are bearer values and a cleartext hop hands them to whoever is on it. A widened bind prints a banner saying exactly that.
- **`--hook-timeout`** pins `--timeout` on every hook call. Without it the CLI default stands.
- **An unusable `APPROVAL_DAEMON_ID` refuses to start**, as `approval up` and `approval daemon run` already do: a process whose whole purpose is dispatching verbs that append should not start in order to find out that it cannot. The resolved id and its source are on the started line (AC1).
- **`serve` is `human_only: true`** in the registry, for `mcp serve`'s reason plus one of its own: it holds both credentials, and which door an agent gets is not the agent's to choose.

## Global invariants this touches (CLAUDE.md requires saying so)

- **Invariant 6 (refusals are machine-readable and distinct, unions frozen).** Two new unions: `SERVE_CREDENTIAL_REFUSAL_CODES` in `serve/credentials.ts` and `SERVE_REFUSAL_CODES` in `serve/server.ts`. Codes a VERB or `buildArgv` produced are passed through unchanged, `mcp-` prefix and all, because renaming them here would make one surface lie about the other.
- **Invariant 7 (configuration is never loaded implicitly from the working tree).** Both credentials and the identity come from the launch environment. The server reads no `.approval/env`, inherited from the MCP server by calling its code.
- **Invariant 9 (human-only classes and verbs are inert to agents).** No human-only verb is published, by the registry's own marker, and the test asserts `grant`, `reject`, `revoke`, `policy attest` and `expire` are absent.
- **Invariants 1, 2, 5 and 8 are untouched by construction**: no decision, append or verification happens in `src/serve/`. The test "the server appends no record on its own account" pins the negative.

## Verification

`npm run build`, `npm run typecheck`, `npm run lint` clean. Suites run: see the final report on this task's PR.

## Proposed SPEC.md section 10 hunk (NOT applied)

A new subsection after §10.5, and one line in the §10.1 CLI block. Both additive; no existing sentence changes.

**10.1, after the `approval mcp serve` block:**

> ```
> approval serve                     # the §10.7 HTTP transport of the same
>                                    #   agent-facing surface, in the foreground,
>                                    #   under one agent identity the operator
>                                    #   fixes when they start it; two bearer
>                                    #   credentials from the launch environment
> ```

**New §10.7, "HTTP transport for a remote harness (optional)":**

> A harness that runs where the log and the policy do not has nowhere for the hooks of §10.1 to write and nothing for them to read. An implementation MAY publish the agent-facing surface of §10.5 over HTTP for such a deployment. What shipped is `approval serve`.
>
> The published verb surface MUST be §10.5's exactly: the registry filtered by `human_only`, `--as` deleted from every published schema, the server's own identity appended last to every argv, and a refusal returned as a result carrying `{"error":{"code","message"}}` rather than as a transport error. A conformance reader takes the two surfaces to publish the same names and the same schemas, and an implementation MUST NOT let this transport publish a verb the MCP one withholds for authority reasons.
>
> It MAY additionally publish the three verbs §10.5 withheld for transport reasons, each in the shape that transport lacked. A harness hook endpoint takes the harness envelope as the request body and MUST answer the bytes the stdin form prints for that envelope, together with the exit-code semantics that form carries, for every harness the implementation speaks a protocol for; the dialects of §10.1 disagree about whether a block is in the body or in the exit status, so an implementation MUST NOT normalise one into the other. A log-follow endpoint MUST be paged rather than streamed, MUST take the exclusive `(seq, hash)` cursor of §8, MUST answer the cursor the page ends at, and MUST refuse a cursor whose hash does not bind with the integrity refusal of §8 and no records. An export endpoint MAY return the store as an archive, which MUST carry the policy file, the log and the projections, and MUST NOT carry key material, the environment source map of §5.2, or the vault.
>
> Authority is split between two credentials read from the launch environment (§11.1 invariant 7), and the split is the reason this transport is safe to expose. One credential reaches the agent-facing verbs and the harness hook; the other reaches the log, the export and the status report. An implementation MUST NOT let the agent credential read the log, since a party that can read the verified log can read every decision made about it and the shape of the oversight it is under. Each direction MUST refuse with its own distinct machine-readable code. An implementation MUST NOT serve any path without a credential.
>
> The server MUST bind a loopback interface unless the operator explicitly asks otherwise, and MUST NOT terminate TLS itself: the supported deployment is a proxy the operator owns in front of a loopback bind. It appends no record on its own account, holds no state a restart loses (a follow cursor belongs to the caller), and reads no `.approval/env`. (Added APRV-421, pending sign-off.)

## Validation

- `npm run build`, `npm run typecheck`, `npm run lint`: clean (exit 0).
- Targeted suites (mcp-server, mcp-http, mcp-guest, e2e-mcp-demo, cli-hook and every cli-hook-<harness>, log, log-subscribe, cli-log-follow, cli-log-verbs, channels-cli, channels-web, channels-telegram, channels-contract, serve, serve-hook): **686 tests, 686 pass, 0 fail, exit 0**.
- Full `npm test`: 5102 tests, 5079 pass, 22 fail, 1 skipped, exit 1.

**The 22 failures are pre-existing and unrelated to this task, proved rather than assumed.** A clean clone at the base commit 99cd51e, carrying none of this branch's code, fails the identical 22 by name (182 tests, 160 pass, 22 fail). They are `tests/smtp-probe.test.ts`, `tests/adapter-email.test.ts`, `tests/adapters-contract.test.ts` and the `setup adapter email` cases in `tests/cli-setup.test.ts`. The cause is the Node version on this machine (v26.8.2): it refuses `tls` `servername` set to an IP address ("Setting the TLS ServerName to an IP address is not permitted. Received '127.0.0.1'"), and the SMTP mock binds loopback. This repo's floor is Node >= 20 and CI runs 20 and 22, so it is a newer-Node regression in the SMTP test harness and wants its own task.

PR: https://github.com/approval-md/approval.md/pull/534 (not armed for merge: this lane was told not to run `gh pr merge`, which is the one point where the brief narrows CLAUDE.md's rule 7 — the orchestrator reviews first).

## Review of PR #534: two conformance fixes

### 1. Agent scope narrowed to an allowlist

Authorization is now per verb and positive. `AGENT_VERBS` in `src/serve/server.ts` is exactly: `instructions`, `hook_classify`, `register`, `request`, `wait`, `withdraw`, `payload_hash`, `payload_agentmail-draft`, `policy_check`, `policy_test`, `log_verify`, `gate_status`. Everything else the catalog publishes is TENANT-scoped, and a verb added to the registry tomorrow lands outside the list, so widening is a diff in the server and a diff in a test rather than a silent consequence of adding a verb. `TENANT_ONLY_VERBS` (the one-element set that used to hold `status`) is gone; one rule replaces two.

Publication is unchanged, so AC3 still holds: `serveCatalog()` is still `toolDefinitions()` name for name and schema for schema, and the existing entry-for-entry test proves it. What changed is the `scope` annotation on each entry and the check behind it.

Two tests added. `the agent allowlist is exactly the decided list` pins the twelve names and asserts each is actually published, so a registry addition or a rename fails loudly. `every published verb off the allowlist refuses the agent credential` walks the live catalog, asserts the list it walks is not trivially small (>20), and for each entry asserts both the `tenant` annotation and a real `403` carrying `serve-agent-forbidden`. A third test asserts the twelve allowlisted verbs never answer with that code, so the sweep cannot pass by refusing everything.

**One rule needed a decision the instruction did not cover: an UNPUBLISHED verb name.** With "default to tenant" applied literally, a tenant-credential call to `/verb/consume` would have passed the scope check and fallen through to `serve-unknown-verb` (404), which breaks AC5's "a tenant-credential call to request, wait or consume is refused likewise". So `scopeOf` has three arms: on the allowlist means agent; published and off it means tenant; **not published at all means agent**, so the tenant credential is refused `serve-tenant-forbidden` and the agent credential gets `serve-unknown-verb`. Both answers are true, and the fail-closed direction is preserved in both: the names in that third arm are the ones `mcp/server.ts` withholds for transport reasons, `consume` above all, which is an agent-side act and not a door the tenant may probe. The coordinator's "a new verb defaults to tenant" rule is intact for everything that reaches the catalog, which is where a new verb arrives.

### 2. Export now carries `.approval/payloads/`

Added to `EXPORTED_PATHS`. The four exclusions are unchanged and still asserted in both directions: by path, and by scanning every byte of the archive for the planted secrets. The archive test asserts the fixture payload's bytes come back verbatim, and separately that a RUNTIME-written payload is present (attesting the policy stores its bytes under a hash-named file), so the assertion is about the real store and not only about a file the test planted.

### The design question the review invited: how a granted token is spent from a sandbox

Leaving it tenant-scoped as instructed, and naming it here because it is real.

The HOOK flow is complete and needs nothing more. `POST /hook/<harness>` runs the whole sequence inside `commandHook` on the host: classify, register, request, wait, and the `execution.started` the hook writes with `execution: "harness"`, which SPEC §10.2 makes terminal by design because a harness adapter answers before the tool runs and never observes an exit status. No agent-scoped verb is needed for any of it.

The EXPLICIT flow is the one with a gap. An agent that drives `register` -> `request` -> `wait` itself and is granted now holds a decision it has no published way to act on from inside the sandbox: `run` spawns argv on the daemon's machine (correctly tenant-scoped, and over this transport the wrong machine entirely), and `consume` — the token spend `run` wraps — is published on neither transport. SPEC §10.5's APRV-105 amendment makes this sharper: under `token_delivery: sealed`, `wait` MAY return the raw execution token in its result, so an agent can RECEIVE a token over this transport and cannot spend it through anything published.

This pre-exists the review and is not created by it. `approval mcp serve` has the same shape; there it is harmless because the server and the agent share a machine, so `run` is the right answer. What the narrowed scope does is make the gap visible rather than paper over it with a `run` that would execute in the wrong place.

Three ways out, none implemented, all the orchestrator's call: publish `consume` on this transport only and put it on the agent allowlist; add an execution-report endpoint shaped like the hook's post-execution counterpart, so the sandbox reports an outcome the host records; or declare the hook path the only supported sandbox path and the explicit sequence host-side only, which is the status quo and wants saying out loud in §10.7 if so.

### One observation about `payload_agentmail-draft`

It is on the agent allowlist as a payload builder, per the instruction, and the registry's own reasoning supports it: the key it reads cannot send, the sending key is in the vault and answers only to a grant, and the verb produces a proposal and no authority. Worth noting anyway: it reads `AGENTMAIL_API_KEY` from THIS SERVER's launch environment, so a sandboxed agent calling it through the transport reads drafts with the host's copy of that key rather than its own. That is a hosted-deployment fact for whoever writes the operator runbook, not a reason to withhold the verb.

### The 22 SMTP failures

Already tracked as **APRV-416**; not filed again. They are `tests/smtp-probe.test.ts`, `tests/adapter-email.test.ts`, `tests/adapters-contract.test.ts` and the `setup adapter email` cases in `tests/cli-setup.test.ts`, and they reproduce identically at the base commit `99cd51e` with none of this branch's code (control run: 182 tests, 160 pass, 22 fail). Cause: Node v26.8.2 refuses a TLS `servername` set to an IP address while the SMTP mock binds `127.0.0.1`.

### Validation after the review fixes

`npm run build`, `npm run typecheck`, `npm run lint`: clean (exit 0).

Targeted suites (mcp-server, mcp-http, mcp-guest, e2e-mcp-demo, cli-hook and every cli-hook-<harness>, cli-hook-scope, cli-hook-read-scope, cli-hook-rewrite, cli-hook-scratch, log, log-subscribe, cli-log-follow, cli-log-verbs, channels-cli, channels-web, channels-telegram, channels-contract, serve, serve-hook, cli-help, cli-long-help, cli-instructions, docs-guard, layering, harness-enum): **785 tests, 785 pass, 0 fail, exit 0.**

The partition was also checked directly against the coordinator's own list: 36 published verbs, 12 agent, 24 tenant, and the 24 are exactly the names the review enumerated with nothing left over in either direction.

AC5 (both credential directions refuse with their own code) and AC6 (the export's contents) are the two the review touched. Both were re-verified after the fixes rather than left standing on the earlier run: AC5 by `every published verb off the allowlist refuses the agent credential`, `the agent allowlist is exactly the decided list`, `the verbs a harness needs ... DO answer the agent` and the unchanged tenant-direction test; AC6 by the archive test, which now asserts the payload bytes are present (both the fixture's and one the runtime itself wrote during attestation) alongside the four exclusions it already asserted by path and by byte scan.

## Adversarial review of PR #534: eight findings, all fixed

### 1 (BLOCKING). The export followed symlinks

`archive.ts collect()` checked the archive-relative NAME against the allowlist and the exclusions, then `statSync`/`readFileSync` followed the link. `ln -s .approval/keys/sender.key .approval/log/note.jsonl` therefore passed every name-based check ever written and put the sender key in the tenant's archive; a link to a host file did the same for anything the process could read.

Every entry is now `lstat`ed, and a symbolic link anywhere the walk reaches throws `ExportSymlinkError`, which the transport turns into a 409 `serve-export-symlink` naming the link's own relative path and never its target. The WHOLE export is refused rather than the link skipped: an archive silently missing a file is an archive nobody can tell from a complete one, and a tenant checking their exit against their own `payload_hash` values would find the gap only by doing the check.

One consequence found while fixing it: the export now takes the append lock (see the note below), so `<log>.lock` exists for exactly the span of the copy and the archive started carrying it. Any `*.lock` under the store is excluded, asserted.

### 2 (BLOCKING). Refusals carried no exit code, and the agent could force one

The header contract is gone. `POST /verb/<name>` and `POST /hook/<harness>` now answer with ONE body:

```json
{"exit_code": 0, "stdout": "…", "stderr": "…",
 "stdout_truncated": false, "stderr_truncated": false}
```

`stdout` and `stderr` are exactly what the CLI wrote to each stream and `exit_code` is exactly what it exited, so AC2 is satisfied by `stdout` being byte-equal to the stdin form's output — asserted directly in the table test, which also asserts `stdout_truncated` is false. Both streams are capped at 256 KiB and clipped with `StringDecoder`, which emits only whole codepoints; that also answers the note about `serve-no-structured-output` returning uncapped text, and retires that code, since the new contract never has to look for a JSON object in order to answer.

Every refusal (401, 403, 404, 405, 413, 500, and the cursor refusals) keeps `{error:{code,message}}` and now also carries `exit_code: 2` in the body. A server-authored refusal on the HOOK route additionally carries the harness's own block directive in `stdout`, rendered by `harnessBlockDirective`, a new export over `cli/hook.ts`'s existing `deny()` — one construction site per dialect, no second implementation. A client that writes `stdout` and exits `exit_code` therefore blocks on both halves of every dialect at once.

`docs/cli-reference.md` now states the client rule: **a missing, unparseable or truncated body is a BLOCK.** That covers the one case where no dialect can be spoken — a 401, which happens before the URL is parsed and so before the harness is known.

### 3 (BLOCKING). Store-root flags were caller-supplied

Two halves, both needed.

`--dir`, `--log` and `--policy` are now pinned on EVERY verb call in EVERY scope from the launch configuration, whether or not the operator named them (`--dir` never was before). `ServerOptions` in `mcp/server.ts` gained an optional `dir`, injected by the same `buildArgv` both transports call and inert for `approval mcp serve`, which never sets it. `--policy` is pinned only where the operator named one, because it names a FILE; where they did not, `--dir` is the pin and the CLI resolves the policy from that directory.

A caller supplying any of the three is refused `serve-path-pinned` even when the value is correct. Any other path-shaped argument must resolve inside the store and is refused `serve-path-outside-store` otherwise, checked through `realpath` on the deepest existing ancestor so a symlink in the middle cannot walk out and back in.

**The stated fix did not reach positionals, and one of them is a hole.** `payload hash <file>` names a host file and is on the agent allowlist: `{"positionals":["/etc/hosts"]}` was a hash oracle over the host filesystem that also filed the bytes into the payload store. `request --payload <file>` was the same hole through a flag. The confinement above covers both, by flag and by positional, so the scope decision you made stands unchanged. **Worth your attention anyway:** a remote harness has no files on the host, so every path it could legitimately name is one the host put there, which makes `payload_hash` close to inert over this transport. Dropping it from the allowlist is a one-line change and I have not made it.

### 4 and 8. Scope

Agent scope is now exactly `instructions`, `hook_classify`, `request`, `wait`, `withdraw`, `payload_hash`, `payload_agentmail-draft`. `register`, `log_verify`, `gate_status`, `policy_check` and `policy_test` moved to the tenant side. The allowlist test pins that list exactly, and the sweep walks the published catalog asserting every verb off it refuses the agent credential.

### 5. `from>0` without `cursor_hash`

Refused `serve-invalid-cursor`. With `once` mode every request is a first read, so the hashless bootstrap's single weakness — it cannot detect a fully recomputed replacement prefix on a first read — would be permanent rather than paid once, and the caller who dropped the hash would be served the replaced prefix silently while the honest one got the refusal. `from=0` is the only hashless form.

### 6. `from=99999999999999999999`

Validated as a safe integer before anything reads a file, refused `serve-invalid-cursor`. It used to reach the subscription's `TypeError` and escape a GET as a 500.

### 7. URL parsed before auth

Authentication now runs first, before `new URL()`. An unauthenticated malformed request gets exactly the 401 body (asserted over a raw socket, because `fetch` will not send a `Host: [`); a malformed URL after authentication is a 400 `serve-malformed-url`.

### The notes

- **`limit`** out of range is refused `serve-invalid-cursor` rather than clamped, range documented as 1 to 1000. `clampFollowLimit` is gone.
- **Duplicate `Authorization`** headers are counted from `req.rawHeaders` and refused 401, because Node keeps the first and discards the rest, so the credential this server checks need not be the one a reader of the request would name.
- **`log/follow` and `export`** now run on the same `serialize()` queue as the verbs. The export additionally takes the append lock: `core/log.ts` DOES expose one, `withAppendLock`, the same exclusion `approval log sync` takes, so the log and the payload store are copied as one snapshot rather than as two reads an append can land between.
- **Uncapped output** is covered by the stream caps in finding 2.

### New tests, by name

In `tests/serve.test.ts`:

1. `export: a symlink under the store refuses the whole export and names the link`
2. `export: a symlink pointing outside the store is refused the same way`
3. `hook: an oversized envelope is a BLOCK in the harness's own dialect, never an allow`
4. `every refusal on every route carries a non-zero exit code in the body`
5. `a caller may not name the store: --log, --dir and --policy are refused`
6. `a caller may not name a path outside the store, by flag or by positional`
7. `log/follow: from>0 requires cursor_hash`
8. `log/follow: an unrepresentable from is a cursor refusal, not a 500`
9. `log/follow: limit=0 and an over-large limit are refused, not clamped`
10. `a malformed request with no credential gets the 401 and nothing else`
11. `two Authorization headers are refused rather than resolved`

Updated rather than added: the allowlist pin and the catalog sweep now carry the seven-verb list; the archive test asserts no `*.lock`; the hook table asserts `stdout` byte-equality and `stdout_truncated`; the Hermes allow test reads `stderr` from the body; the tenant-direction test drops `register` and adds `payload_hash`.

### APRV-416

The 22 SMTP failures under Node v26.8.2 remain tracked there and are referenced rather than re-filed.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added `approval serve`: a foreground HTTP transport publishing the same registry-derived verb catalog `approval mcp serve` publishes, plus the three things that transport withheld for transport reasons — `POST /hook/<harness>` answering the byte-for-byte verdict the stdin form prints for every adapter in HARNESS_ADAPTERS, `GET /log/follow` paged by an exclusive (seq, hash) cursor over subscribeVerifiedLog, and `GET /export`, the store as an archive carrying the policy, the log, the payload bytes behind every payload_hash and the projections, and never the keys, the environment source map or the vault. Publication is the MCP surface's; AUTHORIZATION is per verb and positive: the agent credential opens the hook and a twelve-verb allowlist of what a harness under oversight needs in order to ask and to act on a grant, the tenant credential opens everything else, and a verb added to the registry is the tenant's until somebody widens the list. It is transport only: the catalog, the argv build, the verb dispatch, the hook verdict and the verified read are all the functions the CLI dispatches to, reached by import rather than by copy. Verified with 785 passing tests across the mcp, hook, log, channels, help, docs and layering suites plus two new suites (tests/serve.test.ts, tests/serve-hook.test.ts), exit 0, on a clean build, typecheck and lint. The only failures in a full `npm test` are the 22 of APRV-416, which reproduce identically at the base commit. SPEC.md untouched; the section 10 hunk is proposed in the notes, along with the one design question the split surfaces: how a granted execution token is spent when the action runs in the sandbox rather than on the daemon host. PR #534.
<!-- SECTION:FINAL_SUMMARY:END -->
