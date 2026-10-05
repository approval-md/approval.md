---
id: APRV-486
title: >-
  Review card bytes view: escape or mark bidi and invisible characters so a
  payload_hash review never covers text that reads differently
status: To Do
assignee: []
created_date: '2026-10-05 08:19'
labels:
  - agentvillage
dependencies: []
priority: high
ordinal: 371000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up from the PR #614 refutation (note N2, APRV-480/481). The opaque canonical view is JSON.stringify, which leaves U+202E, U+2066-U+2069 and U+200B unescaped, so a bytes card can display text that reads differently from its bytes while the review records payload_hash, the claim that the reviewer read those bytes. The shared renderer already did this for grant prompts; APRV-481 makes it carry weight for a new record field. Refuter's probe: material {text: 'a<U+202E>b'} gives the bytes view with an unmarked U+202E.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Bidi controls and zero-width characters in a payload region are escaped or visibly marked on every channel that renders the canonical view
- [ ] #2 A card carrying such characters either shows them marked or falls back to the hash view, and never records payload_hash over an unmarked one
- [ ] #3 A test pins the refuter's U+202E probe on the review card and on a grant prompt
<!-- AC:END -->
