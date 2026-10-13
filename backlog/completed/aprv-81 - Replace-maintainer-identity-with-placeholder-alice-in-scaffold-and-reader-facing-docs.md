---
id: APRV-81
title: >-
  Replace maintainer identity with placeholder alice in scaffold and
  reader-facing docs
status: Done
assignee:
  - fable
created_date: '2026-08-18 10:37'
updated_date: '2026-08-18 10:47'
labels:
  - docs
  - cli
dependencies: []
ordinal: 80000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The maintainer's identity 'carter' appears in the approval init scaffold (src/cli/scaffold.ts), CLI help/setup/env-file/attest doc text, examples/*.md, and the SPEC.md examples. The scaffold case is a real defect: every new user's APPROVAL.md is written with a stranger's approver identity. The rest is a copy-paste hazard where open-source convention is a neutral placeholder. Swap those reader-facing occurrences to 'alice'. Deliberately unchanged: the repo's own dogfood APPROVAL.md, .approval/ (append-only log), docs/dogfood-cutover.md, backlog records, tests and schema fixtures (except the two canonical policy fixtures that mirror SPEC §5.1), and /Users/carter paths.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 approval init emits an APPROVAL.md with no 'carter' in it
- [x] #2 git grep -n carter -- src examples SPEC.md README.md returns nothing
- [x] #3 schema/fixtures/policy(-md)/valid/canonical.* and tests/policy-load.test.ts stay in sync with the SPEC §5.1 example
- [x] #4 npm test and lint pass
- [x] #5 SPEC.md edit is called out in implementation notes as cosmetic, no behavior change
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Mechanical carter->alice / human:carter->human:alice in src/cli/scaffold.ts, src/cli/help.ts, src/cli/setup.ts, src/core/env-file.ts, src/core/attest.ts, src/channels/telegram.ts comment, src/adapters/email.ts comment (carter@example.com -> alice@example.com), examples/email-demo.md, examples/telegram-demo.md, SPEC.md examples (5.1 policy, envelope created_by, event actor). 2. Mirror the SPEC 5.1 change into schema/fixtures/policy-md/valid/canonical.md, schema/fixtures/policy/valid/canonical.json, tests/policy-load.test.ts assertion. 3. Leave APPROVAL.md, .approval/, docs/dogfood-cutover.md, backlog/, other tests/fixtures untouched. 4. Verify: git grep carter over src examples SPEC.md README.md is empty; npm test; lint; run approval init in scratch dir.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Mechanical carter->alice swap, 15 files, 53 lines. Reader-facing: src/cli/scaffold.ts (the actual defect: approval init wrote the maintainer's identity into every new APPROVAL.md), src/cli/help.ts, src/cli/setup.ts, src/core/env-file.ts, src/core/attest.ts, src/channels/telegram.ts (comment), src/adapters/email.ts (carter@example.com -> alice@example.com), examples/email-demo.md, examples/telegram-demo.md (re-padded the log table columns since alice is one char shorter). SPEC.md: 5 example lines changed (5.1 policy approvers x3, envelope created_by, event actor). COSMETIC ONLY, no behavior change, no schema/invariant touched; called out here for the human per CLAUDE.md. Fixture mirrors updated to stay in sync with SPEC 5.1: schema/fixtures/policy-md/valid/canonical.md, schema/fixtures/policy/valid/canonical.json, plus the assertions that read them in tests/policy-load.test.ts and tests/policy-match.test.ts (policy-match was found by the test run; policy-explain uses an inline policy and needed nothing). Deliberately untouched: APPROVAL.md and .approval/ (the repo's real dogfood identity and append-only log), docs/dogfood-cutover.md and /Users/carter paths (runbook for the primary checkout; the committed payload hash binds that cwd), backlog/, and the ~300 human:carter in other tests/fixtures (cosmetic, and hash/known-answer.json would need regenerating for no reader benefit). Verified: git grep carter -- src examples SPEC.md README.md empty; npm test 1509/1509; oxlint clean; approval init in a scratch dir emits alice.
<!-- SECTION:NOTES:END -->
