---
id: APRV-499
title: Policy-declared tool-name mapping and a default for unmapped harness tools
status: In Progress
assignee: []
created_date: '2026-10-05 22:48'
updated_date: '2026-10-05 23:11'
labels:
  - hook
  - policy
  - harness
  - marketplace
dependencies: []
priority: high
ordinal: 383000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The harness hook classifies a tool call through a per-harness hard-coded rule table (src/cli/hook.ts, hermesToolRule for Hermes). A tool the table does not claim, including every MCP tool mcp__<server>__<tool>, is answered 'not a gated tool' and allowed with no record. The Agent Village wants residents to install third-party apps (MCP servers) from a marketplace with per-app action classes chosen at install time, with no core release per app, and wants every tool call recorded. This task adds a policy key mapping harness tool names to declared classes, and a defaults key saying what happens to a tool nothing maps. Target 0.4.2. SPEC amendment proposal in the notes; SPEC.md itself is attested by Carter, never edited here.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Top-level policy key tools: an ordered list of {match, class}; match is a glob over the harness tool name (* is the only wildcard), class is a concrete class that is an exact key of classes or extends a declared trailing family key; first match wins
- [x] #2 The hook consults tools only for a call the harness's own tables do not claim (shell, file, read, pass-through tools and the hard-coded rule table keep precedence)
- [x] #3 A malformed match, a malformed class, or a class absent from classes makes the policy fail to load (schema-invalid), so every class resolves manual
- [x] #4 defaults.unmapped_tool: record | ask; record = allow and append execution.started under harness.tool.unmapped carrying the tool name; ask = gate under that class as manual; absent = today's allow with no record
- [x] #5 harness.tool.unmapped resolves through classes like any class; with no rule matching, defaults.unmapped_tool supplies its autonomy (record autonomous, ask manual) instead of defaults.autonomy
- [x] #6 Tests: exact, glob, precedence vs hard-coded Hermes rules, first match, unknown class rejected, malformed glob rejected, unmapped record/ask/absent; policy schema tests; conformance vectors regenerated and diff read line by line
- [x] #7 Docs: docs/claude-code-hook.md and docs/hermes-hook.md tool classification sections; CHANGELOG Unreleased; SPEC amendment proposal text in these notes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Schema: top-level `tools` (ordered list of {match, class}; match grammar `^(?:[A-Za-z0-9_.:-]|\*(?!\*))+$`, max 256; class a concrete class) and `defaults.unmapped_tool` (record | ask). Event schema: optional `payload.harness_tool` on execution.started.
2. `src/core/tool-map.ts` (pure): glob matcher, first-match verdict, load-time checks (undeclared class, reserved unmapped class, duplicate match) wired into `loadPolicyText` as schema-invalid.
3. `policy-match.ts`: `harness.tool.unmapped` takes its default from `defaults.unmapped_tool` (record autonomous, ask manual) when no rule matches; explain and diff follow.
4. `hook.ts`: an unclaimed call (not shell, file, read, pass-through, nor the rule table) is described by the policy mapping; the early allow happens only when the policy loads and neither maps the tool nor declares the key; the post half closes mapped/unmapped starts; autonomous starts carry `harness_tool`.
5. Tests, conformance regen, docs, CHANGELOG, SPEC proposal.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## Done (branch lane/aprv-499-tool-map)

- Keys: top-level `tools` (ordered `[{match, class}]`) and `defaults.unmapped_tool: record | ask`. Fixed class `harness.tool.unmapped`.
- Precedence: the adapter's shell/file/read/pass-through tools and the Hermes rule table (gated or read) claim first; `tools` is consulted only for an unclaimed call; first match wins; then `defaults.unmapped_tool`; absent = the old not-a-gated-tool allow, no record.
- Resolution: `harness.tool.unmapped` resolves through `classes` like any class. Only when no rule matches does `defaults.unmapped_tool` supply its default (record = autonomous, ask = manual), in place of `defaults.autonomy` (human-only included). Implemented in `policy-match.ts` `fromDefaults`, so the hook, the gate's write boundary, explain and diff agree.
- Validation (fail closed, `schema-invalid`): malformed match (schema pattern: `**`, space, slash, `?`, empty), malformed class (wildcard, uppercase), extra/missing entry keys, unknown unmapped_tool value; load-time: class not declared by `classes` (exact key or trailing `<prefix>.*` family; interior wildcards and bare `*` do not declare), class = `harness.tool.unmapped`, duplicate `match`.
- Records: an autonomous start from a mapped or unmapped call carries `payload.harness_tool` (the NAME only; arguments bound by `payload_hash` of `{tool, input}`). New optional event-schema field, shape-checked (`^[A-Za-z0-9_.:-]+$`, 1..256). Manual/supervised paths carry the whole call in the registered request payload, as the Hermes rule table already did.
- Behaviour change (deliberate, fail closed): under a policy that does not load, an unclaimed call is now refused `hook-policy-unavailable` (was allowed). Under the open window with an unloadable or unattested policy it is recorded as `gate.bypassed` under `harness.tool.unmapped` (fix round 1, S1; superseded the original "keeps the allow").
- Cost: an unclaimed call now costs one policy read and one verified log read (attestation check, fix round 1 B1) before the not-gated allow; the post half likewise.
- Also: `approval policy diff` probes every `tools` class and `harness.tool.unmapped` when either side declares the key; `approval explain` names `defaults.unmapped_tool`; doctor's MATCHED AND NOT CLASSIFIED line mentions the mapping.
- Conformance: policy-resolution 4.0.0 (+4 vectors, +2 controls), schema-validation 3.2.0 (+6 fixtures), new suite hook-tool-map 1.0.0 (14 vectors, 2 controls). Regen diff read line by line: removed lines are only vectors_version, algorithm (policy-resolution) and count in the two moved files; hook-read-scope, gate-verdicts, command-class, refusal-unions, chain, jcs, bridge unchanged. No existing fixture moved.

## SPEC amendment PROPOSAL (for Carter to attest; SPEC.md untouched)

§5.1, canonical example `defaults:` block, add after `on_expiry: reject`:

    unmapped_tool: record     # harness tool calls nothing classifies are recorded (absent = not gated)

§5.2, new bullet after `read_scope`:

- **`tools`.** An optional top-level ordered list of `{match, class}` entries naming the class a harness's own tool call is judged under, by tool name, for a call the harness adapter's built-in tables do not claim (its shell, file, read and pass-through tools and any rule table that reads the call's arguments). `match` is compared against the whole tool name, case-sensitively; `*` is the only wildcard and matches any run of characters, including none; any other character outside letters, digits, `_`, `.`, `:` and `-`, and two `*` in a row, are schema violations. The first entry whose `match` matches decides, and later entries are not read. `class` is a concrete class that MUST be declared by `classes`, as an exact key or under a trailing family key `<prefix>.*` whose literal prefix it extends; it MUST NOT be `harness.tool.unmapped`; two entries MUST NOT share a `match`. A violation of any of these makes the policy fail to load, so every class resolves `manual`, and an implementation MUST then refuse a harness tool call it would otherwise have answered from the mapping, rather than treat it as unmapped. The adapter's built-in tables keep precedence over every entry: an entry reads only a name and MUST NOT reclassify a call the runtime classified from its arguments. A call an entry claims is gated under that class with the whole call (`{tool, input}`) as its payload. (Amended APRV-499, pending sign-off.)
- **`defaults.unmapped_tool`.** Optional, `record` or `ask`: what a harness hook does with a tool call that neither the adapter's tables nor any `tools` entry claims. Either value classifies the call `harness.tool.unmapped` (§7), and the key is that class's default: when no `classes` rule matches it, it resolves `autonomous` under `record` and `manual` under `ask`, in place of `defaults.autonomy`. A rule matching the class decides it as a rule decides any class. Absent, such a call is not a gate question and leaves no record, which is the behaviour of every policy written before the key. (Amended APRV-499, pending sign-off.)

§7, developer-workstation namespace table, new row after `harness.launch.*`:

| `harness.tool.*` | `.unmapped` (a harness tool call no adapter table and no `tools` entry claims, under `defaults.unmapped_tool`) | as `defaults.unmapped_tool` says when no rule matches: `record` autonomous, `ask` manual; a policy MAY declare it at any level |

§8, after the `policy_sha256` paragraph of the harness start record:

A harness `execution.started` whose class came from the policy's tool mapping (a `tools` entry, or `harness.tool.unmapped`) MAY carry `harness_tool`, the tool name, so that several tools sharing one class remain distinguishable. It is the name only: the call's arguments are bound by `payload_hash` and MUST NOT be written to the log. (Amended APRV-499, pending sign-off.)

## Fix round 1 (refutation A10, claude-edge/A10-fix)

- B1 closed by the ATTESTATION CHECK, not by decoding attested bytes from the store: "not a gated tool" for an unclaimed call is believed only when the policy bytes (read once, parsed and hashed from the same buffer) load, leave the tool unmapped with no `unmapped_tool`, AND match the latest attestation in the verified log. Applied on the fast path, the post half, the closed path (`decideHarnessSteps`, explicit check on the unclaimed allow) and the window path. Otherwise: `hook-gate-refused:policy-not-attested` (mirrors Bash under the same file), `hook-log-unreachable` (no log dir) or `hook-io` (log unreadable). Consequence accepted: under drift or a never-attested policy, TodoWrite/MCP calls that NEITHER version maps are refused too (stricter than 0.4.1, same as Bash). Re-attesting restores them.
- S1: under an open window, an unclaimed call whose policy does not load or is not attested is described `harness.tool.unmapped` and recorded `gate.bypassed`.
- S2: `hook-policy-unavailable` detail now carries the first five per-entry errors (`path: message`) and a repair line (correct the entries, then `approval policy attest`). Applies to every load failure, not only `tools`.
- S3: `harness_tool` on every start a mapped/unmapped call writes: carried on `HookRun`, so the supervised-retro start, the autonomous start and the grant spend (`consumeHarnessGrant` option `harnessTool`, which also covers a floored call routed to a human) all write it.
- S4: an unrecordable tool name under a mapping or unmapped default is refused `hook-io` with detail prefix `tool-name-invalid:` before any append. Existing code chosen deliberately: a new `hook-*` code would grow `hook_deny_codes` (refusal-unions major bump, help text, cursor deny table) for a corner model APIs already exclude; the empty tool name is already `hook-io`.
- RULING H1 (claude-edge): a record-only `harness.tool.unmapped` start (a harness start carrying `harness_tool`, no `approval.granted` on its key) is not counted by any global `budgets.<scope>.daily_actions` and is not refused by a spent one; its outcomes are transparent to the task, session and actor streaks. Granted (`ask`) ones count. Class-scoped `limits` still meter it; `daily_usd` unchanged (these starts carry cost 0). A tripped floor still ROUTES an unmapped call to a human (the class stays side-effecting for routing).
- Security scan, named attacks: (1) the exemption keys on the start written by the policy-authorized harness start only (`execution: "harness"` + `harness_tool`), and that start now re-derives the named tool's class from the ATTESTED mapping (`toolMapStartRefusal` in gate.ts, refused `policy-not-attested`), so neither the tool input nor a declared class nor a policy swap between the hook's read and the gate's read can make a real action record-only. (2) refused starts write nothing; outcomes with no start, declared-only unmapped starts and ordinary classes accrue exactly as before.
- H2: CHANGELOG now states the upgrade order (every runtime on 0.4.2 before a template carries the keys).
- docs-guard: dictionary rows for `defaults.unmapped_tool`, `tools`, `tools[].match`, `tools[].class` in docs/README-extended.md.
- SPEC proposal additions (for Carter): §5.2 `tools` bullet, append: "An implementation MUST NOT answer a call it does not classify as outside the gate on the strength of policy bytes that are not attested (§11.1)." §5.2 `defaults.unmapped_tool` bullet, append: "A start recorded under `record` with no human grant is a record of unclassified tool use: global `daily_actions` budgets do not count it, and §10.2's harness streaks do not accrue it."
- RULING (claude-edge), implemented: `harness.tool.unmapped` is reserved to the hook. `register` refuses any envelope declaring it (`envelope-invalid`, nothing appended) unless the in-process call option `toolMapHook: true` is set, which only the hook's registration passes; that covers task files, `approval propose` (it registers through `register`) and the HTTP registration route. `approval run` (`core/execute.ts` `attemptStart`) refuses a key declared under the class with `harness-executed` (the existing "the harness runs this itself" refusal). A policy-path start of the class without `harness_tool` is refused `not-granted` (`toolMapStartRefusal`). Existing codes only; no refusal union changed. CORRECTED in fix round 2: as of fix round 1 a CLI `approval request` against a key the hook itself registered could still mint a token after the hook's own request was withdrawn, and that token COULD be spent by `approval consume` (only `approval run` refused the class), writing a reserved-class `execution.started` with no `harness_tool` (recheck SF2). Fix round 2 closes both doors; see below.

## Fix round 2 (recheck A10-recheck, agentvillage-d4/A10-fix2)

- SF1 (budget under-count): `isRecordOnlyUnmappedStart` (budgets.ts) now returns false for any start carrying `grant_origin` or `grant_seq`, the fields `consumeHarnessGrant` writes and the policy-authorized start never does. A hook's grant spend whose `approval.granted` has aged out of the 24 h window (an `approval_ttl` in days) is counted by `daily_actions` again, as ruling H1 says. loop.ts `recordOnlyKeys` already excluded granted keys (whole log), unchanged. Tests: budgets.test.ts probe (grant T-30h, spend T-1h, `daily_actions: 1`: consumed 1, refused), the control without `harness_tool`, and a record-only start still consumed 0.
- SF2 (reservation at consume): `verifyTokenSpend` (token.ts), shared by `consumeToken` and `approval run`'s preflight, refuses a grant whose class is `harness.tool.unmapped` with `harness-executed` (the code `approval run` already uses), state `granted`, nothing appended. A token a log already holds for the class (written by an earlier runtime) cannot be spent by `approval consume` or `approval run`.
- SF2 (reservation at request): `attemptRequest` (gate.ts) refuses `envelope-invalid`, before the log is read, a request on `harness.tool.unmapped` that is not `execution: "harness"`. The hook's own request is always a harness request (mints no token), so it is unaffected; `approval request` (CLI, class from the registration) after a withdrawn hook request is refused and mints nothing. Same shape as the registration refusal.
- Tests: cli-hook-tool-map.test.ts, two SF2 cases: the five-step flow now refused at step 3 (CLI and core `request`, nothing appended, no grant possible); and on a log holding steps 3-4 as the pre-fix runtime wrote them (appended at the log layer, the tests/token.test.ts legacy-grant idiom), `approval run`, `approval consume` and core `consumeToken` all refuse `harness-executed` with the reservation's words, nothing appended, `log verify` exit 0.
- docs/cli-reference.md: `envelope-invalid` and `harness-executed` entries name the reserved-class cases. CHANGELOG updated. No SPEC.md, schema or conformance change; no refusal union changed.

## Remaining / for the orchestrator

- SPEC amendment applied in PR #626, pending sign-off. Hunks 2-6 only: hunk 1 (the 5.1 canonical example gains `unmapped_tool: record`) is DEFERRED, because the example is pinned byte for byte to the scaffold fixture (test 'the fixture's policy half is SPEC.md 5.1 verbatim'), so it moves together with the scaffold and the fixture in a later pass, not at the 0.4.2 cut.
- Refuter scope (noticed and accepted): see the PR body.
- Follow-ups not done here: `.mcp.json` is not a built-in protected path (an agent able to write it could name a server a loose entry claims; documented, operator adds it to `protected_paths`); `approval hook classify` has no tool-name form; the open-window path with a mapped tool is covered by code (describeToolCall gets the loaded policy) but by no test.
<!-- SECTION:NOTES:END -->
