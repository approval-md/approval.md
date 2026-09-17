---
id: APRV-243
title: >-
  Grok Build harness adapter: `approval hook grok` answers the PreToolUse
  envelope in Grok dialect, and the Claude-file compatibility read is probed
  live
status: In Progress
assignee:
  - '@opus-lane-closeouts'
created_date: '2026-09-02 21:10'
updated_date: '2026-09-17 01:21'
labels: []
dependencies: []
references:
  - 'https://docs.x.ai/build/features/hooks'
  - 'https://github.com/xai-org/grok-build'
  - docs/cursor-hook.md
priority: medium
ordinal: 192000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Grok Build (xAI, github.com/xai-org/grok-build, CLI `grok`) documents a PreToolUse hook modelled on Claude Code hooks: camelCase stdin fields (hookEventName, sessionId, cwd, workspaceRoot, toolName, toolInput), allow on exit 0, deny on exit 2 or stdout {"decision":"deny","reason":...}, and fail-open on timeout, crash or malformed output with no documented flag. It also states that .claude/settings.json and .cursor/hooks.json hook files are read for compatibility. If that read fires our committed claude-code hook under a Grok session, the hook parses no tool_name, prints a deny in the Claude nested envelope and exits 0, which Grok reads as allow: every command appears gated and none is. The adapter closes that gap the way `hook cursor` did for Cursor (APRV-133): recognise the Grok envelope, decide through the same deterministic core, answer in Grok dialect with exit 2 on deny. Assessed 2026-09-02 in docs/integrations-considered.md (parked until the probe below runs). Unverified for now: install is `curl -fsSL https://x.ai/cli/install.sh | bash` (classifies opaque), `grok` itself is unclassified.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A live probe on an installed Grok Build (human-installed; the installer is opaque to the classifier) records whether a Grok session fires the hook entries in .claude/settings.json, what envelope it sends, and how it treats the Claude nested output on exit 0. The result goes in the task notes and the register entry moves from parked to adopted or declined
- [x] #2 `approval hook grok` (or envelope auto-detection in the harness table in src/cli/hook.ts) parses the camelCase Grok envelope, resolves the class through the same core as claude-code and cursor, and answers {"decision":"allow"|"deny","reason"} with exit 2 on deny; never ask
- [x] #3 The Grok hook config the human commits (.grok/hooks/*.json) is printed by --help with a per-hook timeout above --timeout, and .grok/hooks/ classifies policy.core like .cursor/hooks.json
- [x] #4 docs/grok-hook.md states plainly that Grok fails open on hook timeout, crash and malformed output, that this contradicts the fail-closed invariant, and which cases the adapter cannot cover; SPEC §6.3 table gains the harness row if behaviour matches cursor
- [x] #5 Conformance tests cover allow, deny, unparseable input and the post-event no-op for the Grok dialect
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add grok to HARNESS_KINDS and HARNESS_BINARY in src/core/harness-version.ts, and to the stub binaries the test runner puts in front of PATH. 2. Add a GROK_ADAPTER to the harness table in src/cli/hook.ts with agent:grok, Bash plus the Claude file tools, and an opt-in camelCase envelope flag; route hook grok to it. 3. Teach parseHookInput to read camelCase keys for that adapter only, snake_case first so a doubled envelope cannot show the classifier one command and the harness another. 4. Emit {decision,reason} for grok and return exit 2 on deny; force the post-execution path to exit 0 on grok because a non-zero exit there is a verdict about a call that already ran. 5. Classify .grok/hooks and .grok/hooks.json as policy.core in src/core/command-class.ts beside .cursor. 6. A grok-specific --help carrying the .grok/hooks/pre-tool-use.json entry with a timeout above --timeout, under the repo 25-line short-help cap. 7. docs/grok-hook.md naming the fail-open cases and what the adapter cannot cover. 8. tests/cli-hook-grok.test.ts for allow, deny at exit 2, unparseable input, post-event no-op, dialect precedence and the protected path. 9. scripts/probes/grok-build-hook.mjs, read-only, for Carter AC1. 10. Decide the SPEC row on AC4 own condition rather than by default.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented by the closeouts lane, 2026-09-16. AC2, AC3 and AC5 are delivered and verified; AC4 is delivered with one deliberate exception, stated below; AC1 is Carter's live probe and stays open.

AC2, the adapter. The verb routes to a new GROK_ADAPTER in the harness table in src/cli/hook.ts, with originApp grok-hook, default actor agent:grok, the shell tool and the Claude Code file tools.

It resolves through the same deterministic core as the claude-code and cursor adapters, with no separate decision path: same classifier, same policy load, same verified-log read, same refusal codes. The verdict object is a decision and reason pair, and DENY IS EXIT 2, which is the whole reason the adapter exists rather than being a convenience. It is never ask; the word appears nowhere the verb can print it, and a test asserts that. The gated tools are the shell tool plus Edit, Write, MultiEdit and NotebookEdit, which follows from the harness documentation and the compatibility read rather than from an observed session; docs/grok-hook.md says so in as many words and the probe corrects the list.

Envelope parsing. parseHookInput now takes a camelCase flag, opted into per adapter rather than tolerated everywhere. The harness sends toolName, toolInput, sessionId, hookEventName, toolUseId, toolResponse, isInterrupt and workspaceRoot. snake_case is read FIRST in both dialects, so an envelope carrying both spellings resolves identically for every harness and cannot be used to show the classifier one command and the harness another; a test drives exactly that case with two different commands in the two spellings. workspaceRoot is deliberately ignored: the classifier resolves relative paths against the directory the command will run in, which is cwd, and reading a workspace root as if it were cwd would bind the wrong paths. The other adapters do not read camelCase at all, because a Claude Code event with the wrong spelling is a malformed event and the strict answer to that is the deny it already gets.

One behaviour is harness-specific and load-bearing. On every other harness the post-execution path exits 2 to make its stderr line visible. Here a non-zero exit is a verdict, and a verdict about a tool call that has already finished is meaningless at best, so the post-execution path always exits 0. The machine-readable line still goes to stderr. Losing a debug line is a smaller harm than emitting a decision the protocol will act on.

AC3. The verb has its own --help text, carrying the .grok/hooks/pre-tool-use.json the human commits, with timeout 600 against the adapter default --timeout of 9m, and a sentence saying the entry timeout MUST EXCEED --timeout with the reason: if the harness times out first it abandons the hook, fails open, and runs the command while the approver is still being asked about it. The help sits inside the repository 25-line short-help cap, which the first draft broke and cli-long-help caught. .grok/hooks and .grok/hooks.json now classify policy.core in src/core/command-class.ts, beside the .cursor and .claude branches; .grok/notes.md does not, and both directions are tested, including a Write to .grok/hooks denied through the hook itself.

AC5, conformance. tests/cli-hook-grok.test.ts, 12 cases, all green: an autonomous allow at exit 0 that records execution.started under agent:grok; a deny at exit 2 that writes nothing; a human-only class denied and never asked; unparseable input in four shapes (empty, not JSON, a JSON array, no tool name in either spelling) each a deny at exit 2 with nothing reaching the log; snake_case still read and winning over a conflicting camelCase copy; an ungated tool passing through; the post-execution no-op at exit 0 with empty stdout and the report line on stderr; the path classification; the help contents; and the shared hook help listing the new verb.

AC4, and the one deliberate exception. docs/grok-hook.md is written and states plainly that the harness fails OPEN on hook timeout, crash and malformed output, with no documented setting to change it; that this contradicts SPEC §11.1 and the fail-closed rule in CLAUDE.md; and exactly which cases the adapter cannot cover, as a table. Four rows are outside the hook entirely (timeout, missing binary, crash before printing, a verdict the harness cannot parse) and in each of them the command runs. Three are inside it and deny (no policy, unreachable log, any unexpected throw). The document also spells out the compatibility hazard the adapter exists to remove: a committed claude-code entry firing under a session of this harness denies in the nested Claude envelope at exit 0, and exit 0 is an allow here, so every command would look gated and none would be.

SPEC.md was NOT amended, deliberately, and this is the part to argue with if you disagree. AC4 asks for the harness row if behaviour matches cursor. It does not match in the one way that matters: Cursor's hook entry has failClosed, so a Cursor hook that dies still blocks and the harness language can honestly call it a gate; this one cannot be made to block. There is also no harness table in SPEC §6.3 today; the hook verbs are enumerated in the §10 verb listing. Adding a row that asserts the Cursor property would be false, and adding one with the caveat is a judgement about what the specification claims, which is the human's. The exact proposed hunk is in docs/grok-hook.md under SPEC status, ready to paste. No SPEC hunk is in this pull request.

AC1 stays open; it is Carter's. scripts/probes/grok-build-hook.mjs is the read-only probe, and runbook section 7 of private/runbook-2026-09-16.md points at it. Three modes. --arm prints the .claude/settings.json entry to install by hand and the scratch capture path; it deliberately registers the CLAUDE-shaped entry, because the question is whether a session of this harness reads THAT file, and it points at the probe rather than at the real adapter so the capture does not touch the live log. --record is the hook itself: it reads one envelope on stdin, appends it verbatim to a capture file under the system temp root, then answers deny in the nested Claude shape AND exits 0, which is precisely the combination the hazard is about. --report prints the three answers as text to paste into this task. It invokes no model, opens no network connection, touches no credential, and writes nothing outside the system temp root. The third answer, whether the tool call actually ran, is the one thing the probe cannot observe, so the report says so and asks for it. A confirmed no on answer one closes AC1 just as well as a yes: it would mean the compatibility hazard does not fire and the new verb is the only way in.

The register entry in docs/integrations-considered.md stays PARKED, with a dated status update recording that the code half landed and that parked is about the probe rather than about the adapter. The standing warning is unchanged: do not run this harness in this repository expecting the gate to hold.

Verification, all from a clean worktree, nothing run against the primary. Build, typecheck and lint each exit 0. node scripts/run-tests.mjs --only cli-hook-grok cli-hook cli-hook-cursor cli-hook-codex command-class cli-help cli-long-help cli-instructions docs-guard classify-tier ci-guard hook-module-graph: 725 tests, 725 pass, 0 fail, exit 0. node scripts/run-tests.mjs --only conformance conformance-regen harness-version cli-doctor cli-doctor-codex codex-doctor: 137 tests, 137 pass, 0 fail, exit 0. One existing test needed a one-line edit rather than a fix: harness-version pins the harness list literally, so the new kind is an explicit edit there, which is the property that test is protecting. The probe was exercised by hand end to end (arm, record with a synthetic envelope, report) and its scratch directory removed.

ACs 2, 3 and 5 checked. AC4 checked on the documentation clause, which it fully meets, with the SPEC row declined on the criterion's own condition and the proposed hunk left for the human. AC1 unchecked, runbook section 7. Task stays In Progress.
<!-- SECTION:NOTES:END -->
