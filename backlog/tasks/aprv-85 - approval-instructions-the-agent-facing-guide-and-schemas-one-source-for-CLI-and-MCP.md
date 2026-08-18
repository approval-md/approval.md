---
id: APRV-85
title: >-
  approval instructions: the agent-facing guide and --schemas, one source for
  CLI and MCP
status: To Do
assignee: []
created_date: '2026-08-18 11:16'
labels: []
milestone: m-11
dependencies: []
priority: high
type: feature
ordinal: 80000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC 10.1 lists approval instructions (full agent-facing usage guide, also in --help) and 10.1 says schemas for inputs and outputs are printed by approval instructions --schemas; neither exists. It lands first in M8 because the MCP wrapper (SPEC 10.5) publishes tool descriptions and input schemas, and those MUST be derived from the same source the CLI prints, or the two surfaces drift (SPEC principle 5: CLI-first; MCP is a thin optional wrapper over the same commands). Build: a structured verb registry (src/cli/instructions.ts or a registry each verb module contributes to) carrying, per agent-facing verb: name, one-paragraph purpose, argument/flag schema (JSON Schema, hand-authored, validated by ajv at test time), --json output schema, exit codes, and the human-only marker for verbs agents must not be offered. approval instructions prints the prose guide (what to declare, how to register/request/wait/run, what refusals mean, the invariants an agent must not try to route around); --schemas prints the machine-readable registry as JSON. Existing --json outputs are pinned by tests already; the schemas here must match them (a test validates every existing --json fixture/output shape against its declared schema, so a drift in either direction fails). Do not restructure help.ts; the registry references the same help constants.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval instructions prints the agent guide; approval instructions --schemas prints a JSON registry with name, purpose, input schema, output schema, exit codes, human_only flag for every verb
- [ ] #2 Every existing --json output shape validates against its declared output schema in a test (both directions pinned); human-only verbs are marked and the marking is asserted for grant/reject/revoke/attest/amend/vault/setup/audit review/expire
- [ ] #3 The guide states the agent-facing invariants plainly (declare before execute; never author the clock; never touch APPROVAL.md or the log; refusals are final until a human acts)
<!-- AC:END -->
