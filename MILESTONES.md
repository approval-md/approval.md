# Milestones — the canonical map

Backlog.md milestone ids drifted from SPEC names during development and ids are
never renumbered. This file is the canonical mapping; a guard test
(`tests/milestones-guard.test.ts`) asserts every task's milestone id appears
here with a matching display name, so drift fails CI.

| SPEC name | Backlog id | Display name | Status | Scope |
|---|---|---|---|---|
| M0 | `m-0` | M0 - Schemas and fixtures | done | JSON Schemas for policy, envelope, events, plus the validation harness |
| M1 | `m-1` | M1 - Event log | done | Append-only hash-chained log: append, verify, reindex, log CLI |
| M2 | `m-2` | M2 - Policy engine | done | Policy load, class matching, explain, fail-closed, dogfood suite |
| M3 | `m-3` | M3 - Gate | done | Budgets, attestation, request lifecycle, tokens, run/wait/status/queue |
| M3.1 | `m-3.1` | m-3.1 (virtual) | done | Consolidation: holistic review, Part A retrofit, Part B spec pass |
| M4 | `m-5` | M4 - Channels | done | Channel contract, cli/web/telegram channels, QUEUE.md, e2e demo |
| M4.1 | `m-6` | M4.1 - Human ergonomics | done | Payload store, amend/doctor/payload verbs, README, tiering, CI |
| M5 | `m-7` | M5 - Daemon | done | approvald: watch, sampling, retention pruning, git commits, head caching, dogfood cutover |
| M6 | `m-8` | M6 - Backlog.md round-trip and AGENTS.md import | done |
| M7 | `m-9` | M7 - First adapter (email) and vault | active (demo run pending) |
| M7.1 | `m-10` | M7.1 - Setup ergonomics | done |
| M8 | `m-11` | M8 - MCP wrapper and harness hooks | active | approval instructions + schemas registry, Claude Code PreToolUse hook (APRV-82), gated SDK dep-add, agent-only MCP server over CLI code paths, e2e demo, README holistic pass | Policy-honoured env names, .approval/env source map + approval env, approval setup verbs, doctor fixes + environment check, docs cutover | Adapter contract + conformance, vault, SMTP email adapter, live channel dispatch, approval init, end-to-end SPEC demo | Round-trip writer, envelope write-back, envelope-loss detection, AGENTS.md import, format-fixture drift guard |

Retired ids: `m-4` was an empty duplicate of M3.1 created by the implicit-
creation footgun described below; it was removed and its number is not reused.
`m-3.1` exists only as a value in task frontmatter (a "virtual" milestone with
no file); it groups its three tasks correctly and is left as the historical
record.

## Standing rules

1. Milestones are created only deliberately, at decomposition time, with
   `backlog milestone add`. Task creation never names a milestone that does not
   already exist: passing an unknown value to `--milestone` silently creates a
   virtual one, which is how `m-3.1` and the `m-4` duplicate happened.
2. Ids are never renumbered. New milestones take the next free id and this map
   records the correspondence.
3. Prose (tasks, commits, reports, docs) refers to milestones by SPEC name.
   The Backlog id appears only where the tooling requires it.
