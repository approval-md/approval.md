---
id: APRV-227
title: >-
  Harness version provenance: hook records carry the harness version, doctor
  fails on an unverified change
status: In Progress
assignee:
  - 'agent:opus-lane-n'
created_date: '2026-09-02 17:00'
updated_date: '2026-09-04 21:16'
labels:
  - enhancement
dependencies: []
references:
  - docs/integrations-considered.md
  - >-
    https://github.com/Dicklesworthstone/misc_coding_agent_tips_and_scripts/blob/main/UNIVERSAL_CODING_AGENT_HARNESS_UPDATER.md
priority: medium
ordinal: 183000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A harness upgrade (claude update, a global npm install, an unattended updater such as UCA on a launchd timer) swaps the binary that hosts the PreToolUse hook without any record in the log. A new harness release can change the hook envelope semantics and silently stop the gate firing. The gate cannot stop a human upgrading their own machine, and should not; what it can do is notice the effect. Records the hook writes should name the harness version that issued them, and `approval doctor` should fail when the installed harness differs from the version last recorded, until the hook self-test (docs/claude-code-hook.md) re-records it. Filed from the UCA assessment in docs/integrations-considered.md. Touches SPEC §11.1 invariant 4: the version is a self-reported, informational field and moves no verdict, no budget and no sampling probability; implementation notes must say so. The schema amendment is its own concern per CLAUDE.md and may split out.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Hook-written `task.registered` and `gate.bypassed` payloads carry `harness_version`, taken from the hook event where the harness supplies it, else from `<harness> --version` read once per process
- [ ] #2 The amended event schema validates the new field at the write boundary; records written before the field existed still validate and verify
- [ ] #3 `approval doctor` gains a row `harness-version-unverified` that fails when the installed harness version differs from the version on the latest hook-written record, and passes after the hook self-test re-records it
- [ ] #4 The field moves no gate verdict, budget, streak or sampling decision (test asserts a record with a mismatched or missing version resolves identically)
- [ ] #5 `approval status` harness coverage figures are unaffected
- [ ] #6 docs/claude-code-hook.md and docs/cursor-hook.md describe the field and the doctor row
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. New `src/core/harness-version.ts`: the HARNESS_BINARIES map (claude-code -> `claude`, cursor -> `cursor-agent`), `normalizeHarnessVersion` (first line, trimmed, printable-ASCII only, capped at HARNESS_VERSION_LIMIT=64) and `installedHarnessVersion(kind)` — one memoized spawnSync(`<binary> --version`) per process, 2s timeout, PATH-resolved with no configurable binary name (the seam `cli/gloss.ts` already uses), null on anything unclear.
2. Schema: two OPTIONAL sibling payload names constrained regardless of event type, beside `est_cost_usd` — `harness` (enum claude-code|cursor) and `harness_version` (the normalized string). Deviation from the one-field brief, and the reason is stated in the notes: one log holds both harnesses' records, so doctor needs a discriminator to know which binary a recorded version is about. Additive: older records still validate and verify. New fixtures: 2 valid, 2 invalid (multi-line version, unknown harness).
3. `core/gate.ts` `register` and `core/gate-window.ts` `recordGateBypass` accept the provenance as a CALL option (never from the envelope or the task file), and copy it into the payload only when both halves are present.
4. `cli/hook.ts`: derive the pair once per process — the hook event's own `version` field where the harness supplies one, else `installedHarnessVersion`, else absent — and pass it to `register` and `recordGateBypass`. Nothing reads it back: no verdict, floor, budget, streak or sampling path takes it as an input.
5. `cli/doctor.ts`: row `harness-version-unverified`, appended fourteenth at the end of the list. Harness kind from the `approval hook <kind>` command in this checkout's settings file; latest verified record carrying the pair for that kind; `<binary> --version`. Differs -> fail naming both versions and the self-test; no record, no harness on PATH, no hook entry -> skip with the reason. Row-count pins 21 -> 22.
6. Docs: a 'Harness version provenance' section in docs/claude-code-hook.md and docs/cursor-hook.md — the field, the doctor row, and the promptless self-test (one supervised-class command piped through the hook writes a fresh task.registered and clears the row).
7. Tests: tests/harness-version.test.ts (unit + hook end-to-end + AC4 identical-resolution + AC5 status), doctor rows, event-schema fixtures. Conformance regen per conformance/README.md, schema-validation vectors_version 1.3.0 -> 1.4.0 (minor: new vectors, no expectation moved), manifest rehashed.
<!-- SECTION:PLAN:END -->
