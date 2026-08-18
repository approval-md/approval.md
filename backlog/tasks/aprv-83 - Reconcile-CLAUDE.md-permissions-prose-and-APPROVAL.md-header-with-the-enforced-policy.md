---
id: APRV-83
title: >-
  Reconcile CLAUDE.md permissions prose and APPROVAL.md header with the enforced
  policy
status: In Progress
assignee:
  - Carter
created_date: '2026-08-18 11:00'
updated_date: '2026-08-18 12:21'
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

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Code half (agent-owned, files.write.workspace): classifier emits vcs.pr.open (gh pr create), vcs.pr.update (gh pr edit/comment/review/ready/close/reopen/lock/unlock), vcs.push.main (gh pr merge), vcs.commit.branch (gh pr checkout); tests + docs table. Under the current policy these still resolve to defaults.autonomy (manual), so nothing loosens until the human adds a rule. 2. Policy half (human-owned, policy.edit): exact proposed edits as docs/proposals/aprv-83-policy.patch (APPROVAL.md header + vcs.pr.* supervised + deps.install autonomous; CLAUDE.md Permissions preface deferring to APPROVAL.md, feature-branch push and PR open/update moved to Allowed, gh pr merge named under main merges, dogfooding bullet on the hook) and docs/proposals/aprv-83-claude-settings.json (the hook entry). 3. Verify the proposal: proposed APPROVAL.md loads and resolves as intended; proposed CLAUDE.md section imports cleanly via approval import agents-md; patch applies to main. 4. Human applies the patch, commits settings.json, runs approval policy amend/attest as human:carter on the primary checkout, then checks AC 1-3.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Gate check at start (2026-08-18): primary log healthy and attested (seq 4, 12 records) but no daemon running and no channel configured, so a policy.edit request could not be delivered; per CLAUDE.md that is stop-and-escalate. Agent-side work therefore stops at a proposal. DONE (code): src/core/command-class.ts refineGh now emits vcs.pr.open / vcs.pr.update / vcs.push.main (gh pr merge) / vcs.commit.branch (gh pr checkout); everything else under gh pr/issue/repo/run stays network.call or read.vcs.remote. tests/command-class.test.ts fixtures added; docs/claude-code-hook.md row updated; targeted suites 167/167 and lint clean. Under the live policy these classes still resolve to defaults.autonomy = manual, so this is not a loosening. DELIVERED (proposal, human applies): docs/proposals/aprv-83-policy.patch and docs/proposals/aprv-83-claude-settings.json. Decisions recommended: (b) PR class = vcs.pr.* at supervised (proceed, sampled), the routine partner of vcs.push.branch; gh pr merge shares vcs.push.main; deps.install (bare npm install / npm ci from the lockfile) autonomous, matching the policy's own 'beyond package installs' wording; network.call stays manual. CLAUDE.md: Permissions preface says APPROVAL.md wins on disagreement and points at 'approval hook classify'; feature-branch push and PR open/update move to Allowed; 'Merges to main (including gh pr merge), tag creation' under Require approval; the 'npm ci' bullet is worded without the phrase 'npm install' because the importer's deps.add heuristic claims that phrase; a dogfooding bullet describes the hook and the classify fallback. Verified: proposed APPROVAL.md loads; policy test resolves gh pr create -> vcs.pr.open supervised, gh pr merge -> vcs.push.main supervised, npm install -> deps.install autonomous, curl -> network.call manual; proposed CLAUDE.md imports with ok:true and only the pre-existing events.jsonl 'never' bullet unmapped (AC4); git apply --check passes against main. The pinned fixture tests/fixtures/agents-md/claude-md-permissions.md is a dated copy by design and is intentionally NOT updated. Note on the settings.json snippet: --dir carries the primary checkout's absolute path; a follow-up could let the hook derive the primary from git rev-parse --git-common-dir so worktrees need no path in a committed file. Remaining for the human: apply patch, commit .claude/settings.json, approval policy amend/attest as human:carter on the primary, then check AC 1-3 and mark Done.
<!-- SECTION:NOTES:END -->
