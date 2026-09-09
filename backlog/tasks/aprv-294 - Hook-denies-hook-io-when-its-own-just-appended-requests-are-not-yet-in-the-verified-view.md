---
id: APRV-294
title: >-
  Hook denies hook-io when its own just-appended requests are not yet in the
  verified view
status: Done
assignee: []
created_date: '2026-09-07 02:41'
updated_date: '2026-09-07 06:24'
labels:
  - hook
  - daemon
dependencies: []
priority: high
ordinal: 218000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
2026-09-07 02:00Z, minutes after approval log sync replaced the committed baseline and the daemon restarted: a hook call appended its requests, re-read the verified log, found every key in state none, and denied at once with hook-io 'the verified log does not show every request as granted (states: none, none, none)' (src/cli/hook.ts around line 2097). The requests were real and later showed on the phone; the verified view the hook read (verified-head.json, seq 26931 at 01:58:07) did not yet include them. A second call in the same minute took the bypass path on a stale 'window open' reading and was refused gate-not-open by the append, which re-derived the window from a fresher read. Both are the same fault: the hook decides from one read and acts on another. The immediate deny also counts as a failed side-effecting call for the loop-escalation floor (APRV-287).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 After appending its requests the hook treats state none for its own keys as 'not yet verified' and keeps waiting (bounded by the hook timeout), never as a terminal hook-io; a test appends requests, serves a verified view that lags them, and asserts the hook waits then allows on the grant
- [x] #2 The window decision and the bypass append read the same records: a window that closed between the two refuses with a distinct code that names the closing seq, and the refusal is not counted as a failed side-effecting call
- [x] #3 docs/claude-code-hook.md explains the verified-view lag after a sync or daemon restart and what the hook does about it; CHANGELOG entry
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What was done

Three places, one fault: a verdict formed on one read of the log and acted on against another.

**1. src/core/gate-window.ts — the bypass append takes the decision it records.**
New refusal code `gate-window-closed`, added to the frozen `GATE_WINDOW_REFUSAL_CODES` union and pinned in tests/gate-window.test.ts. Added and never repurposed: `gate-not-open` still means no window stood at all, and a caller that names no window still gets it. `recordGateBypass` takes an optional `GateBypassDecision` — the seq of the `gate.opened` the caller decided under, plus that decision's own verified read. The FIRST append attempt uses that read, so the window decision and the record are one read rather than two that can disagree. A head-moved retry re-reads (it must: the head it would chain onto has moved), re-derives the window, and compares it with the seq the verdict named; a window closed, lapsed or superseded in between refuses `gate-window-closed` naming the `gate.closed` seq, or the expiry where a lapse left no record to name.

**2. src/cli/hook.ts — the bypass path carries it.**
`lookupWindow` now returns the head alongside the records, `runHarnessHook` hands both to `runBypass`, and `runBypass` hands them to `recordGateBypass`. The refusal reaches the agent as `hook-gate-refused:gate-window-closed` through the family already reserved for a code the writer produced, so `HOOK_DENY_CODES` gains no member.

**3. src/cli/hook.ts — the wait loop waits out a lagging view.**
A key this invocation established exists (one it appended, or one intake adopted from an earlier tool call) that a later verified read does not carry is now read as NOT YET VERIFIED: it waits exactly as `requested` waits, bounded by the same timeout. The log is append-only, so a request that existed does not stop existing, and `none` for such a key is a fact about the view. One stderr line per invocation says so and names the verified head; a wait that ends with the view still short adds a clause to the ordinary `hook-timeout` naming the repair (`approval log verify` in the checkout that owns the log). The old immediate `hook-io` deny is kept as a now-unreachable backstop for a future member of `RequestState`.

## Decisions worth recording

- **The waiting reading covers adopted keys too**, not only the keys this invocation opened. AC1 says its own keys; the argument is identical for an adopted one, since intake saw it in a verified read, and the widening can only lengthen a wait and never produce an allow. Fail-closed either way.
- **The APRV-287 withdrawal is untouched.** `withdrawAbandoned` names only keys the view shows as live `approval.requested` records, so a lagging view withdraws nothing — the strict direction: the hook does not take back a question it cannot see.
- **One code for three endings.** `gate-window-closed` covers closed, lapsed and superseded because the caller's repair is one sentence (retry, and be answered by the policy or by whatever window stands then); the message states which of the three happened.

## Invariants touched (CLAUDE.md / SPEC §11.1)

- **1, enforcement paths read only verified records.** The invariant the task is about. Nothing here reads unverified bytes: waiting for the verification to catch up is the honest response to a lag, and the hook still allows only on records the verified chain carries.
- **4, self-reported fields never reduce scrutiny.** Nothing an agent supplies reaches either change. The lag reading turns on whether THIS process appended or adopted the key, which the runtime knows from its own writes; the window comparison turns on a seq the runtime read from the log.
- **5, compare-and-append.** The seeded read carries the head it observed, so the first attempt states a precondition it actually read, and every retry re-reads. Nothing appends against a head it did not observe.
- **6, refusals machine-readable and distinct.** `gate-window-closed` is a new member of a frozen union, pinned by tests/gate-window.test.ts, with the §11.2 row drafted below.
- **8, no allow before its record.** Unchanged and reinforced: the bypass still records before it allows, and an append refused for any reason (the new code included) is a deny.

## Tests

tests/cli-hook.test.ts:
- *a view that lags the hook's own requests is waited out, never denied* — a detached helper waits for the request to land, swaps in the log as it stood before the tool call (write-then-rename, so the hook never reads a half-written file), holds it 1.5s, swaps the whole file back and grants. Asserts the allow, the stderr lag line, the `execution.started`, and a clean chain. This test fails on the pre-change code, which denies `hook-io` on the first poll.
- *a lag that outlives the wait times out and says the view is behind.*
- *a window that ends between the verdict and the record has its own code* — also asserts the refusal appends nothing, that the harness's report of the failed tool call is refused `not-delegated` and appends nothing, and that `harnessLoopEscalation` is empty. That is AC2's not-counted-as-a-failed-side-effecting-call, end to end.
- *a lapsed window is named as lapsed*, and *with no decision stated the bypass still refuses gate-not-open.*
tests/gate-window.test.ts: the frozen-union pin gains the new member.

Docs: docs/claude-code-hook.md gains **When the verified view lags its own requests (APRV-294)** and a paragraph under *Opening the gate to debug it*. CHANGELOG: one bullet.

## SPEC amendment text (apply by hand)

SPEC.md was not edited: a gate window is open and a bypassed SPEC edit cannot pass the protected-path guard.

**A. §11.2, `gate_window_refusal_codes` table.** Replace the `gate-not-open` row with:

| `gate-not-open` | `close` found no open window, or a bypass that named no window found none. A bypass that named the window its verdict was decided under takes `gate-window-closed` instead. (Amended APRV-294, pending sign-off.) |

and insert immediately after it:

| `gate-window-closed` | A bypass was decided under a named window and that window is gone by the time the record is appended: a `gate.closed` names it, its expiry has passed, or a later `gate.opened` supersedes it. The refusal names the closing record's `seq`, or the expiry where a lapse left no record to name. Distinct from `gate-not-open`, which says no window stood at all. Nothing is appended, no command ran, and the refusal is not an execution, so no loop-safety streak accrues (§10.2). (Amended APRV-294, pending sign-off.) |

**B. §5.2, the open-window bullet.** After the sentence ending 'with a reason prefixed `gate-open:` and a banner on its error stream.', insert:

The window a call is DECIDED under is the window it records. An implementation MUST derive the window and append the `gate.bypassed` record from one verified read, and where the append is retried against a moved head it MUST re-derive the window from the fresh read and compare it with the one the verdict named. A window that ended in between, by a close, by lapsing, or by a later opening superseding it, refuses with its own code naming what ended it, distinct from the refusal that says no window stood at all (§11.2 `gate_window_refusal_codes`). Deciding on one read and acting on another is what produced a call that was told no window is open while it stood inside one. (Amended APRV-294, pending sign-off.)

**C. §11.1, invariant 1.** Append this scope note:

*Scope note:* reading only verified records means a surface can hold a record the view it has just read does not carry, and a harness adapter is where that bites: it appends its requests, re-reads, and after a log synchronisation or a daemon restart the verified view can be behind its own writes. The absence of a record for an action key the surface itself appended, or found pending in its own earlier verified read, MUST NOT be read as a terminal state, because a log is append-only and a request that existed does not stop existing. The response is to keep waiting inside the bound the surface already has and to report that the view lags; an implementation MUST NOT read unverified bytes to resolve it, and MUST NOT allow on a record the verified chain does not carry (`tests/cli-hook.test.ts`). (Amended APRV-294, pending sign-off.)
<!-- SECTION:NOTES:END -->
