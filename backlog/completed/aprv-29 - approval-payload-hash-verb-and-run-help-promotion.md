---
id: APRV-29
title: approval payload hash verb and run --help promotion
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 12:19'
updated_date: '2026-08-05 15:32'
labels: []
milestone: m-6
dependencies: []
priority: medium
type: feature
ordinal: 29000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-ups 2 and 4 from the M4 demo (human-approved 2026-08-05). Computing a payload_hash today requires a node -e one-liner against an internal module path — the roughest step in the manual walkthrough. Ships approval payload hash <file|-> printing the RFC 8785 payload hash of a JSON file or stdin, and promotes --payload-hash in run --help from exotic-looking override to documented common case for adapter-shaped payloads (argv+cwd hashing stays the default for command-shaped ones).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 approval payload hash <file> and approval payload hash - (stdin) print the payload hash used by the binding path, byte-identical to what request/grant record; --json frozen; non-JSON input refused with a clear message
- [x] #2 run --help documents --payload-hash as the normal path for adapter-shaped payloads, with the argv+cwd default explained; the examples walkthrough replaces its node -e step with the new verb
- [x] #3 Exit codes per the frozen table; subprocess tests pin verb output against a grant recorded through the real gate
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented by Opus subagent; fable review found nothing to override. The verb hashes the canonical VALUE (non-JSON bytes have no defined hash — stated in the refusal); the load-bearing test proves byte-identity against a real grant recorded through the gate, and pins the examples doc's expected hash value so the walkthrough transcript is regression-tested. RUN_HELP promotion landed with the settled framing: argv+cwd default is right whenever the command IS the action; content-bound actions MUST pass --payload-hash, obtained from the verb or recorded at request time. examples node -e internal-module step replaced. Verified on merged tree: 894/894, lint, typecheck.

Date corrected in place per the 2026-08-05 human ruling (log-is-authoritative, applied to all APRV-46 findings): prose previously claimed 2026-08-09; this task's own created_date (2026-08-05) is the cited source. The wrong date was orchestrator confabulation, part of the systematic drift reported in APRV-46.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
approval payload hash <file|->: the binding hash as a first-class verb, proven byte-identical to gate-recorded hashes; run --help promotes --payload-hash to documented common case; examples walkthrough de-internalized. 10 tests. Verified: 894/894, lint, typecheck.
<!-- SECTION:FINAL_SUMMARY:END -->
