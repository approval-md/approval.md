---
id: APRV-350
title: >-
  Meta Muse Code harness adapter: approval hook muse answers the PreToolUse
  envelope, the hooks file is a gate organ, and the two deciding facts are
  probed live
status: To Do
assignee: []
created_date: '2026-09-17 02:21'
labels:
  - muse
  - hook
  - harness
dependencies: []
priority: high
ordinal: 267000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter wants first-class approval.md support for Meta Muse Code agents (2026-09-17), the same standing Claude Code has and Codex is getting. docs/integrations-considered.md gained a Muse section on 2026-09-17 (APRV-347, PR #411) marked parked and unverified: Meta documents a hook system with PreToolUse and a committable .muse/hooks.json, but the two facts that decide whether an adapter can be enforcement rather than advice, whether the hook payload carries the per-call working directory and whether the harness fails closed on hook crash, timeout or malformed output, came only from third-party sites, one of which disputes the vendor docs about the config path that ships. This task settles those facts first and builds the adapter second, in the APRV-243 shape (Grok Build) with the Claude Code adapter as the reference (src/cli/hook.ts adapter table, docs/claude-code-hook.md). A sibling name collision is recorded in the register: Meta's consumer Muse personal agent is a different product with a money-and-mail surface and is out of scope here. The muse read jail (APRV-347) needs nothing from this task: a session under ~/dev/muse with its own APPROVAL.md is already confined; this task is about Muse Code's native shell, write and read tools reaching the gate at all. Related: APRV-347, APRV-243, APRV-311, APRV-348.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A live probe on an installed Muse Code (human-installed; the installer is opaque to the classifier) records, verbatim, the PreToolUse envelope for one shell command, one file write and one file read, the config path the installed version actually reads, and the observed behaviour on hook crash, timeout and malformed output with file effects and exit codes; the result goes in the task notes and the register entry moves from parked to adopted or declined
- [ ] #2 approval hook muse parses the Muse envelope, resolves the class through the same core as claude-code, cursor and codex (including read.file.out_of_scope for its read tools and the fileTools and readTools tables), and answers the verdict in Muse dialect with the deny form the probe established; it never asks
- [ ] #3 The Muse hook config the human commits is printed by --help with a per-hook timeout above --timeout, and the hooks file path classifies policy.core like .cursor/hooks.json and .grok/hooks/
- [ ] #4 docs/muse-hook.md states what the hook binds, what it cannot cover, and the fail-open or fail-closed finding plainly; SPEC 6.3 gains the harness row only if the behaviour supports enforcement, with the amendment called out; conformance vectors cover allow, deny, unparseable input and the post-event no-op
- [ ] #5 If the probe shows the payload omits the working directory or the harness fails open, the adapter ships in the same refuse-early shape as the Codex native hook (hook-unsupported-execution-context) and the task notes name the upstream ask, mirroring APRV-348
<!-- AC:END -->
