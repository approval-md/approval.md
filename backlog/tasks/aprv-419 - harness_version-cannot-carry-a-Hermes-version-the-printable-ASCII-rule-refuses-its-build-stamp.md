---
id: APRV-419
title: >-
  harness_version cannot carry a Hermes version: the printable-ASCII rule
  refuses its build stamp
status: Done
assignee:
  - '@claude-nonav'
created_date: '2026-09-21 02:52'
updated_date: '2026-10-17 01:02'
labels:
  - schema
  - hermes
  - harness
dependencies: []
priority: low
ordinal: 322000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The provenance pair a hook-written record carries (payload.harness, payload.harness_version, APRV-227) is empty for every Hermes session, and nothing says so at the time.

Why: hermes --version prints "Hermes Agent v0.21.3 (2026.9.14) · upstream 913d4098". The separator is U+00B7, and both normalizeHarnessVersion in src/core/harness-version.ts and the schema pattern for payload.harness_version require printable ASCII on one line (SPEC section 11.1 invariant 3, no exception for provenance). So the whole line is refused, the version is absent, and a Hermes task.registered or gate.bypassed carries neither half of the pair.

Consequences, both small and both real. The doctor row harness-version-unverified can never make its recorded-versus-installed comparison for hermes: it reports "no baseline to compare against" forever. And the fail-closed version floor APRV-415 added had to be read from the installed binary rather than from a record, which is why installedHarnessVersionRaw exists beside installedHarnessVersion.

Options for a human to choose between, none of them taken here because each is a write-boundary decision rather than a tidy-up. (a) Leave it: absence is honest, the floor row covers the one question that matters, and the cost is one doctor comparison nobody has. (b) Widen the recordable form to printable Unicode minus control characters, which is a schema change and its own conformance bump, and which re-opens the question the ASCII rule was written to close (a banner quoting a credential). (c) Record a NORMALIZED projection, for instance the build stamp and the upstream commit as separate ASCII fields, which keeps the rule and loses the verbatim line. (c) is the most likely right answer and it is still a schema change.

Found while building the floor in APRV-415; recorded there in the implementation notes as well.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 SPEC and the schema state which of the three options was chosen, and why, before any code moves
- [x] #2 if the recordable form changes, schema/event.schema.json, normalizeHarnessVersion and the schema-validation conformance suite move together with a version bump
- [x] #3 approval doctor's harness-version row says something true about hermes either way: a comparison, or the reason there can never be one
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Decision (Carter, 17 Oct 2026, relayed by the claude-nonav lead as D-7): option (c) in its no-schema form. Record the printable-ASCII prefix of the version line; the field, the schema pattern and the 64-character cap stay as they are.

1. src/core/harness-version.ts: add printableAsciiPrefix(), the one place the rule lives (the leading run of U+0020..U+007E; it stops at the first byte outside that range, so non-ASCII, control characters, the newline and everything after any of them are cut). normalizeHarnessVersion becomes: first line, trimmed, its printable-ASCII prefix, trimmed again, null when empty or over HARNESS_VERSION_LIMIT (64). Over the cap stays a refusal rather than a truncation.
2. Every value the new rule returns is a value the old rule accepted as a whole line, so schema/event.schema.json validation, readHarnessProvenance and the conformance vectors do not move; only the schema description text records the choice (AC1).
3. tests/harness-version.test.ts: unit test for printableAsciiPrefix and the new normalizeHarnessVersion cases (Hermes line, control char, non-ASCII, cap); a hook-to-doctor test that a hermes record carries the prefix and doctor compares it.
4. src/cli/doctor.ts comments and docs (claude-code-hook.md, cursor-hook.md, cli-reference.md, hermes-hook.md): say what a Hermes record now carries; the floor stays read from the raw line because the prefix drops the upstream commit.
5. npm test via the tier gate.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Decision: Carter, 2026-10-17, relayed by the claude-nonav lead as D-7 of APRV-decisions-batch.md: option (c) in its no-schema form, record the printable-ASCII prefix of the version line. This is a variant of (c) the description does not list: it keeps the field, the schema pattern and the 64-character cap, and loses the upstream commit rather than adding new ASCII fields.

What changed:
- src/core/harness-version.ts: printableAsciiPrefix() is the one place the rule lives (the leading run of U+0020..U+007E; the first control or non-ASCII character and everything after it are cut). normalizeHarnessVersion is now first line, trimmed, prefix, trimmed again, null when empty or over HARNESS_VERSION_LIMIT (64). Over the cap stays a refusal, never a truncation: the cap keeps banners out and a truncated banner is still a banner.
- Hermes now records "Hermes Agent v0.21.3 (2026.9.14)" from "Hermes Agent v0.21.3 (2026.9.14) · upstream 913d4098".
- schema/event.schema.json: description text only for payload.harness_version (pattern, maxLength, minLength unchanged).
- src/cli/doctor.ts: comments only. The fail-closed floor (APRV-415) still reads the raw installed line, because the prefix drops the upstream commit.
- Docs: claude-code-hook.md, cursor-hook.md, cli-reference.md (harness-version-unverified row), hermes-hook.md.

Invariant touched (SPEC §11.1 invariant 3, raw secrets never in the log): the set of recordable values is unchanged. Every string the new rule returns is one line of 1..64 printable-ASCII characters, which the old rule accepted as a whole line; what changes is that a line with a non-ASCII or control character after an ASCII prefix now records that prefix instead of nothing. A banner that is ASCII from its first byte is bounded exactly as before (first line, 64 cap). Invariant 4 (self-reported fields never reduce scrutiny) is unaffected: the field's only reader is still the doctor row, which can only add a red line.

Known consequence: the cut is per character, so a version token with a non-ASCII character inside it records a truncated token ("2.0.14-café" records "2.0.14-caf"). Both sides of doctor's comparison are normalized the same way, so the comparison stays consistent. Cutting back to the last space before the non-printable character was considered and not done, because the ruling defines the prefix rule exactly.

SPEC.md: no text on harness_version exists on main (grep: 0 hits), and the D-7 ruling adopted the batch's recommendation that the prefix form needs no SPEC amendment, only docs. AC1 is met by the schema description and docs/claude-code-hook.md; no SPEC hunk.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
harness_version now records the printable-ASCII prefix of the harness version line (APRV-419 option (c), no schema change), so Hermes records carry "Hermes Agent v0.21.3 (2026.9.14)" and approval doctor's harness-version-unverified row compares Hermes like any other harness. The rule lives in printableAsciiPrefix() in src/core/harness-version.ts with unit tests; an end-to-end test drives approval hook hermes to a record and doctor to a pass on the same build and a fail on a later build of the same semver. AC2: the recordable form (the set of values the schema admits) did not change, so no schema, conformance or version bump moved; conformance passed unchanged. Verified with tsc, oxlint, the harness/hermes/doctor/schema test files (240 pass) and conformance/run.mjs (exit 0), plus the tier gate recorded in the PR.
<!-- SECTION:FINAL_SUMMARY:END -->
