---
id: APRV-10
title: 'Policy loading: fenced-block extraction, YAML parse, fail-closed result'
status: To Do
assignee: []
created_date: '2026-08-05 00:23'
labels: []
milestone: m-2
dependencies: []
priority: high
type: feature
ordinal: 10000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC.md section 5: APPROVAL.md is human prose plus exactly one fenced `yaml approval-policy` block; implementations MUST parse the block, MUST ignore the surrounding prose, and MUST accept APPROVALS.md as a fallback with APPROVAL.md taking precedence. This task builds the loader that turns a file on disk into either a schema-valid policy object or a typed fail-closed result — the single entry point every other M2 task consumes. Fail closed is the load-bearing property (section 5.2): unparseable policy means the matcher must treat every class as manual, so the loader's failure type is part of the engine's contract, not an exception path. YAML parsing requires this project's third runtime dependency (e.g. `yaml`); human approval is required before install, exact-pinned, justified in implementation notes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 loadPolicy() extracts exactly one `yaml approval-policy` fenced block; zero blocks or more than one both yield a fail-closed result, covered by fixtures
- [ ] #2 APPROVALS.md is accepted as fallback and APPROVAL.md takes precedence when both exist, each covered by a test
- [ ] #3 The parsed YAML is validated against schema/policy.schema.json through the APRV-2 harness; any load, parse, or validation failure yields a typed fail-closed result with machine-readable codes distinguishing: file missing, no policy block, multiple blocks, YAML parse error, schema-invalid
- [ ] #4 The fail-closed result's documented meaning is "treat every class as manual" and the type makes the downstream obligation explicit for the matcher (APRV-11)
- [ ] #5 approval_ttl and other duration strings are parsed to milliseconds by a deterministic parser matching the schema's duration grammar exactly, with tests for every unit and rejection cases
- [ ] #6 Prose surrounding the block is ignored per the MUST, verified with fixtures including prose that contains YAML-looking content and unfenced yaml blocks
- [ ] #7 The YAML parser dependency is exact-pinned, human-approved before install, and justified in implementation notes
<!-- AC:END -->
