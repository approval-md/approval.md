---
id: APRV-227
title: >-
  Harness version provenance: hook records carry the harness version, doctor
  fails on an unverified change
status: In Progress
assignee:
  - 'agent:opus-lane-n'
created_date: '2026-09-02 17:00'
updated_date: '2026-09-04 22:15'
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
- [x] #1 Hook-written `task.registered` and `gate.bypassed` payloads carry `harness_version`, taken from the hook event where the harness supplies it, else from `<harness> --version` read once per process
- [x] #2 The amended event schema validates the new field at the write boundary; records written before the field existed still validate and verify
- [x] #3 `approval doctor` gains a row `harness-version-unverified` that fails when the installed harness version differs from the version on the latest hook-written record, and passes after the hook self-test re-records it
- [x] #4 The field moves no gate verdict, budget, streak or sampling decision (test asserts a record with a mismatched or missing version resolves identically)
- [x] #5 `approval status` harness coverage figures are unaffected
- [x] #6 docs/claude-code-hook.md and docs/cursor-hook.md describe the field and the doctor row
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What was built

New `src/core/harness-version.ts` is the whole of the new mechanism: the closed harness set (`claude-code`, `cursor`), the binary map (`claude`, `cursor-agent`), the ONE normalizer both the writer and the reader call, a per-process memoized `<binary> --version` probe, and the strict read of an already-written payload.

Two OPTIONAL additive payload names, constrained regardless of event type beside `est_cost_usd` in schema/event.schema.json: `harness` (enum) and `harness_version` (one line, printable ASCII, max 64). The hook stamps them on the `task.registered` it writes through `register` (new `RegisterOptions.harness`) and the `gate.bypassed` it writes through `recordGateBypass` (new `GateBypassInput.harness`). `approval doctor` gains `harness-version-unverified`, appended fourteenth.

Commits: 6b4828e (core + schema + hook + doctor), c94c701 (tests + conformance + row-count pins), 640b8c9 (docs).

## Decisions the diff will not show

**Two fields, not one.** The task and the brief both say `harness_version`; this landed as a PAIR, `harness` beside it. One log holds the records of every harness that ever wrote to it, so a version with no binary named beside it is a string doctor cannot attribute: it would be comparing a recorded `cursor-agent` version against `claude --version` and failing the row for a change nobody made. The two travel together or not at all, and `readHarnessProvenance` refuses half a pair. The alternative considered and rejected was inferring the harness from the record's `actor`, which is caller-supplied through `--as` and therefore not a discriminator.

**A call option, never a field of the envelope.** `register` takes the pair through `RegisterOptions`, so it comes from the hook process's own event and its own PATH. An envelope field would have been a value the party under oversight authors ABOUT the binary that is supposed to be watching it, which is the shape invariant 4 exists to refuse. A CLI `approval register` passes none and writes the record it always wrote.

**Where the probe runs, and why that is the whole cost story.** `<binary> --version` is spawned at the write site of the two stamped records and nowhere else. The pass-through verdict, the autonomous verdict (which writes an `execution.started` and registers nothing) and every deny pay no spawn at all, which is what keeps APRV-186/188/212's work on hook start-up cost intact. A test pins it with a witness file the stub touches.

**The probe timeout is 10s, not the 2s first written.** A bound against a hung binary, not a latency target, and `cli/gloss.ts` sets the precedent at 20s. At 2s the new suite went intermittently absent under machine load (the CLI itself takes 10s+ to start on a loaded box here), and an absence that only appears under load is the least useful failure a provenance field could have.

**The self-test is promptless, and that is what makes the failing row honest.** A supervised class registers the task and allows with no approval lifecycle (amended SPEC §6.3, and the table at the top of the Cursor doc), so one supervised-class tool call through the upgraded hook re-records the version and clears the row without a question on anybody's phone. Both hook docs give the exact `printf | approval hook …` line.

**The shape constraint is not decoration.** `<binary> --version` is third-party process output being written to an append-only log, so the write boundary takes one line of printable ASCII capped at 64 characters. The invalid fixture is a version with a banner line quoting a token, which is exactly the arrival path SPEC §11.1 invariant 3 forbids. The normalizer cuts at the first newline before the value ever reaches the schema, and the schema refuses anything that got past it.

## SPEC §11.1 invariant 4 is touched, and how it is satisfied

`harness_version` is a self-reported field: it comes from the hook event where the harness states one, and otherwise from a binary the harness installed. Invariant 4 says a self-reported field never reduces scrutiny, and the discipline here is structural rather than careful. The field has exactly ONE reader in the whole runtime (`approval doctor`'s `harness-version-unverified`), and that reader can only ADD a red line. No verdict, no irreversibility floor, no budget, no loop streak and no sampling draw reads it; `grep` over src/ shows two write sites, one reader, one producer. A harness that states a false version defeats a check that would have asked a human to look and buys itself no permission it did not already have. Two tests pin the negative claim (AC4): three runs whose only difference is the version resolve identically, and a version already in the log moves no later verdict.

The row's PASS wording states its own limit for the same reason: a match is not proof the hook fired, only the absence of the one thing the row can see.

No NEW cross-cutting property was born, so nothing is added to the §11 global-invariant list.

## SPEC sentences to add (§10.1, hook records) — for the human to apply

> A harness hook MAY stamp the records it authors with the harness that issued them: `harness`, a value from the closed set of harnesses this runtime speaks a hook protocol for, and `harness_version`, that binary's version as one line of printable ASCII at most sixty-four characters long. Both are optional and additive, they travel together or not at all, and they appear only on `task.registered` and `gate.bypassed`. The value is taken from the hook event where the harness states one, otherwise from `<binary> --version` read at most once per process; a hook that can establish neither records neither, and never a placeholder.
>
> The pair is informational. No verdict, irreversibility floor, budget, loop streak or sampling draw reads it, which is how §11.1 invariant 4 is satisfied for a field the party under oversight supplies: its single reader is a health check that can only add scrutiny. `approval doctor`'s `harness-version-unverified` fails when the installed binary differs from the version on the newest hook-written record and passes once one record has been written under the new binary. A match is not evidence the hook fired; it is the absence of an unverified change to the binary hosting it.

## Conformance

Regenerated per conformance/README.md (`node scripts/regen-conformance-vectors.mjs`). `schema-validation` 1.3.0 -> **1.4.0**, a MINOR bump: four new fixtures (a stamped `task.registered`, a stamped `gate.bypassed`, a multi-line version, an unknown harness kind), no existing expectation moved, because the two names are optional and additive. Manifest rehashed. The two invalid vectors pin the constraint each violates: `schema-enum` on `/payload/harness` and `schema-pattern` on `/payload/harness_version`. No other suite's version changed.

## Verification (per file, exit codes read)

- `dist/tests/harness-version.test.js` — exit 0, 22/22 (new file)
- `dist/tests/cli-doctor.test.js` — exit 0, 55/55 (row-count pins 21 -> 22)
- `dist/tests/cli-hook.test.js` — exit 0, 88/88
- `dist/tests/conformance.test.js` + fixtures + event-schema + validate — exit 0, 210/210
- `dist/tests/cli-gate-window.test.js` + cli-status + gate + hook-module-graph + layering — exit 0, 126/126
- `dist/tests/docs-guard.test.js` — exit 0, 11/11
- `dist/tests/cli-help.test.js` + cli-long-help — exit 0, 32/32
- `npm run build` exit 0, `npx oxlint` exit 0

## For the orchestrator

The autonomous path writes an `execution.started` and is NOT stamped, by the design in the brief (two record types only). So a session that runs nothing but autonomous-class commands never re-records a version, and its doctor row stays red until somebody runs the self-test. That is the intended cost — the row is asking for a deliberate act — but if the red row proves noisy in practice, stamping the unattended `execution.started` too would make the re-record automatic. It is a one-line change at `recordUnattended` plus a schema note, and it is deliberately NOT in this task.
<!-- SECTION:NOTES:END -->
