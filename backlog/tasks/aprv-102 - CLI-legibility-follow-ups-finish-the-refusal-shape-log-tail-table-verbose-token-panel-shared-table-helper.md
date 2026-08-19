---
id: APRV-102
title: >-
  CLI legibility follow-ups: finish the refusal shape, log tail table,
  --verbose, token panel, shared table helper
status: To Do
assignee: []
created_date: '2026-08-19 12:32'
labels:
  - cli
  - ux
milestone: m-11
dependencies:
  - APRV-93
priority: medium
ordinal: 94000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Remainder of APRV-91 ACs 8/13 and 9/14 after APRV-93 (PR by branch aprv-93-legibility) landed the style module. Found in the 2026-08-19 review of that PR. (a) Refusal shape: only the gate (src/cli/gate.ts) prints the glyph+code / fix-line shape; src/cli/execute.ts (run/token refusals, the highest-traffic path), src/cli/audit.ts, src/cli/channel.ts and src/cli/env.ts still print "approval: <code>: <message>", so two human refusal grammars coexist on stderr; src/cli/hook.ts hand-rolls the shape instead of calling refusal() from style.ts. (b) Tables: log tail is untouched; no --verbose flag exists on doctor or status (doctor.ts carries a comment declining it); the rule-boxed execution-token panel from the 91 brief is absent. (c) Small debts: three independent column-padding helpers (style.ts table is 2-column; execute.ts queue and hook.ts classify each pad by hand), amend.ts prints "✗ DOES NOT LOAD (schema-invalid)" inverting the glyph <code> <message> order, FORCE_COLOR honours only the literal "1", queue paints requested_ts and status paints "(seq N)" (copyable-ish values), ttlOf is called twice in the queue render, examples/email-demo.md shows 9 doctor rows under an "11 ok" summary, mcp serve identity refusal still cites "SPEC.md §11" and mcp is missing from the verb list in tests/cli-help.test.ts. --json bytes stay frozen throughout; refusal codes unchanged (SPEC §11.1 invariant 6).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Every human-readable refusal across src/cli (execute, audit, channel, env, hook, gate) renders through refusal() from style.ts; a test sweeps stderr of each refusing path and finds no "approval: <code>:" line
- [ ] #2 log tail renders as an aligned table (seq right-aligned, timestamp muted, event in key, actor coloured by kind); doctor and status accept --verbose restoring the sentence form; the granted-token panel renders as the rule-boxed block from the APRV-91 brief with the token itself uncoloured
- [ ] #3 style.ts exposes one n-column table helper and the queue and hook classify renders use it; amend uses glyph <code> <message> order; FORCE_COLOR accepts any non-empty value other than 0/false
- [ ] #4 No colour on copyable values including timestamps and seq numbers, asserted by the existing cli-style-render sweep; --json output byte-identical before and after (tests pin it)
- [ ] #5 mcp serve refusals carry no SPEC citation and mcp is in the cli-help verb sweep; examples/email-demo.md doctor transcript matches the shipped row count
- [ ] #6 npm test and lint pass
<!-- AC:END -->
