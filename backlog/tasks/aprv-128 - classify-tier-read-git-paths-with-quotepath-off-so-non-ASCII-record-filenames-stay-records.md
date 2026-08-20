---
id: APRV-128
title: >-
  classify-tier: read git paths with quotepath off so non-ASCII record filenames
  stay records
status: Done
assignee: []
created_date: '2026-08-20 19:06'
updated_date: '2026-08-20 20:58'
labels:
  - ci
milestone: m-12
dependencies: []
priority: high
ordinal: 120000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found by the records tier's first customer (PR 109, 2026-08-20): a pure backlog/tasks diff classified full because one task filename contains a section sign (aprv-103 ... §10.1 ...), git prints non-ASCII paths C-quoted by default, and the APRV-112 classifier correctly fails closed on a quoted path it cannot parse. Fail-closed was right; the fix is to make the path parseable: run the diff with -c core.quotepath=false (or -z NUL-delimited output, the more robust choice since it also survives newlines in names) so real record filenames reach the path rules intact. Keep the fail-closed branch for whatever still cannot parse. Test with a fixture filename containing § and one containing a space plus quote.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A backlog-only diff whose filenames contain non-ASCII classifies records; pinned with a section-sign fixture
- [x] #2 Path reading is NUL-delimited or quotepath-off; the unparseable fail-closed branch survives with a test that still reaches it
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Merged as PR 111 (branch aprv-128-quotepath-queue-tier). Half one: the classifier reads git paths NUL-delimited (git diff -z --name-only, chosen over quotepath=false because -z also survives newlines in names); the C-quoted fail-closed branch survives for callers the classifier cannot vouch for, still tested. Fixtures with a section sign and with space+quote classify records, including an end-to-end test against a real throwaway repo that fails when -z is removed. Half two (scope extended by the human): merge_group candidates classify their own diff exactly as PRs do; BASE_REF is genuinely empty on merge_group (verified against live run 32401864721, not docs), so base resolves origin/main under an explicit guard; push-to-main stays unconditionally full; unknown output still fails closed. ci-guard now executes the workflow's own tier script under bash for the three event shapes. A records-only PR's full journey (branch CI + queue candidate) drops to roughly four minutes. Footnote for posterity: the classifier CLI silently exits 0 doing nothing when invoked via a non-canonical path (its invokedDirectly check), discovered via macOS /var symlinks; realpath in the test harness. 2002 tests at merge.
<!-- SECTION:NOTES:END -->
