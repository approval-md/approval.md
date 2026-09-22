---
id: APRV-423
title: >-
  Daemon TTL below the harness cap: approval.expired lands before the harness
  blocks on its own timeout
status: Done
assignee:
  - '@opus-423'
created_date: '2026-09-21 06:42'
updated_date: '2026-09-22 02:24'
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

## Second review pass (adversarial findings F1 to F7, fixed by a Fable subagent)

Each fix below carries a test that reproduces the finding. Opus was unavailable, so the fixer ran at Fable; the refuter was a separate pass and saw neither the plan nor these notes.

**F2 (design defect): the Hermes default ceiling is 30_000, not 300_000.** `HERMES_ADAPTER` now carries two numbers. `capCeilingMs: 300_000` stays as the observed per-entry maximum and is applied only as a CLAMP on a stated `--harness-cap` (Hermes will not honour an entry above it however it is written, so a flag that overstates it is a window the process will not live to see). New `capDefaultMs: 30_000` is `plugins.hook_callback_timeout`'s documented default, which bounds the whole dispatch and fails closed on `pre_tool_call`; it is what the hook assumes when no flag is passed, because an operator who has said nothing is assumed to run Hermes as shipped. The first pass assumed the ceiling in that case, which on a default install asserted a T+240s deadline for a hook Hermes kills at 30s: APRV-410 again with a fictional deadline. 30s does not clear the 60s margin, so a Hermes hook with no flag is now refused `hook-harness-cap-too-short` before anything is written. The combination rule in `runHarnessHook` is: stated flag present, effective cap = min(flag, ceiling); flag absent, effective cap = adapter default, falling back to the ceiling for an adapter that documents only a maximum. `HookRun` gained `harnessCapStated` (so the deny says whether the ceiling was stated or assumed) and `harnessCapRepair` (the adapter's own repair sentence, `HarnessAdapter.capRepair`). The Hermes repair text says exactly: raise `plugins.hook_callback_timeout` above the per-entry `timeout`, then pass `--harness-cap <the smaller of the two>`; the too-short deny also names the actions and classes it refused for, so a reader still sees which class routed the call to a human. Docs: docs/hermes-hook.md's config block adds `--harness-cap 300s` to the `pre_tool_call` entry (the post half opens no question, so the flag is inert there), the effective-window section is rewritten around "240s once you say so, refused until you do", and the For Agent Village bullet states all three values (`hook_callback_timeout: 600`, `timeout: 300`, `--harness-cap 300s`) and what a tenant that omits the flag gets. `src/cli/help.ts`'s hermes help and docs/cli-reference.md say the same in short. `HOOK_DENY_CODES` is unchanged, so no conformance vector moves. Tests (tests/cli-hook-hermes.test.ts): "a manual-class command with no --harness-cap is refused for Hermes's 30s default, and the log is untouched" (deny code, the 30000ms ceiling, the "assumed ... because no --harness-cap was passed" clause, the exact repair order, the class named, the log byte-identical); "a manual-class command under --harness-cap 300s waits, and the window it is judged by is 240s" (hook-timeout, `harness_cap_ms: 300000` recorded, the deny names requested_ts + 240s); "a stated cap above Hermes's 300s per-entry maximum is clamped to it" (`--harness-cap 10m` records 300000).

**F3 (consistency): one derivation for the remaining window.** `src/cli/execute.ts`'s `pendingRequests` reads `derivation.effectiveTtlMs` instead of recomputing from the policy TTL, so `approval queue` shows a capped request its real remaining window and a capped request under a policy with no `approval_ttl` shows a number rather than "no TTL". `QueueEntry` gained `ttl_ms` (the whole window the remaining counts down from), additive in the `--json` shape and documented in docs/cli-reference.md; the human TTL column's colour fraction is remaining over THAT window, so a four-minute question three minutes in reads as a quarter left rather than a sliver of the policy's hour. `src/channels/telegram.ts`: every `Delivery` and `DigestState` now carries `windowMs`, computed at delivery by `retentionWindowMs(request)` as the SHORTER of the request's own `ttl_remaining_ms` (the tagger computed it from `effectiveTtlMs`; it was measured at tagging and delivery is at or after tagging, so counting it from delivery ends at or after the gate's lapse) and the channel's configured `approvalTtlMs` (the pre-APRV-423 bound, counted from delivery, also at or after the real lapse). Both bounds are individually safe in the only direction that matters (never forgetting a button a decision could still reach), so their minimum is too. A digest takes the widest member's window and `null` if any member is unbounded. `sweep`'s `lapsed` and `expired` read the entry's window, falling back to `approvalTtlMs` and then the 24h default only for an entry that carries none (review cards). The channel still reads no policy and no log. Tests: tests/harness-cap-ttl.test.ts "F3: approval queue shows a capped request its real remaining window, not the policy's hour" and "F3: a capped request under a policy with no TTL is no longer shown as 'no TTL'" (both spawn the real hook and then `approval queue --json` and the human render); tests/channels-telegram.test.ts "a capped request's buttons are forgotten when ITS window closes, not the policy's (APRV-423)" (a 300s-capped harness request tagged two minutes in has 120s left; the channel configured with the policy's 1h TTL drops the delivery at exactly +120s, and a digest of the same request likewise). The existing "with no approval TTL only settled entries are forgotten" case now opens its requests under a no-TTL policy (`POLICY_NO_TTL`): the old fixture tagged requests under a 24h policy while telling the channel there was no TTL, which the per-request window makes visible; the case's claim is about a policy that bounds nothing, so the fixture now says so.

**F5 (docs): the margin buys the ordering in the common case; the lazy refusal is the guarantee.** docs/hermes-hook.md, docs/claude-code-hook.md, docs/cli-reference.md and the `HARNESS_CAP_MARGIN_MS` comment in src/core/harness-wait.ts now say that `Daemon.tick` skips a sweep when the previous tick is still running and that the request's `ts` trails the hook's spawn by intake latency, so an overrunning tick plus a slow intake can put `approval.expired` after the kill; what keeps a late tap safe regardless is `requestState`'s arithmetic lapse, which `decide` refuses `expired` and materialises the record on. No code changed for this finding.

**F6 (schema): `harness_cap_ms` minimum is 60001.** The route chosen is the schema floor, `HARNESS_CAP_MARGIN_MS + 1`, with the mirror pinned by a test rather than a gate-side refusal. Why: the margin keeps ONE owner (`harness-wait.ts`); the schema literal is a mirror in exactly the sense `docs/cursor-hook.md`'s deny table mirrors `HOOK_DENY_CODES` and the conformance vectors mirror the unions, each pinned equal by a test so drift fails the build rather than passing silently. A gate-side check would have needed either a new `GATE_REFUSAL_CODES` member (a SPEC.md §11 refusal-table edit, which this task may not make, plus a conformance major) or the reuse of a code that means something else, and would have put the field's second shape rule in a different file from its first (`dependentSchemas` already pairs the cap with `execution: "harness"` at the write boundary). The `harnessCappedTtlMs` comment no longer claims the zero window is unreachable only "through the hook". Test: tests/harness-cap-ttl.test.ts "F6: the schema's floor on harness_cap_ms is the margin plus one, so a non-hook caller cannot open a zero-length window" (reads the schema, asserts `minimum === HARNESS_CAP_MARGIN_MS + 1`, then calls `request()` directly with caps of 1, 59999 and 60000 and asserts each is refused with nothing appended, and that 60001 opens a 1ms window).

**F7 (text): the `hook-timeout` sentence is conditional on which ends first.** New `windowEndsBeforeGrace(run)` in src/cli/hook.ts compares two durations from the same `approval.requested` `ts`: `harnessCappedTtlMs(run.ttlMs, run.harnessCapMs)` and `abandonedAfterMs(run.timeoutMs, run.graceMs)`. It is `false` for every uncapped run whatever the policy's TTL, so the uncapped sentences stay byte-for-byte APRV-287's (tests/cli-hook.test.ts's snapshot case depends on that). When the capped window closes first, the deny says the request(s) "expire at T, which comes before the Nm retry grace would run out, so that is how long they stay open" and drops the "past the grace the hook takes the question back" sentence, which could not happen; the announce line on stderr says the same. When the grace is shorter, the APRV-287 sentence stands and the harness deadline is added after it, as before. Computed from this invocation's own flags, so for an ADOPTED question opened under other flags it is the current invocation's reading of the two windows; noted in the helper's comment. Tests: tests/harness-cap-ttl.test.ts "F7: when the capped window closes before the retry grace, the deny says the window is what holds the question open" (1s wait, default 5m grace, 300s cap) and "F7: when the retry grace is the shorter of the two, the grace sentence stands and the deadline is added" (1s wait, 10s grace, 300s cap); each asserts the present and the absent phrasing in both the deny and the announce line.

**Invariants touched by this pass.** §11.1 invariant 4 (self-reported fields never reduce scrutiny): the stated cap is still taken through a minimum with the contractual ceiling and can only shorten; the new DEFAULT is the runtime's own assumption, not a claim by the party under oversight, and it is the stricter of the two documented bounds. §11.1 invariant 7 (refusals distinct): no code added, removed or renamed; `hook-harness-cap-too-short`'s message gained the action list, the stated/assumed clause and the adapter repair. Fail closed: a Hermes hook with no flag now refuses where it previously opened a question with a deadline the harness would not keep; the schema floor refuses at the write boundary what the hook already refused. The log is append-only and `approval.expired` remains the runtime's record; nothing here writes one.

## Proposed SPEC.md hunk (NOT applied — §5.2, beside the §6 hunk above; F1)

§5.2 currently says a request under a policy that omits `approval_ttl` stays actionable until a human decides it, and that implementations MUST NOT invent a default duration. The proposal:

> **A harness-stated ceiling is a bounded input, not an invented duration.** The prohibition above forbids a runtime supplying a number of its own; it does not forbid a runtime honouring a ceiling the requesting hook recorded at request time about its own process (`harness_cap_ms`, §6). That number is stated by the party under oversight, MUST be accompanied by `execution: "harness"`, and is applied only through a minimum, so it can shorten a request's window and never lengthen one (§11.1 invariant 4). A request carrying such a ceiling under a policy that omits `approval_ttl` therefore lapses at the ceiling less the implementation's margin, and a decision after that instant is refused `expired`; the absence of `approval_ttl` still means nothing lapses for every request that carries no ceiling. This is not the runtime expiring an approval its author never asked to expire: the asker itself will not be present to receive the answer past its ceiling, and a runtime that kept the question open would be collecting a decision for a call nobody holds. (Amended APRV-423.)

## Validation (second review pass)

- \`npm run build\`, \`npm run typecheck\`, \`npm run lint\`: all exit 0.
- Targeted: harness-cap-ttl, cli-hook-hermes, serve, serve-hook, channels-telegram, cli-status (the queue cases), cli-style-render, cli-help, cli-long-help, docs-guard, event-schema, cli-hook, render-queue: 553/553 after the one regex fix in the new hermes case. Then harness-enum, cli-instructions, cli-hook-hermes, cli-status, conformance, docs-guard, cli-help: 156/156.
- **Whole matrix once: 5167 tests, 5142 pass, 24 fail** at the first run. 22 are the Node 26 SMTP / email-adapter cases (adapter-email 14, cli-setup 4, smtp-probe 4; APRV-416, pre-existing). The other two were this pass's own and are fixed: \`tests/harness-enum.test.ts\`'s hermes case ran \`hook hermes\` with no \`--harness-cap\` and expected \`hook-timeout\`, and now states \`--harness-cap 300s\` as the documented config does (the too-short deny it got is the F2 behaviour, not this case's subject); \`tests/cli-instructions.test.ts\`'s registry check found \`ttl_ms\` missing from the queue verb's declared \`--json\` output schema in \`src/cli/verb-registry.ts\`, which now declares it (additive, required, nullable integer). No conformance vector freezes the registry schemas, so nothing regenerates.

## Third review pass (recheck findings R1, R2)

**R1 (adopted question under a ceiling with no room): the wait is clamped.** The too-short refusal fires only for a question this invocation would OPEN (`fresh.length > 0`), so a run whose every key was ADOPTED (run A opened the question with `--harness-cap 300s`; run B, same bytes, flag omitted, so Hermes's assumed 30s) opened nothing, sat in its poll loop for `--timeout` (55s default, 4m in the documented config), was killed by the harness at 30s, and on an entry without `fail_closed` the call proceeded; `announceWait` only warned, and only when `timeoutMs >= harnessCapMs`. Fix in `src/cli/hook.ts`: `HookRun.waitMs` is THIS invocation's wait, `min(timeoutMs, harnessCapMs - HARNESS_CAP_MARGIN_MS)` clamped at zero when there is a ceiling and `timeoutMs` otherwise; the poll deadline, the announce line, the lagging note and every `hook-timeout` deny read it through `waitText(run)`, which spells a clamped wait as `0ms wait (a 240000ms --timeout clamped to what the 30000ms harness ceiling leaves)`. A zero wait still reads the verified log once before denying, so a decision already recorded is honoured, and then denies `hook-timeout` with the retry-grace wording: the adopted question stays open and its recorded deadline is untouched (the clamp bounds the wait, never the window). The stderr warning is gone; in its place one line, only when the clamp shortened the wait, states the configured `--timeout`, the ceiling, the margin and the wait actually made. `abandonedAfterMs(run.timeoutMs, graceMs)` (withdrawal and `windowEndsBeforeGrace`) still reads the CONFIGURED wait, so the grace an earlier run promised is the grace a later run enforces. Tests (`tests/cli-hook-hermes.test.ts`): "a retry that adopts a question under an assumed 30s ceiling answers before the ceiling, and leaves the question open" (A with `--harness-cap 300s --timeout 1ms`, then B with `--timeout 4m` and no flag: B denies `hook-timeout` in well under 30s, names the clamped wait, says NOTHING WAS WITHDRAWN, stderr shows the adoption and the clamp line, the log holds one `approval.requested` and no `approval.withdrawn`, `approval queue --json` lists the one pending request, `log verify` clean) and "a retry that adopts a question under an adequate cap still adopts it and waits" (B with `--harness-cap 300s --timeout 1s`: adopts, waits its full 1000ms, no clamp line).

**R2 (serve operators).** `docs/cli-reference.md`'s `serve` section gained a paragraph under `POST /hook/<harness>`: a Hermes tenant behind a `serve` started without `--hook-harness-cap` gets `hook-harness-cap-too-short` on every manual class, with the repair worded for an operator who does not own the tenant's `$HERMES_HOME` (have the tenant raise `plugins.hook_callback_timeout` in the harness's config, then start `serve` with `--hook-harness-cap <the smaller of the two>`), the note that the value is per server so it states the smallest ceiling any fronted tenant runs under, and that the same flag clamps the wait. The Hermes `capRepair` text in `src/cli/hook.ts` now names both routes ("in the harness's config ... pass `--harness-cap` on the hook command, or start `approval serve` with `--hook-harness-cap`") and no longer names `$HERMES_HOME/config.yaml`. The `hook-timeout` row in the reference's deny table, `docs/claude-code-hook.md`'s "three ways a call proceeds" item 1 and `docs/hermes-hook.md`'s effective-window bullets say the wait is clamped rather than warned about.

Invariants: fail closed (a wait the harness would have cut short is shortened by the runtime, so the hook always answers before the harness stops listening); §11.1 invariant 7 unchanged (no code added; `hook-timeout` keeps its meaning, the wait ran out, the question is open); the log is untouched by the clamp and the adopted question's recorded deadline is unchanged.

Validation: build, typecheck, lint clean; cli-hook-hermes, harness-cap-ttl, cli-hook, serve-hook, harness-enum, cli-help: 242/242 after the change, plus the broader hook and docs sweep recorded in the commit.

## Ported from PR #539 (duplicate APRV-423, withdrawn in favour of this branch)

Its `harness_cap_ms` schema cases are kept here, adjusted to this branch's floor (60001) and `dependentSchemas` pairing. `tests/event-schema.test.ts` gained "approval.requested takes a harness_cap_ms that is an integer above the margin, and nothing else": accepts 300000, 60001 and 86400000 on a harness request; refuses 0, 1, 60000, -1, -300000, 299999.5, 0.5, 86400001, "300s", "300000", null, true, an array and an object; refuses a cap with no `execution` and a cap beside `execution: "token"`; and asserts the constraint does not leak onto `approval.expired`, where `appendExpiry` legitimately records the cap that shortened the window. Fixtures under `schema/fixtures/event/`: `valid/approval-requested-harness-cap.json` (ported), `invalid/harness-cap-{zero,negative,fractional,string}.json` (ported), and two new for this branch's rules, `invalid/harness-cap-at-margin.json` (60000) and `invalid/harness-cap-without-harness-execution.json`. `tests/fixtures.test.ts` proves each as filed. PR #539's `withCap(1)` acceptance was dropped on purpose: under this branch 1 ms is below the margin and is refused. event-schema, fixtures, harness-cap-ttl: 276/276.

The seven fixtures reach `conformance/vectors/schema-validation.v1.json`, which is generated from `schema/fixtures`, so `scripts/regen-conformance-vectors.mjs` bumps that suite to **2.8.0** (a MINOR: new vectors, no existing expectation moves; rationale beside the earlier bumps in the script) and the vectors and `conformance-manifest.json` are regenerated. conformance, conformance-regen, fixtures: 265/265.

Orchestrator review (Fable, 2026-09-22). Conformance pass, then adversarial refutation by a fresh Fable subagent (Opus unavailable at the time) given only the diff, the AC and the spec: first pass seven findings (SPEC section 5.2 contradiction, Hermes default ceiling 300 s while hook_callback_timeout defaults to 30 s, a second copy of the window arithmetic in approval queue and Telegram retention, a bundling artefact of the refuter's older base, margin argument overstated, schema floor of 1, contradictory hook-timeout sentence); all code findings fixed with reproducing tests. Recheck found one more: a run whose keys are all adopted waited its full timeout past the cap and only warned; fixed by clamping the wait to what the ceiling leaves, denying at zero after one verified read. Final narrow recheck: no findings; one note that waitMs is clamped to the cap rather than the effective window, harmless because each poll derives expiry first. Ported PR #539's schema refusal cases (schema-validation vectors 2.8.0). Duplicate implementation in PR #539 withdrawn by agreement with the other session. SPEC hunks (sections 5.2 and 6) are proposed in these notes and will ride one attestation batch with 383, 421 and 422 for Carter; SPEC.md is untouched here by design (protected path, human-applied).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The hook states the harness ceiling (--harness-cap; Hermes assumes 30 s unless stated, clamped at its 300 s maximum), records it as harness_cap_ms on approval.requested, and one derivation in core/state.ts judges every lapse against min(policy TTL, cap minus a 60 s margin), so the gate, sweep, carry lookup, queue and channels agree; the hook's own wait is clamped to what the ceiling leaves; a cap with no room for a human is denied hook-harness-cap-too-short; approval serve gains --hook-harness-cap. Verified by 5167-test full runs (22 pre-existing APRV-416 SMTP failures only), targeted suites after each pass, conformance vectors regenerated, and three adversarial passes ending with no findings.
<!-- SECTION:FINAL_SUMMARY:END -->
