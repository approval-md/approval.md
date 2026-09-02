---
id: APRV-225
title: >-
  `approval log sync` refuses over untracked payload files that are
  byte-identical to the incoming commit
status: To Do
assignee: []
created_date: '2026-09-02 16:52'
labels:
  - daemon
  - dogfood
dependencies: []
priority: medium
ordinal: 181000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Seen 2026-09-02 after PR #226 (log advance to seq 11361) merged: `approval log sync` in the main checkout failed with `log-sync-git-failed`, because `git merge --ff-only FETCH_HEAD` refused to overwrite 33 untracked files under `.approval/payloads/` that the records advance had already committed. The verb restored the working log correctly, so only the fast-forward was blocked. The files are content-addressed (`<sha256>.json`, §9 payload store), and every one matched its name on both sides, so the local and incoming bytes were identical by construction and the only way forward was a hand step: move the untracked files aside, sync, build. Outcome: sync recognises this case and completes on its own. A payload whose bytes do NOT match its name, or differ from the incoming blob, is a different situation and must still refuse with its own code, since a payload is the material evidence an approval bound to.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Before the fast-forward, sync lists untracked files under `.approval/payloads/` that the incoming tree also carries; for each, it hashes the local bytes and refuses to proceed unless the hash equals the filename and equals the incoming blob
- [ ] #2 When every such file is identical, sync completes the fast-forward without a hand step and reports how many payload files it reconciled; the local bytes are never deleted before the incoming blob has been confirmed identical
- [ ] #3 A mismatching payload (name, local bytes, incoming blob disagree) refuses with a distinct machine-readable code that names the file, appends nothing, and leaves the working tree and the working log as they were
- [ ] #4 Tests cover the identical case, the mismatch case, and a payload present locally but absent from the incoming tree (left alone)
- [ ] #5 docs/dogfood-cutover.md or the log sync reference names the behaviour
<!-- AC:END -->
