---
id: APRV-289
title: Dedicate SPEC.md and schema/ to the public domain under CC0 1.0
status: Done
assignee:
  - '@claude'
created_date: '2026-09-07 00:59'
updated_date: '2026-09-07 01:10'
labels:
  - licensing
dependencies:
  - APRV-288
priority: high
type: chore
ordinal: 214000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The format is the standard; the runtime is one implementation. A CC0 1.0 dedication on the specification text and the JSON schemas lets a lab or an indie developer reimplement the format in any language without touching Apache-licensed code or asking permission. CC0 is a waiver with a fallback licence for jurisdictions that do not allow waiver, the same instrument used by W3C community drafts and Open Data Commons. Bountify.ai's commercial moat is the hosted reviewer layer, so the format carries no commercial value that this gives away. Edits SPEC.md, which classifies policy.edit through the hook.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 SPEC.md header line reads: License: CC0 1.0 (this document) / Apache 2.0 (reference runtime)
- [x] #2 SPEC.md carries a short CC0 dedication paragraph under the header, naming Carter Crouch, linking the CC0 text, and marked (Amended APRV-n.) per the spec's convention
- [x] #3 schema/LICENSE contains the CC0 1.0 Universal legal text
- [x] #4 Every schema/*.schema.json carries "$comment": "CC0 1.0. See schema/LICENSE." and the schema loader ignores it
- [x] #5 npm test and npm run lint pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. SPEC.md header: License field lists CC0 1.0 (document) / Apache 2.0 (runtime). 2. Add CC0 dedication paragraph under the header, marked (Amended APRV-289.). 3. schema/LICENSE gets the CC0 1.0 Universal text. 4. Each schema/*.schema.json gets a top-level $comment pointing at it. 5. npm test, npm run lint. 6. Commit.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
CC0 1.0 Universal text copied from /opt/homebrew/Cellar/libb2/0.98.1/COPYING (identical to creativecommons.org). Dedication paragraph sits under the SPEC header, marked (Amended APRV-289.); gate window was open so it carries the plain suffix. $comment added to all five schema files (envelope, event, policy, sample-record, values); ajv treats $comment as a known keyword in strict mode. npm test: 3836 pass, 1 skipped, 0 fail. npm run lint: clean. This task edits SPEC.md (policy.edit) and touches no §11 invariant.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
SPEC.md header lists CC0 (document) / Apache 2.0 (runtime) with a dedication paragraph; schema/LICENSE carries CC0; every schema has a $comment. Verified by full test suite and lint.
<!-- SECTION:FINAL_SUMMARY:END -->
