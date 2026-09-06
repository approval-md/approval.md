---
id: APRV-281
title: >-
  The hook waits nine minutes in silence when a request is on the phone; say so
  and where
status: In Progress
assignee:
  - '@opus-hook'
created_date: '2026-09-06 07:19'
updated_date: '2026-09-06 12:03'
labels:
  - hook
  - ux
dependencies: []
type: enhancement
ordinal: 207000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
When a hook-gated command resolves to manual or a live sample, the hook blocks for up to 540 s and only then prints hook-timeout. During that wait the agent and the human see nothing. Print one line to stderr the moment the request is appended: the action key, the class, the channel it went to, and that a decision on the phone releases it; and if no listener is consuming the channel (the daemon socket refuses, or the last decision on any channel is older than the TTL), say that too, since 2026-09-05 showed taps piling up unconsumed while the hook waited. Also shorten the default wait for classes the policy resolves autonomous but a loop escalation overrode (see the loop-escalation task).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A hook-gated manual request prints one stderr line naming key, class and channel before it waits
- [x] #2 When the daemon socket refuses connections, the line says no listener is running and names approval up
- [x] #3 tests/cli-hook.test.ts covers both lines
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Insertion point: src/cli/hook.ts gateAndWait, after the request loop and immediately before the poll loop (`const deadline = ...`). Past every early return, so it is reached only where this process is genuinely about to block on a human; the supervised and carried paths return above it and stay silent.
2. The set announced is the set waited on: the keys this invocation opened PLUS the keys it adopted from an earlier tool call. Adopting is the retry case, and a retry that waits in silence is the same nine minutes the task is about. A carried grant is not announced, because nothing waits on it.
3. The line: 'approval: <actionKey> (<class>) is waiting for a human on <channel(s)>; a decision on the phone releases it, and this hook blocks for up to <n>ms before denying with hook-timeout and leaving the request open.' Channels come from the policy's own channels block, sorted, carried down on HookRun; a policy that configures none says so in the same line. An adopted key adds one sentence saying the question was already open.
4. The listener line, printed once after the announce and before the wait: probe .approval/daemon/draw.sock through core/live-draw.ts, which now EXPORTS its socket predicate as `drawSocketUsable` (it was a private `socketUsable`) so the hook reaches the conclusion an asker reaches instead of carrying a third copy of the ownership check. Absent, not a socket, foreign-owned or group/other-readable means no `approval up` is running against this log: say so, name the reason code and the socket path, and name the command. A socket that looks usable prints nothing, because a stat cannot establish that the far side answers (the connect probe is APRV-282's).
5. Wait semantics unchanged: no timeout change, no new deny code, nothing decided on either line, stdout untouched (a decision object is the only thing that may appear there).
6. Tests in tests/cli-hook.test.ts, all three re-parsing stdout as the harness does: a manual class under a policy with a channel prints the announce line with key, class and channel AND the no-listener line naming `approval up`; the same command under the suite's channel-less policy says the policy configures none; a manual class with a real owner-only bound socket at draw.sock prints the announce line and NOT the listener line (under a short scratch root, since sun_path is 104 bytes on macOS).
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What changed

`src/cli/hook.ts`: `announceWait` prints, on STDERR, one line per key this invocation is about to wait on (action key, class, the policy's channel names, the wait length, and that a decision on the phone releases it), then at most one further line when nothing is listening for this log. It is called once in `gateAndWait`, after the request loop and immediately before the poll loop, so it is reached only where the process genuinely blocks on a human. `HookRun.channels` is filled from the policy the caller already loaded and validated, sorted.

`src/core/live-draw.ts`: the private `socketUsable` is now exported as `drawSocketUsable`. No behaviour change (the single existing caller, `askDaemonDraw`, was renamed with it). The hook asks the same predicate an asker asks rather than carrying a third copy of the path-length/is-socket/owner/mode check; doctor's inline copy is left alone as out of scope.

## Decisions

- **Announced set = waited set, so adopted keys are announced too.** The plan of record said 'after each `request` returns a record'. That would have left the retry case silent: a hook that timed out, whose retry ADOPTS the still-open question, opens no request of its own and would have waited out a second window with nothing on stderr. That is the same silence the task exists to remove, so the announce is computed over `waitKeys` (opened plus adopted) and printed at the one place the wait begins. An adopted key says so in its own sentence.
- **The listener probe stats and never dials.** A usable-looking socket therefore prints NOTHING, because a stat cannot establish that the far side answers; the connect probe stays APRV-282's. What an absent or untrustworthy socket DOES establish is that `approval up` is not running against this log here, and `approval up` is the process that serves the channels and consumes the taps, so the line names it.
- **Channel names, not a delivery claim.** The line says which channels the policy configures. It does not assert that any of them delivered anything, because this process does not know; a policy with no channels block gets the fact ('this policy configures none, so nothing is delivering the question') rather than a filled-in default.
- **No em dash, one line each, stderr only.** Stdout carries the verdict object the harness parses, and the tests re-parse it in every case.

## Invariants touched (CLAUDE.md 'Global invariants are implicit acceptance criteria')

Nothing here decides anything. No verdict, timeout, deny code, record or refusal changes: both lines are prose on a stream the harness does not parse, printed after the request is appended and before the poll loop starts. §11.1 invariant 7 (refusals machine-readable and distinct) is untouched, since `HOOK_DENY_CODES` gained no member; the listener line quotes `live-draw`'s existing refusal reason code rather than minting a word. No self-reported field reduces scrutiny: the probe can only ADD a warning, never remove one, and a probe that cannot conclude anything stays quiet.

## Validation

- `npm run build`, `npm run typecheck`, `npm run lint` (oxlint): all exit 0.
- `node --test dist/tests/cli-hook.test.js`: 97/97 pass (3 new).
- `node --test` over cli-hook-cursor, cli-hook-rewrite, cli-hook-scope, cli-hook-scratch, hook-module-graph: 47/47 pass. The module-graph case still passes, so importing `core/live-draw.js` into the hook adds no forbidden module to a cold pass-through invocation (live-draw's own imports are node builtins plus `core/jcs.js`).
- `node --test dist/tests/live-draw.test.js`: 16/16 pass. `node --test dist/tests/cli-doctor.test.js`: 57/57 pass (the two suites that read the draw socket).

## Not done

The description's second sentence ('shorten the default wait for classes the policy resolves autonomous but a loop escalation overrode') is NOT in this change and is in none of the three acceptance criteria. It changes wait semantics, which this task was scoped to leave alone; it wants its own task against SPEC §10.2.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The hook now says what it is waiting for before it waits: one stderr line per key naming the action key, the class, the policy's channels and the wait length, plus a second line naming `approval up` when the daemon socket for this log is absent or untrustworthy. Verdicts, records and wait semantics are unchanged and stdout still carries only the decision object. Verified by three new cases in tests/cli-hook.test.ts (97/97 in that suite, 47/47 across the other hook suites, 16/16 live-draw, 57/57 doctor) with build, typecheck and lint clean.
<!-- SECTION:FINAL_SUMMARY:END -->
