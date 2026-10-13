---
id: APRV-303
title: >-
  Harness outcome reports do not land, so no completion clears the
  loop-escalation floor
status: Done
assignee:
  - 'agent:claude-code'
created_date: '2026-09-07 23:36'
updated_date: '2026-09-08 00:43'
labels:
  - harness
dependencies: []
ordinal: 223000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
On 2026-09-07, with session hook:e39a116c-09c5-4950-8958-1ae0a4de9c24 at four consecutive failed side-effecting tool calls, the human granted a policy.edit.spec Edit-tool request, the edit ran and completed, and the floor still read four failures on the next Bash call (npm run build was routed to the phone as loop-escalated). Eight further Edit-tool calls on the same file were then allowed without routing, so the floor's counting and routing disagree across tool kinds. APRV-287 fixed the shell case via spent_by_task.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Reproduce in tests/cli-hook.test.ts through the real append path: floor tripped, an Edit/Write tool request granted and its completion reported, and the floor is clear for the next Bash call.
- [x] #2 Identify why Edit-tool calls were allowed under the standing floor (whether the floor predicate is skipped on the Edit path, or the completion was attributed to a different scope) and make the floor predicate identical for every tool kind, as SPEC §10.2 (APRV-297 text) requires.
- [x] #3 Implementation notes say which it was.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Widened 2026-09-07 after the fact was measured on the primary log: approval status shows harness outcomes 22062 started, 10 reported, 22052 unreported. PostToolUse is registered in .claude/settings.json with the same command as PreToolUse, yet reports almost never append, so neither Bash nor Edit completions clear a streak; escalations stood on both the session scope and the whole agent:claude-code actor scope, which is the flood every session has been producing. Diagnose the post-execution path first (what the hook receives on PostToolUse, what it refuses, and where the refusal goes), then the Edit-specific case. Release blocker.

## Diagnosis, established before the fix

### Root cause: the post-execution reading was written against a payload Claude Code never sends

readReportedOutcome in src/cli/hook.ts read the outcome off tool_response.type, accepting exactly text, base64 and error, per the contract pinned in docs/claude-code-hook.md. That is the shape of an API content block. What a PostToolUse event actually carries under tool_response is the TOOL'S OWN structured output object, verbatim. From the shipped declarations in @anthropic-ai/claude-code/sdk-tools.d.ts:

- BashOutput, for Bash: stdout, stderr, interrupted, isImage, returnCodeInterpretation and more, with NO type field at all.
- FileEditOutput, for Edit and MultiEdit: filePath, oldString, newString, originalFile, structuredPatch, userModified, replaceAll. No type field.
- FileWriteOutput, for Write: it does have type, and its values are create and update, neither of which is one of the three pinned readings.
- NotebookEditOutput: no type; an optional error string instead.

So for every gated tool the reading fell through to the unreadable arm, printed post-tool-unreadable-outcome on stderr, and appended nothing. That is the whole of the 22052 unreported starts.

### Why the handful that landed were all failures

The hook's other reading was the event name: hook_event_name equal to PostToolUseFailure is a failure, with no further inspection. PostToolUseFailure is a real Claude Code event and it is registered in the primary .claude/settings.json alongside PostToolUse. Its input schema, from the shipped binary's own zod definitions and confirmed against the published hooks reference, is hook_event_name, tool_name, tool_input, tool_use_id, error, optional is_interrupt, optional duration_ms, and NO tool_response. PostToolUse's is hook_event_name, tool_name, tool_input, tool_response, tool_use_id, optional duration_ms. The reference says PostToolUse runs immediately after a tool completes successfully and PostToolUseFailure runs when a tool that started executing fails; exactly one of the two fires, and neither fires when a permission decision stopped the call before it ran.

The counterpart therefore read failures perfectly and successes never. Measured on the primary log, among records carrying reported_by post-tool-use, the agent:claude-code actor has 9 execution.failed and 0 execution.completed. Not one completion has ever been reported by this adapter. The loop streak of amended SPEC.md section 10.2 was a ratchet that only counts up, so a long session reached three and stayed escalated, first on the session scope and then on the actor scope. Both standing escalations on this log are that.

### Which branch swallowed it, and where the refusal went

runPostToolUse called readReportedOutcome, which returned not-ok because response type was undefined for Bash, Edit, MultiEdit and NotebookEdit, or create or update for Write. finishHarnessExecution was never reached, so nothing was refused and nothing was appended. The stderr line was correct and machine-readable, and nobody ever saw it: Claude Code discards a hook's stderr when the hook exits 0, and the counterpart exited 0 on every path. The coverage row of approval status is informational by design, so the flood produced no failing check anywhere.

Why the tests did not catch it: every PostToolUse case in tests/cli-hook.test.ts constructed tool_response as type text or type error. The suite pinned the documented contract against itself, and no fixture ever carried a payload Claude Code emits.

### AC 2, which was a second and independent hole: the floor predicate was skipped on the file-tool path

It was the predicate, not the scope. describeToolCall called fileToolGate, which returned null whenever protectedPathClass of the target was null, that is for every ordinary source file, and runHarnessHook then returned allow with the reason that the tool is not a gated edit. That early return sat ABOVE the harnessFloor lookup, above recordUnattended, and above everything that appends. So an ordinary Edit or Write under a tripped floor was not routed, was not counted, and recorded no execution.started that any completion could ever close. The shell path had no such hole.

That is the whole of the incident description. The granted Edit was a protected-path edit of class policy.edit.spec, so it WAS gated and DID record a start; its completion was swallowed by the reading bug above. The eight Edit calls that followed were ordinary workspace edits, which the file-tool path never gated at all.

## What was done

Three changes in src/cli/hook.ts, no change to core/loop.ts, core/gate.ts or core/harness-wait.ts.

1. **The reading is the event name.** readReportedOutcome now answers from hook_event_name, which is the harness saying which of its own two code paths ran, and reads tool_response only in the strict direction. interrupted true on the response, or is_interrupt true on the event, is UNREADABLE and appends nothing, because a call somebody stopped neither completed nor failed on its own terms. type error, or a non-empty error string, is a FAILURE whatever the event name said. Everything else on PostToolUse is a completion. An event name this adapter does not know stays unreadable. No text from any field reaches the log or the return value.
2. **A report that did not land exits 2.** report() exits 0 only for post-tool-reported and 2 for every other code, which is the harness protocol's show-this-line and blocks nothing on a post-execution event. A throw on the post path now reports post-tool-io on stderr instead of falling into commandHarnessHook's catch, which would have printed a permission verdict about a tool call that had already run.
3. **The floor sees every tool kind.** fileToolGate now returns a FileGate for any named file, carrying protectedPath false and class files.write.workspace for an unprotected target, and describeToolCall marks that description with a passthrough reason. runHarnessHook prints exactly the old allow, in the old words, from BELOW the floor lookup: no floor standing means the same outright allow with nothing appended, and a floor standing routes the edit as files.write.workspace like any other write. runBypass answers a passthrough edit before the bypass record, since an open window has nothing to suspend for a call the policy already allows.

## Decisions worth recording

- **The event name is trusted for the outcome, and for nothing else.** That is not new latitude. SPEC section 10.2 already frames the counterpart as an outcome an untrusted reporter ASSERTED, marked as such on its face; what bounds it is that the report chooses neither the bucket nor the execution it closes. Both still come from the runtime's own execution.started: the task id is minted by the pre-execution hook from session_id and tool_use_id, finishHarnessExecution resolves the action keys out of the verified log, and core/loop.ts reads the class from the start record. The old reading was no stricter, since type text was equally a thing the reporting side wrote.
- **Interrupted is unreadable rather than failed.** A failure nobody observed trips an escalation on noise, and a control that trips on noise is one operators learn to silence. This keeps the unreadable arm live and meaningful rather than dead code.
- **The passthrough edit is gated only by the floor.** Classifying every keystroke would double the log's growth for a foregone conclusion, which is the cost APRV-217 is already about. The fast path stays fast; what it can no longer do is skip establishing that no floor stands.
- **No SPEC amendment.** Section 10.2's counterpart paragraph names no field of any harness event; the readings are the adapter's, and docs/claude-code-hook.md is where they are pinned. That doc's contract paragraph was simply wrong and is rewritten.
- **Not fixed here:** the class for a Cursor Delete of an unprotected file is files.write.workspace rather than a delete class. It is side-effecting either way, so the floor behaves correctly; minting a class is a separate task.

## Tests, all through the real append path

New in tests/cli-hook.test.ts, with fixtures BASH_OUTPUT, FILE_EDIT_OUTPUT and FILE_WRITE_OUTPUT copied from the shipped sdk-tools.d.ts declarations:

- the payload Claude Code actually sends closes the start it opened: a PreToolUse allow then a PostToolUse carrying BashOutput appends execution.completed, and a PostToolUseFailure carrying error and is_interrupt false appends execution.failed. Both assert the tool text never reaches the log.
- a granted Bash completion clears a tripped floor: three failures, a grant on the floored request, the completion reported, no escalation left standing, and the next write answered by the policy inside a 1s timeout that would have failed under a floor.
- a granted Edit or Write completion clears a tripped floor too, driven twice over a protected-path grant with the real FileEditOutput and FileWriteOutput shapes. This is AC 1.
- an ordinary edit is floored exactly as an ordinary shell write is: under a floor the Edit is routed and its request lands under hook:sess-1:tu-edit:files.write.workspace; with no floor the same edit allows outright and appends nothing. This is AC 2.
- a report that closes nothing is machine-readable and is not exit 0: exit 2, empty stdout, a parsed JSON line carrying the code post-tool-gate-refused:not-delegated, nothing appended; and the interrupted case at the same exit code with its reason.

Rewritten: the unreadable-outcome case, which used to pin the invented content-block shape, now pins the interrupted reading in both spellings. reportOf() now derives the expected exit code from the reported code, so every existing post-tool case in the file pins the 0-versus-2 rule at once.

Results: npm run build clean; the hook, gate, gate-window and execute suites 368 tests; full npm test 3869 tests, 3868 pass, 1 skipped, 0 fail, exit 0; npm run lint clean.

## Global invariants touched

- **Invariant 1, enforcement paths read only verified records.** In play and unchanged. The counterpart still resolves its task and its action keys from the verified log by the identifiers the runtime minted, never from the reporting event; only WHICH of two outcomes is written moved. The floor lookup the file-tool path now performs reads the same verified records the window lookup already read in the same invocation.
- **Invariant 4, self-reported fields never reduce scrutiny.** In play, and the reason the tool_response refinements are one-directional: interrupted can only unread a completion, and error can only turn a completion into a failure. Nothing read from the response can turn a failure into a completion or a completion into something the floor forgives. The event name decides the outcome and no field of the response can override it upward.
- Invariant 6, refusals machine-readable and distinct: POST_TOOL_CODES is unchanged as a union, and every member now reaches a stream somebody reads.
- Invariant 3: none of the tool's output text reaches the log, re-pinned by two assertions on the new fixtures.

## Operational note for the primary checkout

The fix cannot take effect on this repository's own log until the primary checkout rebuilds the CLI the hook runs. Until then no completion can land, so the two standing escalations, on hook:e39a116c-09c5-4950-8958-1ae0a4de9c24 and on agent:claude-code, cannot clear from inside a session. That is a catch-22 in the deployed binary rather than in this branch.
<!-- SECTION:NOTES:END -->
