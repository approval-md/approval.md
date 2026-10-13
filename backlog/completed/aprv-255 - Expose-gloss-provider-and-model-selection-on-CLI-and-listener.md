---
id: APRV-255
title: Expose gloss provider and model selection on CLI and listener
status: Done
assignee:
  - '@codex'
created_date: '2026-09-04 22:00'
updated_date: '2026-09-05 09:55'
labels: []
dependencies:
  - APRV-253
type: feature
ordinal: 196000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Task C of approved Codex gloss stack; integrate task B runner and preserve current defaults. Own CLI channel/up wiring, help, docs and dedicated option tests. Existing Claude APRV-218 and active adapter/values work overlap shared files: defer those edits until relevant changes land and integrate against refreshed baseline. Same feature PR with per-task commit. Binding SPEC 3,9,10.3,11.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 up, channel telegram listen and channel cli accept --gloss-provider claude|codex and --gloss-model; Codex requires explicit nonblank model and invalid options fail as usage.
- [x] #2 Existing Claude Haiku and enablement defaults and no-gloss are preserved; operator selects provider and no fallback occurs.
- [x] #3 CLI and Telegram display correct unverified provider/model provenance; docs give complete examples and explain failure and isolation limits.
- [x] #4 Option, compatibility and rendering tests pass with fake providers; full suite, lint and typecheck pass after integrating active Claude changes.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Implement isolated provider/model option validation and factory with dedicated tests after reviewing APRV-253 contract and APRV-254 factory. 2. Defer shared channel/up/help/docs edits while Claude ownership overlaps; recheck remote PRs and land those edits only after relevant branch delivery. 3. Preserve current enablement defaults and no-gloss precedence; reject invalid or missing Codex model as usage. 4. Integrate on refreshed main, document available isolation limits, run rendering and full stack checks and deliver the task stack as one PR.

APRV-218 merged as PR 257 at origin/main 1c3aced and was merged into this feature branch. Resume channel.ts, channel-telegram.ts and up.ts with early semantic option validation, existing enablement defaults, scrubbed selected-provider factory and fixed diagnostics; preserve exported glossWiring compatibility. Add dedicated fake-provider integration tests. Help, README and CLI reference remain deferred behind active Claude adapter work; prepare an unapplied patch for later integration.

2026-09-05 integration dependency verified resolved: origin/main contains Claude coverage/help/documentation commits 57ed88c and 79ebfd7. Refreshed isolated delivery branch to main 4a3ed0b and restored the prepared C source without conflicts. Apply the reviewed docs/help patch, document saved CLI authentication and its subscription/API billing distinction, then build, run focused and full fake-executable suites, lint, typecheck and documentation checks. Final review compares only our task stack against current main.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented all three entrypoints with early provider/model validation, preserved enablement, no fallback, credential scrub and safe diagnostics. Direct CliChannel/renderTelegram tests verify requested Codex attribution, unverified marker, escaping, original request preservation and unchanged canonical payload/hash. Focused suite 25/25 plus build/typecheck/lint/diff check exit 0. Shared help, README and CLI reference patch is prepared and apply-check passes, but remains unapplied: user is choosing whether to relax the original wait-for-Claude-merge requirement after hunk inspection found disjoint sections. Full source suite and critical review are running; task is not complete or shipped.

Handoff checkpoint: implementation worktree /private/tmp/approval-codex-gloss, branch codex/codex-gloss, HEAD 069d400b0572c5e0b01310a30f942e7443f61794. APRV-255 entrypoint changes, options module and integration tests remain reviewed local changes; README, CLI reference and help patch remains unapplied at /private/tmp/aprv255-docs-help.patch pending the explicit concurrent-Claude coordination choice. Integrated npm test finished exit 0: 3187 passed, 1 skipped, no failures or cancellations. Focused 25/25; build, lint, typecheck and diff check exit 0. Astra critical review found no code blocker. Clean delivery worktree /private/tmp/approval-gloss-delivery on codex/gloss-provider-stack contains reviewed A commit 38e8175 and B commit a093ab9, pushed in draft PR https://github.com/approval-md/approval.md/pull/262. Next: resolve shared docs ownership constraint, integrate C as its reviewed commit, complete corrected gated live smoke and verify final CI before arming feature merge. No deployment, listener restart or edits to concurrent sessions.

Current handoff: /private/tmp/approval-gloss-delivery, branch codex/gloss-provider-stack, HEAD 94f7e14c9e1beaa509e60634734ba23e8f14acd1. C source and CLI-authored task from implementation commit f804936 are staged here without final commit; the original implementation branch is preserved. Assembled A-C build, focused 25/25, typecheck, owned-file lint and both staged/whole-stack diff checks exit 0 after the live runner fix. B synthetic smoke now succeeds in 4296 ms and is pushed in PR 262; no new model call is pending. README/docs/cli-reference/src/cli/help patch remains unapplied because Claude coverage changes are committed on aprv-245-coverage but not delivered to main. Explicit earlier coordination question remains unresolved. Next: once that constraint clears, apply/reconcile the prepared documentation patch, finish the C commit, update final AC evidence, and verify/arm PR 262. No other sessions or live services modified.

Final integration completed in /private/tmp/approval-gloss-delivery on codex/gloss-provider-stack after the overlapping Claude commits landed. Applied README, CLI reference and all three help updates; clarified selector versus enablement, preserved default enablement and terminal-token guidance, and documented saved authentication and conditional billing. Final npm test passed with exit 0: 3426 passed, 1 skipped, zero failures or cancellations. The first sandboxed full attempt failed localhost listen permission and was stopped; the host-permitted retry passed with fake model binaries. Focused A-C 25/25 and docs/help 43/43 passed; build, lint, typecheck and diff checks passed. Independent final review approved the integrated behavior and documentation. No policy/schema/dependency additions, live listener configuration or service restart. Final task-scoped source commit and PR262 merge follow this completed verification.

Final main refresh added upstream checkpoint prompts. Resolved the sole channel.ts conflict by retaining both glossRunner(selectedGloss.options, policy, streams) and the checkpoint argument; no upstream behavior was removed. Post-merge build, 91 targeted provider/checkpoint/help/documentation tests, lint, typecheck and diff checks all exit 0. The prior full npm test result remains the local full-suite evidence; final PR and merge-queue CI validate the refreshed head.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Exposed provider/model selection on up, Telegram listener and CLI channel while preserving Claude/Haiku and enablement defaults. Added compatibility, option validation and real-renderer provenance tests plus complete operator examples and authentication/isolation guidance. Full suite: 3426 passed, 1 skipped; focused 25/25 and docs/help 43/43 passed, with lint/typecheck and independent review clean.
<!-- SECTION:FINAL_SUMMARY:END -->
