---
id: APRV-419
title: >-
  harness_version cannot carry a Hermes version: the printable-ASCII rule
  refuses its build stamp
status: To Do
assignee: []
created_date: '2026-09-21 02:52'
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
- [ ] #1 SPEC and the schema state which of the three options was chosen, and why, before any code moves
- [ ] #2 if the recordable form changes, schema/event.schema.json, normalizeHarnessVersion and the schema-validation conformance suite move together with a version bump
- [ ] #3 approval doctor's harness-version row says something true about hermes either way: a comparison, or the reason there can never be one
<!-- AC:END -->
