---
id: APRV-408
title: >-
  doctor harness-hook-wiring derives its tool roster from the Claude adapter,
  reports the held read tools, and binds the handler --dir to this checkout
status: Done
assignee:
  - '@opus-lane-aprv408'
created_date: '2026-09-20 19:03'
updated_date: '2026-09-20 19:27'
labels:
  - doctor
  - hook
dependencies: []
references:
  - docs/claude-code-hook.md
  - private/approval-capability-inventory-spec.md
priority: medium
ordinal: 314000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Origin: a ChatGPT proposal (private/approval-capability-inventory-spec.md, 2026-09-20) for a new approval capabilities verb. Every factual claim in it checks out at HEAD, but its headline finding (Read, Glob, Grep declared by the Claude adapter and absent from the committed matcher) is the deliberate, documented default of docs/claude-code-hook.md (a read is the most frequent tool call and every match is a Node start; APRV-347 notes). Carter chose the small version: repair the existing doctor row, no new verb, no schema, no MCP snapshot import, no log projection. Four things are worth keeping. (1) The harness-hook-wiring row in src/cli/doctor.ts compares the PreToolUse matcher against a hand list GATED_TOOLS = [Edit, Write, Bash]; the Claude adapter in src/cli/hook.ts gates Bash plus Edit, Write, MultiEdit, NotebookEdit, so a matcher of Bash|Edit|Write passes doctor today while MultiEdit and NotebookEdit writes reach protected paths unclassified. (2) The row says nothing about the adapter readTools, so the operator who held the read-scope line cannot see from doctor that it is held. (3) The handler is matched by the substring approval hook; nothing checks that --dir names this checkout primary root, and the committed file hardcodes one absolute path, so a clone elsewhere gates against a directory that does not exist. The Codex row already has a strict parse (isDirectCodexHookCommand); Claude Code has none. (4) A matcher tool the adapter does not handle is reported as covered although the hook answers it through the not-a-gated-tool passthrough. Not touched: .claude/settings.json (policy.core), APPROVAL.md, SPEC.md, the verb registry, schemas. The row stays advisory except for a positively misbound handler.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The gated-tool roster of harness-hook-wiring is the Claude adapter shellTool plus fileTools read from HARNESS_ADAPTERS in src/cli/hook.ts; the hand list GATED_TOOLS is deleted. A fixture matcher of Bash|Edit|Write reports MultiEdit and NotebookEdit as not wired; the committed matcher still passes
- [x] #2 Every adapter readTools entry absent from the matcher is named in a separate non-failing line that says it is left out by design and points at the documented matcher line in docs/claude-code-hook.md; adding the three tools to a fixture matcher removes the line
- [x] #3 A matcher tool the adapter does not handle (not shell, file, read, or passthrough) is reported as matched but answered allow unclassified; a fixture matcher ending in |WebFetch shows it
- [x] #4 The handler command is parsed rather than substring-matched: executable basename approval, verb hook claude-code, and a --dir value. A --dir that is absent, relative, or resolves to a directory other than this checkout primary root (primaryRoot from src/cli/git-scope.ts, falling back to repoRoot) is reported with both paths named; a different root is a fail; a command the parse cannot read (wrapper, shell function, substitution) is a skip that says the binding is unresolved and is never a pass
- [x] #5 Matcher patterns are split on | only; a pattern containing any other regex metacharacter, or an empty pattern, is reported as matching by pattern with tool coverage not resolved, and inspection completes on a hostile nested-quantifier pattern
- [x] #6 harness-hook-outcomes uses the same handler parse for its PreToolUse and PostToolUse detection so the two rows cannot disagree about which entries are ours; its existing test outcomes in tests/cli-hook.test.ts are unchanged
- [x] #7 Row names are unchanged so tests/doctor-rows.ts and doctor --help need no roster edit; build, typecheck, lint, and the doctor, hook and harness-enum suites pass; docs/claude-code-hook.md gains one short paragraph on what the row now reports; implementation notes name the SPEC 11 invariants touched
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. doctor.ts: read HARNESS_ADAPTERS["claude-code"] (exported from src/cli/hook.ts, no new export) and derive the gated roster (shellTool + fileTools); delete GATED_TOOLS.
2. Pure helper parseClaudeHookCommand(command) modelled on isDirectCodexHookCommand but returning the --dir value or an unresolved reason; use it in approvalHookMatchers and registersApprovalHook. Leave HOOK_COMMAND and registeredHarnesses for the other harnesses byte-identical.
3. Pure helper matcherTools(pattern): string[] | "pattern" (split on | only, any other regex metacharacter or empty means pattern).
4. Extend checkHarnessWiring: derived roster gap (skip), read-tools line (informational, points at docs/claude-code-hook.md matcher line), passthrough line, binding result (different root: fail; unresolved: skip; keep the existing pass sentence that presence is NOT proof the session loaded it).
5. Tests through runCli doctor --json in a git-init temp dir so primaryRoot resolves: AC1 to AC5 fixtures plus the hostile-pattern completion case; keep tests/cli-hook.test.ts outcomes test green.
6. docs/claude-code-hook.md: one paragraph under the self-test section.
7. build, typecheck, lint, suites; implementation notes with the SPEC 11 statement.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
APRV-408 implementation, 2026-09-20.

WHAT WAS DONE. harness-hook-wiring derives its gated roster from HARNESS_ADAPTERS[claude-code] in src/cli/hook.ts (shellTool plus fileTools: Bash, Edit, Write, MultiEdit, NotebookEdit); the hand list GATED_TOOLS is deleted, and the map was already exported, so no new export was added. Four new pure helpers in src/cli/doctor.ts: parseClaudeHookCommand (a tokenizing parse modelled on isDirectCodexHookCommand, tolerant of flag order and of --as/--timeout being absent, strict about the three facts that decide the binding: executable basename approval, the verb hook claude-code, and the --dir value); claudeHookEntries (one reading of which entries in .claude/settings.json are ours, used by BOTH harness rows so they cannot disagree, AC6); matcherTools (split on the pipe only, any other regex metacharacter or an empty matcher means coverage is not resolved; the pattern is never compiled, so a hostile nested quantifier costs one anchored character-class test per alternative); describeBinding (--dir compared against primaryRoot of the doctor dir, falling back to repoRoot, both sides realpath-resolved).

VERDICTS. Roster gap: skip, naming the uncovered tools. Matcher that is not a plain pipe-joined list: skip that resolves no coverage either way and withholds the roster, read-tool and passthrough lines rather than computing them against a set that may be incomplete. Binding absent, relative, unresolved, or uncomparable because git could not say: skip, never a pass. Binding to a DIFFERENT checkout: the row's one fail, since such an entry answers from another policy, another log and another open window. Two informational lines that never decide anything: the adapter readTools the matcher leaves out (Read, Glob, Grep), named as the documented default with a pointer at the read-scope matcher in docs/claude-code-hook.md, and a matched tool the adapter handles as neither shell, file, read nor passthrough, named as the unclassified allow the hook will actually return. The APRV-151 sentence that the file being present is NOT proof the session loaded it is preserved verbatim on the pass path.

DECISIONS WORTH KNOWING. (1) An empty matcher used to read as full coverage and now reads as unresolved: Claude Code treats matcher as a regular expression, this row will not evaluate one, and a coverage claim is better written down than inferred. (2) A command the parse cannot read counts as OURS for registration, so a wrapped handler does not read as no hook registered, and never counts as a bound one. The mention test is the verb hook claude-code rather than the word approval, because a wrapper (dollar-paren substitution, bash -lc, a function name) is exactly what hides the executable. (3) harness-hook-outcomes now uses the same parse, so an approval hook cursor entry parked in Claude Code's own settings file no longer reads as Claude Code's post-execution reporter; its three detail strings now name the verb as hook claude-code. (4) Outside the stated criteria but left true: the harness-hook-wiring bullet in docs/cli-reference.md named a roster that had drifted the same way the code had (it omitted MultiEdit), so it was corrected alongside.

SPEC SECTION 11 GLOBAL INVARIANTS TOUCHED. Self-reported fields never reduce scrutiny: the row still asks the session nothing about itself. Every line it added comes from the settings file on disk or from git rev-parse, never from the process under oversight reporting on its own oversight, and nothing a session could write about itself widens any verdict. Fail closed: every shape the parse cannot read (shell metacharacters, unclosed quoting, a non-approval executable, a relative executable path, a --dir flag with no value) resolves to unresolved, which is reported and is never a pass, and the same holds for a matcher that is not a plain tool list. Enforcement paths unchanged: doctor appends nothing and writes nothing, the log is untouched, and the single new verdict is the fail for a handler positively bound to another checkout, which is a disk fact rather than a claim.

FILES. src/cli/doctor.ts; tests/cli-doctor-wiring.test.ts (new: nine cases, each on its own real git init checkout so primaryRoot resolves, including the hostile nested-quantifier pattern and the three unreadable command shapes); docs/claude-code-hook.md (one paragraph under the self-test section); docs/cli-reference.md (bullet corrected). Row names are unchanged, so tests/doctor-rows.ts, the docs guard and doctor --help needed no edit.

CHECKS. npm run build exit 0. npm run typecheck exit 0. npm run lint exit 0. node scripts/run-tests.mjs --only cli-doctor cli-hook harness-enum cli-doctor-wiring: 245 tests, 245 pass, 0 fail, exit 0. Adjacent sweep --only docs-guard cli-doctor-codex dark-session cli-long-help cli-coverage cli-help agent-sdk-hook: 109 tests, 109 pass, exit 0. Built CLI in this worktree: harness-hook-outcomes pass, harness-hook-wiring pass with the binding resolved to /Users/carter/dev/approval-md (the primary root, while the row ran in the linked worktree), the read-tools line naming Read, Glob, Grep as held by design, and no passthrough line. The run's exit 1 comes from pre-existing environment rows (identity, sampling secret, envelope-integrity, dark-sessions, live-draw, sender-mapping), none of them these two.

Orchestrator review 2026-09-20: re-ran build, typecheck, lint (all exit 0) and node scripts/run-tests.mjs --only cli-doctor cli-hook harness-enum cli-doctor-wiring docs-guard cli-doctor-codex cli-help: 279 pass, 0 fail. Diff reviewed: one derived roster, parse fails closed, matcher never compiled, both rows share claudeHookEntries. Deliberately NOT done: the ChatGPT proposal approval capabilities verb, its JSON schema, MCP snapshot import, verified-log projection, classes view and strict mode; no task filed for them. The read-scope matcher line stays held (policy.core, docs/claude-code-hook.md states the cost).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
harness-hook-wiring now reads its gated roster from the Claude adapter (the hand list had drifted: MultiEdit and NotebookEdit were unchecked), names the held read tools Read/Glob/Grep as the documented default, names a matched tool the adapter would pass through, and parses the handler command to compare its --dir with this checkout primary root (different checkout: fail; unreadable wrapper or regex matcher: skip, never pass). harness-hook-outcomes shares the parse. Verified by tests/cli-doctor-wiring.test.ts (9 cases on real git checkouts) plus the doctor, hook, harness-enum, docs-guard suites: 279 pass; built CLI in the linked worktree binds to /Users/carter/dev/approval-md and passes.
<!-- SECTION:FINAL_SUMMARY:END -->
