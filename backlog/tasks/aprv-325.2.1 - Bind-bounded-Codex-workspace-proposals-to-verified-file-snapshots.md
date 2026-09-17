---
id: APRV-325.2.1
title: Bind bounded Codex workspace proposals to verified file snapshots
status: Done
assignee:
  - '@codex-sol'
created_date: '2026-09-09 22:11'
updated_date: '2026-09-17 01:59'
labels: []
dependencies: []
documentation:
  - docs/codex-workspace-planner.md
modified_files:
  - src/codex/workspace-plan.ts
  - tests/codex-workspace-plan.test.ts
  - docs/codex-workspace-planner.md
parent_task_id: APRV-325.2
priority: high
type: feature
ordinal: 246000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Build the read-only proposal planner needed before an executable workspace broker. This unit validates bounded typed operations, derives path classes and binds observed bytes without exposing an endpoint, writing workspace files, or claiming confinement.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Closed create, replace, delete and move inputs reject caller authority overrides, malformed or oversized data, aliases, traversal, symlinks, hardlinks and unsupported files.
- [x] #2 Human-only gate, log and credential paths refuse before preimage reads; permitted distinct path classes retain separate action legs bound to the full proposal and trusted policy digest.
- [x] #3 Deterministic immutable proposals bind complete bounded preimages and new bytes plus file and parent identities; read-only revalidation rejects observed drift.
- [x] #4 Adversarial tests pass and documentation states that snapshot checks do not establish OS custody, atomic writes, approval or race-proof enforcement.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Implement internal src/codex/workspace-plan.ts and tests/codex-workspace-plan.test.ts on merged APRV317 baseline. Accept strict relative NFC POSIX paths and canonical base64, with 64 operations, 1024-byte paths, 1 MiB per image and 8 MiB aggregate. Classify before reading protected preimages; use bounded no-follow nonblocking descriptor reads and metadata binding. Preserve each distinct class action, mark reversible false, bind one full deterministic payload. Add read-only revalidation and adversarial tests. No CLI/MCP surface, execution, credentials, log writes or protected configuration changes; OS-exclusive write custody remains prerequisite for future broker exposure.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented the internal read-only planner with a strict four-operation language, agent-only trusted actor shape, canonical bounded base64, path and endpoint conflict validation, policy-first classification, bounded no-follow file reads, complete file/root/ancestor identity binding, deterministic per-class action legs, deep immutability, and full snapshot revalidation. The parser charges the 8 MiB aggregate before decoding each after-image; filesystem reads use the remaining aggregate budget before allocation. Directory spelling checks use bounded iteration capped at 4,096 entries. The documentation states that trusted context is an assertion, built-in classification is not arbitrary secret discovery, and path snapshots do not establish adversarial rename confinement or OS custody. Focused validation: build, 13 adversarial tests, lint with deny-warnings, and typecheck all exited 0. No endpoint, mutation, authorization, credential, log, or provider path was added; the future broker still requires protected context and exclusive write custody.

Broad-suite evidence is intentionally not claimed as passing. The sole full npm test attempt stalled in the pre-existing daemon-advance-adopt test under full-suite load and was gracefully terminated, exit 143; durable log: /private/tmp/aprv32521-full.log. That test process had no remaining fixture child and retained an open daemon or server handle. A bounded isolated rerun with a hard 60-second timeout passed all 7 cases in 16.83 seconds, wrapper exit 0; log: /private/tmp/aprv32521-daemon-adopt-isolated.log. Inspection found that the existing async test closes its daemon and mock server only on its success path, so a load-sensitive timeout or assertion can leak both handles indefinitely. No unrelated test source was changed.

After APRV-328 repaired the unrelated daemon adoption test cleanup leak, the unchanged final planner head completed the full suite: 4,097 passed, 1 skipped, 0 failed, exit 0 in 544.96 seconds. Durable final log: /private/tmp/aprv328-full-final.log. This final result supersedes the earlier interrupted exit-143 runs; those remain recorded as non-passing diagnostic evidence.

Final review caught and repaired one UTF-16 edge case after the recorded full run: a trailing unpaired high surrogate produced NaN from charCodeAt and previously passed the low-surrogate range comparisons. hasWellFormedUtf16 now requires an in-bounds following code unit. Added explicit trailing-high-surrogate refusals for both path and agent actor input. Final-head focused planner tests remain 13/13 passing; build, lint with deny-warnings, typecheck and diff check all exit 0. The prior 4,097-pass full suite remains historical evidence for the immediately preceding head; broad CI or the coordinated final full run is still required for these final bytes.

Closeout verification (lane/closeouts, 2026-09-16). Source is on main: PR #380 MERGED at aebb204fb5a181ffc81d58da75cdfb7805e2b619, PR CI run 34416802253 green on ci, all three node-22 full-gate shards, protected paths and classify tier; merge-commit run 34418188770 success.

Re-ran the adversarial suite from a clean worktree at merged main: node scripts/run-tests.mjs --only codex-workspace-plan, wrapper exit 0, tests 13 / pass 13 / fail 0 (/tmp/lane5.log). The thirteen cases are the AC evidence, one to one. AC1: closed-operation binding, the exact 1 MiB canonical base64 boundary, malformed and noncanonical base64 with aggregate overflow, unknown fields/kinds/over-64 operations plus non-agent contexts (the caller-authority override refusal), ambiguous/non-NFC/malformed-Unicode/escaping paths, duplicate/case-aliased/overlapping/chained endpoints, and missing or aliased parents, existing destinations, symlinks, hardlinks and directories. AC2: human-only built-ins and routed classes refused before endpoint inspection, and one sorted action leg per distinct permitted endpoint class, each bound to the full proposal and the trusted policy digest. AC3: the four-operation binding case plus expected-hash and combined-size checks, and revalidation refusing content, context and intermediate ancestor identity drift, with a symbolic workspace root rejected outright.

AC4 had one real gap, now closed. The adversarial tests passed, and docs/codex-workspace-planner.md already stated that the path snapshots do not establish OS custody or confine hostile concurrent renames, and that a future broker must retain exclusive write custody and authorize every leg. It did not state the atomic-write half of the criterion. Rather than check AC4 on three of its four clauses, this closeout added a short explicit list to the end of that document naming all four things a plan is not: not OS custody, not an atomic write (the planner writes nothing, and a broker applying legs one at a time could still stop halfway), not approval (classification names a class and mints no grant or token), and not race-proof enforcement (revalidation reports the state it observed when it looked). Documentation only, no source change. Verified: build exit 0; docs-guard plus codex-workspace-plan 29/29, fail 0, exit 0.

Closeout delivered in pull request #414 (lane/closeouts).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Delivered the read-only Codex workspace proposal planner (src/codex/workspace-plan.ts): a closed create/replace/delete/move language, agent-only trusted context, canonical bounded base64, policy-first classification that refuses human-only endpoints before any preimage read, bounded no-follow reads with full file/parent/root identity binding, one deterministic action leg per distinct permitted class bound to a single payload hash, deep immutability and read-only revalidation that rejects observed drift. No endpoint, writer, credential or log path was added. Merged in PR #380 (aebb204); PR CI 34416802253 and merge CI 34418188770 green. Verified at merged main by the 13-case adversarial suite (13/13, exit 0), and AC4's documentation clause completed by stating the atomic-write limit alongside the custody, approval and race-proof limits already documented (docs-guard + planner 29/29, build/typecheck/lint exit 0).
<!-- SECTION:FINAL_SUMMARY:END -->
