---
id: APRV-273
title: >-
  Dogfood test for the proposed values block fails once the block is live in
  APPROVAL.md
status: Done
assignee:
  - '@fable'
created_date: '2026-09-05 20:41'
updated_date: '2026-09-05 20:44'
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
- [x] #1 With a values block the loader sees in the live APPROVAL.md, the test asserts it loads (ok, present) and that loadPolicyText over the live bytes deep-equals loadPolicyText over the live bytes with the values fence removed
- [x] #2 With no block the loader sees, the existing paste check still runs unchanged
- [x] #3 A second test exercises whichever state the live file is not in, against scratch strings, so both branches run in every tree; nothing writes APPROVAL.md and the mid-suite byte guard still passes
- [x] #4 The dogfood suite passes on main (block hidden by the wrapper) and on the policy-amend-23351 contents (block live)
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Decide the live file's state by loadValuesText (present or not), never by substring, because the wrapper paste hid a block the text names.
2. Present: strip the fence the loader saw and assert loadPolicyText(live) deep-equals loadPolicyText(stripped); absent: keep the paste check.
3. A second test runs whichever state the live file is not in against scratch strings.
4. Verify on main's APPROVAL.md (hidden block) and on the policy-amend-23351 bytes (live block); dogfood, values and values-inert suites; lint; typecheck.
5. PR off origin/main, merge armed; then PR #301 needs its branch updated or its checks rerun.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Cause: the APRV-240 test assumed the pre-paste state. Fix decides the live state by loadValuesText, since the first paste into APPROVAL.md carried the proposal's four-backtick wrapper and hid the block from the loader while the text still named it; a substring test would have stripped a fence the loader never read. In the hidden-block case the other-state check cuts the LAST fence (the one it appended). The proposal doc drops its wrapper and says to copy from the sentence through the closing fence. Validation: dogfood + values + values-inert 65/65 on main's APPROVAL.md (hidden block); the same assertions mirrored in a scratch script against the policy-amend-23351 bytes (live block) hold; lint and typecheck clean.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Made the APRV-240 dogfood check hold in both states of the live APPROVAL.md (block absent, block present, block hidden by a wrapper), added the other-state test, and removed the wrapper from the proposal doc. Verified on main's bytes and on PR #301's bytes.
<!-- SECTION:FINAL_SUMMARY:END -->
