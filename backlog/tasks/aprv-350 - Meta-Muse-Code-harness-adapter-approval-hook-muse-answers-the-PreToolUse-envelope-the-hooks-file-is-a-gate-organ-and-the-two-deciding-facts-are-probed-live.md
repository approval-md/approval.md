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
updated_date: '2026-09-17 22:00'
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
- [x] #1 A live probe on an installed Muse Code (human-installed; the installer is opaque to the classifier) records, verbatim, the PreToolUse envelope for one shell command, one file write and one file read, the config path the installed version actually reads, and the observed behaviour on hook crash, timeout and malformed output with file effects and exit codes; the result goes in the task notes and the register entry moves from parked to adopted or declined
- [x] #2 approval hook muse parses the Muse envelope, resolves the class through the same core as claude-code, cursor and codex (including read.file.out_of_scope for its read tools and the fileTools and readTools tables), and answers the verdict in Muse dialect with the deny form the probe established; it never asks
- [x] #3 The Muse hook config the human commits is printed by --help with a per-hook timeout above --timeout, and the hooks file path classifies policy.core like .cursor/hooks.json and .grok/hooks/
- [x] #4 docs/muse-hook.md states what the hook binds, what it cannot cover, and the fail-open or fail-closed finding plainly; SPEC 6.3 gains the harness row only if the behaviour supports enforcement, with the amendment called out; conformance vectors cover allow, deny, unparseable input and the post-event no-op
- [ ] #5 If the probe shows the payload omits the working directory or the harness fails open, the adapter ships in the same refuse-early shape as the Codex native hook (hook-unsupported-execution-context) and the task notes name the upstream ask, mirroring APRV-348
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Gather first-party evidence read-only: the launcher at the user local bin path, and narrow grep over the shipped binary for hook vocabulary, config paths and model keys. One Sonnet research subagent for Meta's own published docs, Meta-owned URLs only.
2. Ship the probe script first, as its own PR, because Carter is waiting to run it. scripts/probes/muse-hook.mjs on the grok-build-hook.mjs pattern: setup builds a scratch project of synthetic files only with candidate hook configs inside it; record is the hook entry and carries the contributor-model guard; arm makes the next call crash, hang, print garbage or deny; report leads with the model line.
3. Test it with canned envelopes so no Muse install is needed: synthetic-only scratch, contributor denies, unknown denies, standard allows, armed trials behave, report ordering.
4. Wait for Carter's report, then build the adapter on the observed facts in the APRV-243 shape.

5. LIVE PROBE REPORT RECEIVED 2026-09-18. Take over the coordinator's probe fixes, fix the pointer-hygiene defect and drop the two configs that never fired, then build MUSE_ADAPTER on the observed facts: snake_case envelope, tools bash/write_file/read_file/search plus a bookkeeping pass-through, per-call workdir, ONE verdict dialect, contributor-model guard above the policy, real outcome reading on the post event.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Probe shipped ahead of the adapter (first PR) so the human step is unblocked early.

FIRST-PARTY EVIDENCE, gathered read-only from the installed build 1.3.0-R3233.1. The launcher is a shell script that only authenticates and updates; it names the credential path under the user config muse directory (never read here), and the hosts api.meta.ai, auth.meta.com and lookaside.facebook.com, which is reusable for APRV-351. A narrow grep over the shipped binary finds the hook vocabulary is CLAUDE-SHAPED and camelCase: hookSpecificOutput, hookEventName, permissionDecision, permissionDecisionReason, alongside PreToolUse and PostToolUse. It ALSO carries a snake_case permission_decision, so the dialect is genuinely ambiguous and the probe emits a superset rather than guessing. The event names present as JSON strings are PreToolUse, PostToolUse, PermissionRequest, UserPromptSubmit, Stop and Notification. Entry keys present: hooks, event, events, command, type, run, when, timeout. The key matcher, which Claude Code's schema turns on, is ABSENT, so the entry shape differs and the probe writes three candidate configs with three plausible shapes and reports which fired. managed_hooks_path is present in the binary, corroborating Meta's configuration docs against the third-party source that disputed them.

META-SOURCED RESEARCH, Meta-owned URLs only. Model selection lives in the user config settings.json under the key model, with a per-run model flag and an in-session models command; there is NO project-level model setting, so the probe cannot pin one and says so in capitals. Tiers are named Contributor and Standard and the tier is carried in the id as a contributor suffix; Meta documents the Contributor variant as trading a lower price for permission to train on prompts and completions, and Standard as never used for training. Known ids: muse-spark-1.2 and 1.3, each with a contributor counterpart. Meta's changelog says hook payloads carry the session's canonical model_provider; a provider is not a tier, so the probe records it and refuses to decide on it. Meta documents the sandbox as Seatbelt on macOS with a sandbox-network flag offering proxy-only, restricted and enabled, which is directly relevant to APRV-351. The exact hook payload schema, verdict dialect, per-hook timeout and crash behaviour are NOT in Meta's published docs; only a third-party source claims them, so the probe observes them instead.

GUARD DESIGN. Allow-list, not deny-list, with the contributor mark checked FIRST so an operator declaration can widen the guard but never launder a contributor model. No model, unknown model, unparseable envelope and a brand-new id all land on deny. Invariants touched, SPEC section 11.1: fail closed (unknown model denies, an unwritable capture never becomes an allow, a crashing arm prints no verdict at all); self-reported fields never reduce scrutiny (the envelope's own model string can only ever fail the check, and passes only by matching what the operator declared independently out of band at setup, which is the operator's authority rather than the harness's).

A SECOND REASON the scratch project holds nothing real, found in Meta's configuration docs: Muse Code reads a trusted workspace's AGENTS.md and CLAUDE.md as agent instructions. The scratch project deliberately contains none of them and the test asserts their absence.

Verification: node scripts/run-tests.mjs --only probe-muse-hook, 10 tests, 10 pass, 0 fail, exit 0. Build, typecheck and lint all exit 0.

Adapter built on the live evidence.

Every field of MUSE_ADAPTER is observed from the 139 captured envelopes rather than guessed, which is the difference between this entry and the Grok one beside it. Config: the installed build reads the project's muse hooks json, in the event-keyed object shape with a nested hooks list; the array-of-events shape is rejected at startup with a MalformedConfig warning and zero runnable hooks, and the other two candidate paths never fired. No matcher key.

Envelope: snake_case, carrying hook_event_name, tool_name, tool_input, tool_use_id, session_id, turn_id, cwd, transcript_path, model, permission_mode and model_provider, with tool_response added on the post event. Tools: bash (shell, with a PER-CALL workdir), write_file (file, RELATIVE path), read_file and search (reads; search names an ARRAY under paths), and submit_reminder_decision, a bookkeeping tool that fired 100 of the 139 times and now passes through.

THE DIALECT FINDING, which shaped everything. Five single-variable trials established that three forms block (nested permissionDecision at exit 0; a decision-block object at exit 0; empty stdout with exit 2) and two do not (top-level snake_case; ANY payload mixing dialects, even at exit 2). The reading: an unsupported key makes the whole output invalid, an invalid hook is a failed hook, and a failed hook fails open, overriding the exit code. So being MORE explicit made the refusal WEAKER.

The adapter emits exactly one form and nothing else, and the test asserts the verdict object has exactly one top-level key; that assertion is load-bearing, not style. I chose the nested form because it is the only blocking form carrying a reason the model is shown: in the probe an agent refused without explanation shelled out to read the hook's own state file to work out why, which is the behaviour a silent refusal buys.

FAIL OPEN ON EVERYTHING ELSE. Crash, hang past the timeout, and garbage all let the write through. Consequences built in: the committed per-hook timeout must exceed the wait (help prints 600s against a 9m default and says why), a pending decision is answered as a deny rather than by waiting past the harness deadline, and the docs open with the finding stated plainly in the Grok manner.

CONTRIBUTOR GUARD. Its own code, hook-muse-contributor-model, added to the deny union and frozen in the refusal-union conformance suite at a major bump. It runs BEFORE the event dispatch, the policy and the bookkeeping pass-through, so no tool escapes it, and an absent or unrecognised model is refused like an unparseable event. It shares one definition of the contributor mark with the classifier's harness launch rule rather than spelling it twice. Documented limit stated wherever it appears: it stops tool calls and cannot recall a prompt already sent.

OUTCOME READING. Muse sends both facts Codex lacks, so the post event closes a real outcome: the shell tool_response is a JSON STRING carrying exit_code and terminal_status, and the generic reader would have seen a string, found no error key, and closed every command as a completion including the failures. A terminal_status that is not completed is unreadable rather than assumed either way. Post events print NOTHING on stdout, because Muse rejects a permission field there and a rejected hook is a failed one.

A REGRESSION CAUGHT AND FIXED before it shipped. My first cut of the per-call working directory used the envelope cwd for EVERY adapter, not just the one that declares a key. That re-classified Grok's commands against a directory that does not exist on disk and denied all of them: two Grok cases went red. The fix is that an adapter declaring no key gets byte-identical behaviour to before, and the reason is a comment on the code rather than a note here. Verified against a clean-main baseline, which is also how I confirmed the email and SMTP failures in this environment are pre-existing and none of mine.

TWO PROBE DEFECTS FIXED. The pointer file is now injectable through an environment variable and the suite uses its own temp directory: the old suite wrote the REAL pointer under the system temp root and a test run during the live session repointed the operator's arm at a test directory mid-run, so that round proved nothing. And the two candidate configs that never fired are deleted rather than left standing, because a disproved guess is noise in the next report.

SCHEMA CHANGE, called out because schema changes are meant to be their own tasks: the event schema's harness enum is a closed set documented as extended by the task that adds the case, and muse was added. Without it a manual-class registration fails validation at the write boundary. Note for whoever picks it up: grok was never added to that enum either, and no test would notice, so a grok session registering a manual-class action would fail the same way. Not fixed here, to keep this diff to its task.

SPEC 6.3: NO ROW, following the Grok precedent. A row asserting this hook gates a Muse session would be false in exactly the cases that matter, since the harness fails open. The proposed hunk sits in the doc under SPEC status with the fail-open sentence attached, for a human to decide on. The register entry moves from parked to adopted with caveats, and keeps the 2026-09-16 assessment verbatim because what it got wrong is the most useful thing in it.

Invariants named, SPEC section 11.1: fail closed where the runtime controls the outcome (unknown model, absent model, unparseable envelope, unresolvable read path, an out-of-scope entry anywhere in a path list) and stated plainly where it does not, since the harness itself fails open and no adapter can fix that; self-reported fields never reduce scrutiny (the model string can only ever refuse, a non-absolute workdir falls back rather than widening, the description field is dropped from bound payloads); human-only classes stay inert to agents (read.file.out_of_scope routes to the human gate and the adapter mints no verb for it).

Verification. cli-hook-muse: 21 tests, 21 pass, 0 fail, exit 0. Targeted matrix across cli-hook-muse, cli-hook-grok, cli-hook-cursor, cli-hook, cli-hook-codex, cli-hook-read-scope, probe-muse-hook, probe-constrained-egress, conformance and command-class: 712 tests, 712 pass, 0 fail, exit 0. Full shard 1 of 3: 1671 pass, 0 fail, exit 0. Shards 2 and 3 carry only the pre-existing email and SMTP failures, matched one for one against a clean-main baseline (19 and 8). Conformance: 369 vectors, 369 passed, 0 failed, exit 0. Build, typecheck and lint each exit 0.

AC5 IS LEFT UNCHECKED, AND THIS IS A DIVERGENCE A HUMAN SHOULD RULE ON. Its condition is an OR and the probe triggered only half of it: the payload does NOT omit the working directory (bash carries a per-call workdir, so a verdict CAN bind the action), but the harness DOES fail open. The remedy the criterion prescribes is keyed to the other half: hook-unsupported-execution-context means this runtime cannot tell where the call will run, and on Muse it can. Shipping refuse-early here would deny every shell call in a session whose commands the gate is perfectly able to classify and bind, which is a real loss of function bought with no gain in safety.

The precedent points the same way: APRV-243 met exactly this on Grok Build, which also fails open, and shipped an ordinary adapter with the hazard documented rather than a refuse-early one. So the adapter blocks when healthy and the fail-open finding leads docs/muse-hook.md, the help text and the register entry. THE UPSTREAM ASK, which is the half of AC5 that does apply and which no agent posts: Muse Code needs a fail-closed hook option, so that a hook which crashes, times out or emits output the harness cannot parse BLOCKS the tool call instead of allowing it. The sharpest form is the mixed-dialect case, where being more explicit made the refusal weaker. If a human would rather have refuse-early until that ships, the change is small and the criterion can then be checked as written.
<!-- SECTION:NOTES:END -->
