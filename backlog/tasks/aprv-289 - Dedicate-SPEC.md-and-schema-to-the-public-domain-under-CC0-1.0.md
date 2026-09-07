---
id: APRV-289
title: Dedicate SPEC.md and schema/ to the public domain under CC0 1.0
status: To Do
assignee: []
created_date: '2026-09-07 00:59'
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
- [ ] #1 SPEC.md header line reads: License: CC0 1.0 (this document) / Apache 2.0 (reference runtime)
- [ ] #2 SPEC.md carries a short CC0 dedication paragraph under the header, naming Carter Crouch, linking the CC0 text, and marked (Amended APRV-n.) per the spec's convention
- [ ] #3 schema/LICENSE contains the CC0 1.0 Universal legal text
- [ ] #4 Every schema/*.schema.json carries "$comment": "CC0 1.0. See schema/LICENSE." and the schema loader ignores it
- [ ] #5 npm test and npm run lint pass
<!-- AC:END -->
