---
id: APRV-43
title: 'Verified-read head caching: the S1 deferral'
status: To Do
assignee: []
created_date: '2026-08-05 14:19'
labels: []
milestone: m-7
dependencies: []
priority: medium
type: feature
ordinal: 43000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The optimization deferred by APRV-20's S1 note: enforcement paths re-verify the full chain on every read, linear cost accepted at v0.1. With the daemon re-reading on every watch event, linear-per-read becomes quadratic-per-session. readVerifiedRecords gains a cache of the last verified state keyed by file identity (path, size, mtime, head hash): on re-read, if the previous head's bytes are unchanged at their offset, verify only the appended suffix; ANY mismatch (size shrank, mtime moved without growth, head line differs) discards the cache and re-verifies from genesis. The invariant is absolute: no code path may act on records the cache theory admitted but verification did not prove — the cache is an accelerator for the honest case, never a bypass. Global invariant 1 is touched; implementation notes must say so per CLAUDE.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Suffix-only verification when the cached head's bytes are byte-identical at their recorded offset; full re-verification on any mismatch, shrinkage, or reordering — tamper-after-cache tests cover mutation before, at, and after the cached head
- [ ] #2 Cache hit and miss produce byte-identical results to uncached verification across the whole existing verify/state test corpus (run both modes in tests)
- [ ] #3 Daemon watch loops use the cache; CLI single-shot invocations are unaffected (process-lifetime cache only, no cache files on disk)
- [ ] #4 Implementation notes declare the Global-invariant-1 touch and the argument for why the accelerator cannot become a bypass
<!-- AC:END -->
