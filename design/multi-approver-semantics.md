# APRV-323 — Multi-approver and concurrent-decision semantics

**Status: design, pending human sign-off. Nothing here is wired into the gate.
Quorum does not exist in this runtime today, and this document changes no
behaviour. Every code reference below describes what the gate does NOW.**

GitHub issue #138 asks for two things: a stated default (first tap wins), and
an optional per-policy quorum of N approvals. The first already holds and is
merely unwritten. The second is a change to the one part of this system that
must never be wrong, so this is the design that has to be argued with before
anything is built.

---

## 1. What the gate does today, precisely

### 1.1 One decision, and the guard that enforces it

`decide` (`src/core/gate.ts:2507-2517`) wraps `attemptDecide`
(`src/core/gate.ts:2538-2934`) in a bounded read-check-append retry. Inside
`attemptDecide`, in order:

1. the actor must match `^human:.+` or the refusal is `actor-not-human`
   (`gate.ts:2546-2551`);
2. a fresh verified read of the log (`gate.ts:2571`);
3. for a grant, the policy must be attested (`gate.ts:2574-2580`);
4. `requestState(records, actionKey, ts, ttlMs)` derives the current state from
   the log alone (`gate.ts:2584`, implementation `src/core/state.ts:1312-1440`);
   state `none` refuses `not-requested`;
5. human-only class refuses `class-human-only` (`gate.ts:2613-2630`);
6. a lapsed TTL is materialised as `approval.expired` and the decision refuses
   `expired` (`gate.ts:2632-2650`);
7. a withdrawn request refuses `request-withdrawn` (`gate.ts:2652-2662`);
8. a rejected or revoked request refuses `already-decided` (`gate.ts:2664-2670`);
9. **an already-granted request refuses `already-decided`**
   (`gate.ts:2672-2679`), with the message "a second decision would rewrite a
   human's answer". Revoke is the one decision still allowed after a grant, and
   only before execution starts (`already-executed`, `gate.ts:2680-2685`).

So "first tap wins" is not an emergent property. It is a refusal with a name.

### 1.2 The projection says the same thing independently

`requestState`'s `settle` closure (`state.ts:1338-1354`):

```
if (decision !== null && value !== "revoked") return;
```

Once any decision has settled, only a revocation can change it. The comment at
`state.ts:1288-1296` states the reasoning: the gate refuses to append a second
decision, so a log carrying two was written by something else, and the
fail-closed reading of such a log is that the earliest human decision stands.

This matters for quorum more than it looks. **Today the writer-side guard and
the reader-side projection agree that a second `approval.granted` is an
anomaly.** Any quorum design must change both, together, or a two-of-three log
will be read by old code as a forgery.

### 1.3 The token is minted at grant time

`mintToken()` at `gate.ts:2865`, immediately before the append; only
`tokenHash(token)` reaches the log, as `token_sha256`
(`src/core/token.ts:122, 134-141`). The raw token is returned to the calling
process (`gate.ts:2927-2933`) or, under sealed delivery, encrypted to the
requester's ephemeral key (`gate.ts:2890-2899`). The grant payload binds
`payload_hash`, `class`, `est_cost_usd` and `policy_sha256` (`gate.ts:2742-2754`).
A request declaring `execution: "harness"` mints nothing (`gate.ts:2861-2864`).

**One grant, one key.** That is the invariant a quorum has to preserve, and the
one most likely to be broken by a careless implementation.

### 1.4 Expiry

`defaults.approval_ttl` parses in `src/core/policy-load.ts:740-752`. The lapse
test is in `requestState` (`state.ts:1400-1423`): no TTL means a request stays
pending forever; with a TTL, `now > requestedAt + ttlMs` is `expired`, and an
unparseable timestamp is also `expired`, which is the fail-closed direction.
`approval.expired` is appended by `appendExpiry` (`gate.ts:4191-4221`) under
the system actor, from two callers: lazily inside `decide`, and the `expire()`
verb (`gate.ts:4242-4297`) used by `approval expire` (`src/cli/gate.ts:703`)
and the daemon's TTL sweep (`src/daemon/daemon.ts:2382`). `on_expiry: reject`
changes no gate mechanic; it tells the projection to render the envelope state
as rejected (`gate.ts:4237-4239`).

### 1.5 Concurrency

An advisory lockfile `<log>.lock`, created with `open(path, "wx")`
(`src/core/log.ts:350-377`), is held across the whole read-check-write span by
`withAppendLock` (`log.ts:655-684`). The compare-and-append precondition is
`headPrecondition` (`log.ts:586-604`), called inside the lock by `appendEvent`
(`log.ts:713-751`). On `head-moved`, `withHeadMovedRetry`
(`gate.ts:945-950`, `src/core/head-retry.ts:129-137`, three attempts) re-runs
the ENTIRE `attemptDecide` from a fresh read, so the loser of a race gets a
re-derived, current-fact refusal (`already-decided`) rather than a plumbing
error.

**Two humans tapping Approve at the same instant is already a solved problem
here, and the way it is solved is that one of them is told no.** Quorum changes
what the second tap means; it must not change the serialization that makes the
question answerable.

### 1.6 Budgets

`evaluateBudgetsWithTask` runs in the grant branch only, before the append
(`gate.ts:2802-2810`). Authorizations counted in a window are
`approval.granted` records, plus `execution.started` records with no matching
grant in the same window (`src/core/budgets.ts:270-280`). So **a budget is
charged per grant record**, and a naive two-of-three would charge the same
action twice. §4.5 below is the fix.

### 1.7 Who the approver is

Every channel resolves identity the same way: `resolveHumanActor`
(`src/core/attest.ts:432-440`), which reads `--as human:<id>` and otherwise
`APPROVAL_HUMAN`. Telegram (`src/cli/channel-telegram.ts:436`), web
(`src/cli/channel-web.ts:371`) and cli (`src/cli/channel.ts:279`) all do this
at start-up and then pass one fixed actor to `recordChannelDecision`
(`src/channels/contract.ts:765-813`) for every decision that surface collects.

There IS already a roster. `approvers` exists at the top level of the policy
(`schema/policy.schema.json:88-108`) and per class as an array of ids
(`schema/policy.schema.json:437-443`), enforced by `namesApprover`
(`gate.ts:248-250`) at `gate.ts:2792-2801` with the refusal
`actor-not-approver`. SPEC.md:137 defines the matching: exact, no case folding,
`human:` prefix removed.

**And here is the load-bearing limitation.** The actor is declared by the
process, not proved by the tap. SPEC.md:549 says so: human identity in v0.1 is
config-declared, the trust boundary is the local machine. `src/channels/telegram.ts:37-52`
says it again for that channel: the callback is checked against a configured
chat id (`telegram.ts:3327-3331`) and the `from` field is never read; anyone in
that chat approves as the configured actor.

> **A quorum of N over identities that are not distinguishable is a quorum of
> one, counted N times.** This is the single most important sentence in this
> document. APRV-324 (issue #137) is the work that makes two approvers
> distinguishable, and quorum is not worth implementing before it lands.
> APRV-323 already declares the dependency on APRV-249; it should declare one
> on APRV-324 as well, and this design assumes it.

---

## 2. What is being proposed

An optional, per-rule `quorum: N` in the policy. Absent, or `1`, means exactly
today's behaviour, byte for byte. Present and greater than one, a grant needs N
distinct approvers before a token exists.

Nothing else about the manual path changes: the request is the same, the
channels are the same, the payload binding is the same, the refusals are the
same words.

---

## 3. The shape of a quorum decision

### 3.1 Two events, not one overloaded one

A quorum needs to record N human decisions and one authorization. Three options
were considered:

**(a) N `approval.granted` records, the Nth being the authorizing one.**
Rejected. It breaks §1.2's projection for every existing reader, makes "was
this granted?" a counting question in every consumer, and makes the budget
double-charge of §1.6 structural rather than incidental.

**(b) A new `approval.endorsed` for the first N-1 and `approval.granted` for
the Nth.** Rejected, narrowly. It keeps old readers correct and the budget
honest, but it makes the Nth approver's record structurally different from the
others', which is exactly backwards: in a quorum every approver does the same
thing, and only the runtime notices that the threshold was crossed.

**(c) N `approval.endorsed` records, then one `approval.granted` whose actor is
the system.** Recommended.

Under (c):

- each human decision appends `approval.endorsed`, actor `human:<id>`, carrying
  the same `class`, `payload_hash` and `policy_sha256` the grant would;
- when the Nth endorsement lands, the same locked, compare-and-append
  transaction that wrote it also writes `approval.granted` with actor
  `system:quorum`, `payload.quorum: {required: N, endorsements: [seq…]}`, and
  the minted `token_sha256`;
- a reader that does not know about `approval.endorsed` sees exactly one
  `approval.granted` and behaves correctly, except for one thing it must be
  told about: the granting actor is a `system:` id.

That exception is real and it is the price of (c). `schema/event.schema.json:204-264`
currently requires `approval.granted.actor` to match `^human:`. Loosening it is
a schema change that every conforming implementation must take, and §5 lists it
as such. The alternative — putting one of the N humans' ids on the grant — is
worse: it names one person as the decider of a decision N people made.

### 3.2 Distinctness

An endorsement is counted only if its actor is distinct from every earlier
endorsement's actor for the same action key, compared exactly, with no case
folding, as `namesApprover` already compares (`gate.ts:248-250`, SPEC.md:137).

A second endorsement by the same actor is refused `already-endorsed`, a new
code. It is NOT `already-decided`: nothing is decided, and telling an approver
"already decided" when the request is still pending would be a lie they act on.

Distinctness is only as good as identity. See §1.7 and §6.

### 3.3 The channel roster is not the quorum

`approvers[id].channels` in the policy is currently read only for policy-diff
display (`src/core/policy-diff.ts:487-490`) and enforced nowhere
(§1.7). Quorum must not quietly start enforcing it: that would be a behaviour
change smuggled in under a feature flag. If channel binding should be enforced,
that is its own task with its own tests.

---

## 4. The rules, one at a time

### 4.1 Identity

- `quorum: N` is valid only on a rule that also declares `approvers` with at
  least N entries. A rule with `quorum: 3` and two approvers is a policy that
  can never grant, and policy loading refuses it at load time rather than
  discovering it when someone is waiting. Fail closed: an unparseable or
  unsatisfiable quorum makes the whole policy unparseable, which by SPEC §11.1
  makes everything `manual`.
- An endorsement by an actor the rule's `approvers` does not name is refused
  `actor-not-approver`, the existing code, unchanged.
- `quorum` on a class whose autonomy is not `manual` is a load-time refusal.
  Supervised and autonomous actions emit no approval events at all (SPEC §6.3),
  so a quorum on them would be inert, and an inert safety control is worse than
  none because it reads as protection.

### 4.2 Denial

**One rejection ends it.** A `approval.rejected` from any named approver is
terminal, whatever the endorsement count. This is deliberately asymmetric, and
the asymmetry is the point: a quorum exists to make authorization harder, not
to make refusal harder. A design where two approvers can outvote one objector
is a design where the objector's job is to argue, and the gate is not a
debating chamber.

Consequence to state plainly: any single named approver can veto. If that is
not wanted operationally, the answer is a smaller `approvers` list, not a
voting rule.

### 4.3 Expiry

The TTL runs from `approval.requested`, unchanged (§1.4). It is **not** extended
by endorsements. A quorum that refreshed its own clock on each endorsement
could stay open indefinitely, and "how long may this question stand?" is a
property of the question, not of how many people have looked at it.

When the TTL lapses with fewer than N endorsements, `approval.expired` is
appended as it is today and the endorsements stay in the log as the record of
who did look. The `expire()` verb's `not-expired` / `already-decided` refusals
are unchanged.

Operationally this means a quorum needs a TTL long enough for N people to be
awake. That is a policy-authoring concern and the doctor should say so: a rule
with `quorum > 1` and a TTL under some threshold deserves a warning row, not a
refusal.

### 4.4 Concurrency

No new machinery. Endorsement counting happens inside `attemptDecide`, under
the same append lock and the same compare-and-append precondition
(§1.5). Two approvers tapping simultaneously serialize: one writes, the other
gets `head-moved`, `withHeadMovedRetry` re-runs the whole derivation from a
fresh read, and the second endorsement is counted against a view that includes
the first.

The one genuinely new race is the Nth endorsement. It must be **one
transaction**: the endorsement, the token mint and the grant append, under one
lock hold. Writing the endorsement and then re-entering to write the grant
would leave a window in which a crash leaves N endorsements and no grant, which
a later reader would have to repair, and repairing authorization is exactly the
thing this system does not do automatically. `appendEvent` currently appends one
event per call; a batched append under one lock is an addition to `src/core/log.ts`
and is listed in §5.

### 4.5 Budget

Budget is evaluated once, at the Nth endorsement, immediately before the
combined append, exactly where `evaluateBudgetsWithTask` runs today
(§1.6). `approval.endorsed` consumes nothing and is invisible to
`src/core/budgets.ts`. So a quorum-granted action is charged once, like every
other action.

Note what this means: a budget refusal arrives after N-1 people have already
endorsed. That is the honest ordering — a budget is a property of the
authorization, not of each opinion about it — and the refusal should say so:
`budget-exceeded` on a quorum action names the endorsement count so the
approvers can see their work was not lost.

### 4.6 Token

One grant, one token, unchanged (§1.3). The token is minted at the Nth
endorsement and delivered to the requester by the existing path. Under sealed
delivery it seals to the requester's ephemeral key, which is a property of the
request, not of the approvers, so nothing changes.

No approver holds a partial token. There is no secret sharing here and there
should not be: it would add a cryptographic failure mode to buy a property
(no single machine sees the token) that the trust boundary in SPEC §11 does not
currently claim.

### 4.7 Revocation

Revocation stays single-actor: any named approver may revoke a quorum grant
before execution, refusing `already-executed` afterwards, as today
(`gate.ts:2680-2685`). Same asymmetry as §4.2, same reason.

### 4.8 Compatibility with `supervised-live`

A `supervised-live` action the draw selects goes down the manual path and emits
exactly the manual events (SPEC §6.3, APRV-127). If its rule also declares
`quorum`, the drawn action needs N endorsements. That is consistent but
surprising, and the doctor should surface the combination.

---

## 5. Required SPEC and schema changes

Each is a task of its own. None may be done silently.

**SPEC.md**

1. §6.3, the lifecycle: `approval.endorsed` added to the event vocabulary, with
   its terminality rules (endorsements are not decisions; one rejection is
   terminal; the TTL is not extended).
2. §6.3: the sentence that `approval.*` events are exclusive to the manual path
   extends to `approval.endorsed`.
3. §5.2, policy semantics: `quorum: N`, its load-time validity rules (§4.1),
   and the statement that absent or `1` is byte-identical to today.
4. §5.2: the `approvers` binding paragraph gains distinctness, and repeats the
   §11 caveat that identity is config-declared.
5. §11.1: a new global invariant, or an extension of invariant 4, that N
   endorsements by indistinguishable identities do not constitute a quorum, and
   that an implementation MUST NOT count two endorsements it cannot show came
   from different people. (This is the §6 question, and it belongs in §11
   because it binds every task, per CLAUDE.md's rule about cross-cutting
   properties.)
6. §11.2, the refusal registry: `already-endorsed`, `quorum-unsatisfiable`,
   `quorum-not-manual`.
7. §6.2: `approval.granted.actor` MAY be `system:quorum`, and what that means.

**`schema/event.schema.json`**

8. New `approval.endorsed` event: requires `task`, `action_key`, `actor`
   matching `^human:`, payload carrying `class` and `payload_hash`.
9. `approval.granted.actor` pattern loosened from `^human:` to
   `^(human|system):`, with the system form permitted only when
   `payload.quorum` is present. (A `oneOf`, so the loosening cannot be used by
   anything else.)
10. `approval.granted.payload.quorum`: `{required: integer ≥ 2, endorsements:
    array of integers}`, additive and optional.

**`schema/policy.schema.json`**

11. `quorum` on a class rule: integer ≥ 1, additive and optional.

**`conformance/`**

12. New vectors for every rule in §4, each carrying its `failure_class`, plus
    negative controls. A conforming second implementation must reject a
    two-of-three log whose two endorsements share an actor.

**Runtime**

13. `src/core/log.ts`: a batched append under one lock hold (§4.4).
14. `src/core/state.ts`: `requestState` learns endorsements without changing
    what it returns for a non-quorum request.
15. `src/core/budgets.ts`: an explicit statement (and test) that
    `approval.endorsed` is not an authorization.
16. `approval doctor`: rows for the §4.3 short-TTL warning and the §4.8
    combination.

---

## 6. The question this design cannot answer

Everything above is mechanically sound and, on this repository's current trust
boundary, **partly decorative**.

With Telegram as the channel, the runtime records the actor the listener
process was launched with (§1.7). If Carter and a second approver both tap
Approve in the same chat, both endorsements carry `human:carter`, the second is
refused `already-endorsed`, and the quorum never completes. If instead the
deployment runs two listeners as two actors, then anyone in either chat can
endorse as either actor, and a quorum of two is one person tapping twice from
two phones.

There is no implementation of quorum that fixes this from inside the gate. It
is fixed by APRV-324 (per-sender identity, issue #137) and APRV-249 (identity
and receipts), and only then.

**Recommendation.** Do not build quorum before APRV-324 lands. Land §5's items
1-7 and 11 (the vocabulary and the policy key) as a documented, refusing stub
if the schema needs to be stable early; make `quorum: N` for N > 1 a load-time
refusal with the message "quorum requires per-approver identity (APRV-324)"
until it is true. A gate that refuses to pretend is worth more than a gate that
counts.

---

## 7. Adversarial acceptance tests

Each of these is a test that must exist and fail before the implementation, in
the repository's usual style: built through the real append path, never a
hand-written log line.

**Counting**

1. Two endorsements from the same actor: the second refuses `already-endorsed`,
   appends nothing, and no token exists.
2. Two endorsements from distinct actors under `quorum: 3`: no grant, no token,
   request still pending.
3. The Nth endorsement: exactly one `approval.granted` appears, its actor is
   `system:quorum`, its `payload.quorum.endorsements` names the N endorsement
   seqs, and exactly one token is minted.
4. An endorsement from an actor not in the rule's `approvers`: refuses
   `actor-not-approver`, is not counted, appends nothing.
5. Actor distinctness does not case-fold: `human:Alice` and `human:alice` are
   two ids by the letter of SPEC.md:137, and a test pins whichever answer the
   spec amendment chooses so it cannot drift.

**Denial and revocation**

6. One rejection after N-1 endorsements is terminal; a subsequent endorsement
   refuses `already-decided`.
7. Revocation by any one named approver after a quorum grant, before execution:
   succeeds. After `execution.started`: refuses `already-executed`.
8. Withdrawal by the requester after N-1 endorsements: succeeds, and a
   subsequent endorsement refuses `request-withdrawn`.

**Expiry**

9. TTL lapses at N-1 endorsements: `approval.expired`, endorsements remain in
   the log, no token, and a late Nth endorsement refuses `expired`.
10. Endorsements do not extend the TTL: a request endorsed repeatedly right up
    to its deadline still expires at `requestedAt + ttl`.

**Concurrency**

11. Two processes endorsing the same action key simultaneously: both land, in
    some order, both counted once, and neither observes the other's write as
    its own.
12. Two processes racing the Nth endorsement: exactly one grant, exactly one
    token, and the loser gets a re-derived refusal rather than a `head-moved`.
13. A crash injected between the Nth endorsement and the grant is impossible by
    construction: a test that the batched append is one `appendEvent` call, and
    a test that a log holding N endorsements and no grant is read as PENDING,
    never as granted.

**Budget**

14. A quorum-granted action is charged exactly once, and the endorsements
    contribute nothing to any window.
15. A budget refusal at the Nth endorsement: nothing is granted, no token, the
    N-1 endorsements stand, and the refusal message names the count.

**Policy loading**

16. `quorum: 3` with two approvers: the policy fails to load and everything
    resolves `manual`.
17. `quorum: 2` on an autonomous class: load-time refusal.
18. `quorum: 1` and absent `quorum`: the log of a full manual cycle is BYTE
    IDENTICAL to one produced before this feature existed. This is the
    regression test that matters most.

**Identity (the §6 question)**

19. Two endorsements arriving through one Telegram listener carry the same
    actor and cannot form a quorum. A test that pins this until APRV-324 lands,
    so nobody ships a quorum that counts one person twice.
20. While the stub of §6 stands: `quorum: 2` is a load-time refusal naming
    APRV-324.

---

## 8. What this document does not do

It does not change `src/core/gate.ts`. It does not add an event type, a policy
key, a schema field or a refusal code. `approval.granted` is still one record
written by one human, `already-decided` is still the answer to a second tap,
and no `quorum` key is read by anything. Issue #138 stays open until the
behaviour it asks for is delivered and verified, which this is not.
