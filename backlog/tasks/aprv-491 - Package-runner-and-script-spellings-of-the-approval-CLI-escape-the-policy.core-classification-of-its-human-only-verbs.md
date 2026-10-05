---
id: APRV-491
title: >-
  Package-runner and script spellings of the approval CLI escape the policy.core
  classification of its human-only verbs
status: To Do
assignee: []
created_date: '2026-10-05 12:03'
labels:
  - security
dependencies: []
priority: medium
ordinal: 375000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From the APRV-479 round-3 refuter (R3-6) and the round-4 security review of PR #615. The harness hook holds the approval CLI's human-only verbs (log unlock, log checkpoint, gate open, policy apply, setup checkpoint, channel relay, quickstart) human-only by classifying them policy.core, but only for the spellings the approval and node rows recognize. Measured with classifyCommand on the classifier main ships: npx approval|approval-md <verb> -> files.write.workspace (workspace-tool; autonomous in this repo's APPROVAL.md); npm exec approval -- <verb> -> npm-script; node node_modules/.bin/approval <verb> -> node-script; npx -c 'approval <verb>' and npx --call -> workspace-tool; npx file:. <verb> (installs this package and runs its bin) -> workspace-tool; npx approval${IFS}log${IFS}unlock -> workspace-tool; and any node x.mjs that imports dist/src/cli/main.js is node-script. pnpm dlx, bunx, pnpx, yarn dlx, npm x, env X=1 and command npx are unclassified or opaque (refused), so they are not bypasses. A route through refineApprovalVerb for npx (22 lines, tried in #615 as 4a2e565d and reverted there) closes the literal npx spelling only; the rest (file: and git specs, aliases, npm exec, -c, wrapper scripts, a module import) cannot be enumerated, so classification cannot be the boundary for these verbs. Decide: accept classification as a speed bump and give each human-only verb a second factor an agent's environment does not carry (as log checkpoint has the vault passphrase and gate open the terminal lock and typed word), or classify every package-runner and node-script invocation that can reach the CLI as policy.core, or both.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Each human-only verb of the approval CLI has a second factor an agent process cannot supply, or the decision not to give one is recorded with its reason
- [ ] #2 classifyCommand pins every spelling listed in the description: policy.core where routed, and a stated reason where a spelling cannot reach the CLI
- [ ] #3 approval log unlock's header and docs/cli-reference.md say which of the two holds it human-only
<!-- AC:END -->
