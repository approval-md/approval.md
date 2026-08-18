---
id: APRV-83
title: >-
  Reconcile CLAUDE.md permissions prose and APPROVAL.md header with the enforced
  policy
status: To Do
assignee:
  - Carter
created_date: '2026-08-18 11:00'
updated_date: '2026-08-18 11:00'
labels:
  - docs
  - dogfood
dependencies:
  - APRV-82
references:
  - CLAUDE.md
  - APPROVAL.md
priority: medium
type: docs
ordinal: 82000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
CLAUDE.md's Permissions section and APPROVAL.md's policy disagree, and agents cite the prose. Observed 2026-08-18: CLAUDE.md lists 'git push' under Require approval first while APPROVAL.md has vcs.push.branch: autonomous; CLAUDE.md does not mention opening a PR while APPROVAL.md's network.call: manual arguably covers gh pr create, so every agent-opened PR technically violates the policy; APPROVAL.md's header still says enforcement is social 'until the gate (M3) and channels (M4) exist', which have shipped. Both files are policy.edit class, so this task is a proposal for the human to apply by hand and attest via approval policy amend; agents do not edit them.

Proposed resolution: (a) APPROVAL.md header: replace the pre-M3 sentence with the current state (gate and channels exist; harness Bash commands are gated once APRV-82 lands, until then CLAUDE.md prose is the fallback). (b) Decide the class for opening a PR: either leave it as network.call (manual, through the gate) or add an explicit vcs.pr.open class (suggest supervised, matching vcs.push.main). (c) CLAUDE.md Permissions: state that APPROVAL.md is authoritative and wins on any disagreement, drop feature-branch git push from Require approval first, and keep the section AGENTS.md-shaped since it is the M6 import fixture (re-run the import fixture test after editing). (d) Note in the dogfooding section that harness-run shell commands are the enforcement gap APRV-82 closes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 APPROVAL.md header no longer claims the gate and channels do not exist
- [ ] #2 A class for opening a PR is decided and recorded in APPROVAL.md (network.call or a new vcs.pr.open) and the policy is re-attested by the human
- [ ] #3 CLAUDE.md Permissions section defers to APPROVAL.md on disagreement and no longer lists feature-branch git push under Require approval first
- [ ] #4 The AGENTS.md import fixture test (M6) still passes against the edited CLAUDE.md section
<!-- AC:END -->
