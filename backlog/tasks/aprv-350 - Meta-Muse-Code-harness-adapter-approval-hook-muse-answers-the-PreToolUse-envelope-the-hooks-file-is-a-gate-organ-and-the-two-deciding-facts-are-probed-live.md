---
id: APRV-350
title: >-
  Meta Muse Code harness adapter: approval hook muse answers the PreToolUse
  envelope, the hooks file is a gate organ, and the two deciding facts are
  probed live
status: In Progress
assignee:
  - '@opus-lane-muse'
created_date: '2026-09-17 02:21'
updated_date: '2026-09-17 07:49'
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

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Gather first-party evidence read-only: the launcher at the user local bin path, and narrow grep over the shipped binary for hook vocabulary, config paths and model keys. One Sonnet research subagent for Meta's own published docs, Meta-owned URLs only.
2. Ship the probe script first, as its own PR, because Carter is waiting to run it. scripts/probes/muse-hook.mjs on the grok-build-hook.mjs pattern: setup builds a scratch project of synthetic files only with candidate hook configs inside it; record is the hook entry and carries the contributor-model guard; arm makes the next call crash, hang, print garbage or deny; report leads with the model line.
3. Test it with canned envelopes so no Muse install is needed: synthetic-only scratch, contributor denies, unknown denies, standard allows, armed trials behave, report ordering.
4. Wait for Carter's report, then build the adapter on the observed facts in the APRV-243 shape.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Probe shipped ahead of the adapter (first PR) so the human step is unblocked early.

FIRST-PARTY EVIDENCE, gathered read-only from the installed build 1.3.0-R3233.1. The launcher is a shell script that only authenticates and updates; it names the credential path under the user config muse directory (never read here), and the hosts api.meta.ai, auth.meta.com and lookaside.facebook.com, which is reusable for APRV-351. A narrow grep over the shipped binary finds the hook vocabulary is CLAUDE-SHAPED and camelCase: hookSpecificOutput, hookEventName, permissionDecision, permissionDecisionReason, alongside PreToolUse and PostToolUse. It ALSO carries a snake_case permission_decision, so the dialect is genuinely ambiguous and the probe emits a superset rather than guessing. The event names present as JSON strings are PreToolUse, PostToolUse, PermissionRequest, UserPromptSubmit, Stop and Notification. Entry keys present: hooks, event, events, command, type, run, when, timeout. The key matcher, which Claude Code's schema turns on, is ABSENT, so the entry shape differs and the probe writes three candidate configs with three plausible shapes and reports which fired. managed_hooks_path is present in the binary, corroborating Meta's configuration docs against the third-party source that disputed them.

META-SOURCED RESEARCH, Meta-owned URLs only. Model selection lives in the user config settings.json under the key model, with a per-run model flag and an in-session models command; there is NO project-level model setting, so the probe cannot pin one and says so in capitals. Tiers are named Contributor and Standard and the tier is carried in the id as a contributor suffix; Meta documents the Contributor variant as trading a lower price for permission to train on prompts and completions, and Standard as never used for training. Known ids: muse-spark-1.2 and 1.3, each with a contributor counterpart. Meta's changelog says hook payloads carry the session's canonical model_provider; a provider is not a tier, so the probe records it and refuses to decide on it. Meta documents the sandbox as Seatbelt on macOS with a sandbox-network flag offering proxy-only, restricted and enabled, which is directly relevant to APRV-351. The exact hook payload schema, verdict dialect, per-hook timeout and crash behaviour are NOT in Meta's published docs; only a third-party source claims them, so the probe observes them instead.

GUARD DESIGN. Allow-list, not deny-list, with the contributor mark checked FIRST so an operator declaration can widen the guard but never launder a contributor model. No model, unknown model, unparseable envelope and a brand-new id all land on deny. Invariants touched, SPEC section 11.1: fail closed (unknown model denies, an unwritable capture never becomes an allow, a crashing arm prints no verdict at all); self-reported fields never reduce scrutiny (the envelope's own model string can only ever fail the check, and passes only by matching what the operator declared independently out of band at setup, which is the operator's authority rather than the harness's).

A SECOND REASON the scratch project holds nothing real, found in Meta's configuration docs: Muse Code reads a trusted workspace's AGENTS.md and CLAUDE.md as agent instructions. The scratch project deliberately contains none of them and the test asserts their absence.

Verification: node scripts/run-tests.mjs --only probe-muse-hook, 10 tests, 10 pass, 0 fail, exit 0. Build, typecheck and lint all exit 0.
<!-- SECTION:NOTES:END -->
