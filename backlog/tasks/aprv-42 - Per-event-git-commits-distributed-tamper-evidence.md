---
id: APRV-42
title: 'Per-event git commits: distributed tamper evidence'
status: To Do
assignee: []
created_date: '2026-08-05 14:19'
updated_date: '2026-08-05 14:27'
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
- [ ] #1 Opt-in daemon flag/config; each observed append yields one commit in the log-dir repo with seq+hash in the message and the daemon's own identity
- [ ] #2 The log-dir repo is required to be its own repository root; enabling inside the project repo or any outer working tree is refused with a clear message
- [ ] #3 Tamper evidence demonstrated in a test: rewriting a committed log line then verifying shows both the chain failure and the git history divergence
- [ ] #4 Disabled by default; nothing changes for daemons without it; log verify clean throughout
- [ ] #5 Rider (human, at decomposition review): reconciled with the dogfood layout — per-event git commits are an opt-in for standalone log deployments and require an own-root log repo; the nested project-repo layout remains valid without the opt-in; docs state both patterns and why they do not mix
<!-- AC:END -->
