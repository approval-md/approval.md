---
id: APRV-200
title: >-
  The harness hook's grant can follow the write it authorizes: PreToolUse
  returns before the human decides
status: Done
assignee:
  - 'agent:opus-lane-v'
created_date: '2026-09-01 19:18'
updated_date: '2026-09-02 09:11'
labels:
  - security
  - hook
dependencies: []
priority: high
ordinal: 165000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-08-30 22:32 UTC and recorded as comment #2 on APRV-151, where it was mis-filed as a silent hook miss. It is not one: the consent trail is complete. It is RETROACTIVE.

An Edit-tool call from the orchestrating session to /Users/carter/dev/approval-md/APPROVAL.md produced a full manual-path trail in the log — policy.edit registered at seq 3057, approval.requested seq 3058, approval.granted by human:carter at seq 3064 (22:37 UTC), execution.started with grant_seq at seq 3065 — and yet the Edit tool had already returned success and the modified file was on disk at ~22:32, five minutes BEFORE the grant landed. The session even observed its own unauthorized write in the interim: a policy-not-attested refusal fired against the modified bytes while the request was still pending.

So the write preceded its authorization. Every record says the right thing and the ordering they imply is false. This matters for three reasons that are separate from the APRV-151 bypass:

1. It defeats the property the manual path exists for. A human tap that arrives after the effect has landed is a ratification, not an approval, and SPEC.md 6.3 does not distinguish them anywhere a reader could notice.
2. execution.started carries grant_seq, which reads as 'this execution was authorized by that grant'. When the execution preceded the grant, that field is an assertion the log cannot support and an auditor has no way to detect from the record alone: the log carries no timestamp for when the tool call actually applied, only for when the gate learned of it.
3. It is adjacent to the carryover semantics of APRV-117 and APRV-150. A carried or adopted question whose write already happened is the same defect with a longer fuse, and whatever fix lands here has to say what carryover does when the bytes are already on disk.

What is NOT yet established, and is the first thing to establish: WHY the tool call returned before the hook's decision. Candidates worth separating are a hook timeout at the harness boundary (the entry in .claude/settings.json sets timeout 600 and the verb's own --timeout is 9m; a mismatch in either direction produces exactly this), a hook whose non-blocking return path is taken for file tools, and a harness that applies an Edit optimistically and consults the decision afterwards. Each implies a different fix and only one of them is fixable inside this runtime.

Related: APRV-151 (the CI-side protected-path grant cross-check, whose recency bound accepts a grant on either side of the commit precisely because this ordering is real and the guard is not the place to adjudicate it), APRV-117, APRV-150.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The mechanism is established and recorded: why the Edit tool returned success before the gate's decision, with the evidence that settles it between a harness-side timeout, a non-blocking hook return path, and optimistic application
- [x] #2 The runtime states, in SPEC.md or in the hook's documentation, what a grant that arrives after its write means and whether it authorizes anything; if the answer is that it does not, the hook has a distinct refusal for it
- [x] #3 A detection exists for the condition: from the committed log alone, an auditor can tell an execution that preceded its grant from one that followed it, or the task records why that is not derivable and what record would make it so
- [x] #4 The carryover paths of APRV-117/150 are checked against this case, and what an adopted or carried question does when its bytes are already on disk is stated
- [x] #5 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
0. MEASURE FIRST (AC#1). Read the committed log around the incident (seq 3050-3070) and settle the mechanism from the record rather than from the narrative.
1. Reproduce the class of defect that IS in this runtime: the APRV-117 carryover. Invocation A returns hook-timeout (deny) and leaves the request open; invocation B spends the grant. From the log alone B's execution.started is shaped identically to a direct in-invocation spend, so an auditor cannot tell an execution that followed its grant from one a harness had already applied before A's deny. The failing test asserts a grant_origin marker that does not exist yet.
2. core/gate.ts: consumeHarnessGrant gains ConsumeHarnessOptions.spendingTask and writes grant_origin on the execution.started payload. Derived at the write boundary: "direct" ONLY when the presented spending task equals the request's own task; every other case, absence included, is "carried". A self-reported value can therefore only add scrutiny (invariant 4).
3. schema/event.schema.json: additive optional grant_origin on execution.started, shape-constrained, the way env_stripped (APRV-205) and reported_by (APRV-145) are.
4. cli/hook.ts: after consumeGrants and BEFORE the allow, re-read the VERIFIED log and confirm every spent key's execution.started is in it. A re-read that cannot establish it denies hook-grant-unverified, a new member of the frozen union. Strengthens invariant 8 on the one surface where the executor is not this runtime.
5. Pin the carryover binding (command, cwd, payload hash, class, tool). Existing tests cover bytes/cwd/TTL/single-use; add the cross-tool pin (an Edit's policy.core grant is not spendable by a shell command that classifies the same class) and the negative that a late grant is not consumed by an unrelated later call.
6. The ordering test the deliverable names: after a granted file-tool edit, read the log and assert task.registered -> approval.requested -> approval.granted -> execution.started -> (the write) -> execution.completed by seq, driving PreToolUse and then PostToolUse.
7. Pin that the gate's clock is the gate's: a hook event carrying ts/timestamp fields changes no record's ts.
8. docs/claude-code-hook.md: a new section stating the exact boundary where PreToolUse can return before the human decides (the harness kill at its own timeout, any non-zero exit other than 2, an unlaunchable binary), what a grant arriving after its write authorizes (nothing that already happened), what grant_origin: carried means to an auditor, and what carryover does when the bytes are already on disk (AC#2, AC#3, AC#4). New deny-code row.
9. help.ts deny list, HOOK_DENY_CODES, the docs guard and the help guard move together.
10. Draft the SPEC.md 10.4 / 11.1 text in the implementation notes flagged "(Amended APRV-200, pending sign-off.)"; no SPEC edit in this lane.
11. lint, build, full npm test with counts; notes; -s Done.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What was done

Built on `origin/main`, which already carried APRV-188 (PR #213 merged), so no rebase is owed.

**AC#1 — the mechanism, established from the log rather than from the narrative.** Read the committed log around the incident (`.approval/log/events.jsonl`, seq 3050-3070). The trail is:

- 3055 22:31:09 the last event of session `a9c93b44` before the Edit;
- 3057 22:32:23.359 `task.registered`, 3058 22:32:23.382 `approval.requested` for `hook:a9c93b44…:toolu_01B5QjLwkk7XEUnF7a6mBAnJ:policy.edit`;
- 3059-3063 (22:32:42 to 22:34:23) belong to a DIFFERENT concurrent session, `0308ead3`; `a9c93b44` writes nothing for 5m26s;
- 3064 22:37:49.179 `approval.granted` by `human:carter`;
- 3065 22:37:49.393 `execution.started`, `grant_seq: 3064`, 214 ms later, SAME `tool_use_id` and same task as the request;
- 3066 22:40:03 `a9c93b44`'s next tool call.

Three things follow, and together they settle the candidate list the task named.

1. The request and the spend carry the **same `tool_use_id`**. A retry mints a new one, so this was not a carried grant: one hook process opened the request, blocked, saw the decision and spent it.
2. The requesting session emitted **nothing for 5m26s** while a second session kept writing. The hook process was genuinely blocking, so it was neither killed at the harness `timeout` (the wait was 9m and it returned at 5m26s) nor taking a non-blocking return path.
3. `consumeHarnessGrant` checks attestation against the LIVE `APPROVAL.md` bytes. Seq 3065 exists, so at 22:37:49 those bytes still hashed to the attested `c61e175…`. Had the Edit applied at 22:32 the spend would have refused `policy-not-attested` and 3065 would not be in the log.

So none of the three candidates (a harness-side timeout, a non-blocking hook return path, optimistic application) produced this trail, and the ordering the records imply is the true ordering. Comment #2 on APRV-151 read the incident as retroactive; the log does not support that reading. **Recorded as a finding, not as a fix.**

That does not make the property enforced, and the rest of the task is what the log CAN be made to show.

**AC#2/#3 — `grant_origin`, and the boundary stated.** The window that is real in this runtime is APRV-117's carryover: invocation A returns a `hook-timeout` deny and leaves the request open, and invocation B spends the grant. If A's deny was not honoured (a kill at the harness `timeout`, any non-zero exit other than 2, an unlaunchable binary — all three are non-blocking errors in Claude Code and the tool proceeds), the bytes are already on disk when B's `execution.started` lands with its `grant_seq`. Before this task, B's record was shaped identically to a direct in-invocation spend, so an auditor could not tell which window a spend sat in.

- `core/gate.ts`: `consumeHarnessGrant` records `grant_origin` on the `execution.started` payload — `direct` when the spending tool call is the tool call the request record names, `carried` otherwise. Derived at the write boundary from `derivation.task`, which is read out of the verified log; the new `ConsumeHarnessOptions.spendingTask` is a CLAIM, and it is bounded the way §11.1 invariant 4 bounds every claim: absence and every mismatch record `carried` (the value that adds scrutiny), and `direct` is reachable only by naming a fact the log already holds. It gates nothing and changes no refusal.
- `schema/event.schema.json`: `grant_origin` as an additive, shape-constrained optional property on `execution.started`, the way `env_stripped` (APRV-205) and `reported_by` (APRV-145) were added under their own tasks. Every record written before it still validates and still verifies.
- `docs/claude-code-hook.md`: a new section, "When the grant can follow the write (APRV-200)", stating the three harness-boundary cases in which a tool call proceeds with no verdict, the requirement (not the nicety) that `--timeout` sit below the settings `timeout`, what a grant arriving after its write means (a ratification, authorizing nothing that already happened), and what is and is not derivable from the log. `docs/cursor-hook.md` gets the short version plus the note that `failClosed` removes case 1 and 3 on that harness.

**The deliverable's `allow`-after-record property.** `cli/hook.ts` gains `verifySpent`: after `consumeGrants` and BEFORE the allow, it re-reads the VERIFIED log and establishes that every spent key's `execution.started` is in the chain, denying `hook-grant-unverified` where it cannot. This is not redundant with invariant 8's write-side check on this one surface: everywhere else the process that appends is the process that then performs the side effect, but here the executor is the harness and it never sees the gate's return value, so the record is the authorization and the record is what gets checked.

**AC#4 — carryover with the bytes already on disk.** Stated in the docs and pinned by a test: adoption and carryover do not inspect the target, deliberately. A grant binds to bytes, not to a state of the world; a carried grant says a human approved this exact change to this exact file, once, inside the TTL, and never says the change had not been made. The control where the ordering matters is a `manual` floor plus the `carried` marker in review, not a check of the file at spend time, which would be a race the runtime loses to the harness by construction.

## Reproduction

With the `grant_origin` assignment disabled and everything else in place:

```
✖ a spend records whether its authorization was carried across invocations
    actual: undefined, expected: 'direct'
✖ THE DEFECT: a grant spent by a later invocation is marked carried, not direct
    actual: undefined, expected: 'carried'
```

## Tests added (tests/cli-hook.test.ts, 7 new, all through the real CLI)

- a direct spend records `grant_origin: "direct"` and names its `grant_seq`;
- THE DEFECT: a grant spent by a later invocation records `carried`, and the record's `task` is still the ASKING invocation's, which is what makes the marker readable;
- an adopted question's spend is `carried` too;
- an unattended execution names neither `grant_seq` nor `grant_origin`, so absence is not ambiguous;
- the log order after a granted file-tool edit is `task.registered -> approval.requested -> approval.granted -> execution.started -> (the write) -> execution.completed`, asserted by `seq`, driving PreToolUse and then PostToolUse with the write performed between them;
- a grant left open by a denied hook is not spendable by a different TOOL's call for the same file (an Edit's `policy.core` grant versus a shell redirect that classifies the same class): different payload shapes, different hashes, a new question and the first grant untouched;
- §11.1 invariant 2 on this surface: a hook event carrying `ts`/`timestamp`, at the top level and inside `tool_input`, reaches no record.

## Invariants touched

- **Invariant 1 (enforcement reads only verified records):** `verifySpent` is a new enforcement read and uses `readVerifiedRecords`, like every other read in the module.
- **Invariant 2 (gate-typed events never accept caller timestamps):** unchanged, and now pinned on the hook surface by a test.
- **Invariant 4 (self-reported fields never reduce scrutiny):** `spendingTask` is the one new caller-supplied input; it can only produce the scrutiny-adding value unaided.
- **Invariant 5 (every check-then-append through compare-and-append):** unchanged; the spend still appends against the head its derivation read, and the re-read is after the append and appends nothing.
- **Invariant 6 (refusals machine-readable and distinct):** `hook-grant-unverified` joins the frozen union, the help text and both docs guards.
- **Invariant 8 (a verdict whose event cannot be appended is a refusal):** strengthened on the harness surface from "the append returned success" to "the verified chain carries it".

## Draft SPEC.md text — NOT APPLIED, for human sign-off

To §10.4, after the paragraph on recomputation:

> Where the executor is not this runtime — a harness adapter that answers a permission question and lets the harness run the command (§14) — the record IS the authorization, because the executing program never observes the gate's return value. Such an adapter MUST spend the grant, MUST establish from the verified log that the `execution.started` recording the spend is in the chain, and only then MAY return its allow; a spend it cannot establish refuses with its own machine-readable code. It MUST additionally record, on that `execution.started`, whether the invocation spending the grant is the invocation that requested it: `grant_origin: "direct"` where they are the same, `"carried"` where a later invocation spent an earlier one's grant. Only `direct` asserts an ordering the runtime observed. `carried` names the window in which a decision can arrive after the effect it approves, because the earlier invocation had already returned a verdict and whether the harness honoured that verdict is not a fact this runtime holds. A decision that arrives after its effect is a ratification and authorizes nothing that has already happened; implementations MUST NOT record it as though it did. The marker is derived from the request record's own task and never from a caller's assertion about itself, so the value that adds scrutiny is the one an unproven claim reaches. (Amended APRV-200, pending sign-off.)

To §11.1, as a scope note on invariant 8:

> *Scope note:* on a surface where this runtime decides and another program executes, "the event recording that verdict has been appended" is read as "the verified log carries it". An append whose success is known only to the deciding process authorizes nothing the executing one can be held to. (Amended APRV-200, pending sign-off.)

## Decisions the orchestrator might overrule

1. **The incident is a mis-read, and I did not fix it.** AC#1 asks for the mechanism and the evidence; the evidence says the ordering was correct. The work here closes the class of defect rather than the instance. If the orchestrator holds that comment #2's on-disk observation is authoritative over the log, that is a different task and needs the session transcript, which this lane cannot reach.
2. **`grant_origin` is a schema addition inside a non-schema task.** CLAUDE.md says schema changes are their own tasks; I read an additive, optional, shape-constrained field as the `env_stripped`/`reported_by` category, both of which landed inside their own feature tasks. Easy to split out if that reading is wrong.
3. **`hook-grant-unverified`'s branches are not covered by a test.** They fire only when a verified re-read fails immediately after a successful compare-and-append, which cannot be provoked from the CLI boundary without corrupting the log mid-process — and the repo forbids hand-written log lines. The code is in the frozen union and both docs guards; the behaviour is not exercised. Flagged rather than faked.
4. **No new event type.** A record of "this invocation stopped waiting and left the request open" would make the carried window narrower still, but it needs a new event in the closed vocabulary, which is its own task. `grant_origin` gets the same information from a field on a record that already exists.
5. **Nothing renders the marker yet.** `approval status`, `journal` and the audit sampler do not surface `grant_origin`. Worth a follow-up if the orchestrator wants a `carried` spend to be visible without reading JSONL.

## Validation

`npm run lint` clean. `npm test`: **2716 tests, 2715 pass, 0 fail, 1 skipped** (108 test files). `tests/cli-hook.test.ts` alone: 74 tests, 74 pass (67 before this task, 7 added).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Established the incident's mechanism from the committed log and closed the class of defect it was read as. The 2026-08-30 trail is NOT retroactive: the request (seq 3058) and the spend (seq 3065) carry the same tool_use_id and the same task, the requesting session emitted nothing for the 5m26s between them while a concurrent session kept writing, and the spend passed attestation against the live APPROVAL.md bytes 214 ms after the human's grant — which it could not have done had those bytes been modified five minutes earlier. One hook process asked, blocked and consumed; none of the three candidate mechanisms produced that trail.

The window that IS real in this runtime is APRV-117's carryover, where a later invocation spends a grant an earlier one asked for, and the earlier one's deny may not have been honoured at the harness boundary. Closed three ways: consumeHarnessGrant now records grant_origin ("direct" only when the spending tool call is the tool call the request record names, "carried" for every other case including absence, derived at the write boundary from the verified log so a claim can only add scrutiny); the hook re-reads the verified log after the spend and before the allow, denying the new hook-grant-unverified where the chain cannot be seen to carry the execution.started; and docs/claude-code-hook.md states the exact boundary — the three ways a Claude Code tool call proceeds with no verdict, what a grant arriving after its write authorizes (nothing that already happened), what carryover means when the bytes are already on disk, and what an auditor can and cannot derive from the log.

Verified by 7 new CLI-level tests in tests/cli-hook.test.ts covering the direct and carried spends, the adopted spend, the unattended non-claim, the full seq ordering (task.registered -> approval.requested -> approval.granted -> execution.started -> the write -> execution.completed) after a granted file-tool edit, the cross-tool replay bound, and the caller-timestamp invariant. The defect reproduces with the marker disabled (actual: undefined). npm run lint clean; npm test 2716 tests, 2715 pass, 0 fail, 1 skipped.

SPEC.md text for §10.4 and §11.1 is drafted in the implementation notes flagged "(Amended APRV-200, pending sign-off.)" and NOT applied.
<!-- SECTION:FINAL_SUMMARY:END -->
