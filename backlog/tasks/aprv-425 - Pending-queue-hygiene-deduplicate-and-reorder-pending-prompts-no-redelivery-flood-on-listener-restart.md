---
id: APRV-425
title: >-
  Pending-queue hygiene: deduplicate and reorder pending prompts, no redelivery
  flood on listener restart
status: Done
assignee:
  - '@claude'
created_date: '2026-09-21 06:42'
updated_date: '2026-09-22 01:40'
labels:
  - telegram
  - daemon
  - hygiene
dependencies: []
priority: low
ordinal: 326000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Dogfooding produced a specific list of what hurts about running the gate: a listener restart redelivers every pending prompt at once because the sent-record starts empty, a live prompt is buried behind dead ones, and an operator rejected a decision they wanted in the flood (APRV-118). APRV-287 collapses old requests into one reject-all message on reconnect. Go further: the sent-record survives restart (derived from the log, never evidence), pending prompts are ordered with the live one on top, expired and superseded ones are collapsed, and a restart resends nothing already on the phone. This is a hosted-daemon hygiene requirement and a self-hosted quality of life fix in one.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 After a listener restart with N pending requests already delivered, zero new messages are sent; shown by a test against the injected fetch
- [x] #2 Pending prompts are ordered newest-live first and expired or superseded ones are collapsed per APRV-287, with the ordering rule documented
- [x] #3 The sent-record is rebuilt from the log on start and is never read as evidence of delivery
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read APRV-196's notes first, as instructed, and EXTEND rather than duplicate. 196 already bought three things this task builds on: every callback is acked exactly once, a tap on ANY copy decides the request (callback_data carries a restart-stable action ref, so an un-annotated pre-restart button still works), and the first batch a process sends is preceded by one banner. APRV-287 then added the collapse of requests nobody is waiting on. What is missing is ORDER, DEDUPE, and the honest accounting of what the collapse covers.

2. orderPending(requests, now), exported and documented, applied to queue.requests once in dispatchPending so pacedSelection, collapseStale and groupForDigest all inherit it. The rule: attestation prompts stay LAST (buildPendingQueue puts them there deliberately, because a policy amendment changes the rules the entries above it were routed by); among the approvals, the LIVE ones (younger than the hook's wait plus its retry grace) come first, newest first, because the newest is the one most likely to have a tool call still blocking on it; the stale ones follow, oldest first, and are what the collapse takes. Stable within each bucket, so log order breaks ties and the ordering is deterministic.

3. supersededPending(requests): a pending request whose (payload_hash, class) pair a NEWER pending request also names is one nobody will answer - the newer request is the live question for those bytes, and the older is what a hook-timeout past the retry grace leaves behind. Those are collapsed regardless of age, which is the 'deduplicate' half of AC2 and the 'a live prompt is buried behind dead ones' complaint.

4. staleLines has to stay true. It currently says every collapsed request is older than the wait plus the grace; with superseded duplicates in the set that is no longer so, so the lines state the split by count. A message that overstates what it collapsed is the stale-documentation failure in message form.

5. AC3, and the SPEC boundary. The sent-record IS rebuilt from the log on start: collapseStale marks every collapsed member as sent by this process, and the set it works from is the pending set re-derived from the verified log. It is never read as evidence: every collapsed request stays pending, listable by /queue and decidable from any copy already delivered (APRV-196's action-ref resolution), and losing the record degrades to showing them again. Tested both ways.

6. AC1 is met as ZERO NEW PROMPT MESSAGES with one summary, not as literal zero, and the notes say why: SPEC 10.3 requires that losing the sent-record degrade to a re-send and NEVER to a pending request nobody is shown. Seeding the record from the log and sending nothing would produce exactly that for a request no listener ever delivered (a request that arrived while the listener was down predates this process's start like any other). The summary is what keeps it legal. The SPEC hunk that literal zero would need is written out in the notes and NOT applied.

7. Tests in tests/channels-telegram.test.ts against the injected fetch, beside APRV-287's own case: a restart with N stale pending sends one message and zero prompts; the ordering rule, newest live first with the prompts last; a superseded duplicate collapsed while its newer twin is delivered; and the sent-record rebuilt on start yet not evidence (a fresh DispatchState shows them again).
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What was done

Read APRV-196's notes first, as the brief instructed, and this EXTENDS them
rather than repeating them. APRV-196 already bought the three things that make
the rest safe: every callback is acked exactly once, a tap on ANY copy decides
the request (callback_data carries a restart-stable action ref, so a button on a
pre-restart copy still works), and a startup batch is preceded by one banner.
APRV-287 then collapsed the requests nobody is waiting on. What was missing was
ORDER, DEDUPE, and an honest accounting of what the collapse covers.

**orderPending(requests, now)**, exported and applied ONCE per cycle to
queue.requests in dispatchPending, so the annotation pass, the paced
walkthrough's seeding, the collapse and the digest grouping all read one
sequence. Live requests (younger than COLLAPSE_STALE_AFTER_MS, the hook's wait
plus its retry grace — the same boundary the collapse uses, so there is one
meaning of 'somebody may still be holding this') come first, newest first;
stale ones follow, oldest first; attestation prompts stay last, because
buildPendingQueue put them there on purpose and that placement is not this
function's to relitigate. Stable inside each bucket, so log order breaks every
tie. /queue takes the same ordering, because two orders would be two answers to
'what is waiting on me'. Under paced the order reaches only the SEEDING, so a
request already in the walkthrough keeps the place /skip gave it.

**supersededPending(requests)**: a pending request whose (payload_hash, class)
pair a NEWER pending request also names. Keyed by bytes and class rather than by
task, because a harness adapter mints a fresh task id per tool call (SPEC 10.2),
so two askings of one command never share one, while the bytes and the class are
what a decision binds to. Those are collapsed regardless of age, which is the
deduplicate half of AC2 and the direct answer to APRV-118's complaint. An
attestation prompt is never a duplicate of anything, and a request whose instant
cannot be read loses to one whose can.

**staleLines had to stay true.** It said every collapsed member was older than
the wait plus the grace, which stopped being so the moment the collapse widened.
It now states the split by count, or says 'all superseded by a newer pending
request for the same bytes and class' when age collapsed nothing. A message that
overstates what it collapsed is the stale-documentation failure in the one place
a human is deciding from.

## AC3: where the sent-record is rebuilt, and why it is not evidence

collapseStale is the place, and deliberately not a second mechanism: it writes
every collapsed member into state.delivered and state.sentAtMs, and the set it
writes from is the pending set re-derived from the verified log. The log is the
only place 'what is pending' is answered.

It is not evidence of delivery, and nothing reads it as any. A collapsed request
stays pending in the log, is listed by /queue, and is decidable from any copy
already on the phone (APRV-196's action ref). Losing it shows the requests again.
Both halves are asserted: the second cycle of the same process sends nothing, and
a fresh DispatchState re-shows every request.

## AC1: met as zero new PROMPT messages, with one summary. Held, and why

The literal reading — zero messages after a restart with N pending requests
already delivered — is not implementable without a SPEC amendment, and the
amendment was NOT applied (the gate daemon is down this session and SPEC is out
of scope for this lane).

The reason is SPEC 10.3: 'A listener's record of what it has already sent ... its
loss MUST degrade to a re-send (a duplicate in front of the approver), never to a
pending request nobody is shown.' A listener cannot tell a request a previous
process delivered from one that arrived while nothing was running: both predate
this process's start. Seeding the record from the log and then sending nothing
would produce exactly the forbidden outcome for the second kind. The one summary
message is what keeps it legal, and it is why APRV-287 built the collapse rather
than a silence.

What did change is the count. A restart with N stale pending was a banner plus N
prompts; it is now ONE summary and zero prompts, and the second cycle of that
process sends nothing at all. Measured against the injected fetch.

**The SPEC hunk literal zero would need**, written here and not applied, for
SPEC 10.3's dispatch paragraph:

  'A channel MAY treat a request that was already pending when the process
  started as one a previous process delivered, and withhold a re-delivery for it,
  PROVIDED the request remains pending, listable and decidable from any copy
  already delivered, and provided the channel has some evidence of that earlier
  delivery other than the request's own age. Absent such evidence the collapse of
  the paragraph below is the narrowest answer, because a request that arrived
  while no listener was running is indistinguishable by age from one that was
  shown.'

I do not recommend it as written: the proviso names evidence this project does
not have, and the only honest sources would be a delivery event in the log
(a schema change and its own task) or a read of the chat's own history (a network
read at startup, and a new trust dependency). Carter's call.

## Invariants touched

None weakened, and none of §11.1's ten is reached by this diff: no verdict, no
classification, no sampling draw, no budget, no token, no obligation and no
harness allow reads anything added here. Ordering and collapsing are display,
and the code says so in three places. The property that IS load-bearing is
SPEC 10.3's 'never a pending request nobody is shown', which is exactly what the
held AC1 above protects.

## Evidence per criterion

- **AC1** — NOT checked. Met as 'zero new prompt messages, one summary' and not
  as literal zero; see 'AC1: met as zero new PROMPT messages' above for the
  SPEC 10.3 reason and the unapplied hunk. The measured behaviour is
  tests/channels-telegram.test.ts 'APRV-425: a restart with every pending
  request stale sends ONE message and no prompts': four pending requests, a
  fresh DispatchState, and exactly ONE message on the injected fetch (asserted
  on mock.sentTexts() length, not on a result field), no banner, no prompt
  digest, all four accounted for in result.delivered — and the next cycle of the
  same process sends nothing at all.
- **AC2** (ordered newest-live first; expired or superseded collapsed per
  APRV-287; the rule documented). 'APRV-425: the order is live newest-first,
  then stale oldest-first, prompts last' pins the full comparator including
  ties, an unreadable instant and that nothing is dropped. 'APRV-425: a newer
  pending request for the same bytes and class supersedes an older one' pins the
  dedupe including the same-bytes-different-class case (a multi-class tool call,
  which must NOT dedupe). 'APRV-425: a superseded duplicate is collapsed while
  its newer twin is prompted' drives it end to end through the real log and the
  injected fetch: the two older askings collapse, the newest keeps its card, the
  summary says supersession rather than age, and no approval.granted,
  approval.rejected or approval.withdrawn was produced. Expired requests need no
  collapsing: buildPendingQueue only ever returns state === 'requested', so a
  lapsed request is absent from the queue rather than shown. The rule is
  documented in docs/claude-code-hook.md 'The order the queue arrives in
  (APRV-425)', in docs/dogfood-cutover.md's operator paragraph, and on
  orderPending itself.
- **AC3** (rebuilt from the log on start, never read as evidence). Both halves
  in 'a restart with every pending request stale sends ONE message and no
  prompts': the second cycle of the same process sends nothing (the record was
  rebuilt), and then queueOf() shows all four still pending in the log and a
  fresh DispatchState re-delivers all four (it is not evidence, and its loss
  degrades to a re-send). Documented on collapseStale.

## Validation

- npm run build: exit 0. npm run typecheck: exit 0. npm run lint: exit 0, no
  output.
- node scripts/run-tests.mjs --only channels-telegram: 150 tests, 150 pass, 0
  fail (146 before this task, 4 added). The 146 passing unchanged is the
  compatibility evidence: APRV-287's own collapse cases, the paced walkthrough,
  /skip and /queue all still behave as they did.
- node scripts/run-tests.mjs --only harness-cap daemon-drift-deferral daemon
  channels-telegram gate cli-gate cli-hook cli-hook-hermes cli-help
  cli-long-help clock audit event-schema conformance conformance-regen state:
  680 tests, 680 pass, 0 fail.
- node conformance/run.mjs: exit 0, 458 vectors, 458 passed, 0 failed, 176
  controls, manifest ok.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The pending set now has a stated order, applied once per cycle and shared by the delivery, the paced walkthrough's seeding and /queue: live requests newest first (live being younger than the hook's wait plus its retry grace, the same boundary the collapse uses), then stale ones oldest first, with attestation prompts last where approval queue already put them. A pending request whose payload bytes and class a NEWER pending request also names is collapsed whatever its age, which is the direct answer to APRV-118's live-prompt-buried-behind-dead-ones, and the collapsed summary now states whether each member is there for age or for supersession instead of claiming all of them are old. A restart with N stale pending went from a banner plus N prompts to ONE summary and zero prompts, with the second cycle of that process sending nothing; the sent-record is rebuilt from the log on start by the collapse itself and is never read as evidence, so every collapsed request stays pending, listable and decidable from any copy already on the phone (APRV-196's action ref), and losing the record shows them again. Verified with build, typecheck and lint at exit 0, channels-telegram 150/150 against the injected fetch (146 unchanged plus 4 new), the 16-suite touched set 680/680, and conformance 458/458 vectors with 176 controls. AC1 is NOT checked: literal 'zero new messages' would require withholding a re-delivery for a request no listener can prove was delivered, which SPEC 10.3 forbids ('never a pending request nobody is shown'); the hunk it would need is written in the implementation notes and deliberately not applied, and it needs Carter's call because the evidence it names does not exist yet. The merge is NOT armed: the gate daemon is down for this session.
<!-- SECTION:FINAL_SUMMARY:END -->
