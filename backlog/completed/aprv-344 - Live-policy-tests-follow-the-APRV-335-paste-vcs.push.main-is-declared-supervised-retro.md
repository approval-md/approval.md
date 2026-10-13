---
id: APRV-344
title: >-
  Live-policy tests follow the APRV-335 paste: vcs.push.main is declared
  supervised-retro
status: Done
assignee:
  - '@claude-fable'
created_date: '2026-09-16 18:20'
updated_date: '2026-09-16 18:26'
labels:
  - tests
dependencies: []
priority: high
type: bug
ordinal: 262000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
tests/cli-policy.test.ts ('this repo's APPROVAL.md gates its own classes as written') pins the live APPROVAL.md's vcs.push.main rule as the bare supervised, as the APRV-127 migration promise. APRV-335 deprecated the bare spelling and on 2026-09-16 the human pasted the proposal (attested seq 32573, PR #397), so the live rule now reads supervised-retro and the test fails on that PR (matched.rule.autonomy and outcome.declaredAutonomy). The resolved tier is still supervised with supervision retro, so only the declared spelling moves. The test's comment is rewritten to say the promise was kept and then retired.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The live-policy test expects matched.rule.autonomy and outcome.declaredAutonomy of supervised-retro for vcs.push.main, with autonomy supervised and supervision retro unchanged
- [x] #2 The test passes against the APPROVAL.md on origin/policy-amend-32573 and the full suite passes there; no other test pins the bare spelling on the live file
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. In tests/cli-policy.test.ts, the live-policy test expects matched.rule.autonomy and outcome.declaredAutonomy of supervised-retro for vcs.push.main; the resolved tier and supervision stay. Rewrite the APRV-127 comment to say the promise held until APRV-335 and the 2026-09-16 paste. 2. Verify by running the full suite in a checkout of origin/policy-amend-32573 with the fixed test copied in. 3. Lint.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Verified in a detached checkout of origin/policy-amend-32573 with the fixed test copied in: 'this repo's APPROVAL.md gates its own classes as written' passes (it is the one failure on PR #397 without the change). That local run also showed 22 email-adapter failures under Node 26 (TLS ServerName to an IP address not permitted); they pass on CI's Node 22 and on #397's own shards, unrelated to this task. grep confirms no other test pins the bare spelling against the live file (the remaining 'supervised' expectations are the resolved tier or scratch policies). Lint clean. Test-only change; no enforcement path touched.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
tests/cli-policy.test.ts now expects vcs.push.main declared as supervised-retro (rule and declaredAutonomy), resolved tier and retro supervision unchanged, comment rewritten to record that the APRV-127 promise held until the APRV-335 paste. Verified against the pasted policy on origin/policy-amend-32573; lint clean.
<!-- SECTION:FINAL_SUMMARY:END -->
