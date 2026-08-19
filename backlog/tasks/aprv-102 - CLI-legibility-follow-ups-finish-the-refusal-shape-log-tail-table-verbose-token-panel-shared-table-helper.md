---
id: APRV-102
title: >-
  CLI legibility follow-ups: finish the refusal shape, log tail table,
  --verbose, token panel, shared table helper
status: Done
assignee:
  - '@fable'
created_date: '2026-08-19 12:32'
updated_date: '2026-08-19 16:05'
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
- [x] #1 Every human-readable refusal across src/cli (execute, audit, channel, env, hook, gate) renders through refusal() from style.ts; a test sweeps stderr of each refusing path and finds no "approval: <code>:" line
- [x] #2 log tail renders as an aligned table (seq right-aligned, timestamp muted, event in key, actor coloured by kind); doctor and status accept --verbose restoring the sentence form; the granted-token panel renders as the rule-boxed block from the APRV-91 brief with the token itself uncoloured
- [x] #3 style.ts exposes one n-column table helper and the queue and hook classify renders use it; amend uses glyph <code> <message> order; FORCE_COLOR accepts any non-empty value other than 0/false
- [x] #4 No colour on copyable values including timestamps and seq numbers, asserted by the existing cli-style-render sweep; --json output byte-identical before and after (tests pin it)
- [x] #5 mcp serve refusals carry no SPEC citation and mcp is in the cli-help verb sweep; examples/email-demo.md doctor transcript matches the shipped row count
- [x] #6 npm test and lint pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, worktree from main merged with aprv-101-hook-log-scope (shared hook.ts lines). 2. refusal() everywhere in src/cli human output; sweep test for the old "approval: code:" grammar; gate keeps no fix line. 3. log tail table (piped bytes kept if pinned), doctor/status --verbose, tokenPanel helper used by grant, telegram listener, cli channel. 4. One n-column table helper; queue and hook classify use it; amend glyph order; FORCE_COLOR truthy. 5. No paint on timestamps/seq; --json byte pins. 6. mcp refusals drop SPEC citation; mcp in cli-help sweep; email-demo doctor transcript recaptured. 7. PR by branch, auto-merge; records here.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Opus subagent build, PR by branch aprv-102-legibility-followups (#82). All 18 "approval: code: message" sites in src/cli converted to refusal(); a sweep test drives 16 refusing paths under NO_COLOR and asserts none print the old grammar (non-vacuous: at least 12 glyph lines) and that a gate refusal has no fix line and no help. log tail: piped and NO_COLOR bytes kept byte-identical (tests/cli.test.ts pins the tab-separated line and three example transcripts print it); alignment, right-aligned seq, key event and actor-by-kind colour apply only when colour is enabled; DEPARTURE FROM THE 91 BRIEF: tail timestamp is undressed, because AC 4 (no colour on copyable values, timestamps included) outranks the brief muted marking; same for queue requested. status and doctor --verbose restore the sentence form; --json byte-identical with and without it (pinned). tokenPanel(style, actionKey, token, notice) in style.ts used by gate grant, the Telegram listener and the cli channel; token line bare, asserted byte-exactly; web channel HTML and --json untouched. One alignment engine table(style, rows, {header, align, gap, gaps, indent, underHang}); the 2-column Style.table rebuilt on it with pinned bytes unchanged; queue and hook classify use it. amend uses refusal(). FORCE_COLOR accepts any non-empty value other than 0/false (11 matrix rows). The paint sweep now inspects every painted run and fails on an ISO timestamp or seq N inside one. mcp serve --as refusal lost its SPEC citation; mcp usage errors adopted the pointer convention (they printed the whole MCP_HELP); mcp joined the cli-help verb sweep plus an awaited test. email-demo doctor transcript recaptured from a real NO_COLOR run: eleven rows, 9 ok, 2 not applicable. doctor truncation narrower than the brief: only with a known stdout width, minimum 20 detail columns, never a fix line; no pinned doctor byte moved. DOCTOR_HELP folded --verbose into a shared line to stay at 25. ttlOf called once in the queue render. Tests changed deliberately: cli.test (corrupt line), cli-amend (schema-invalid line), cli-token and channels-cli (token extraction from the panel), channels-telegram, e2e-demo, e2e-mcp-demo, e2e-email-demo (panel regex, "not sent to Telegram" case). 1809 tests, lint and typecheck clean. INVARIANT 6 touched: human refusal grammar unified; codes and --json objects unchanged and pinned.

Merged at 87bdd48 via auto-merge behind ci.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The visual layer from the APRV-91 brief is complete: one refusal grammar across src/cli (sweep-tested), aligned log tail/queue/status/doctor with --verbose, a shared token panel, one table engine, no paint on copyable values, mcp refusals clean. PR #82 merged at 87bdd48; verified by 1809 tests incl. the refusal sweep, paint sweep, --json byte pins, lint and typecheck.
<!-- SECTION:FINAL_SUMMARY:END -->
