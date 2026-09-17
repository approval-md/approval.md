---
id: APRV-311
title: Native approval hook codex shell gating and outcome records
status: In Progress
assignee:
  - '@opus-lane-codex-native'
created_date: '2026-09-08 07:24'
updated_date: '2026-09-17 07:38'
labels: []
dependencies:
  - APRV-310
references:
  - 'https://learn.chatgpt.com/docs/hooks'
  - 'APRV-348 upstream payload issue draft: docs/upstream/codex-hook-payload.md'
priority: high
type: feature
ordinal: 229000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
User-authorized overnight Codex integration. Binding SPEC 6.3,7,9,10,11.1. Isolated branch; no live installation, credential access or deployment. Morning activation remains a separate pending task.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Bash reuses verified gate policy, budgets, waits and grant carryover with Codex actor/harness provenance.
- [ ] #2 Malformed/unexpected input denies; stable ids correlate success/failure reports, duplicates refuse and unknown outcomes append nothing.
- [x] #3 Runtime/schema/registry/MCP exclusion support codex; Claude and Cursor regression tests pass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Probe the installed Codex CLI read-only and record the version and what its hook envelope carries; approval hook classify refuses codex --version as hook-unclassified, so read the @openai/codex package manifest and the reviewed native fixtures instead. 2. Decide AC1 against that evidence: if no envelope variant carries a per-call execution directory, keep the unconditional native Bash refusal, prove the refusal path, and do not check AC1. 3. Give the execution-context refusal its own machine-readable code instead of overloading hook-io, per SPEC 11.1 invariant 6. 4. Fix the post-phase input defect: a malformed or unexpected Codex PostToolUse event currently prints a PreToolUse permission verdict at exit 0; route post-phase input rejection through the post-tool report path with no verdict and nothing appended. 5. Correlate the post-phase diagnostics so every Codex post report names the stable task id the pre half minted. 6. Prove stable-id correlation and duplicate refusal for Codex ids at the gate boundary through the real append path, and say precisely what that does and does not prove while the native contract emits no discriminating success or failure report. 7. Add hook_deny_codes and post_tool_codes to the conformance refusal-union suite and regenerate vectors and manifest. 8. Tests for each, docs/codex-hook.md updated, and Claude and Cursor hook regression suites rerun.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Infrastructure reviewed: strict Bash validation and explicit denies; Codex tool/command/cwd payload plus domain-separated session/call digests preserve loop scope and avoid delimiter/cross-tool collisions; codex provenance/schema/registry/MCP exclusion. Sol focused regression 227/227 exit0 outside socket/sandbox restrictions; latest build and Codex/schema34/34 exit0; lint/typecheck exit0. Native hook outcomes remain unverified; current PostToolUse emits diagnostic and appends nothing. Task and outcome acceptance remain open while APRV-312 proceeds.

Final code df570ea passed npm test3920/3921 with1skip, lint/typecheck,293 conformance vectors, and all3 CI-parity shards plus protected-path guard (all exit0). Codex provenance/schema/MCP exclusion and shared Claude/Cursor regressions verified. AC2 remains pending: success/failure outcome parsing has no native-verified contract; PostToolUse remains diagnostic and append-free.

Native v6 invalidates the previously checked Bash support acceptance: actual per-call workdir is omitted, so current native Bash must be refused. Historical unit results remain recorded, but do not establish safe native operation.

Implemented mandatory early Bash refusal because native execution cwd is omitted. Refusal precedes policy/window/self/carry/start and preserves an already granted token without log change. Direct patch gate retains exact-byte identity updatedInput, budgets, manual/carry/duplicate protections. Post remains diagnostic. Astra final review has no remaining findings; focused adapter/probe26/26 and full npm3928 pass/1skip exit0; lint/typecheck/conformance exit0. Bash support and reliable outcome closure remain acceptance blockers.

Lane 4b (2026-09-16), agent half. Installed Codex CLI probed read-only: @openai/codex 0.152.1, the same version APRV-310 probed, so the blocking native fact is unchanged. For the record, approval hook classify refuses codex --version as hook-unclassified (fail closed: no rule covers the codex binary), so the version came from the installed package manifest at /opt/homebrew/lib/node_modules/@openai/codex/package.json rather than from running the CLI. No Codex process was started and no host trust state or ~/.codex was touched. Envelope, re-read from the reviewed native fixtures rather than re-probed: top-level fields are cwd, hook_event_name, model, permission_mode, session_id, tool_input, tool_name, tool_use_id, transcript_path, turn_id, plus tool_response on the post event; every Bash event in native v6 and v7 carries tool_input keys exactly [command], with no cwd and no workdir, while the event cwd and the hook process cwd both stay at the session root and the shell honours a nested per-call directory. No envelope variant on this version carries a usable execution directory.

AC1 NOT CHECKED. Its clause, Bash reuses verified gate policy, budgets, waits and grant carryover, is impossible on the installed version: a hook that cannot bind the execution directory cannot bind the action, so the unconditional native Bash refusal is kept and the refusal path is what is proven instead (zero gate mutation across autonomous, supervised, manual and human-only policies, under an open window, on gate-self commands, and with an exact unspent grant already in the log). AC1 reopens only when a Codex release exposes the effective per-call working directory.

AC2 NOT CHECKED, and exactly one clause is why. Malformed or unexpected input denies: proven, and now with distinct machine-readable codes on both phases. Unknown outcomes append nothing: proven. Duplicates refuse: proven on the pre side (a second delivery refuses hook-gate-refused) and on the report side through the real append path (already-finished, with one execution.completed in the log). The clause that stays open is stable ids correlate success or failure REPORTS: on Codex 0.152.1 no such report exists to correlate. Exit 0 and exit 7 shell calls both raise the same PostToolUse event with the same empty-string tool_response, the event exposes no status and no exit code, and Codex has no counterpart to Claude Code's PostToolUseFailure, so the event name is not a reading either. Any outcome appended here would be fabricated. The correlation itself is proven against the reviewed native v6 pair (the Pre and Post of one call reconstruct one task id, and every observed Pre has its own), and the duplicate-refusal proof supplies the outcome from the test the way approval report supplies one, which the test's own comment states so nobody reads it as native evidence.

Changes. (1) The Bash refusal has its own code, hook-unsupported-execution-context, instead of borrowing hook-io; the two repairs are opposite (send a well-formed event, versus wait for a harness contract) and a caller could not tell them apart. (2) Defect found and fixed: a malformed or unexpected Codex PostToolUse event printed a PreToolUse permission verdict at exit 0, a permission decision about a call that had already run and indistinguishable from the pre-phase refusal of the same shape. Verified against the built CLI before the fix with an unsupported tool name and with an unstable tool_use_id; both now report post-tool-io on stderr at exit 2, print no verdict and append nothing. (3) Every Codex post-phase line now carries the stable task id the pre half minted, so the execution.started nobody closed is named by its own identifier instead of being grepped for. (4) hook_deny_codes and post_tool_codes join the conformance refusal-union suite (vectors_version 9.0.0), which is what makes the distinction in (1) something a second implementation has to reproduce.

SPEC 11 invariants touched: refusals are machine-readable and distinct (the new deny code, the two conformance unions, the post-phase vocabulary); fail closed (malformed input still refuses on both phases, and the post phase refuses by appending nothing); self-reported fields never reduce scrutiny (tool_response is still accepted and ignored, and no field of the event can turn the Bash refusal into an allow); gate-typed events never accept caller timestamps, unchanged.

Evidence: run-tests --only cli-hook-codex cli-hook gave 142 tests, 142 pass, 0 fail, exit 0; the sweep --only conformance cli-hook cli-hook-cursor cli-hook-codex cli-hook-rewrite cli-hook-scope cli-doctor-codex codex-doctor human-only hook-module-graph gave 229 tests, 229 pass, 0 fail, exit 0. node conformance/run.mjs exit 0 with 302 vectors, 145 controls, manifest ok. build, typecheck and lint all exit 0. Full npm test is CI's.

New tests: Codex post-phase input rejection reports and never prints a permission verdict; Codex derives one stable id for the Pre and Post of the same native call; Codex leaves the outcome open and names the execution.started it did not close; Codex stable ids close their own delegated execution once, and a duplicate refuses.

APRV-348 (lane codex, 2026-09-17) drafted the upstream issue that names the condition for reopening AC1. The draft is at docs/upstream/codex-hook-payload.md and asks openai/codex for three separate things: the effective per-call execution directory on the shell pre-event, an outcome field plus a documented stable call id on the post-event, and an option for a hook to fail closed. Ask one is what AC1 waits on; ask two is what the outcome clause of AC2 waits on. docs/codex-hook.md and docs/integrations-considered.md now both name that issue as the activation condition. The operator posts the issue; the URL lands in APRV-348's notes.
<!-- SECTION:NOTES:END -->
