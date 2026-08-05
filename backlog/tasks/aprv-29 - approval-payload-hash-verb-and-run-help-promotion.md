---
id: APRV-29
title: approval payload hash verb and run --help promotion
status: To Do
assignee: []
created_date: '2026-08-05 12:19'
labels: []
milestone: m-6
dependencies: []
priority: medium
type: feature
ordinal: 29000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-ups 2 and 4 from the M4 demo (human-approved 2026-08-09). Computing a payload_hash today requires a node -e one-liner against an internal module path — the roughest step in the manual walkthrough. Ships approval payload hash <file|-> printing the RFC 8785 payload hash of a JSON file or stdin, and promotes --payload-hash in run --help from exotic-looking override to documented common case for adapter-shaped payloads (argv+cwd hashing stays the default for command-shaped ones).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval payload hash <file> and approval payload hash - (stdin) print the payload hash used by the binding path, byte-identical to what request/grant record; --json frozen; non-JSON input refused with a clear message
- [ ] #2 run --help documents --payload-hash as the normal path for adapter-shaped payloads, with the argv+cwd default explained; the examples walkthrough replaces its node -e step with the new verb
- [ ] #3 Exit codes per the frozen table; subprocess tests pin verb output against a grant recorded through the real gate
<!-- AC:END -->
