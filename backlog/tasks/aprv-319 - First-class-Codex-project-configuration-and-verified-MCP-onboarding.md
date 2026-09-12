---
id: APRV-319
title: First-class Codex project configuration and verified MCP onboarding
status: In Progress
assignee:
  - '@codex-sol'
created_date: '2026-09-08 22:43'
updated_date: '2026-09-09 22:25'
labels: []
dependencies: []
priority: high
type: feature
ordinal: 236000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter expects a version-controlled .codex folder and a usable Codex entry point. Ship supported portable project configuration and onboarding for the existing gate through Codex MCP, while keeping unsafe native hook activation opt-in and clearly bounded. Preserve the primary checkout gate, user sandbox settings, trust choices and untracked local carryover.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A committed .codex configuration provides a supported usable Codex MCP entry point with stable agent identity and explicit gate root.
- [ ] #2 Configuration and launcher behavior are verified with the installed Codex parser and scratch MCP discovery/execution, including nested directories and linked worktrees or a tested explicit setup path.
- [ ] #3 No repository configuration weakens native approval or sandbox settings, enables failing-open hooks by default, reads credentials, or impersonates a human.
- [ ] #4 Docs and diagnostics distinguish MCP availability, trust, observed gated operation and known native Bash/outcome limits; tests cover refusals and malformed setup.
- [ ] #5 Reviewed changes and protected-file evidence pass applicable checks and are delivered to GitHub with Codex co-author attribution.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Keep Codex integration voluntary: project config exposes only the existing optional stdio MCP server and preserves native approval, sandbox, trust, apps/plugins, remote-control, and hook defaults. 2. Install the reviewed launcher and README as new policy.edit files, and add only the codex:mcp package script by an exact whole-file Edit; parent reviews and executes separate primary-gate drivers, while .codex/config.toml remains a human-only policy.core copy and organ attestation. 3. Resolve nested and linked worktrees from Git's common directory, execute the active worktree cli.js, and pin every gate subprocess cwd, policy, log, and payload custody to the primary checkout with actor agent:codex-mcp. 4. Add tests/codex-project-config.test.ts for safe config keys, package wiring, non-repository refusal, linked-worktree path/argv binding, spawn failure, signal forwarding, and child exit propagation. 5. Parent applies protected payloads, human installs and attests exact config bytes, then verify installed Codex parsing, real MCP discovery/instructions, focused tests, build, lint, typecheck, full suite, protected-path evidence, and GitHub delivery. Ownership: Sol owns only the ordinary test and APRV-319 task record in this tree; parent owns .codex/package/config writes, gate operations, review, commit, push, PR, and merge.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Researched delivery against fresh worktree /private/tmp/approval-project-codex-config at 7050881a. Reviewed current proposal retains voluntary MCP semantics and makes no whole-session enforcement claim. A separate exact delivery bundle will bind new-file writes for .codex/approval-mcp.mjs and .codex/README.md plus a whole-current package.json Edit; config.toml remains outside agent write authority.

Prepared reviewed protected delivery proposal at /private/tmp/aprv319-delivery-bundle without registration or execution. Manifest SHA-256 025988d911a5f57544e654175c2506ed6dc7ebc109efb52053ba3c1c52c76fc4. Canonical action payload hashes: launcher 0271dfc2aed0f1e0aa315e14edb9e5cfddc2ba3d16d0d481cdf8f6676c537560; README 8325366ba43823395f97038342067c745f22ec3b1855adb412fe39edf438db7f; package b8da4840a529cef42e9810495face58e75440e5936b767d673cd771a4e41dc6d. All three prepare-only driver validations and syntax checks exited 0; SHA256SUMS verification exited 0. The rule string binds cwd and new_target_root as reviewed metadata while the driver checks exact manifest/root/target paths; it grants no authority. Copied the byte-reviewed test proposal to tests/codex-project-config.test.ts (SHA-256 2c2b8dd006b9e2353d00be9d6027e59716c71e3543f987dff26c08f194616a8b). Focused execution in this tree remains pending parent application of the protected launcher, README and package payloads plus separate human config installation.

Actual support files installed through parent gate evidence: README outcome30258, package outcome30266, launcher outcome30277. In /private/tmp/approval-project-codex-config, build exit0, lint exit0, typecheck exit0; six config-independent compiled launcher tests passed6/6 exit0. A real read-only stdio MCP SDK handshake launched the package script from nested src/core, listed36tools, found and successfully called instructions, fixed actor agent:codex-mcp and primary cwd /Users/carter/dev/approval-md, exit0. No side-effecting MCP tool, config install, organ attestation or log action was performed by this validation. Human config ceremony and integrated config/full-suite evidence remain pending.

Correction after the old launcher task identity collided at seq29994: the final fresh launcher declaration is codex-aprv-319-launcher-current, action key codex-aprv-319-launcher-current:0271dfc2aed0f1e0aa315e14edb9e5cfddc2ba3d16d0d481cdf8f6676c537560, and superseding delivery manifest SHA-256 a3e2a04ead3f2ab56c87604206dd04dfa5d7de84b8aca7771d92d96080cc03bf. Its prepare validation exited0 before parent registration/execution; launcher outcome30277 records the final action. The earlier 025988d9 manifest is historical and must not be reused.

Final integrated verification after the human-owned project config installation: .codex/config.toml SHA-256 af5e3218df1277aae52ab250da759125d00d73a713427f90a09bfaff450eeb9c; primary organ attestation seq 30313, event hash 5cc6b1d6e823d0842baf98439d65c49d971516b6c5e503f54a46165efd61ff7e. In /private/tmp/approval-project-codex-config, npm run build exited 0 (/private/tmp/aprv319-integrated-build.log); all 7 tests in tests/codex-project-config.test.ts exited 0 (/private/tmp/aprv319-integrated-config-tests.log); npm run lint exited 0 (/private/tmp/aprv319-integrated-lint.log); npm run typecheck exited 0 (/private/tmp/aprv319-integrated-typecheck.log). The first sandboxed full npm test attempt was interrupted with exit 130 after loopback listeners conclusively failed with outer-sandbox EPERM (/private/tmp/aprv319-full-npm-test.log). The identical authorized unrestricted env -u APPROVAL_HUMAN npm test rerun exited 0: 4,039 tests, 4,038 passed, 1 skipped, 0 failed, duration 441108.431542 ms (/private/tmp/aprv319-full-npm-test-unrestricted.log). Existing parser and read-only MCP handshake coverage was not redundantly repeated beyond the integrated 7-test suite. Voluntary MCP setup does not gate Codex built-in tools and makes no enforced-session claim.
<!-- SECTION:NOTES:END -->
