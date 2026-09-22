---
id: APRV-423
title: >-
  Daemon TTL below the harness cap: approval.expired lands before the harness
  blocks on its own timeout
status: In Progress
assignee:
  - '@opus-423'
created_date: '2026-09-21 06:42'
updated_date: '2026-09-22 00:40'
labels:
  - daemon
  - hook
  - ttl
dependencies: []
priority: medium
ordinal: 324000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Harness hooks bound the wait: Hermes caps a pre_tool_call entry at 300 seconds (docs/hermes-hook.md), Claude Code and Cursor have their own ceilings. When the harness times out first, the hook returns a block while the request is still pending on the phone, and a later tap becomes a grant on a call nobody holds (the shape APRV-410 describes from the retry side). Add a per-request TTL derived from the harness cap, so the daemon expires the request and appends approval.expired before the harness gives up, and the two records agree. The hook knows its harness and can pass the cap; the daemon takes the smaller of the policy TTL and the harness-derived one.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A hook-originated request carries the harness cap; the daemon's TTL for it is the smaller of policy TTL and cap minus a documented margin
- [x] #2 In a test with a fake clock the daemon appends approval.expired strictly before the harness cap elapses, and the hook's block message names the expiry
- [x] #3 A tap arriving after expiry is refused with the existing code for a request no longer pending and never becomes a grant
- [x] #4 docs/hermes-hook.md and docs/claude-code-hook.md state the effective window
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. **The cap is a BOUNDED INPUT, never a TTL.** The hook records the harness's per-entry ceiling as `payload.harness_cap_ms` on `approval.requested`; nothing reads it as a deadline. Every reader derives the deadline through ONE function, `harnessCappedTtlMs(policyTtlMs, capMs)` in `core/harness-wait.ts` (the module that already owns the hook's durations and is already read by the hook and the Telegram listener): `min(policyTtl ?? Infinity, capMs - HARNESS_CAP_MARGIN_MS)`. A cap can only SHORTEN (SPEC §11.1 invariant 4); the precedent is `core/gate-window.ts`'s `expires_at`, which is a claim clamped with `Math.min` for the same reason.
2. **The margin is a documented constant**: `HARNESS_CAP_MARGIN_MS = 60_000`, justified in its doc comment as twice the daemon's `DEFAULT_INTERVAL_MS` (30 s), so a lapse that falls immediately after a sweep still gets its `approval.expired` appended a full tick before the cap elapses.
3. **One seam, so no reader can disagree.** `core/state.ts`: `DeclaredAction` gains `harness_cap_ms` (read by `declaredFrom`, unreadable values read as `null` = the policy TTL, which is the pre-existing baseline and not a reduction), and `requestState`'s lapse arithmetic uses the effective TTL. Everything downstream — `decide`, `withdraw`, `expire`, `findHarnessCarry`, `lapsedRequests`, the queue, the channels, intake limits — reaches the shorter window without a second copy of the min. `grantLapsed` takes the same effective window (stricter path).
4. `core/gate.ts`: `RequestInput.harnessCapMs`, written to the requested payload; `appendExpiry` records the EFFECTIVE `ttl_ms` and the `harness_cap_ms` that shortened it, so the expiry record says why its window was short; the `expired`/`not-expired`/`withdraw` messages name the effective window instead of the policy one.
5. `daemon/projection.ts`: `lapsedRequests` no longer returns `[]` outright on a null policy TTL — it keeps that cheap path for requests that carry NO cap, and considers the capped ones. This is the case the hosted Hermes policies actually hit.
6. `cli/hook.ts`: `HarnessAdapter.capCeilingMs` (hermes 300_000, from its own documented per-entry maximum; no other harness documents a ceiling, so no other adapter guesses one), a `--harness-cap <d>` flag for the ceiling the operator configured, effective cap = `min(ceiling, flag)`. `HookRun.harnessCapMs` rides into `request`. A cap at or below the margin leaves no window a human could answer in, so it is denied before anything is appended, with a new distinct code `hook-harness-cap-too-short`. The announce line, the `hook-timeout` deny and the `hook-expired` deny all NAME the expiry instant. `--timeout` is not silently clamped; a wait that outlives the cap gets one stderr line, which is the check docs/claude-code-hook.md currently says the runtime cannot make.
7. `approval.expired` stays the RUNTIME's: the hook never appends one, and its poll loop keeps returning the existing `hook-expired` deny when the lazy state says expired.
8. `channels/tagging.ts`: the phone's `expires HH:MM UTC` line is computed from the effective window, so an approver is not told they have five minutes when they have four.
9. `schema/event.schema.json`: `harness_cap_ms` on `approval.requested` is a positive integer AND requires `payload.execution: \"harness\"` in the same record, refused at the write boundary. A cap on a token-minting request would be a window shorter than the token's shelf life.
10. `serve/server.ts` + `cli/serve.ts`: `--hook-harness-cap` pins `--harness-cap` on every hook call exactly as `--hook-timeout` pins `--timeout`; the two are independent and compose.
11. Docs: docs/hermes-hook.md and docs/claude-code-hook.md state the effective window (cap minus margin) and where it comes from. SPEC.md is NOT edited; the amendment §6 needs (an absent `approval_ttl` plus a declared cap) is proposed verbatim in the implementation notes.
12. Tests: `tests/harness-cap-ttl.test.ts` — fake clock via `tests/scenario.ts`, every record through the real append path. Strict ordering: nothing lapses at cap-margin-1ms; `approval.expired` is appended with a `ts` strictly less than request+cap; a grant attempted after that is refused `expired` with no `approval.granted`; a cap larger than the policy TTL changes nothing (the policy still wins); a cap on a non-harness request is refused at the write boundary. Plus CLI cases spawning the real hook: the deny text names the expiry, and a sub-margin cap denies `hook-harness-cap-too-short` with nothing appended.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What changed

**The cap is recorded, never obeyed.** `approval hook <harness> --harness-cap <d>` states the
ceiling the harness imposes on the hook process. The hook writes it onto every request it opens
as `payload.harness_cap_ms` and nothing reads it as a deadline. One function derives the deadline,
`harnessCappedTtlMs(policyTtlMs, capMs)` in `src/core/harness-wait.ts`: `min(policyTtl ?? Infinity,
capMs - HARNESS_CAP_MARGIN_MS)`. The margin is 60_000 ms, and `tests/harness-cap-ttl.test.ts`
asserts it equals twice the daemon's `DEFAULT_INTERVAL_MS` rather than leaving that in prose, so a
lapse landing just after a sweep still gets its `approval.expired` a whole tick inside the cap.

**One seam.** `core/state.ts`'s `requestState` reads `harness_cap_ms` off the declaration it
already parses and judges the lapse against the effective window, reporting it as
`RequestDerivation.effectiveTtlMs`. Every reader downstream — `decide`, `withdraw`, `expire`,
`findHarnessCarry`/`grantLapsed`, the daemon's `lapsedRequests`, the queue, the channels, the
intake limits — reaches the shorter window with no second copy of the arithmetic. Two copies would
have been two answers to "has this lapsed", and the one that said no is the one a late tap gets
recorded against.

**What the log says.** `appendExpiry` records the EFFECTIVE `ttl_ms` (recording the policy's while
expiring on a shorter one would fail the obvious reader check, `requested_ts + ttl_ms` against
`ts`) and the `harness_cap_ms` that shortened it. The gate's `expired`, `not-expired` and
grant-lapsed refusals name the effective window and, where a ceiling produced it, say so. The phone
line in `channels/tagging.ts` is computed from the same window, so an approver is not told they
have an hour for a question that dies in four minutes.

**The hook's words.** The announce line, the `hook-timeout` deny and the `hook-expired` deny name
the expiry instant, derived from the runtime's own write-boundary `ts` on the record `request`
returned (never from the hook's clock) and from intake's verified read for an adopted key — no
extra read of the log pays for the sentence.

## Decisions the task did not specify

- **A cap at or below the margin is refused, with a new deny code**
  `hook-harness-cap-too-short`, before anything is registered or requested. The alternatives were
  an effective window of zero (every manual call denied by a question that expires as it is asked,
  with a prompt on a phone that nothing can answer) or silently ignoring the ceiling, which is the
  failure this task exists to end. It is refused at the point the invocation is about to OPEN a
  question, so an adopted question and a carried grant are untouched. `HOOK_DENY_CODES` gained a
  member, so `conformance/vectors/refusal-unions.v1.json` is regenerated at **22.0.0** with the
  rationale in `scripts/regen-conformance-vectors.mjs` beside the other majors.
- **Adapter ceilings are contractual maxima only.** `hermes` carries 300_000 ms because its own
  contract states a per-entry maximum no configuration can exceed. No other adapter carries one:
  Claude Code, Cursor, Grok, Muse and Codex document a DEFAULT hook timeout and no maximum, and a
  guessed ceiling would either invent a deadline the harness never imposed or guess high and leave
  the gap open. The effective cap is `min(adapter ceiling, --harness-cap)`, so a stated value can
  only shorten.
- **A cap bounds a request under a policy that declares no `approval_ttl`.** This is the case the
  hosted Hermes policies actually hit, and skipping it would leave exactly APRV-410's pending
  question. `lapsedRequests` keeps its cheap path (with no policy TTL a record carrying no cap is
  not even derived) and considers the capped ones. **This needs a SPEC amendment; the hunk is
  proposed below and SPEC.md is NOT edited here.**
- **`--timeout` is not silently clamped.** The wait stays the operator's. What the hook now does is
  print one stderr line when the wait is not shorter than the ceiling it was told about — the check
  `docs/claude-code-hook.md` said the runtime could not make, "because a hook is not told the cap
  it runs under". It is told now. The poll loop reaches the lapse on its own and denies
  `hook-expired`, so no clamping is needed for the ordering to hold.
- **The expiry instant is named only on a CAPPED request.** Under a ceiling the window is neither
  `approval_ttl` nor the harness's timeout and an agent cannot work it out; under the policy alone
  the deadline is already stated where its reader can see it. It also keeps every uncapped deny
  byte-for-byte reproducible across two invocations, which is the property
  `tests/cli-hook.test.ts`'s snapshot case compares.
- **`grantLapsed` takes the effective window too**, so a grant's shelf life is the window its own
  question was asked under. The stricter of the two readings, and it keeps `requestState` the one
  place a deadline is decided.
- **The write boundary refuses `harness_cap_ms` without `execution: "harness"`**, as a
  `dependentSchemas` cross-rule on `approval.requested`. A cap on a token-minting request would be
  a question with a shorter life than the authorization it mints. A schema sees one record, which
  is exactly enough to see both fields.
- **`approval serve` gained `--hook-harness-cap`**, pinning `--harness-cap` on every hook call as
  `--hook-timeout` pins `--timeout`. The two are independent and compose; this is the hosted
  surface where a tenant harness's ceiling is the operator's to state.
- `approval codex bridge` passes no cap and says so in `docs/cli-reference.md`: it holds its own
  connection open, so there is no process something else will kill.

## Invariants touched (CLAUDE.md "Global invariants are implicit acceptance criteria")

- **§11.1 invariant 4, self-reported fields never reduce scrutiny.** The cap is claimed by the
  party under oversight. It is structurally unable to extend anything: the runtime takes a MINIMUM,
  so an overstated cap changes nothing and an understated one shortens only the claimant's own
  window. The precedent followed is `core/gate-window.ts`'s `expires_at`, which clamps a claimed
  window against the derived one with `Math.min` for the same reason. An unreadable value reads as
  absent, which returns to the policy's TTL — the pre-existing baseline, not a reduction below it —
  and the write boundary refuses such a value anyway.
- **§11.1 invariant 2, gate-typed events never accept caller timestamps.** Nothing here adds an
  instant. The cap is a DURATION; every lapse is still measured from the `approval.requested`
  record's own write-boundary `ts`, and the expiry instant the hook prints is computed from that
  `ts` rather than from the hook's clock.
- **§11.1 invariant 7, refusals machine-readable and distinct.** One new code,
  `hook-harness-cap-too-short`, distinct from `hook-timeout` (a wait ran out, the question is still
  open) and `hook-expired` (a real question lapsed): it says NO QUESTION WAS ASKED and the repair
  is the harness's own timeout. The late tap keeps the gate's existing `expired` code; no refusal
  was merged, renamed or softened.
- **The log is append-only.** Nothing mutates or reorders anything. `approval.expired` stays the
  RUNTIME's record: the hook never appends one, and the two writers are unchanged (the daemon's
  sweep, and `decide`'s lazy materialisation before it refuses).
- **Fail closed.** Every direction added here is the stricter one: a shorter window, a refused
  configuration, a carry that stops earlier, a schema pairing enforced at the write boundary.

## Proposed SPEC.md hunk (NOT applied — §6, after the `approval_ttl` paragraph at line 128)

> **A requester may shorten its own question, and only that.** A request opened by a harness hook
> MAY declare `harness_cap_ms`: the ceiling the harness imposes on the hook process that asked.
> The harness kills that process at the ceiling and reads the killed hook as a non-blocking error,
> so a question that outlives its asker collects a decision authorizing a call nobody holds. Where
> the field is present the request is judged against the SHORTER of the policy's TTL and the cap
> less an implementation-defined margin, and never anything longer. This is not a duration the
> runtime invented: the cap is stated by the party under oversight about its own process, a record
> carrying it MUST also declare `execution: "harness"`, and taking the minimum makes it
> structurally incapable of extending any deadline — so it bounds a request under a policy that
> declares no `approval_ttl` without the runtime supplying a number of its own. The margin MUST
> exceed the implementation's own expiry-sweep interval, so that the `approval.expired` record is
> written before the harness stops listening. (Amended APRV-423.)

§11.1 needs nothing new: invariant 4 already binds the field, and this task adds no cross-cutting
safety property that is not an instance of it.

## Validation

- `npm run build`, `npm run typecheck` (tsc --noEmit), `npm run lint` (oxlint): all exit 0.
- `node --test dist/tests/harness-cap-ttl.test.js`: 14/14 pass (the new suite).
- Hook suites, `node --test` over cli-hook, cli-hook-cursor, cli-hook-hermes, cli-hook-grok,
  cli-hook-muse, cli-hook-codex, cli-hook-scope, cli-hook-rewrite, cli-hook-scratch,
  cli-hook-read-scope, agent-sdk-hook, harness-cap-ttl: 381/381 pass.
- Daemon, core and channel suites: daemon, daemon-projection, state, gate, token, log,
  clock, event-schema, intake-limits, render-queue, channels-telegram, prompt-layout:
  458/458 pass.
- Structural and docs guards: conformance, conformance-regen, fixtures, layering,
  hook-module-graph, autonomy-split, decision-refusal, question-preempted, validate,
  cli-help, cli-long-help, docs-guard, serve, serve-hook, channels-contract,
  harness-enum: 524/524 pass.
- **`npm test` once, whole matrix: 5139 tests, 5116 pass, 22 fail.** All 22 failures are the
  SMTP / email-adapter cases that fail on Node 26 before this branch (APRV-416, pre-existing).
  Nothing else fails, and nothing here touches that adapter.

Three existing files were corrected rather than accommodated, and each is a real drift the new
code surfaced: `docs/cursor-hook.md`'s deny table (a test pins it set-equal to
`HOOK_DENY_CODES`), the five hook/serve short helps (all were sitting exactly on the 25-line cap,
so the flag is folded into existing lines rather than added as new ones), and the
`refusal-unions` conformance vector.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
A hook-originated request now carries the ceiling its harness kills the hook at (`--harness-cap`, recorded as `payload.harness_cap_ms`), and every reader judges the request against the SHORTER of the policy's approval_ttl and that ceiling less a documented 60s margin (HARNESS_CAP_MARGIN_MS in src/core/harness-wait.ts, two of the daemon's 30s sweep intervals). The cap is a bounded input taken through one minimum in one place, so it can only move the lapse earlier; the derivation lives in requestState, so the gate, the daemon's sweep, the carry lookup and the channels cannot disagree about when a question ended. approval.expired stays the runtime's record, a late tap keeps the gate's existing `expired` refusal and never becomes a grant, and a ceiling with no room for a human is denied `hook-harness-cap-too-short` before anything is written. Verified by tests/harness-cap-ttl.test.ts (14 cases on a fake clock: the expiry lands a full margin inside the cap, nothing lapses a millisecond early, a late grant is refused with zero approval.granted, the schema pairing is refused at the write boundary) plus a spawned-CLI case proving the hook's block message names the expiry instant; build, typecheck, lint clean; npm test 5116/5139 with the 22 pre-existing APRV-416 SMTP failures and nothing else.
<!-- SECTION:FINAL_SUMMARY:END -->
