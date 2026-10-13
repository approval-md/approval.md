---
id: APRV-214
title: >-
  A human-only open window: `approval gate open` time-boxes a full harness
  bypass so the gate itself can be debugged
status: Done
assignee:
  - '@fable'
created_date: '2026-09-02 14:31'
updated_date: '2026-09-02 16:07'
labels:
  - hook
  - security
dependencies: []
priority: high
ordinal: 177000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Debugging the hook today means editing APPROVAL.md (policy.core, human-only) or turning the hook off in .claude/settings.json, which is an ungated session nobody records. Outcome: a new top-level verb `approval gate open|close|status` whose state lives in the log as `gate.opened` / `gate.closed`, with expiry derived from ts plus duration and no event at lapse. While a window is open the harness hook records each gated tool call as `gate.bypassed` and allows it, ahead of policy load, attestation, the loop floor and the human gate, so a broken policy, a drifted attestation, a dark channel and a hung daemon are all bypassed. It does not bypass an unreachable or unverifiable log, `log.mutate`, any class the policy reserves to human hands, or a command the classifier cannot read. The ceremony is human-only: a terminal and a typed `understood`, with no --yes and no --force, which is what keeps it out of reach of a harness shell tool. `approval status` reports unhealthy while a window is open, so CI or doctor checks keyed on healthy go red by design. Touches SPEC 11.1 invariants 4, 6, 8 and 9; amends SPEC.md 5.2, 8, 10.1, 11.1 and 11.2. Design record: state lives in the log rather than a file, following the .approval/env precedent.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A new event type trio (`gate.opened`, `gate.closed`, `gate.bypassed`) validates at the write boundary with valid and invalid fixtures; `gate.opened` and `gate.closed` refuse a non-human actor in the schema; `gate.*` counts as gate-typed for the timestamp skew check
- [x] #2 `approval gate open --for <d> --reason "<t>"` appends `gate.opened` only after a human types exactly `understood` on a TTY; a mismatch, an EOF, `--json`, or a non-terminal stdin refuses with its own code and appends nothing; there is no --yes or --force flag
- [x] #3 The default duration is 30m, a duration over 24h is refused, and a window whose record claims a longer expiry than its own duration is read as the shorter of the two
- [x] #4 A second open refuses `gate-already-open`; a close with no window refuses `gate-not-open`; expiry appends nothing
- [x] #5 With a window open the hook allows a manual-class command with a `gate-open:` reason and a loud stderr banner, having first appended one `gate.bypassed` naming the opened seq, the classes, the tool, a summary and the payload hash; an append failure denies
- [x] #6 The bypass still applies under an unloadable policy and an unattested policy, and still denies `log.mutate`, any `human-only` class, a classifier refusal, and an unreachable or unverifiable log; the cursor adapter behaves identically
- [x] #7 `approval gate open` and `approval gate close` classify `policy.core` through `approval hook classify`, in both the `approval` and `node cli.js` spellings; `gate status` stays `gate.self`; an agent running the ceremony through the hook is denied `hook-class-human-only` under a human-only policy.core
- [x] #8 `approval status` reports the open window (opener, reason, expiry, bypass count) and flips `healthy` to false, with the new `gate_window` key additive so a repo with no window emits a byte-identical `--json` object; `gate status` and `gate status --json` report the same fact
- [x] #9 The verb-level refusal codes are a frozen union pinned by a test, the harness hook introduces no new HOOK_DENY_CODES, and `gate.bypassed` counts as a session event for the dark-session sweep
- [x] #10 A spawned-process test proves that a non-TTY stdin cannot open a window
- [x] #11 SPEC.md 5.2 (the open window), 8 (enum and gate-typed ts), 10.1, 11.1 (why invariant 4 is not violated and how 8 and 9 still bind, five unions become six) and 11.2 are amended pending sign-off, docs/claude-code-hook.md gains "Opening the gate to debug it", and CLAUDE.md lists the two verbs under Never
- [x] #12 The verb registry marks open and close human_only with a note and status not, and their output schemas validate against real --json output
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Design of record: /Users/carter/.claude/plans/we-should-probably-add-glowing-finch.md (approved by Carter 2026-09-02). State lives in the log (gate.opened / gate.closed, expiry derived, no event at lapse); ceremony = TTY + typed `understood`, no --yes; window lookup sits after hookScope and before loadPolicy and is self-gating on a verified log; gate.bypassed appended before every allow; log.mutate, human-only classes and classifier refusals still deny.
1. Schema + types: event.schema.json enum + three conditional blocks, fixtures, EventType, EVENT_TYPES, isGateTyped gains gate.*, SESSION_EVENTS gains gate.bypassed.
2. Core src/core/gate-window.ts: openGateWindow (pure), openWindow, closeWindow, recordGateBypass (head-moved retry), GATE_WINDOW_REFUSAL_CODES frozen union; tests/gate-window.test.ts.
3. Classification: refineApprovalVerb maps gate open/close to policy.core; tests in command-class and cli-hook (human-only policy.core fixture).
4. Hook: lookupWindow + runBypass in runHarnessHook, shared describeToolCall, records threaded into harnessFloor/unattendedGuard; banner + gate-open: reason; tests in cli-hook and cli-hook-cursor.
5. CLI src/cli/gate-window.ts commandGate open/close/status with injected prompter; main.ts switch, help, verb-registry (open/close human_only); tests/cli-gate.test.ts incl. spawned non-TTY refusal.
6. Health: commandStatus gate_window additive key, healthy false while open; gate status shares openGateWindow.
7. SPEC 5.2/8/10.1/11.1/11.2 (pending sign-off), docs/claude-code-hook.md section, CLAUDE.md Never list.
8. Verify: npm test, lint, build, manual scratch-repo run per the plan; finalize with implementation notes naming invariants 4, 6, 8, 9.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Design and shape as approved: state in the log (gate.opened / gate.closed), expiry derived, ceremony = TTY + typed `understood`, no --yes. Invariants touched: 4 (the window lowers hook scrutiny, authored by the human who is not the party under oversight; no agent self-report is read), 6 (GATE_WINDOW_REFUSAL_CODES is the sixth frozen union, pinned by deepEqual in tests/gate-window.test.ts), 8 (gate.bypassed lands before every allow via appendEvent with expectedHead under a head-moved retry; append failure denies hook-gate-refused:append-failed), 9 (human-only classes and log.mutate stay denied inside a window).
Decisions the diff alone does not show: startHarnessExecution was NOT reused for the bypass record because it refuses on unattested policy, manual, loop floor and budget, the very things being bypassed; only the append mechanism is shared. The window lookup sits after hookScope and before loadPolicy and is self-gating on the verified read, so the closed path is byte-identical and now does one verified read instead of two (records threaded into harnessFloor and unattendedGuard). The classify block moved verbatim into describeToolCall, shared by both paths. Classifier refusals (opaque, unclassified, unparseable) still deny inside a window: a command the hook cannot read cannot be shown to avoid the log. Under an unloadable policy nothing resolves, so only the unconditional log.mutate refusal applies and the allow reason says the policy did not load. log.mutate and human-only denials inside the window both reuse hook-class-human-only with distinct details; no new HOOK_DENY_CODES.
Deviations from the plan: test file is tests/cli-gate-window.test.ts (tests/cli-gate.test.ts belongs to APRV-16); `gate close --note` added since the schema carries it; docs/cli-reference.md gained a gate section because tests/cli-long-help.test.ts requires a heading per help anchor; schema description count corrected to twenty-eight (audit.dark_session had never been counted); the §11.2 evaluation order was rewritten to match the implemented CLI order (reason, duration, actor, terminal, confirmation, read, append).
Dogfood note: eight of the SPEC.md edits hit hook-timeout on the policy.edit gate and were retried once decided; the retries adopted the open requests as designed.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added the human-only open window: approval gate open|close|status, gate.opened/gate.closed/gate.bypassed events, the hook bypass path (lookupWindow before loadPolicy, runBypass records then allows), policy.core classification of the two ceremony verbs, status health reporting, the sixth frozen refusal union, and SPEC/docs/CLAUDE.md amendments pending sign-off. Verified: npm run build and npm run lint clean; npm test 2895 tests, 2894 pass, 1 skipped, 0 fail (59 new); approval hook classify gives policy.core for both spellings and gate.self for status; a spawned non-TTY gate open refuses gate-stdin-not-tty with exit 1 and appends nothing.
<!-- SECTION:FINAL_SUMMARY:END -->
