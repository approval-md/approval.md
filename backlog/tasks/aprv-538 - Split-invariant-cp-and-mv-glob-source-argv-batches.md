---
id: APRV-538
title: Split invariant cp and mv glob source argv batches
status: In Progress
assignee:
  - '@codex'
created_date: '2026-11-26 07:09'
updated_date: '2026-11-26 08:18'
labels: []
dependencies: []
ordinal: 409000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Bound synthetic argv classification for large cp/mv pattern expansions while preserving all guarded-path and credential classes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 All cp/mv cost cases assert less than 100 CPU ms on Node 20 and Node 22; the three formerly PRINT_ONLY lines each measure a Node 20 median at most 80 CPU ms. Every cp/mv shape asserts 4000-character median cost at most 2.6 times its 2000-character median; control ratios are printed without a bound.
- [x] #2 Only pattern-expanded source operands are partitioned; options, target-directory values, actual destination and operand arity are preserved.
- [ ] #3 Equality, true-class and glob comparison sweeps have zero looser outcomes against source baseline6390d987 and current main170229db; relevant checks pass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Partition expanded cp/mv source operands only with a conservative option grammar and fixed destination. 2. Memoize the plain partition only when inEveryReading proves invariance; judge other sources per reading and fall back otherwise. 3. Add semantic regressions, restore all cost assertions, run Node 20/22 cost tests and the three supplied comparison sweeps, then hand off for independent review.

Lead63735 local-only continuation: run main170229db with the identical npmtest runner/default Node26/localbind escalation and600s cap, compare actual six assertion messages and expected/actual values against retained candidate terminal124; keep timeout cancellations separate. If baseline cannot reach a failing file or candidate-only failure remains, bounded paired focused checks for those exact files and touched-file contribution only. Equal failures are baseline; READY-LOCAL can follow matched evidence, while full CI awaits Carter push authorization. No publication or unrelated fixes.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
WIP checkpoint 2026-11-25: conservative cp/mv expanded-source partition retains options and actual destination in both argv lines; plain expanded sources are judged once only after inEveryReading proves invariance. Nonexpanded sources stay in the remaining-source line. Expanded option markers and unsupported flags fall back to the whole argv. Added semantic cases for positive plain-name classes, pattern destinations, -t before/after operands, literal/expanded -- and option fallbacks. Restored every absolute 100 CPU ms assertion and ratio18 assertion; no acceptance criteria checked. Build/typecheck/lint/conformance pass (994 vectors,314 controls); equality sweep against source baseline6390d987 gives2584/2584 identical, zero looser. Node20 cost remains red: cp source22.37, Hermes cp source24.24, Hermes mv source18.19; all absolute cases below100ms. Node22 final cost, full npm test, true-class and glob sweeps still running. Current-main comparison and independent critical reviews remain outstanding. This is an explicitly incomplete draft checkpoint, no merge or task closure.

Incomplete WIP: source split implemented with fixed destinations and conservative option fallback; semantic regression passes. Build/typecheck/lint/conformance pass (994 vectors). Equality6390d987:2584/2584 equal, zero looser. Node20 and22 cost ratios still fail18: Node22 cp20.96, Hermes cp23.70, Hermes mv19.78; every absolute case below100ms. True-class/glob and full npm test still running; current-main comparison and independent reviews outstanding. No AC checked, no merge or closure.

Authorized local-finish decision (lead63725 and cost-owner build5 ANSWER63727): freeze bf196b51 source algorithm, replace cp/mv ratio18 assertions with per-shape 4000/2000 median growth<=2.6, retain100ms assertions, and require<=80ms Node20 measured medians for the three formerly PRINT_ONLY lines. Control ratio remains diagnostic. No network publication authorized. Fresh sweep and terminal test receipts underway in codex/evidence/argv-split-20261125/localfinish.

Corrected-source milestone at local8bfca65a: independent refutation reproduced nonadditive Git sure-target semantics under ENOTDIR, including symmetric plain-protected-source case. Conservative fallback to whole argv whenever either mixed partition earns vcs.history.rewrite closes both; cp/mv regressions pass. Parent and independent source reviews closed findings at hook SHA256221ff47c44c66b0d539738c31e98c439df7302aefc0586e1afdc349a0014be98. Node20 and22 hook-glob-cost each11/11 exit0; Node20 former PRINT_ONLY medians cp destination2000=60.8ms, cp source2000=66.2ms, Hermes cp source20000=70.6ms, all<=80; all absolute100 and all8 growth2.6 assertions pass. Build/typecheck/lint/conformance(994vectors314controls)/protected check exit0. Fresh corrected equality2584 exact and glob10989cases11769cells exact against6390d987 and170229db, zero looser. Evidence under codex/evidence/argv-split-20261125/localfinish with terminal exit files. Trueclass base520/520 PASS complete; main/split fresh independent tables ongoing in tt-parallel. Full npm test bounded escalated600s ongoing; sandbox run rejected local binds and was intentionally stopped exit143. AC3 remains pending until all required terminal checks complete; no READY-LOCAL or publication.

Final local handoff: all corrected-source comparison sweeps are terminal0 and exact against BOTH6390d987 and live-parent-verified170229db: equality2584/2584, trueclass520/520 with every expected denial PASS, glob10989cases11769cells; zero differences and zero looser. See localfinish/true-final-verified.json, true-compare-{base,main}-parallel.txt and eq/glob compare files ending-fixed.json. Source unchanged at8bfca65a; independent integrated conformance/refutation closed both ENOTDIR seams. Full npm test gate remains BLOCKED: bounded escalated run600s exit124,6919tests,6859pass,6fail,41cancelled,12skip,1todo. Failures: Git followup expected guarded class missing; four daemon/watch timing assertions; sandbox-read-jail synthetic build255. Targeted Git followup fails identically on6390d987 and corrected source (both exit1), confirming preexisting failure for literal cp g/config /tmp/c. Other failures unresolved; no environmental waiver or unrelated fixes. Parent directs no broad rerun; AC3 remains unchecked and task In Progress. No READY-LOCAL, push, PR, merge or deployment. All owned verification processes finished/stopped with receipts; leave other seats processes alone. Lead disposition of full-suite gate is the next action.

Matched baseline suite launched in detached real Git worktree localfinish/main-suite at170229dbbed40588fbddf7e0bddc7ece1a092985, preserving archive fixture. Same npmtest, Python timeout/kill-group wrapper600s, Nodev26.8.2 /Users/carter/.hermes/node/bin/node, npm11.19.1, dependency realpath and execution-tool environment/localbind escalation. Original complete environment was not snapshotted; identity evidence and hashed selected env settings are in matched-suite-environment.json. Source/test and prior costs/sweeps/reviews unchanged; waiting for actual baseline terminal evidence.

Lead63735 matched comparison complete, source unchanged. Matched main170229db full suite selected312files with same Node26.8.2/npmtest/dependencies/localbind escalation/cap600s, terminal124:7680tests7651pass9fail7cancel12skip1todo. Retained candidate terminal124:6919tests6859pass6fail41cancel12skip1todo. Five original assertions exactly match main messages+actual/expected/operator/code: Git guarded-class delta, lock/swap/Finder watch timeouts, sandbox build255vs0. Idle-daemon assertion differs: candidate2ticks vs1, main external-append timeout. Bounded paired daemon-only runner--only daemon,600s caps: candidate exit1/44tests39pass5fail0cancel; main exit1/44tests42pass2fail0cancel. Idle test PASSES both; other watcher assertions vary (both lockfile2vs1, backup/tick/Finder/swap outcomes recorded exactly). Full main adds listener-exit timeout and backup/tick watcher failures. Do not call all6 identical. All full/focused failure lists, messages/values, raw diagnostics, terminal exits and cancellation lists are in localfinish/MATCHED-SUITE-COMPARISON.md and matched-full-suite-comparison.json. Environment snapshot limitation preserved in matched-suite-environment.json; identical runner/package/failing-file SHA256s in matched-suite-files.json. Scoped source review: only runtime diffs vsmain are hook/git-directory classifier helpers; daemon/request/watcher/sandbox implementations and test files unchanged, no classifier call in observed daemon idle path. No dynamic causal proof or waiver; variable watcher outcomes unresolved. Parent directs stop further runs/fixes: residual gate is lead disposition of unmatched full idle assertion and variable untouched focused outcomes under63735. AC3 remains unchecked/In Progress; READY-LOCAL withheld, no push or publication.
<!-- SECTION:NOTES:END -->
