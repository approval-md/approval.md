---
id: APRV-273
title: >-
  Dogfood test for the proposed values block fails once the block is live in
  APPROVAL.md
status: In Progress
assignee:
  - '@fable'
created_date: '2026-09-05 20:41'
updated_date: '2026-09-05 20:41'
labels:
  - welfare
  - tests
dependencies: []
type: bug
ordinal: 202000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
tests/dogfood.test.ts "the proposed values block leaves the live policy byte-for-byte the same (APRV-240)" appends the block from docs/proposals/repo-values-block.md to the live APPROVAL.md and asserts loadValuesText accepts the result. Written before the paste, it assumed no block was present; once APPROVAL.md carries one (PR #301, policy-amend-23351) the append yields two fences, the loader refuses multiple-blocks, and CI shard 3/3 fails, blocking the policy amendment. The property the test exists for (a values block changes nothing about the parsed policy) holds in both states and the test must prove it in both. The live state is decided by the loader, not a substring: a block pasted inside a wider fence (the proposal wrapper that one paste carried) is text to the loader.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 With a values block the loader sees in the live APPROVAL.md, the test asserts it loads (ok, present) and that loadPolicyText over the live bytes deep-equals loadPolicyText over the live bytes with the values fence removed
- [ ] #2 With no block the loader sees, the existing paste check still runs unchanged
- [ ] #3 A second test exercises whichever state the live file is not in, against scratch strings, so both branches run in every tree; nothing writes APPROVAL.md and the mid-suite byte guard still passes
- [ ] #4 The dogfood suite passes on main (block hidden by the wrapper) and on the policy-amend-23351 contents (block live)
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Decide the live file's state by loadValuesText (present or not), never by substring, because the wrapper paste hid a block the text names.
2. Present: strip the fence the loader saw and assert loadPolicyText(live) deep-equals loadPolicyText(stripped); absent: keep the paste check.
3. A second test runs whichever state the live file is not in against scratch strings.
4. Verify on main's APPROVAL.md (hidden block) and on the policy-amend-23351 bytes (live block); dogfood, values and values-inert suites; lint; typecheck.
5. PR off origin/main, merge armed; then PR #301 needs its branch updated or its checks rerun.
<!-- SECTION:PLAN:END -->
