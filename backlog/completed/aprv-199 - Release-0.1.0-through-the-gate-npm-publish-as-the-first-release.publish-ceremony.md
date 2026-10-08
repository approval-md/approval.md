---
id: APRV-199
title: >-
  Release 0.1.0 through the gate: npm publish as the first release.publish
  ceremony
status: Done
assignee:
  - '@fable'
created_date: '2026-09-01 18:46'
updated_date: '2026-09-08 04:38'
labels:
  - release
  - dogfood
dependencies:
  - APRV-198
  - APRV-194
  - APRV-224
priority: high
ordinal: 165000
approval:
  origin:
    app: manual
    created_by: 'agent:fable'
  route:
    assignee: 'agent:fable'
    rationale: 'the 0.1.0 release ceremony Carter ordered on 2026-09-08: the agent prepares, requests and executes on a grant; the human decides go or no-go on the phone (APRV-199 AC2..AC4)'
  state: proposed
  actions:
    - class: release.publish
      summary: 'npm publish approval-md@0.1.0 from /Users/carter/dev/approval-md (payload is the argv and cwd; run recomputes the hash before it spawns)'
      reversible: false
      est_cost_usd: '0'
      idempotency_key: 'aprv-199:publish:2026-09-08'
      payload_hash: '3d2fb7d3e8b83e223c134f1b9ae1ec17e8bd9c8cd6886a6cb3220e1b7b70d4bd'
    - class: release.publish
      summary: 'git tag -a v0.1.0 -m "approval-md 0.1.0" in /Users/carter/dev/approval-md, after the publish succeeds'
      reversible: true
      est_cost_usd: '0'
      idempotency_key: 'aprv-199:tag:2026-09-08'
      payload_hash: 'e9660ec161a65dafc0c6be47e92a68ba115e091cb37654eaaff8af34a648617e'
    - class: release.publish
      summary: 'git push origin v0.1.0 from /Users/carter/dev/approval-md (declared release.publish: the classifier reads a tag push as vcs.push.branch, APRV-305)'
      reversible: false
      est_cost_usd: '0'
      idempotency_key: 'aprv-199:tag-push:2026-09-08'
      payload_hash: '633b1e302bc890c2ebff7cfb12716f1ca47616b1fc3ea2bba07f39905f2820a8'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Every SPEC section 14 milestone (M0 to M8) has shipped, package.json already reads 0.1.0, and the log verifies clean. The launch itself is one action in the release.publish class (manual in the repo policy): npm publish, run from the primary checkout through the envelope flow (approval register, request, wait, run) with the granted sealed token, so the first public release of approval.md is approved via approval.md. The same grant is a real manual-class action and doubles as the end-to-end sealed-delivery proof APRV-166 AC3 still needs. This task carries the preconditions a stranger installing the package would notice; the decision to run it is the human operator's.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Preflight recorded: npm pack --dry-run contents reviewed (files and bin fields; no .approval, backlog, or private material shipped), README front page current, LAUNCH.md or CHANGELOG carries the 0.1.0 line
- [x] #2 Envelope on this task: register, request, wait, run for npm publish from the primary checkout; grant seq and execution seq recorded in the notes; no human relayed a token (APRV-166 AC3 evidence)
- [x] #3 v0.1.0 tag pushed through its own gated action and the package installs on a clean machine under the published name; verified and recorded
- [x] #4 The human decides go or no-go; the agent prepares and never triggers the publish
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Preflight (AC1, agent work): package.json files whitelist reviewed (cli.js, dist, schema, docs/cli-reference.md, SPEC.md, README.md; no .approval, backlog, .claude, journal or proposals ship; no .npmignore needed); npm pack --dry-run is unclassified by the hook, so the whitelist is the evidence and Carter runs the dry-run once by hand before the tap. Write CHANGELOG.md with the 0.1.0 line. README front page gains the values/feedback verbs (APRV-237..240) so the shipped surface is current.
2. Ride the aprv-276-278 stack: APRV-276 (drift check before token spend), APRV-277 (runbook PATCH, listener 400), APRV-278 (ambient-bleed false positive) land in the same PR so there is one merge before the publish.
3. AC2-AC4 are Carter's: envelope on this task, register/request/wait/run npm publish from the primary through the gate, tag v0.1.0 through its own gated action, install on a clean machine, go/no-go.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Preflight (fable, 2026-09-06, branch aprv-276-278-agentmail-release-stack): package.json ships by whitelist only (cli.js, dist, schema, docs/cli-reference.md, SPEC.md, README.md), no .npmignore needed; .approval, backlog, .claude, .approval-journal and docs/proposals cannot ship. npm pack --dry-run is unclassified by the hook for an agent, so Carter runs it once by hand before the tap and pastes the file list. CHANGELOG.md created with the 0.1.0 line (unreleased until the tag). README front page gains a section on approval values / approval feedback; tests/docs-guard passes. Riding the same PR as APRV-276/277/278 so one merge precedes the publish.

AC1 closed 2026-09-08: Carter's npm pack --dry-run reviewed (LICENSE and NOTICE present; dist/tests was shipping, fixed in PR #329 so the whitelist is dist/src); CHANGELOG carries the 0.1.0 line; README current. Envelope added to this file with three release.publish actions: aprv-199:publish (npm publish), aprv-199:tag (git tag -a v0.1.0), aprv-199:tag-push (git push origin v0.1.0, declared release.publish because the classifier reads a tag push as vcs.push.branch, APRV-305). Payloads are {argv, cwd} with cwd /Users/carter/dev/approval-md; hashes in the envelope.

The ceremony, 2026-09-08 (all requests by agent:fable, all grants by human:carter on Telegram, all executions on sealed tokens opened by approval run on this machine; no human relayed a token, APRV-166 AC3 evidence):
- aprv-199:publish: requested seq 29600, granted 29604, execution.started 29613, execution.failed 29614 (exit 1). npm refused EOTP: since late 2025 npm demands a second factor on every direct publish from a 2FA account in any mode, and a gated child cannot answer a passkey. The token was spent by the attempt, so the retry is APRV-306.
- aprv-306:publish (same argv and cwd, new key, after Carter set a package-scoped bypass-2FA granular token in his npmrc): requested 29672, granted 29676, execution.started 29681, execution.completed 29682. `+ approval-md@0.1.0`; npm view approval-md shows version 0.1.0 and bin { approval: 'cli.js' } (npm normalised './cli.js' and worded it as a removal; the registry entry is intact). Tarball 1.7 MB, 522 files, shasum a45937a982e1d289d2bd9111336c53e8f71fb793.
- aprv-199:tag: requested 29691, granted 29696, execution.started 29704, execution.completed 29705. Tag v0.1.0 on 78baf52 (main at the time).
- aprv-199:tag-push: requested 29708, granted 29713, execution.started 29719, execution.completed 29720. refs/tags/v0.1.0 on origin at 94d19b7.
- approval log verify after the push: clean, 29727 records; the one standing anomaly is the long-known seq 2957 timestamp regression.
Decided along the way: the bypass token is a one-release measure and is deleted after the tag push; APRV-307 (Trusted Publishing) retires it. The Backlog CLI strips an approval: envelope from a task file, so this file and APRV-306's are edited directly from here on. Global invariants touched: none weakened; §11.1 invariant 7 held (the OTP path was rejected precisely because a code in argv would have been shown on the phone and written to the log).

AC3 closed 2026-09-08: from /tmp, `npx -y approval-md@0.1.0 --version` fetched the package from the registry and ran the `approval` binary (it printed the usage, since the CLI has no --version command; APRV-308 filed for that). Task Done.
<!-- SECTION:NOTES:END -->

2026-09-12 clarification: the current release ceremony is a gated annotated tag, a separately gated tag push, then protected-main publish.yml using npm Trusted Publishing; the bypass-token procedure above is historical and retired.
