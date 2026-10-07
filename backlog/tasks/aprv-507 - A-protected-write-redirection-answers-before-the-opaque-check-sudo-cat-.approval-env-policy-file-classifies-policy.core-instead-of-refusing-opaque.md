---
id: APRV-507
title: >-
  A protected write redirection answers before the opaque check: sudo cat
  .approval/env > <policy file> classifies policy.core instead of refusing
  opaque
status: To Do
assignee: []
created_date: '2026-10-07 04:30'
labels:
  - security
dependencies: []
priority: high
ordinal: 387000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found by the APRV-503 refutation (recheck 2, 2026-10-07, lanes-b1/A503-refute.md) on main and unchanged by PR #631. In src/core/command-class.ts classifySegment, a redirection onto a protected path answers (protected class, rule redirect-protected) BEFORE the opaque checks (sudo, exec, env -i, ...), so 'sudo cat .approval/env > <policy file>' and 'sudo tee .approval/log/x < f' classify policy.core / log.mutate rather than being refused opaque. Under a policy that ranks the class autonomous or in an open window whose policy does not load, a refusal would deny where a class may allow. Fix: run the opaque checks before any redirection answer (or make the redirect answer carry the refusal when the binary is opaque); add vectors and a window e2e for the sudo case; keep the protected class answer for non-opaque binaries.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 sudo <bin> ... > <protected path> and sudo <bin> ... < <protected path> are refused opaque, as sudo <bin> <protected path> is
- [ ] #2 Non-opaque binaries keep the protected class answer for redirections (existing vectors byte-identical)
- [ ] #3 Window e2e through the real hook: the sudo spelling is denied with a policy that does not load
<!-- AC:END -->
