---
id: APRV-174
title: 'mcp serve --http: streamable-HTTP transport with per-session identity'
status: Done
assignee:
  - 'agent:opus-lane-u'
created_date: '2026-08-31 01:16'
updated_date: '2026-09-02 09:06'
labels:
  - core
  - mcp
dependencies: []
ordinal: 153000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From the approved crowd-MCP design (2026-08-31). approval mcp serve gains --http [--port N, default 4681], binding 127.0.0.1 only (the operator fronts it with a tunnel; no TLS or auth in-process). src/cli/mcp.ts owns one node:http listener; per the SDK 1.30.0 model (already in the lockfile — StreamableHTTPServerTransport ships in it, no dependency change), each mcp-session-id gets its own Server + transport pair: on an initialize POST with no session header, build the pair via serveApprovalMcp and stash in a session map; route subsequent requests by header; delete on transport close. Caps: ~20 concurrent sessions, ~200 lifetime, refuse over-cap initializes with a plain HTTP 503 naming the reason. Under --guest (built here, restricted in the follow-up task) each session mints agent:guest-<6hex> via resolveAgentActor at session open, preserving the identity-settled-before-transport invariant verbatim; plain --http keeps the fixed --as/APPROVAL_AGENT actor for every session. src/mcp/server.ts changes only minimally: ServerOptions gains an optional shared serializer so all sessions share one invoke queue (default constructs a fresh one, keeping stdio behavior byte-identical); everything else already closes over per-instance options. The mcp-identity-fixed refusal stays true: the operator chose the scheme, callers still cannot name an identity.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Two concurrent HTTP sessions get distinct agent:guest-* actors whose appends land under their own actor in the log
- [x] #2 Session routing by mcp-session-id, close-cleanup, loopback-only bind, and the 503 over-cap path are all tested
- [x] #3 stdio path byte-identical: existing MCP tests pass unchanged
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/mcp/server.ts, minimal surface change: ServerOptions gains an optional `serialize` (the shared invoke queue) and `serializer()` becomes exported; createApprovalMcpServer uses options.serialize ?? serializer(), so stdio keeps a fresh per-server queue and byte-identical behavior.
2. New src/mcp/http.ts: serveApprovalMcpHttp(options) owning ONE node:http listener. POST /: read the body, JSON.parse, route by the mcp-session-id header. No header + isInitializeRequest -> open a session; header -> hand to that session's transport; unknown header -> 404 JSON-RPC error. GET/DELETE route by header only. Every other path -> 404.
3. Session open: the actor is minted BEFORE the Server/transport pair exists (identity-settled-before-transport, verbatim from stdio). Guest mode mints agent:guest-<6hex> from randomBytes(3); plain --http reuses the operator's fixed --as/APPROVAL_AGENT actor for every session. A client-supplied name is never read: there is no code path from the request into the actor.
4. Caps: MAX_CONCURRENT_SESSIONS 20, MAX_LIFETIME_SESSIONS 200. An over-cap initialize gets a plain HTTP 503 with a JSON body naming the reason (no MCP session is created). Sessions are removed from the map on transport close (DELETE or socket teardown).
5. One shared serializer across all sessions, so N guests cannot overlap wait/run.
6. src/cli/mcp.ts: --http, --port (default 4681), --listen [host:]port, --guest. Default bind 127.0.0.1; a non-loopback host is only reachable through an explicit --listen and prints a loud stderr banner. --guest without --http is a usage error. --listen and --port together is a usage error. Session open/close logged on stderr with the session id and the actor. stdio path untouched when --http is absent.
7. help.ts MCP_HELP and docs/cli-reference.md gain the flags.
8. tests/mcp-http.test.ts: a real StreamableHTTPClientTransport client against an ephemeral loopback port. Two concurrent guest sessions get distinct agent:guest-* actors and their appends land under their own actor in the log; routing by mcp-session-id; a bogus session id is refused; close-cleanup empties the map; the 503 over-cap path; the bound address is 127.0.0.1. Existing tests/mcp-server.test.ts is untouched, which is the stdio-unchanged proof.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What shipped

`approval mcp serve --http` serves the SDK's streamable-HTTP transport beside the unchanged stdio path. New module `src/mcp/http.ts` owns one `node:http` listener and a map from `mcp-session-id` to a `{ Server, transport, actor }` triple: an initialize POST with no session header opens one, every later request routes by the header, and the triple is dropped when its transport closes. `src/cli/mcp.ts` gained the argv (`--http`, `--port`, `--listen`, `--guest`), the bind decision and the stderr lifecycle lines. `src/mcp/server.ts` changed in two lines: `ServerOptions.serialize` (optional) and `serializer()` exported, so every HTTP session shares ONE invoke queue while stdio keeps building its own. No new dependency: `StreamableHTTPServerTransport` and `StreamableHTTPClientTransport` both ship in the `@modelcontextprotocol/sdk` 1.30.0 already in the lockfile.

## How a guest identity is derived, and why that shape

Per session, before the transport exists. `mintSessionActor()` draws `agent:guest-<6 hex>` from `randomBytes(3)` and re-draws against the set of actors this process has already handed out (widening to more bytes if it ever had to), because two sessions sharing an actor would share a budget and a refusal history, which is the one thing the scheme exists to keep apart. Plain `--http` skips minting and runs every session as the operator's `--as` / `APPROVAL_AGENT` actor, which is stdio behavior with more connections.

**Nothing a client sends reaches the actor.** Not a header, not the URL, not `clientInfo.name` in the initialize payload, not a tool argument (`--as` was already refused `mcp-identity-fixed` and still is). A client name is a label. This is invariant 4, self-reported fields never reduce scrutiny, applied to identity: an actor a caller could name is an actor a caller could escalate, and the log, the budgets and any intake limit (APRV-173) key on the server's own value.

## Decisions

- **`--listen <[host:]port>` beside `--port <n>`.** The task said loopback-only; the lane brief said a non-loopback bind must be possible, explicit and printed loudly. Both are satisfied: `--port` cannot reach a non-loopback interface and neither can a bare `--listen 4681`, so an operator who wants one has to write the interface out, and gets a five-line stderr banner every time they do. Passing both flags is a usage error. If the orchestrator prefers the strict reading, deleting `--listen` leaves the rest untouched.
- **`--as` and `--guest` are exclusive** (usage error), rather than `--as` being silently ignored under `--guest`. A guest's identity is not the operator's to choose, and an ignored flag is an operator who thinks they set something.
- **`--listen`, `--port` and `--guest` without `--http` are usage errors** (APRV-175 AC 3 asks for the `--guest` case; it lands here because the flag lands here).
- **Caps**: 20 concurrent, 200 lifetime, refused with a plain HTTP 503 carrying `mcp-session-cap` / `mcp-session-lifetime-cap` before any session exists. Reservations are released when an initialize the transport refused never reaches `onsessioninitialized`, so the cap cannot leak.
- Registry entry for `mcp serve` (human-only, never published as a tool) grew the four flags and a purpose sentence, so `instructions --schemas` still describes the verb that exists.

## Invariants touched

- **4, self-reported fields never reduce scrutiny** — the whole identity design above. A per-session actor is minted by the server; a client-supplied name is a label at most and reaches no decision.
- **9, human-only classes are inert to agents** — untouched and unchanged: the tool list is still `publishedVerbs()`, so the HTTP transport publishes exactly what stdio publishes, and `createApprovalMcpServer` still answers a human-only name with the same refusal.
- Invariants 1, 2, 5 and 8 are reached only through the CLI functions this wrapper calls, which are unchanged: no verb was reimplemented here.

## SPEC 10.5 draft (Amended APRV-174, pending sign-off.)

Append to §10.5:

> `approval mcp serve` also serves the streamable-HTTP transport, under `--http`. One listener holds one MCP server and one transport per session, routed by the `mcp-session-id` the transport mints at `initialize`; a session ends when its transport closes. The bind is `127.0.0.1` unless the operator names another interface in full through `--listen <host:port>`, which prints a warning banner on every start: this server authenticates nobody, so a loopback bind behind a tunnel the operator controls is the supported deployment. Two caps bound the surface, twenty concurrent sessions and two hundred over the life of the process, and an initialize over either is refused with an HTTP 503 naming which. Identity stays the server's under both transports. Plain `--http` runs every session as the one agent identity the operator fixed at startup; `--guest` mints `agent:guest-<id>` per session instead, before that session's transport exists, so budgets and refusals are keyed per connection. Nothing a client sends contributes to that actor: a header, a URL, the initialize payload's `clientInfo.name` and a tool argument are all data the server records or ignores, never an identity it adopts, which is §11's rule that a self-reported field never reduces scrutiny applied to the field that decides who acted. (Amended APRV-174, pending sign-off.)

## Tests

`tests/mcp-http.test.ts`, 11 cases, all against a real `StreamableHTTPClientTransport` (and raw `fetch` where the case is about HTTP rather than MCP) on an ephemeral loopback port: two concurrent guest sessions get distinct actors and their `task.registered` records carry them; a client calling itself `agent:root` still gets a guest actor; without `--guest` both sessions are the operator; 500 mints collide never; routing by header with 404 / 400 / 404-path refusals; a terminated session's id stops working and leaves the map empty; the 20-session cap answers 503 and creates nothing; a non-JSON body is refused before any session work; the default bind is loopback; `--listen` parsing and the loopback predicate; and the four CLI usage refusals. `tests/mcp-server.test.ts` is untouched and passes unchanged, which is the stdio-is-byte-identical proof.

Validation: full suite in three shards (node scripts/run-tests.mjs --shard k/3) after a clean build — 2720 tests, 2719 pass, 0 fail, 1 skipped. tsc --noEmit clean, oxlint clean. Two failures surfaced on the first full run and were fixed here: MCP_HELP breached the 25-line short-help cap (tests/cli-long-help.test.ts) and its rewrap had split the phrase "READS NO .approval/env" across a line break (tests/mcp-server.test.ts). The help is back at exactly 25 lines with every pinned phrase intact; the prose the trim displaced is in docs/cli-reference.md, which is where that test says it belongs.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
approval mcp serve --http serves the SDK's streamable-HTTP transport beside an unchanged stdio path: one node:http listener, one Server+transport per MCP session routed by mcp-session-id, one shared invoke queue, 20 concurrent / 200 lifetime session caps answered with an HTTP 503. Identity stays the server's under both transports and is settled before each session's transport exists: plain --http runs every session as the operator's actor, --guest mints agent:guest-<6 hex> per session so budgets and refusals key per connection, and nothing a client sends (header, URL, clientInfo.name, tool argument) reaches that actor. Verified by tests/mcp-http.test.ts, 11 cases over a real StreamableHTTPClientTransport and raw fetch on an ephemeral loopback port, including two concurrent guests whose task.registered records carry their own actors; the untouched stdio suite still passes, which is the byte-identical proof. Full suite: 2720 tests, 2719 pass, 0 fail, 1 skipped.
<!-- SECTION:FINAL_SUMMARY:END -->
