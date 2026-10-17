---
id: APRV-44
title: 'CI aggregator job: require one thing that means the right thing'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 14:27'
updated_date: '2026-08-05 14:32'
labels: []
milestone: m-6
dependencies: []
priority: high
type: chore
ordinal: 44000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Human CI amendment at M5 review: requiring classify alone protects nothing, since it passes regardless of tier outcome. An aggregator job (ci) depends on classify and both tier jobs, succeeding iff the active tier succeeded and failing on skipped-when-required; branch protection will require ci once green.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Job ci needs classify, doc-guard, and full with if: always(); succeeds iff the tier classify chose ran and succeeded; fails on unrecognized tier, failed classify, or skipped-when-required
- [x] #2 ci-guard tests assert the aggregator exists, its needs and always() gate, and the success-iff-active-tier logic
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Fable-implemented inline (small CI edit): aggregator job ci with needs [classify, doc-guard, full] and if: always(); fails on failed classify, unrecognized tier, or skipped-when-required; succeeds only when the chosen tier ran and succeeded. Guard test extended (needs list, always() gate, script logic, env mappings). The human sets branch protection to require ci once green.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
ci aggregator job: the single required check that means the right thing; guard-tested. Verified: 950/950 at landing.
<!-- SECTION:FINAL_SUMMARY:END -->
