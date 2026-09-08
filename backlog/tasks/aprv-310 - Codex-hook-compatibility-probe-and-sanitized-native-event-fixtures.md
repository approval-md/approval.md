---
id: APRV-310
title: Codex hook compatibility probe and sanitized native event fixtures
status: Done
assignee:
  - '@codex-sol'
created_date: '2026-09-08 07:23'
updated_date: '2026-09-08 21:12'
labels: []
dependencies: []
references:
  - 'https://learn.chatgpt.com/docs/hooks'
priority: high
type: spike
ordinal: 228000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
User-authorized overnight Codex integration, isolated worktree only. Binding SPEC 6.3,7,9,10,11.1. Code/tests/GitHub now; everyday trust and phone decisions in morning.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Native CLI event fixtures and allow/deny, patch and success/nonzero outcomes are captured using harmless scratch effects.
- [x] #2 Crash, timeout, malformed-output and uncovered-tool behavior are reported honestly; desktop and phone checks remain pending.
- [x] #3 No credentials or personal transcripts enter fixtures; repeatable probe and observed version are documented.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Read current contracts; run bounded scratch-only native probes; sanitize native fixtures; record failure boundaries; parent reviews before adapter implementation.

User resumed and explicitly authorized a one-off trust exception for the reviewed scratch probe. Prepare fresh v4 scratch with the unchanged hash-checked probe, generate argv directly from prepare JSON, retain workspace-write approval mode, and enforce a three-minute process-group deadline. Resolve a fresh primary-gate network.call declaration, execute only on admission, then inspect sanitized native events and control effects. No everyday hooks or trust changes.

Follow-up native probe: test documented identity updatedInput allow form; preserve stable session/tool correlation with domain-separated hash pseudonyms instead of shared placeholders; add an exact denied scratch patch and verify no write. Keep crash/timeout/malformed cases distinct and version-labelled. Never parse output text as trusted outcome status. New hash-reviewed probe invocation requires fresh primary network.call gate grant; existing one-shot scratch trust permission applies.

Astra review adds a required native context check: issue one harmless command with an explicit workdir in a prepared scratch child directory; capture hook process cwd, event cwd and input shape, and verify actual marker location. Establish whether event cwd identifies per-call execution cwd or only the session directory. Count pre/post calls around identity updatedInput to detect repeated rewrite/gate cycles. If execution directory is hidden, escalate architecture before claiming scope-safe integration.

One final bounded dispatch probe is required before any patch-only claim: invoke an exact harmless apply_patch heredoc through shell/unified-exec with a prepared nested scratch workdir, capture whether native canonicalizes it as Bash or apply_patch and whether event cwd identifies the actual target directory. Use a focused single-command probe rather than repeating all controls. Keep direct-patch and shell-dispatched patch evidence distinct.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Synthetic probe harness tests pass (5/5; tsc and node --check exit 0). Native CLI invocation is pending primary gate action codex-overnight-aprv-310-native:probe, requested seq 29873; wait exit 6. No native process has run. Exact argv/payload at /private/tmp/aprv-310-native-payload.json; scratch /private/tmp/aprv-310-native-0.152.1. Invocation uses inline hooks, workspace-write, ephemeral, ignore-user-config, and no hook-trust bypass. APRV-311 independent infrastructure may proceed; native outcome interpretation remains pending.

Live evidence: v2 granted seq29877, approval run exited2 before model/tool invocation because --sandbox and --approve-for-me are mutually exclusive in CLI0.152.1. v3 corrected to --approve-for-me (workspace-write), granted and executed via approval run; CLI exit0, verifier exit1, event_count0. All scratch effects including denied marker occurred, but no hook ran: this is loading/configuration failure, not proof of ignored explicit denial. Output /private/tmp/aprv-310-native-0.152.1/native-cli-v3-output.txt. Read-only root-cause investigation underway; no live trust or everyday config changed.

Native v3 config loader positive check accepted exact inline hook arrays; negative PreToolUse=42 control failed config loading. No hook execution has been demonstrated. User clarification requested for a one-off reviewed scratch hook-trust exception; no trust bypass is authorized or executed yet. Probe remains pending. Script frozen SHA256 ce11e1c0e92cb8f484b928748ea35a7ffb6fd60e9ca677ba10f6d5bcd0057b6d; six synthetic harness tests pass (exit0), and fixtures are explicitly synthetic.

Sanitized probe tooling and documented CLI0.152.1 fixture boundary verified in final full suite (3920pass,1skip,exit0) and CI parity(exit0). Native CLI still invoked zero hooks; no trust exception was executed. AC1/2 remain pending and native outcomes must not be inferred.

Resumed v4: user explicitly authorized the one-off scratch hook-trust exception. Gate grant seq 29893 arrived. First launch refused macOS sandbox initialization before execution (exit 127). Escalated launch kept sandbox enabled but launcher incorrectly read top-level wait.token instead of actions[].token; runtime consumed sealed delivery while the separate sandbox selector retained egress-denied, preventing model connection. Hard deadline ended run with exit 124. This is launch failure evidence, not hook behavior. Prepared fresh v5 scratch and verified argv/prompt match generated metadata; corrected launcher requires the exact action token before execution.

Native v5 CLI 0.152.1 completed exit0 through primary manual grant (execution.started 29899, completed29900). Scratch verifier exit0: 15 events, explicit shell denial left target absent; crash, timeout and malformed handler responses all allowed scratch effects. Bash and apply_patch pre/post events observed. Success and exit7 shell post responses were both empty strings, so outcome closure remains unsafe. Bare explicit allow was shown as hook Failed despite execution; investigate supported identity updatedInput shape before claiming working allow handling.

Native v6 Codex0.152.1: primary execution29904/completed29905 exit0; verifier exit1, solely nested_workdir_exposed=false. Identity allow now reports PreToolUse Completed. Explicit Bash and apply_patch denial leave sentinels absent;18 events preserve pre/post identity and single delivery. Crash/timeout/malformed controls still fail open. Critical: explicit per-call nested workdir is honored by the shell, but Pre/Post event cwd and hook-process cwd both remain session root; tool_input has command only, no cwd/workdir. Therefore session cwd cannot substantiate shell execution directory or relative-path scope. Top-level event key/type evidence has no separate exit status; Bash0/7 post responses remain indistinguishable empty strings. Architecture review required before safe shell activation; source behavior changes paused beyond verified identity allow fix.

Native v7 focused patch-workdir probe completed CLI exit0 (execution29909/completed29910); verifier exit1. Shell/unified-exec apply_patch heredoc with explicit nested workdir emitted one PreToolUse named Bash carrying the full heredoc, no PostToolUse, and wrote the nested sentinel. Event/hook process cwd remained session root and tool_input had command only. This observed route is covered by the conservative Bash pre-event refusal; it did not produce an indistinguishable direct apply_patch event. Direct patch root allow and denial remain separately witnessed by v6. No claim of complete dispatch coverage or automatic outcome closure.

Final reviewed native fixtures match scratch captures byte-for-byte (v5 15 rows, v6 18, v7 1). Probe/adapter focused checks26/26 exit0. Full resumed npm test3928 passed,1 skipped,0 failed (3929 total), exit0; lint/typecheck/conformance exit0,293 vectors and142 controls. Native compatibility verifier failures remain documented findings, not hidden test passes. Source/scripts/tests/fixtures and probe documentation are ready for per-task commit; feature delivery remains draft.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Captured sanitized native Codex0.152.1 shell/direct-patch allow and denial, crash, timeout, malformed-output, directory and outcome contracts with scratch effects. Explicit denials blocked; native failures failed open; Bash effective cwd and trustworthy outcomes remain unavailable. Probe and fixture regressions pass in the full3951pass/1skip suite. Published feature PR344; final delivery tracked in APRV314 and everyday activation in APRV315.
<!-- SECTION:FINAL_SUMMARY:END -->
