---
id: APRV-43
title: 'Verified-read head caching: the S1 deferral'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 14:19'
updated_date: '2026-08-05 17:32'
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
- [x] #1 Suffix-only verification when the cached head's bytes are byte-identical at their recorded offset; full re-verification on any mismatch, shrinkage, or reordering — tamper-after-cache tests cover mutation before, at, and after the cached head
- [x] #2 Cache hit and miss produce byte-identical results to uncached verification across the whole existing verify/state test corpus (run both modes in tests)
- [x] #3 Daemon watch loops use the cache; CLI single-shot invocations are unaffected (process-lifetime cache only, no cache files on disk)
- [x] #4 Implementation notes declare the Global-invariant-1 touch and the argument for why the accelerator cannot become a bypass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, isolated worktree from main (post-APRV-38), parallel with APRV-39. 2. Read core/state readVerifiedRecords, core/verify, tests/state.test.ts + verify corpus. 3. Process-lifetime cache keyed by (path, size, mtime, head hash); on re-read verify cached head bytes at recorded offset then suffix-only verify; ANY mismatch discards cache and re-verifies from genesis. 4. Tamper-after-cache tests: mutation before, at, after cached head; whole verify/state corpus run in cached and uncached modes with byte-identical results; daemon loops use the cache, CLI single-shot unaffected. 5. Implementation notes declare the Global-invariant-1 touch and the no-bypass argument. 6. PR, ci green, merge.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built by an Opus subagent, isolated worktree, delivered as PR #4, merged with ci green on both matrix jobs. GLOBAL INVARIANT 1 DECLARATION (required by this task): readVerifiedRecords now consults a process-lifetime, memory-only cache; the invariant holds in the strong form because every record handed out was walked through the full check ladder by this process over bytes it re-proved identical. The brief-anticipated cheap design (head-line bytes at recorded offset) was REJECTED AS UNSOUND: a length-preserving mutation strictly before the head leaves size, head bytes, and offset identical while defeating the chain. The shipped design stores SHA-256 over the entire verified prefix and re-hashes it on every cached read; all other checks (size shrink, mtime move, head bytes, schemaDir) are discard triggers, never licences. Only clean verdicts populate; suffix corruption discards; cached records are deep-frozen (a caller mutating one gets TypeError, a behavior change nothing currently trips); cache holds max 8 logs, insertion-order eviction; CLI one-shots unaffected by construction; cache: null forces cold reads. Tamper matrix proves: pre-head length-preserving mutation, at-head mutation, suffix mutation after honest growth, truncation, reorder, non-linking append, and same-size same-mtime full substitution are all caught, with cache stats distinguishing discard-catches from downstream luck. Whole state corpus parameterized cached/uncached with identical results; verifyText became public core surface (documented as cache-only). Measured: 500-record log 3094ms cold vs 0.24ms warm. No SPEC change: observable behavior byte-identical.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Verified-read head caching via full-prefix SHA-256 re-proof (head-bytes-only design rejected as unsound), suffix-only walk on match, discard-only hints otherwise. Invariant 1 declared and argued in module header and above. Verified: tamper matrix + dual-mode corpus, 1012 tests in PR CI, both matrix jobs green, merged as PR #4.
<!-- SECTION:FINAL_SUMMARY:END -->
