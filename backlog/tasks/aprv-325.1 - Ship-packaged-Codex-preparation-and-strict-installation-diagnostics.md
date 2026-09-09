---
id: APRV-325.1
title: Ship packaged Codex preparation and strict installation diagnostics
status: Done
assignee:
  - '@codex-sol'
created_date: '2026-09-09 07:39'
updated_date: '2026-09-09 19:38'
labels: []
dependencies: []
references:
  - docs/codex-boundary-probe.md
parent_task_id: APRV-325
priority: high
type: feature
ordinal: 243000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Deliver the npm-distributed preparation, explicit setup-check and strict doctor surfaces needed for a constrained Codex environment. This is the first implementation slice of APRV-325; it must not claim that installing npm alone creates enforcement or that an absent executor is ready.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A fresh tarball installation contains all required runtime/schema/template/docs assets and runs preparation and diagnostics from the installed path without a repository checkout.
- [x] #2 Preparation emits inert reviewable artifacts; no install script changes trusted hooks, system requirements, accounts, services, credentials or live policy.
- [x] #3 Strict diagnostics reject unknown or unsafe ownership, writable ancestors, symlinks, root overlap, invocation drift, unsupported versions/platforms and missing enforcement components.
- [x] #4 Existing broad MCP does not publish the new activation/execution surface; incomplete broker or runner always yields an explicit not-ready result.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Implement a closed versioned manifest, packaged inert templates, prepare/setup-check/doctor CLI and conservative trust checks in isolated enforcement worktree. Parent settles SPEC and architecture; worker owns nonprotected code/tests/package assets. Validate hostile manifest/path/ownership cases and installed-tarball execution, then parent reviews and delivers.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Parent security review requires literal shell quoting, a pinned absolute Node interpreter, no manifest-selected binary execution before custody validation, distinct non-root principals, and explicit incomplete subtree/ACL confinement findings. Exact SPEC proposal: /private/tmp/aprv325-preparation-spec-bundle/SPEC.diff; manifest SHA256 13438ecf6a01c25b829354f470edc1ddc7f4ed2f6d0df384c004f52eb8e16d6f. Primary gate declaration codex-aprv325-preparation-spec registered seq30138; live approval requested, wait exit6. No SPEC edit occurred. Implementation continues independently; amendment remains pending a real grant.

Correction to prior pending note: the real primary-gate grant arrived at seq30140. The exact reviewed SPEC amendment was applied through the adapter and recorded at outcome30151. The request used draw-daemon-stale/source unavailable, so it was a real human grant, not an unselected live sample. Parent full npm test exited1 with five integration omissions: registry exit-code invariant, human-only registry allowlist, schema conformance coverage, missing valid and invalid codex-instance fixtures. Sol is fixing these before a fresh full run. Readiness remains false; no installation or activation occurred.

Reviewed implementation commit1d7a442 and ordinary main merge113c6c3. Prepared and installed packed tgz outside repository; manifest/schema/template/docs assets and strict fixed shim were exercised. No lifecycle install scripts or live activation. Parent full npm test after five integration fixes:4035total,4034pass,0fail,1skip exit0. Post-main-merge focused integration79/79 exit0; typecheck0, lint0, conformance295/295 vectors143controls exit0, diff0. Protected-path guard against separate records PR365 exit0. SPEC source grant30140/outcome30151; verbatim merge resolution outcome30174. Doctor executes no manifest-selected binary because ACL/subtree custody remains unproven; broker/runner required-not-shipped, all start/serve attempts explicitly not-ready. This completes packaged preparation only; parent325 and broker/runner tasks remain open. Registry publication and host activation have not occurred. GitHub delivery follows this reviewed task record.

PR366 Node 22 shard 3 failed deterministically under npm 10.9.8 because the packed-install fixture promoted each installed transitive to a direct local file dependency; npm 10 ran express-rate-limit's prepare lifecycle despite --ignore-scripts, then exited 127 because its development-only run-s tool was absent. The focused fix copies only the already-installed production dependency closure into a temporary scratch node_modules tree, removes lifecycle scripts from those temporary dependency copies, and points the offline fixture at those copies. The approval-md tgz remains byte-untouched and is still installed outside the checkout with npm install --ignore-scripts, then invoked from that installed path, so the test continues to verify the shipped artifact while preventing unrelated third-party prepare hooks from rebuilding inside the source checkout. Exact Node 22.23.2/npm 10.9.8 stub-runner check: 6/6 pass, exit 0, /private/tmp/aprv3251-node22-npm10-focused.log. Current Node 24.2.0/npm 11.7.0 stub-runner check: 6/6 pass, exit 0, /private/tmp/aprv3251-node24-npm11-focused.log. Build exit 0: /private/tmp/aprv3251-build.log. Lint exit 0: /private/tmp/aprv3251-lint.log. Typecheck exit 0: /private/tmp/aprv3251-typecheck.log. Original CI failure evidence: /private/tmp/pr366-job102404275904-failed.log.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented inert packaged review bundles, exact setup verification, conservative strict doctor and fixed MCP shim, with no automatic installation or enforcement claim. Full suite4034pass/1skip and post-merge79 focused tests passed. Broker and runner remain separate unfinished subtasks; npm publication and host activation remain pending.
<!-- SECTION:FINAL_SUMMARY:END -->
