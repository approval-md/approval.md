---
id: APRV-42
title: 'Per-event git commits: distributed tamper evidence'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 14:19'
updated_date: '2026-08-05 18:59'
labels: []
milestone: m-7
dependencies:
  - APRV-39
priority: medium
type: feature
ordinal: 42000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC section 8's optional hardening: the log directory is a git repo and the daemon commits per event with its own identity, giving signed, distributed tamper evidence for free. Opt-in via daemon config; when enabled the daemon commits the log (and payload store additions) after each append it observes, message carrying seq and hash, identity its own (approvald <version>), never the operator's. Interacts with the repo's single-writer rule and the outer repo: the log dir git repo is a NESTED, separate repository — never the project repo; refuse to enable when the log dir is inside a working tree tracked by an outer repo unless it is its own root (document).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Opt-in daemon flag/config; each observed append yields one commit in the log-dir repo with seq+hash in the message and the daemon's own identity
- [x] #2 The log-dir repo is required to be its own repository root; enabling inside the project repo or any outer working tree is refused with a clear message
- [x] #3 Tamper evidence demonstrated in a test: rewriting a committed log line then verifying shows both the chain failure and the git history divergence
- [x] #4 Disabled by default; nothing changes for daemons without it; log verify clean throughout
- [x] #5 Rider (human, at decomposition review): reconciled with the dogfood layout — per-event git commits are an opt-in for standalone log deployments and require an own-root log repo; the nested project-repo layout remains valid without the opt-in; docs state both patterns and why they do not mix
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, isolated worktree from main, parallel with 40/41. 2. Opt-in per-event git commits for standalone log deployments: own-root log repo required; refuse (clear message) inside any outer working tree per the accepted ruling; daemon commits log + store additions per observed append, message seq+hash, identity approvald <version>. 3. Tamper test: rewrite committed line, show chain failure + git divergence. 4. Disabled by default; docs state both layouts and why they do not mix. File boundary: owns git-commit module + docs; daemon edits confined to an opt-in hook. PR, ci green, auto-merge.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Opus subagent build, PR #7, merged with ci green. Evidence root deliberately widened from "log dir" to the log HOME (.approval/), so the payload store sits inside the evidence (a tamperer would otherwise work in the one place outside it) — changes the git init target an operator types; docs and refusals say log home. One commit per verified tick (only moment a verified head exists), message seq+hash+count, count from staged numstat so --once restarts stay correct. Nesting refused twice over: root must be its own toplevel AND parent in no working tree (catches git init inside the dogfood .approval/). QUEUE.md excluded from evidence (countdown-rewritten projection), pinned by test. Identity per-commit via -c, operator git config never read or written; runtime git failure is a warning, never a stop (redundancy must not become dependency). Exit codes: git-unavailable/log-dir-missing 4, not-repo/nested 2; git-evidence codes are their own frozen union so DaemonEvent and DAEMON_WARNING_CODES stay byte-identical. Tamper test demonstrates chain failure and git divergence as independent layers. SPEC untouched (§8 sentence covers it as written). Daemon edit: 9 lines. Reviewer-weigh: tests require real git on the runner (CI has it; no skip-guard).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Opt-in per-event git evidence for standalone log deployments per the accepted ruling: own-root log home required, nested layouts refused with distinct reasons, local commits only under the daemon identity, never a push. Tamper test shows both evidence layers independently. Merged as PR #7, 1053 tests.
<!-- SECTION:FINAL_SUMMARY:END -->
