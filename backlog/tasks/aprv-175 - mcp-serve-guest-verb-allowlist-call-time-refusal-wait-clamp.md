---
id: APRV-175
title: 'mcp serve --guest: verb allowlist, call-time refusal, wait clamp'
status: Done
assignee:
  - 'agent:opus-lane-u'
created_date: '2026-08-31 01:17'
updated_date: '2026-09-02 09:21'
labels:
  - core
  - mcp
dependencies:
  - APRV-174
ordinal: 154000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From the approved crowd-MCP design. Guests connect their own agents but must never execute on the host: run executes argv on the server machine and adapter email spends vault credentials, so guest mode is a positive allowlist (GUEST_VERBS: instructions, register, request, wait, status, queue, log verify, policy check, policy test — fail closed when new verbs land), filtered where the registry already withholds human_only and EXCLUDED_VERBS. Defense in depth like mcp-identity-fixed: a guest calling a withheld verb by name is refused mcp-guest-restricted at call time with a message naming why, extending the existing known-but-unpublished arm. Guest wait --timeout is clamped server-side to 5s (Carter's number), appended last like --as so a caller's larger value loses — wait blocks the event loop (Atomics.wait), and the clamp bounds the stall; guest instructions text (distinct under guest mode) says wait returns fast, poll status, and states plainly that granted requests do not execute anywhere: the demo is the approval flow itself. --guest without --http is a usage error. Notes must flag the SPEC 11 tool-list surface: guest mode narrows only, never widens.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 tools/list under --guest is exactly the allowlist; run/adapter_email/token verbs absent
- [x] #2 Calling a withheld verb by name refuses mcp-guest-restricted; wait with a large --timeout is observed clamped to 5s
- [x] #3 --guest without --http is a usage error; full-mode tool list and behavior unchanged
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/mcp/server.ts: GUEST_VERBS, a frozen positive allowlist of verb LABELS — instructions, register, request, wait, status, queue, log verify, policy check, policy test. Fail closed by construction: a verb that lands later is absent until someone adds it here.
2. ServerOptions gains `guest?: boolean`. publishedVerbs(guest) intersects the existing filter (human_only false, less EXCLUDED_VERBS) with GUEST_VERBS; toolDefinitions(guest) follows, so tools/list under --guest is exactly the allowlist and can only ever NARROW (a name not already published cannot be added by guest mode, which is the SPEC 11 tool-list surface the notes must flag).
3. CALL-TIME refusal, because the advertised list is never the enforcement: the dispatch map is built from publishedVerbs(guest), and a name that misses it is checked against the registry. human_only first (the existing arm, invariant 9's refusal, true for guest and non-guest alike), then a guest arm refusing `mcp-guest-restricted` with a message naming the verb, that guest mode is on, and what a guest may call. Unknown names stay `unknown tool`.
4. Wait clamp: in buildArgv, guest + verb `wait` appends --timeout last (parseFlags keeps the last occurrence, the same mechanism that pins --as), at min(caller's value, GUEST_WAIT_TIMEOUT_MS = 5s). A caller's smaller value survives; a larger or unparseable one becomes 5s; a caller who passes none gets 5s instead of the CLI's usage error. wait blocks the event loop with Atomics.wait and the queue is shared, so the clamp bounds how long one guest can stall every other session.
5. Guest instructions string on the Server: distinct text saying wait returns fast and to poll status, and stating plainly that a granted request executes nowhere — the demo is the approval flow itself.
6. src/cli/mcp.ts passes guest through to the session servers (--guest without --http is already a usage error from APRV-174).
7. docs/cli-reference.md: the guest allowlist, the call-time code, the clamp. help.ts already names --guest; add the allowlist pointer if it fits under the 25-line cap, otherwise docs only.
8. tests/mcp-guest.test.ts: tools/list under --guest is exactly the allowlist and holds no run / adapter_email / token / journal_write; a crafted call to each of those refuses mcp-guest-restricted while a human-only name still refuses as before; wait --timeout 10m against a live manual request returns timeout in about 5s, not 10m; the same server without --guest still lists and runs the full set.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What shipped

Guest mode is three things in `src/mcp/server.ts`, all keyed off `ServerOptions.guest`, plus the flag plumbing APRV-174 already put in `src/cli/mcp.ts`.

1. **`GUEST_VERBS`, a positive allowlist of registry labels**: instructions, register, request, wait, status, queue, log verify, policy check, policy test. `publishedVerbs(guest)` INTERSECTS it with the ordinary filter (human_only false, less EXCLUDED_VERBS), so guest mode can only ever subtract. A verb that lands next is absent until someone adds it here, which is the fail-closed direction: a deny list would have had to name `run`, `adapter email`, `token` and `journal write` and then everything after them.
2. **The call-time refusal.** The dispatch map is built from `publishedVerbs(guest)`, and a name that misses it is resolved against the registry: the human-only arm first (unchanged, and true of every session on every transport), then `mcp-guest-restricted` for a name full mode publishes, then plain `unknown tool`. A client that crafts the request name never reaches the verb. Same shape as `mcp-identity-fixed`: `tools/list` describes the boundary, the call handler IS it.
3. **The wait clamp**, `GUEST_WAIT_TIMEOUT_MS = 5000`, appended LAST in `buildArgv` the same way `--as` is, so a caller's larger value loses to `parseFlags` keeping the last occurrence. `guestWaitTimeout()` is a ceiling rather than an override: 10m becomes 5s, an unparseable or absent value becomes 5s, and 500ms stays 500ms. `wait` blocks the event loop with `Atomics.wait` and every HTTP session shares one invoke queue (APRV-174), so an unbounded guest wait is one stranger stalling every other session and the listener with them.

`GUEST_INSTRUCTIONS` replaces the connect-time text under guest mode: what may be called, that a refusal is `mcp-guest-restricted` whether or not the name was listed, that `wait` returns in five seconds so `status` is the poll, and, stated plainly, that NOTHING GRANTED EXECUTES ANYWHERE — no `run`, no adapter, no side effect. A stranger who watched their action get granted and assumed an email went out has learned the wrong thing about this system; what they drove is the approval flow itself.

## Decisions

- **Human-only is checked before guest-restricted.** A guest asking for `grant` gets the existing human-only refusal, not `mcp-guest-restricted`. 'No session on any transport may do this' outranks 'this session may not', and invariant 9's answer should not become a guest-mode detail. Pinned by a test.
- **`journal write` is withheld from guests** even though it is harmless to the gate (it appends to a local gitignored file, is never classified and decides nothing). It writes to the operator's disk, and a stranger with a write primitive on the host machine is not what a guest connected for. `journal read` likewise: it would show a guest the operator's own notes.
- **`withdraw` is withheld** although a guest can open a request. The exit that matters for a demo is TTL lapse, and withdraw is the one gate verb a guest could use to churn the log. If the crowd demo wants it, it belongs in this allowlist as its own reviewable line.
- **The clamped value is written in milliseconds** (`5000ms`) rather than `5s`, so `min(caller, ceiling)` has one spelling for every input.
- Guest mode is invisible to the stdio path: `--guest` without `--http` was already a usage error (APRV-174), and `createApprovalMcpServer` defaults it off.

## Invariants touched

- **SPEC §11 tool-list surface**: guest mode NARROWS, never widens, and the test asserts the intersection in both directions. A name full mode withholds cannot become reachable by turning guest mode on.
- **9, human-only classes are inert to agents**: untouched and deliberately checked first, so a guest gets the human-only refusal for a human-only name rather than a guest-flavoured one.
- **6, refusals are machine-readable and distinct**: `mcp-guest-restricted` is a new, distinct code on the MCP wrapper's own refusal surface (beside `mcp-identity-fixed`, `mcp-unknown-flag`, `mcp-stdin-unavailable` and kin), and it names the verb and the alternative.
- **4, self-reported fields never reduce scrutiny**: unchanged from APRV-174, and it is why the clamp is server-side. A caller's `--timeout` is a request, not an authority.
- APRV-173's intake limits are NOT implemented here, as instructed; what this task guarantees them is an actor to key on, since every guest session carries its own `agent:guest-<id>`.

## SPEC 10.5 draft (Amended APRV-175, pending sign-off.)

Append to §10.5, after the APRV-174 paragraph:

> Under `--guest` the tool list narrows to a positive allowlist: `instructions`, `register`, `request`, `wait`, `status`, `queue`, `log verify`, `policy check` and `policy test`, the verbs that declare, ask and observe. The list is intersected with the filter above, so guest mode subtracts and never adds, and it is positive rather than a set of exclusions so that a verb added later is withheld until someone decides otherwise. Withholding is enforced where the call arrives rather than where the list is published: a guest naming a withheld verb is refused `mcp-guest-restricted` at call time whether or not that name appeared in `tools/list`, which is the same reasoning that refuses a caller-supplied identity twice. A human-only name keeps the human-only refusal, checked first, because that answer is true of every session on every transport. A guest's `wait` timeout is clamped server-side to five seconds and appended last, so a caller asking for more loses and a caller asking for less keeps what they asked for; `wait` blocks and every session on one listener shares one queue, so the clamp bounds how long one guest can stall the rest. The guest instructions say all of that, and say plainly that a granted request executes nowhere on this surface: there is no `run` and no adapter behind it, and what a guest is driving is the approval flow itself. (Amended APRV-175, pending sign-off.)

## Tests

`tests/mcp-guest.test.ts`, 11 cases: the guest list is exactly the allowlist (derived independently AND named), and holds no `run`, `adapter_email`, `token`, `journal_write`, `withdraw` or `payload_hash`; the allowlist narrows the full list in both directions and every name in it is a real agent-facing verb; crafted calls to five withheld names refuse `mcp-guest-restricted`; human-only names and nonsense names keep their own refusals; full mode still lists and RUNS what a guest may not; the clamp is a ceiling in `guestWaitTimeout` and is appended last in the built argv, with full mode injecting no timeout at all; a real `wait --timeout 10m` against a live manual request returns `status: timeout` in about 5.5 seconds; and the two instruction strings are distinct and say what they must.

Validation: full suite in three shards after a clean build — 2731 tests, 2730 pass, 0 fail, 1 skipped. `tsc --noEmit` clean, `oxlint` clean.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
mcp serve --guest narrows the tool list to a positive allowlist (instructions, register, request, wait, status, queue, log verify, policy check, policy test), intersected with the ordinary filter so guest mode can only subtract. Enforcement is at CALL time, not in the advertised list: a crafted name that full mode publishes is refused mcp-guest-restricted, a human-only name keeps the human-only refusal (checked first), anything else is an unknown tool. A guest's wait --timeout is clamped to 5s, appended last so a larger caller value loses while a smaller one survives, because wait blocks the event loop and every HTTP session shares one queue. The guest instructions say wait returns fast, to poll status, and that nothing granted executes anywhere. Verified by tests/mcp-guest.test.ts (11 cases), including a real ten-minute wait returning in ~5.5s and full-mode behavior unchanged beside every guest assertion. Full suite: 2731 tests, 2730 pass, 0 fail, 1 skipped.
<!-- SECTION:FINAL_SUMMARY:END -->
