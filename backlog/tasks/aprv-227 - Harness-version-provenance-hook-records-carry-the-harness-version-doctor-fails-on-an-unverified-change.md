---
id: APRV-227
title: >-
  Harness version provenance: hook records carry the harness version, doctor
  fails on an unverified change
status: To Do
assignee: []
created_date: '2026-09-02 17:00'
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
