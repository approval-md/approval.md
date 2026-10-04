# APRV-451 — Per-class `approval_ttl`: not now

**Status: decided NO, pending human sign-off. No key is added and no SPEC.md
hunk is proposed. Section 5 is what a policy author does instead, section 6 is
the condition that would reopen the question and the shape a yes would take,
and section 7 records two pre-existing gaps found while checking the TTL readers.
Every code reference describes what the runtime does NOW.**

The question: a policy can carry questions that should stand for days (an agent
proposing something a person reviews when they get to it) beside actions that
should not be spendable for more than minutes (a spend). `approval_ttl` exists
only under `defaults`. Does a class rule need its own?

---

## 1. What exists today

**1.1 One optional key.** `defaults.approval_ttl` (`schema/policy.schema.json:32-36`),
parsed once in `src/core/policy-load.ts:799-819`. Its absence is a statement,
nothing lapses, and a runtime MUST NOT invent a default (SPEC.md §5.2, the
paragraph after the canonical example). The class rule is a closed object whose
keys are `autonomy`, `live_rate`, `retro_rate`, `allow_irreversible`, `approvers`
and `limits` (`schema/policy.schema.json:427-431`); there is no TTL on it.

**1.2 Measured from `approval.requested`, judged lazily.** One derivation in
`requestState` (`src/core/state.ts:1447-1478`) serves the gate's decide, withdraw
and expire verbs, the carry lookup, the daemon sweep, the queue and the channels,
so "has this lapsed" has one answer.

**1.3 Narrowed per request by the harness ceiling.** A hook-opened request
records the per-entry timeout its harness runs it under as `payload.harness_cap_ms`,
and the effective window is the shorter of the policy TTL and that cap minus 60 s
(`src/core/harness-wait.ts:107-141`, APRV-423). The cap is self-reported and can
only shorten (§11.1 invariant 4).

**1.4 Recorded on expiry.** `approval.expired` carries `requested_ts`, the
effective `ttl_ms`, the `harness_cap_ms` when there was one, `on_expiry` and
`class` (`src/core/gate.ts:4459-4499`). It is appended lazily by a decision on a
lapsed request or by the daemon's sweep (`src/daemon/daemon.ts:2722`, over
`lapsedRequests` in `src/daemon/projection.ts:210`), which takes one TTL for the
whole log.

**1.5 It also bounds the grant.** A token dies at the parent request's TTL; v0.1
deliberately has no second token clock (`src/core/token.ts:34-53`).

**1.6 The requester can end its own question.** `approval wait <task> --timeout
<d> --withdraw-on-timeout` withdraws what that actor opened when its wait ends
(`src/cli/help.ts:1075-1081`), and a withdrawn request can never be granted
(SPEC.md §6.3). `payload.wait_until` shows an approver when an answer stops
mattering and governs nothing (`src/core/state.ts:1186-1196`). A harness
adapter's request is withdrawn after its retry grace (SPEC.md §10.1).

**1.7 Which policy the TTL is read from.** The policy file as loaded at the
moment of evaluation, and never a value pinned on the request
(`src/core/gate.ts:924`, `src/daemon/daemon.ts:2286-2291`,
`src/core/token.ts:637-640`). A grant requires attestation and refuses
`policy-drift` when the attested hash differs from the one the request pinned
(SPEC.md §5.2), so no TTL edit reaches a grant without a human re-attesting, and
re-attesting voids every pending request for granting. Expiry, withdrawal and
token spend do not check attestation. Section 7 follows that thread.

---

## 2. The cases, and what covers them

| # | case | what it actually wants | covered today? |
|---|---|---|---|
| A | A question raised by an agent that does not block on it (72 h to review a proposal), beside live actions | a long question lifetime for the first, short for the second | **Yes.** A 72 h global TTL serves the first, and a live action reached through a harness hook is clamped to cap minus 60 s (1.3) whatever the policy says |
| B | A consequential class run through a harness hook (a spend in a tool call) | a deadline no later than the moment the harness stops listening | **Yes, and more tightly than any class key could.** The clamp is per request and tracks the harness that asked |
| C | A question with a natural close (a weekly vote that closes Friday) | a deadline per REQUEST: two votes in one class close at two instants | **Partly.** The requester withdraws at its own deadline (1.6). A class TTL would not express it either |
| D | A consequential class on the token path (`approval request`, then `approval run`) whose author wants a grant unspendable after minutes | an author-enforced shelf life for the ANSWER, shorter than the global TTL | **No.** The only author control is shortening the global TTL, which shortens every question with it |
| E | A different `on_expiry` per class | nothing: the enum has one member, `reject` (`schema/policy.schema.json:44-48`) | n/a |
| F | Questions held overnight by quiet hours (APRV-450, `design/quiet-hours.md`, proposed in its own PR) beside classes that must reach a person at night | a TTL that outlasts the window for held classes, and night delivery for the others | **Yes, by that proposal's own keys.** The global TTL is sized to outlast the longest window (its doctor row warns when it does not), and a class that must be answered at night takes the `deliver_in_quiet_hours` bypass rather than a shorter clock |

Case D is the one real gap, and nobody has met it yet. The hosted deployment
that raised this question (Agent Village) gates questions its agents ask and do
not execute through `approval run`, and reaches every executing class through a
harness hook, which is case B.

---

## 3. What a per-class key would cost

**3.1 The harness clamp composes for free.** `harnessCappedTtlMs(policyTtlMs,
capMs)` already takes the policy's number as a parameter, so the effective window
would be the shorter of (class TTL, else default TTL) and cap minus margin. No
cost here, and none of the arguments below depends on it.

**3.2 It makes a deadline a function of class resolution, under a file that is
read live.** Today the number that times every pending request moves only when
`defaults.approval_ttl` itself is edited, and `src/core/policy-diff.ts` already
reports that field (lines 43 and 257). With a class key, adding a more specific
rule for an unrelated reason would re-time every pending request and every live
token of the classes that rule now wins, because expiry, withdrawal and token
spend resolve against the file as loaded (1.7). Policy drift voids those requests
for GRANTING once a human re-attests; it does not stop the sweep expiring them,
or a token being spent, under the new number. Every policy diff would need a
per-class TTL view to show this.

**3.3 Two answers become possible.** The sweep takes one TTL for the log
(`src/daemon/daemon.ts:2722`). Per class it would resolve each request's class
against the policy, and lazy expiry inside `decide` would do the same separately;
the two then agree only if their resolution agrees, where today they share one
number by construction.

**3.4 The record needs more to be readable.** `approval.expired` would have to
name the matched pattern beside `ttl_ms` so that a reader can see why this
request's window differed from its neighbour's. `src/core/token.ts`, which is
pure and takes the TTL as a parameter (`verifyToken`, line 544), would take a
resolver instead.

**3.5 Vocabulary is permanent.** The policy schema is closed (SPEC.md §5.2), so
a policy using a new key fails to load on every older runtime, and removing the
key later breaks every policy that adopted it. Each per-class key so far (`live_rate`,
`retro_rate`, `allow_irreversible`, `approvers`, `limits`) arrived with a need
that had been observed.

**3.6 It mixes two clocks under one name.** Case D is about how long an ANSWER
may be spent. `approval_ttl` is how long a QUESTION may stand, and in v0.1 the
first is derived from the second (1.5). A per-class `approval_ttl` would shorten
how long a person has to answer in order to shorten how long the answer stays
spendable. An author who wants fresh grants on a spend class does not
necessarily want the spend question to vanish before the approver wakes.

---

## 4. Decision

**No per-class `approval_ttl` for now.** Cases A and B are covered by the global
TTL and the harness clamp, and case F by the quiet-hours proposal's own bypass. Case C needs a per-request deadline, which a class key
does not provide. Case D is real, has not been observed, and is about grant
freshness rather than question lifetime, which is the conflation 3.6 describes.
The costs in 3.2, 3.3 and 3.5 fall on every reader of every policy; the benefit
falls on a case nobody has met.

---

## 5. What a policy author does instead

1. **Set `defaults.approval_ttl` to the longest any question may stand.** (A
   deployment whose agents propose and do not wait uses 72 h.)
2. **Put consequential actions behind a harness hook where one exists.** A
   hook-opened request is clamped to the harness ceiling minus 60 s whatever the
   policy TTL is (1.3), so a 72 h policy gives a hook-gated spend about four
   minutes.
3. **On the token path, the executor holds the deadline.** Request, then
   `approval wait --timeout <d> --withdraw-on-timeout`, and spend the token on the
   grant or not at all; an executor that wants a fresh approval later asks again.
   This is cooperative, and the author cannot enforce it. That is case D's gap,
   stated rather than hidden.
4. **For a question with a close (case C)**, the requester withdraws at the close
   and sets `wait_until` so that the approver sees the close on the card.
5. **If case D must be enforced today**, the author's only lever is a shorter
   global TTL, with long-standing questions re-asked when they lapse. A lapsed
   request authorizes nothing and asking again is a new request with a new
   decision (SPEC.md §6.3), so re-asking costs attention and never safety. A class
   that needs its own clock badly enough can also live behind a separate gate
   root with its own policy and log, which is heavy and is the honest price of
   the current vocabulary.

---

## 6. What would reopen this, and the shape a yes would take

**Trigger:** a deployment observed running a consequential class on the token
path (not through a hook) whose author needs that class's grants to stop being
spendable sooner than the global TTL. When that happens, the first question is
whether the right key is a class `approval_ttl` or a separate answer clock (open
question 3). If it is the class key, the shape is already settled here so that
the yes is quick. **This is a sketch and is not proposed:**

- `approval_ttl` on a class rule, admitted on `manual` and `supervised-live` (the
  levels that open requests), a schema violation on every other level.
- The winning rule's value governs, as for every per-rule key (SPEC.md §5.2
  resolution); absent, `defaults.approval_ttl`; absent both, nothing lapses. A
  class cannot declare "never" under a declared default, since a duration is
  positive by grammar.
- Effective window: the shorter of that and the harness cap minus margin.
- The effective TTL is pinned on `approval.requested` at the write boundary, as
  `policy_sha256` is, and every later read judges by the SHORTER of the pinned and
  the current value. Neither an edit nor a new winning rule can then lengthen a
  live deadline, and a shortening still takes effect (open question 1).
- `approval.expired` names the matched pattern; the sweep resolves per request;
  the policy diff shows per-class TTL changes.

No conformance vectors are needed for a no. A yes would need precedence vectors
(class over default, winning rule only, tied rules), clamp composition, and the
pin's min rule under an edit in each direction.

---

## 7. Found while checking the readers (pre-existing, not caused by any key)

**7.1 Three TTL readers read the file on disk, not the attested bytes.** Expiry
(lazy and swept), withdrawal and manual-path token spend take
`defaults.approval_ttl` from the policy as loaded (1.7), and the manual spend path
deliberately does not re-check attestation (`src/core/execute.ts:709-715`). So a
human edit to the TTL that has not yet been attested is already in force for
those three paths. Lengthening it extends the shelf life of tokens already
granted; shortening it expires pending requests early. Only a human can edit the
policy file (`policy.core`), so this is no escalation by an agent. It is a gap
between SPEC.md §5.2's "an edited policy is inoperative until a human re-attests
it" and what these readers do.

**7.2 A policy that fails to load leaves granted tokens unbounded.** SPEC.md §5.2
says a policy that fails to load carries no TTL, and argues it for requests:
failing closed does not shorten the time a human has to answer. The same absence
reaches `tokenTtlMs` (`src/core/token.ts:637-640`), so while the file is broken,
every token already granted stays spendable with no time bound. For a token that
is the opposite direction: it lengthens an authority already conferred.

Neither is fixed or filed by this task. Both are candidates for one follow-up,
and the pin in section 6 would close 7.1 for expiry and spend regardless of
whether a class key ever exists. Filing it is the human's call.

---

## 8. Open questions

1. **Pin the effective TTL on the request now**, independent of this decision,
   judging by the shorter of the pinned and current values. It closes 7.1 for the
   readers that matter and makes `approval.expired` checkable from the log alone.
   Leaning yes, as its own task.
2. **A requester-declared deadline that may only shorten**, generalising
   `harness_cap_ms` from hooks to any request. It serves case C exactly, needs no
   policy vocabulary, and is safe under §11.1 invariant 4 for the reason the cap
   is. Leaning yes, as its own task.
3. **If case D reopens, is the right key an answer clock rather than a question
   clock?** `src/core/token.ts:34-39` rejected a separate token TTL in v0.1
   because a live request with a dead token is hard to explain from the log.
   Case D is the first argument for revisiting that, and it should be weighed
   against a class `approval_ttl` before either is added.
4. **Should 7.2 fail closed for tokens?** A failed load could bound granted
   tokens at the last attested TTL rather than at nothing. That changes a SPEC
   sentence and belongs with question 1.
