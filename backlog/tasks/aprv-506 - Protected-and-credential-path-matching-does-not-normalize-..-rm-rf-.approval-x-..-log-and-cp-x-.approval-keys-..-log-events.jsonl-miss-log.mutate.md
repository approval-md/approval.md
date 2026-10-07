---
id: APRV-506
title: >-
  Protected and credential path matching does not normalize ..: rm -rf
  .approval/x/../log and cp x .approval/keys/../log/events.jsonl miss log.mutate
status: To Do
assignee: []
created_date: '2026-10-07 04:19'
labels:
  - agent-village
dependencies: []
priority: high
ordinal: 388000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found by the APRV-503 recheck (lanes-b1/A503-refute.md, NOTE-R2, 2026-10-07); pre-existing on main bd5c7562 and unchanged by PR #631. pathSegments() in src/core/command-class.ts splits a word on / without resolving .. segments, and protectedPathClass / isCredentialPath match segment runs on that list. So a path that climbs out of a subdirectory of .approval/ and back into the log directory is matched by its FIRST segments only: rm -rf .approval/x/../log and cp x .approval/x/../log/events.jsonl classify policy.core (the .approval/ rule) rather than log.mutate, and cp x .approval/keys/../log/events.jsonl and cat .approval/keys/../log/events.jsonl classify account.credential (the keys/ rule). log.mutate is the one class the open window refuses with no policy consulted (runBypass in src/cli/hook.ts checks it outside the load.ok block); policy.core and account.credential are bypassed by a window over a policy that does not load. When a subdirectory exists under .approval/ (keys/, payloads/), an agent in such a window could write the log. For claude-code and cursor the hook disk pass (resolvedPathClasses, which canonicalizes through realpath) never runs, because those adapters carry no per-call cwd, so the pure classifier answer is final. SPEC §11.1 fail closed. Fix sketch: resolve . and .. lexically in pathSegments (or in a matcher-only normalizer) before protected and credential matching, keeping a leading .. that climbs above the word; and/or treat any .. segment after .approval as log.mutate (strictest). Check the APRV-502 skill-script shape, which deliberately refuses any .. segment, is unaffected.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 rm -rf .approval/x/../log, cp x .approval/x/../log/events.jsonl and cp x .approval/keys/../log/events.jsonl classify log.mutate in the pure classifier
- [ ] #2 An open window over a policy that does not load refuses those commands through approval hook claude-code, naming log.mutate
- [ ] #3 Spellings that climb out of the gate entirely (.approval/../src/x.ts) classify as the landing path, and cat .approval/keys/../log/events.jsonl takes the class a read of the log takes; no existing fixture or conformance vector moves except the named cases
- [ ] #4 command-class conformance vectors added for the cases above, version bumped per conformance/README.md
<!-- AC:END -->
