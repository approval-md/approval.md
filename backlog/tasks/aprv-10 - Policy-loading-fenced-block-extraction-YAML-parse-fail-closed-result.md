---
id: APRV-10
title: 'Policy loading: fenced-block extraction, YAML parse, fail-closed result'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 00:23'
updated_date: '2026-08-05 00:37'
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
- [x] #1 loadPolicy() extracts exactly one `yaml approval-policy` fenced block; zero blocks or more than one both yield a fail-closed result, covered by fixtures
- [x] #2 APPROVALS.md is accepted as fallback and APPROVAL.md takes precedence when both exist, each covered by a test
- [x] #3 The parsed YAML is validated against schema/policy.schema.json through the APRV-2 harness; any load, parse, or validation failure yields a typed fail-closed result with machine-readable codes distinguishing: file missing, no policy block, multiple blocks, YAML parse error, schema-invalid
- [x] #4 The fail-closed result's documented meaning is "treat every class as manual" and the type makes the downstream obligation explicit for the matcher (APRV-11)
- [x] #5 approval_ttl and other duration strings are parsed to milliseconds by a deterministic parser matching the schema's duration grammar exactly, with tests for every unit and rejection cases
- [x] #6 Prose surrounding the block is ignored per the MUST, verified with fixtures including prose that contains YAML-looking content and unfenced yaml blocks
- [x] #7 The YAML parser dependency is exact-pinned, human-approved before install, and justified in implementation notes
- [x] #8 YAML hardening: parsed with the core/plain schema only, no custom tags; the package's alias limit is set explicitly and an alias-bomb fixture fails closed as a load error; the loader documents its YAML version stance
- [x] #9 SPEC.md section 5 documents the duration grammar precisely alongside the load rules, landed in the same commit as the loader (drafted wording flagged to the human at review)
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Dependency: yaml exact-pinned (human-approved 2026-08-05 with hardening conditions as ACs).
2. src/core/policy-load.ts: locate APPROVAL.md/APPROVALS.md (precedence), extract exactly one ```yaml approval-policy fence, parse with the yaml package in core/plain-schema mode (no custom tags, explicit maxAliasCount), validate via APRV-2 harness, return PolicyLoadResult = ok(policy+durations in ms) | fail-closed(code: file-missing|no-block|multiple-blocks|yaml-error|schema-invalid, message).
3. Deterministic duration parser matching the schema grammar ^[1-9][0-9]*(ms|s|m|h|d|w)$.
4. SPEC section 5 duration-grammar paragraph, same commit.
5. Fixtures: prose-with-yaml-lookalikes, unfenced yaml, alias bomb, both-files precedence, every failure code.
6. Opus subagent implements; fable reviews, gates from clean, finalizes, merges, pushes; then APRV-11.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Dependency: yaml@2.9.0 exact-pinned (human pre-approved with hardening conditions; zero transitive deps). Implemented by Opus subagent; fable review found nothing to override. Two empirical findings worth keeping: (1) yaml 2.9.0 resolves known !! tags (e.g. !!timestamp -> Date) even under schema:"core", so the loader adds an explicit visit() pass rejecting ANY tagged node — without it the no-custom-tags AC would have been nominally satisfied and actually false; (2) maxAliasCount is a ToJSOptions field, not ParseOptions — passing it to parseDocument() type-errors and parse() silently ignores it; the bound (MAX_ALIAS_COUNT=32) is applied at document.toJS(), where expansion happens; alias-bomb fixture fails closed as yaml-error. Warnings also fail closed (recovered-from constructs are silent reinterpretation). YAML 1.2 core stance documented in the module header (1.1 yes/no are strings -> fail the autonomy enum loudly). Accepted judgment calls: unterminated fence -> no-block with "unterminated" in the message (CommonMark would close at EOF; a truncated policy must not load); durations as a typed field (approvalTtlMs) not an open map — approval_ttl is the only policy-schema duration today, so a new one is a compile-time prompt; unreachable grammar-drift backstop returns schema-invalid. SPEC section 5.2 duration-grammar bullet (fable-drafted wording, human pre-approved in intent) landed same-commit. Repo APPROVAL.md loads in place: approvalTtlMs 86400000. Verified from wiped node_modules/dist: 335/335 tests, lint, typecheck green.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
src/core/policy-load.ts: fenced-block policy loader (APPROVALS.md fallback, precedence tested) with hardened YAML 1.2 core parsing — explicit tag rejection, bounded alias expansion, warnings fail closed — schema validation, typed fail-closed result (file-missing/no-block/multiple-blocks/yaml-error/schema-invalid), deterministic duration parser, and the SPEC section 5.2 duration-grammar bullet same-commit. 68 new tests incl. alias bomb and the real APPROVAL.md loading in place. Verified: 335/335, lint, typecheck from clean install.
<!-- SECTION:FINAL_SUMMARY:END -->
