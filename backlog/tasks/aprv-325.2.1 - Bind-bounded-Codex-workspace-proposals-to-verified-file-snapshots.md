---
id: APRV-325.2.1
title: Bind bounded Codex workspace proposals to verified file snapshots
status: In Progress
assignee:
  - '@codex-sol'
created_date: '2026-09-09 22:11'
updated_date: '2026-09-09 23:19'
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
- [ ] #1 Closed create, replace, delete and move inputs reject caller authority overrides, malformed or oversized data, aliases, traversal, symlinks, hardlinks and unsupported files.
- [ ] #2 Human-only gate, log and credential paths refuse before preimage reads; permitted distinct path classes retain separate action legs bound to the full proposal and trusted policy digest.
- [ ] #3 Deterministic immutable proposals bind complete bounded preimages and new bytes plus file and parent identities; read-only revalidation rejects observed drift.
- [ ] #4 Adversarial tests pass and documentation states that snapshot checks do not establish OS custody, atomic writes, approval or race-proof enforcement.
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
<!-- SECTION:NOTES:END -->
