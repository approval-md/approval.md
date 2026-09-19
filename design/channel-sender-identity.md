# APRV-324 — Channel sender to attested human identity

**Status: design, pending human sign-off. Nothing here is wired into the gate.
Production attribution is unchanged: a grant is still recorded against the
actor the listener process was launched with.**

GitHub issue #137 asks that a grant name the person who tapped, not the runtime
that was listening. This document says precisely what each channel can and
cannot authenticate today, proposes an operator-attested mapping from an
authenticated sender to a `human:<id>`, and enumerates the tests that must
exist before any of it touches production attribution.

---

## 1. What is recorded today, and where it comes from

### 1.1 One resolution point, three channels

`resolveHumanActor` (`src/core/attest.ts:432-440`) is the whole of identity:

```
export function resolveHumanActor(options: { actor?: string } = {}): string | null {
  const explicit = options.actor;
  if (explicit !== undefined) {
    return HUMAN_ACTOR.test(explicit) ? explicit : null;
  }
  const fromEnv = process.env[HUMAN_ACTOR_ENV];
  if (fromEnv !== undefined && HUMAN_ACTOR.test(fromEnv)) return fromEnv;
  return null;
}
```

`HUMAN_ACTOR` is `/^human:.+/` (`attest.ts:63`); `HUMAN_ACTOR_ENV` is
`APPROVAL_HUMAN` (`attest.ts:66`). Each channel calls it once, at start-up:

- Telegram: `src/cli/channel-telegram.ts:436`, stored as `setup.actor`
  (`:279`), passed to `recordChannelDecision` at `:2164-2167`.
- Web: `src/cli/channel-web.ts:370-371`, passed at `:295` and `:312`.
- CLI: `src/cli/channel.ts:278-279`, passed at `:449-453`.

All three funnel into `recordChannelDecision`
(`src/channels/contract.ts:765-813`), which calls `decide(...)`
(`contract.ts:791-797`). `attemptDecide` appends the record at
`src/core/gate.ts:2910-2921` with `actor` as the literal string it received.

**Nothing observed on the wire reaches that field, on any channel.**

### 1.2 What Telegram actually checks

`routeCallback` (`src/channels/telegram.ts:3321-3331`) reads
`query.message.chat.id` and compares it to `this.chatId`, set from
`APPROVAL_TG_CHAT` (`telegram.ts:2345`, `src/core/telegram-config.ts:35, 44-46`).
The same check guards commands (`telegram.ts:3292-3304`) and note replies
(`telegram.ts:3918-3926`). A callback from another chat is ignored and counted.

The update's `from` object — `from.id`, `from.username`, the fields that
identify the person inside the chat — **is never read anywhere in that file.**

The module header states this honestly (`telegram.ts:37-52`): the channel does
not authenticate the person who tapped, and anyone in the configured chat can
approve as the configured actor.

### 1.3 Web and CLI

`src/cli/channel-web.ts:22-26` says the same in its own header: the actor is
`--as` / `APPROVAL_HUMAN`, "never anything the browser sent — there is nothing
in an unauthenticated form post that could name a person". The page prints a
banner at `:453` saying anyone with access to the machine can decide as that
actor. `src/channels/web.ts` authenticates no requester.

The CLI channel (`src/cli/channel.ts:36-40`) has no separate sender at all:
whoever runs the process with that environment is the approver, which is
inherent to a local prompt rather than a gap.

### 1.4 The roster that does exist

`approvers` is in the policy twice: a top-level map of id to
`{channels: [...]}` (`schema/policy.schema.json:88-108`) and a per-class array
of ids (`schema/policy.schema.json:437-443`). Only the second is enforced, by
`namesApprover` (`src/core/gate.ts:248-250`) at `gate.ts:2792-2801`, refusing
`actor-not-approver`. SPEC.md:137 defines exact, non-case-folding matching and
says outright that this "defends against the wrong approver answering, and it
does not defend against an actor choosing whose name to wear".

The top-level `channels` list is read only for policy-diff display
(`src/core/policy-diff.ts:487-490`) and is enforced by nothing.

### 1.5 What the record carries

`approval.granted` is appended with `ts`, `event`, `actor`, `task`,
`action_key` and `payload` (`gate.ts:2910-2921`). The base schema defines an
optional top-level `channel` field (`schema/event.schema.json:102-106`), and
**the grant never sets it.** The payload can carry `class`, `est_cost_usd`,
`payload_hash`, `policy_sha256`, `reaction`, `note`, `batch_delivery_id` and
the token fields. There is no `decided_by` anywhere in the schema.

One event already has the shape this design needs: `audit.decision_refused`
(`schema/event.schema.json:1436-1475`) requires a `channel` and carries a
`payload.actor` for "the person whose decision was refused... Distinct from the
record's own actor". It is built at `src/channels/contract.ts:836-853`, and
`contract.ts:850` is the only place a channel name is written to the log.

### 1.6 A SPEC sentence that overstates the implementation

SPEC.md §10.3 (`SPEC.md:460`) describes Telegram as "message with declared
effects + inline Approve/Reject buttons; **callback verified against approver
identity**."

That is not what the code does. The callback is verified against a configured
**chat id** (§1.2); no approver identity is read from it. §11 (`SPEC.md:549`)
and §5.2 (`SPEC.md:137`) are both precise and correct, so the §10.3 phrase is a
local imprecision rather than a contradiction of the model — but it is exactly
the sentence a reader would rely on. Correcting it is listed in §5 as a SPEC
change, and it should be made whether or not the rest of this design is built.

---

## 2. What can be authenticated, honestly

Before proposing a mapping it is worth being exact about what each transport
can prove, because the mapping is worthless if the input is not evidence.

| Channel | What arrives | What it proves | What it does not |
| --- | --- | --- | --- |
| Telegram | `from.id` (stable numeric user id), `from.username`, `chat.id` | that Telegram's servers attribute this tap to that account, in a chat the operator configured | that the account belongs to the person the operator thinks; nothing about device possession; nothing if the bot token leaks |
| Telegram | `from.username` | nothing durable | usernames are mutable and reusable; **must never be the mapping key** |
| Web | form POST | nothing | no session, no auth, no origin binding |
| CLI | process environment | local machine control | who is at the keyboard |

So exactly one channel has a sender fact worth mapping: Telegram's `from.id`.
It is the **only** field this design treats as an identity input, and it is
evidence about a Telegram account, not about a person. The mapping from account
to person is the operator's assertion, which is why §3 calls it attested.

---

## 3. The proposed mapping

### 3.1 Where it lives

In the policy, under the existing `approvers` map, as an additive optional key:

```yaml
approvers:
  carter:
    channels: [telegram, cli]
    senders:
      telegram: "12345678"
  dana:
    channels: [telegram]
    senders:
      telegram: "87654321"
```

Three properties, each deliberate:

**It is policy, so it is attested.** `APPROVAL.md` is `policy.core`, human-only
(`APPROVAL.md`'s own class table), and a grant requires an attested policy
(`gate.ts:2574-2580`). So the sender mapping inherits the ceremony that already
protects the roster it sits in, and an agent cannot add itself as an approver's
sender any more than it can add itself as an approver.

**It is a map from person to sender, not sender to person.** The lookup at
decision time inverts it. Written this way, a reader sees each human's identity
in one place, and a duplicate sender id across two approvers is visible on the
page rather than hidden in ordering.

**It is per channel.** `senders.telegram` says nothing about the web page,
which authenticates nobody (§2) and must not be given an identity key it cannot
support. A channel with no entry has no mapping, which §3.3 makes a refusal
rather than a fallback.

### 3.2 Resolution at decision time

The channel gains one new duty: pass the observed sender alongside the
decision. `ChannelActorOptions` (`src/channels/contract.ts`) gains an optional
`sender: {channel: string, id: string}`. `recordChannelDecision` resolves it
against the loaded policy BEFORE calling `decide`:

1. No `sender` supplied: behave exactly as today, using the configured actor.
   This is what keeps the CLI channel and every existing deployment unchanged.
2. `sender` supplied and the policy maps it to exactly one approver id: the
   actor becomes `human:<that id>`, whatever the process was launched with.
3. `sender` supplied and the policy maps it to nothing: **refuse**. See §3.3.
4. `sender` supplied and the policy maps it to more than one approver: refuse
   `sender-ambiguous`. Two people claiming one Telegram account is an operator
   error the runtime must not resolve by picking.

The configured `--as` actor does not disappear. It remains the identity the
listener process itself acts under for everything that is not a decision, and
it becomes the fallback only under mode 1.

### 3.3 Unknown sender: refuse, and record the refusal

An unmapped sender is refused. Not "fall back to the configured actor", which
is precisely today's behaviour dressed up as a feature and would mean a stranger
in the chat still approves as Carter.

The refusal already has a home. `audit.decision_refused`
(`schema/event.schema.json:1436-1475`, `src/channels/contract.ts:836-853`)
exists for a decision the runtime would not honour, carries the channel, and
distinguishes the record's system actor from the subject. An unmapped sender
appends one of those with a new code `sender-unmapped`, and the **observed
sender id goes in the payload**, because an operator investigating who tried
needs the number, and a Telegram user id is not a credential.

The chat is answered with a message naming the code, so the person who tapped
learns why nothing happened rather than watching a button do nothing.

### 3.4 Per-class approvers, unchanged

Once the actor is resolved from the sender, `namesApprover`
(`gate.ts:248-250`, applied at `gate.ts:2792-2801`) runs exactly as it does
today. A mapped sender whose human is not in the rule's `approvers` is refused
`actor-not-approver`, the existing code, with no new path.

This composition is the main argument for resolving the sender at the channel
boundary rather than inside the gate: the gate's authorization logic does not
change at all, and everything it already enforces keeps applying to an identity
that is now better evidenced.

### 3.5 Channel binding

With a real sender in hand, `approvers[id].channels` could finally be enforced:
a decision arriving on a channel the approver's list does not name is refused.
This design **recommends it as a separate task**. It is a behaviour change to a
field that is currently display-only (§1.4), and shipping it inside this one
would mean a deployment that adds sender mapping silently starts rejecting
decisions on a surface that used to work.

---

## 4. Audit fields

The point of this work is that the record answers "who". Three additions, all
additive and optional so that records written before them stay valid:

1. **`channel` on the decision record.** The base schema already defines it
   (`event.schema.json:102-106`) and the grant never sets it (§1.5). Set it.
   This is worth doing on its own merits and needs no mapping.
2. **`payload.sender`** on `approval.granted` / `approval.rejected` /
   `approval.revoked`: `{channel: string, id: string}`, the observed sender the
   actor was resolved from. Absent when mode 1 of §3.2 applied, and its absence
   is therefore meaningful: it says "this decision was attributed by
   configuration, not by a sender".
3. **`payload.sender_source`**: `"policy"` when resolved through the mapping.
   A single closed-vocabulary field, so that a future source (a signed
   receipt from APRV-249) is distinguishable rather than being silently mixed
   in with policy-attested ones.

`from.username` is deliberately NOT recorded. It is mutable and reusable, so a
log carrying it would grow a field that reads like identity and decays into a
lie. If a human-readable name is wanted in a rendering, it comes from the
policy's approver id, which the operator controls.

**What must not be added:** any field the sender supplies about themselves. The
mapping key is the transport's own attribution (`from.id` as Telegram reports
it), never a name, handle or id the message body claims. That is SPEC §11.1's
self-reported-fields invariant, and it is the difference between this design
and a spoofable one.

---

## 5. Required SPEC and schema changes

**SPEC.md**

1. §10.3 (`SPEC.md:460`): correct "callback verified against approver identity"
   to state what is actually verified — the configured chat id — and, once this
   lands, what the sender mapping adds. **This correction is due regardless of
   whether the rest is built** (§1.6).
2. §5.2: `approvers[id].senders`, its per-channel shape, and the rule that an
   unmapped sender is refused rather than defaulted.
3. §5.2 or §11: sender ids are transport attribution, not proof of personhood;
   the operator's assertion is what binds an account to a human, and the
   attestation ceremony is what makes that assertion accountable.
4. §11.2: `sender-unmapped`, `sender-ambiguous`.
5. §6.2/§6.3: `payload.sender` and `payload.sender_source` on decision events,
   optional and additive; `channel` now set on decision records.
6. §10.3: state explicitly, per AC3, what each channel can authenticate: the
   table in §2 of this document belongs in the SPEC, not only here.

**`schema/policy.schema.json`**

7. `approvers.<id>.senders`: object, keys from a closed channel vocabulary,
   values non-empty strings. Additive, optional.

**`schema/event.schema.json`**

8. `payload.sender` and `payload.sender_source` on the decision events.
9. `audit.decision_refused` gains `sender-unmapped` / `sender-ambiguous` to its
   reason vocabulary, and a payload sender field.

**Runtime**

10. `src/channels/contract.ts`: `ChannelActorOptions.sender`, resolution before
    `decide`, refusal recording.
11. `src/channels/telegram.ts`: read `from.id` in `routeCallback`,
    `handleMessage` and the note-reply path, and pass it through. This is the
    only behavioural change to the transport layer.
12. `src/core/policy-load.ts`: parse and validate `senders`, including
    duplicate detection across approvers (§3.2 mode 4) at LOAD time.
13. `approval doctor`: a row for approvers with no sender mapping on a channel
    they are listed for, since that is a deployment that will start refusing.

---

## 6. Safe migration from listener identity

The failure mode to avoid is an operator upgrading and discovering that nobody
can approve anything.

**Phase 1 — record, do not enforce.** Ship items 1, 5, 10, 11 and the `channel`
field: the sender is observed, recorded in `payload.sender`, and the actor is
still the configured one. Nothing refuses. After a week the operator can read
their own log and see exactly which sender ids have been deciding, which is
also how they learn what to put in the policy.

**Phase 2 — map, still do not refuse.** Ship items 7 and 12. When a sender maps,
the actor is resolved from it; when it does not, the configured actor is used
AND an `audit.decision_refused`-shaped warning is recorded with
`sender-unmapped`. The operator now sees the gap without being blocked by it.
This phase is the one that changes production attribution, and §7's tests gate
it.

**Phase 3 — refuse.** An unmapped sender stops being honoured. Gated on the
doctor row (item 13) being clean, so an operator cannot arrive here by accident.

**Rollback.** Removing `senders` from the policy returns to mode 1 of §3.2 at
the next attestation, with no code change and no log repair; the recorded
`payload.sender` fields on old records stay valid and readable. That property
is why the mapping lives in policy rather than in a separate store.

**A deployment that never adds `senders`** is in mode 1 forever: the same
actor, the same decision, and neither of §4's payload keys on the record. That
is the compatibility promise, and §7's test 1 is what keeps it true. The one
field a record gains either way is `channel` (§4 item 1), which is additive and
which §7's test 18 requires of every decision.

---

## 7. The tests that must exist before production attribution changes

APRV-324's AC2 names five cases. It is a gate on the implementation, not on
this document: with no resolution code there is nothing to run these against,
and writing them against a stub would be evidence about the stub. They are
enumerated here so the implementation task has them, and so the criterion can
be checked against something specific rather than against an impression.

Every one is built through the real append path, with a real policy and a real
channel harness, in the manner of `tests/channels-telegram.test.ts`.

**Compatibility (the one that must pass first)**

1. A policy with no `senders` decides exactly as today for a full
   request-decide-execute cycle, on all three channels: the same actor, the
   same payload keys, and neither `payload.sender` nor `payload.sender_source`
   present. *(Corrected during implementation: this item first said
   "byte-identical", which contradicts item 18 and §4 item 1 — both of which
   require the record to carry `channel`. The one additive difference from a
   pre-APRV-324 log is that field, and the test asserts it explicitly rather
   than leaving the contradiction for a reader to resolve.)*

**Two distinct senders (AC2)**

2. Two callbacks from the same configured chat with different `from.id`, both
   mapped: two grants on two different action keys carry two different actors,
   and each `payload.sender.id` matches the callback it came from.
3. The same two senders on one action key: the first decides, the second is
   refused `already-decided`, and the refusal record names the second sender.
4. A mapped sender whose human is not in the rule's per-class `approvers`:
   refused `actor-not-approver`, the existing code, nothing appended.

**Missing or stale mapping (AC2)**

5. A callback from an unmapped `from.id`: no decision is appended, one
   `audit.decision_refused` with `sender-unmapped` is, and its payload carries
   the observed id.
6. A mapping removed from the policy between the request and the tap: the tap
   is refused, not honoured under the old mapping. The decision reads the
   policy at decision time, as `policy-drift` (`gate.ts:2707-2726`) already
   requires for the class.
7. A sender mapped to two approvers: load-time refusal `sender-ambiguous`, and
   because policy loading fails, every class resolves `manual` (SPEC §11.1).

**Spoofed request fields (AC2)**

8. A callback whose message body claims a different user id than `from.id`:
   the body is ignored, the mapping uses `from.id`, and a test asserts the
   resolved actor is the one `from.id` maps to.
9. A callback carrying a `from.username` that matches a different approver's
   id: the username is not a key, is not recorded, and changes nothing.
10. A web form post carrying a `sender` field: ignored entirely; the web
    channel supplies no sender and stays in mode 1. (§2: it can authenticate
    nobody, so it must not be allowed to claim anybody.)
11. A callback from an unconfigured chat carrying a valid mapped `from.id`:
    still ignored by the chat check (`telegram.ts:3331`), which runs first.
    The mapping widens who may decide, never where from.

**Unauthorized sender (AC2)**

12. A sender mapped to an approver the class does not name: case 4 above, and
    additionally that nothing is appended to the log beyond the refusal record.
13. Under a human-only class: refused `class-human-only`, and no record the
    runtime writes about it carries a sender or a resolution. *(Corrected
    during implementation: this item first said "before any sender
    resolution", which is not what the code does. The channel boundary owns
    the resolution and the gate owns the class check, and ordering them the
    other way would mean duplicating the gate's read of the log. What is true,
    and what the test pins, is that a human-only refusal records no sender and
    no resolution, so no authority and no attribution flows from the
    computation — which is the property §11.1 invariant 9 is about.)*

**Concurrent decisions (AC2)**

14. Two mapped senders tapping the same action key simultaneously: exactly one
    `approval.granted`, exactly one token, and the loser gets a re-derived
    `already-decided` rather than a `head-moved`, through the existing
    `withHeadMovedRetry` (`gate.ts:945-950`).
15. Two mapped senders tapping two different action keys simultaneously: both
    land, each with its own actor, and neither observes the other's write as
    its own.
16. A sender resolution racing a policy re-attestation: the decision either
    uses the policy it verified or refuses `policy-drift`; it never resolves a
    sender against one policy and authorizes against another.

**Audit fields**

17. A grant made in mode 1 (no sender) carries no `payload.sender`, and its
    absence is asserted, because the absence is the claim that the attribution
    came from configuration.
18. Every decision record carries `channel`.
19. No record anywhere carries `from.username`.

---

## 7a. The other three callback families (added during implementation, APRV-324)

§3.2 is written about `recordChannelDecision`, and the first implementation
resolved senders there and nowhere else. Review of that implementation found
the gap: a Telegram callback is routed to one of four handlers, and three of
them never reached the resolution. A stranger in the configured chat therefore
kept the exact power this design removes, on the gestures that matter most.

The rule binds all four. `senderOf` is read once, directly after the chat-id
check, so every branch below it sees the same observation and no future branch
can be written that quietly does not.

**Decisions** — §3.2, unchanged.

**Checkpoint signatures** (`log.checkpoint`). A signature says this log's head
is what this person saw, which is a human-only act with no request behind it.
Resolved exactly as a decision: mapped signs as the mapped human, unmapped or
ambiguous is refused, no mapping for the channel is the configured identity.
The signature's `payload` is deliberately NOT given a `sender` field: it is a
signed structure, and an unsigned field beside a signature invites a reader to
treat it as covered by one. What the mapping changes here is the ACTOR, which
is what the signature is over.

**Both of these resolve only against an ATTESTED policy.** A decision is
protected twice — the mapping chooses the actor, and then `decide` refuses
`policy-not-attested` or `policy-drift` if the bytes on disk are not the bytes
in force — while signing and reviewing read the policy, act, and append with no
such check behind them. Without one, an edited `APPROVAL.md` that dropped or
repointed the `senders` block would change who may sign a checkpoint or file a
review from a phone *before any human had attested it*, which is exactly the
property §3.1 claims the mapping has. So a gesture carrying a sender is refused
`policy-not-attested` — the gate's own code, from `core/attest.ts`'s own check —
whenever the file on disk is not the file in force, and records nothing. A
terminal authenticates no sender, is unaffected, and is the repair.

**Retrospective reviews** (`audit.reviewed`), including the note-reply path. A
review confers no authority, and `approval feedback` hands it to agents as
human-authored guidance, so a review attributed to the wrong person is guidance
in somebody else's name. Resolved as a decision is; the record carries
`payload.sender` on the same terms. The ForceReply note prompt additionally
remembers which account armed it, and a reply from a different account records
nothing and leaves the prompt open: the prompt is addressed to the person who
tapped, and its words are recorded as theirs.

**Attestation answers** (`policy.updated` / `policy.declined`) — the one that is
stricter rather than the same, because the amendment being attested may itself
add, remove or repoint the mapping. Resolving a tap against the file it is
attesting would let whoever wrote that file name the account that approves
their own edit: a gate authorizing its own widening. So the oracle is the
policy **in force**, and the ladder is:

1. No sender (terminal, web): unchanged. This is what keeps a repository
   recoverable — a `policy.core` edit happens at a terminal anyway, so no
   mapping, however broken, can strand the repair.
2. In-force bytes recovered and the amendment CHANGES the mapping: only an
   account the in-force policy maps may answer. Where it maps nobody on this
   channel, nobody qualifies and the answer is `attest-requires-terminal`. An
   amendment that introduces the identity system cannot be signed for by the
   identity system it introduces.
3. In-force bytes recovered and the mapping is unchanged: the ordinary rule,
   run against the policy in force.
4. In-force bytes NOT recovered: refuse `attest-requires-terminal` whenever the
   proposed policy maps senders for this channel; otherwise behave as before.

**Recovering the in-force bytes, and why it often fails.** An attestation
records only a SHA-256 (`summarizeDiff` says so in as many words), so the log
alone cannot produce them. The payload store can: every `policy.proposed` binds
the whole policy text as its payload, so a proposal that was attested left the
attested text addressable by its own `payload_hash`. The recovery finds the hash
in force, finds a proposal that named exactly those bytes, reads the stored text
and **re-hashes it against the attested digest** — nothing trusts the store.

It used to fail in the ordinary case, and the implementation said so rather than
pretending otherwise: `approval policy attest`, and `policy amend` on its human
path, appended a `policy.updated` and stored nothing, so a chain that had never
been amended from a phone had no recoverable bytes at all — which was this
repository's own state. Step 4 was therefore the common path.

**The residual, closed (APRV-356, 2026-09-19).** Every attestation now stores
the attested text in the payload store and binds its hash on the
`policy.updated` it appends, terminal and phone alike, and the recovery reads
an attestation's own binding as readily as a proposal's. So an amendment that
REMOVES a mapping is no longer indistinguishable from a policy that never had
one: the in-force bytes are recovered, re-hashed against the attested digest
from the verified log, and read. Step 4 remains, and is now reached only by a
chain attested BEFORE that change, where there is still nothing to recover and
the fail-closed fallback is the honest answer. Nothing about the trust boundary
moved: reaching any of this still requires an attacker who can already write
`APPROVAL.md`, whom SPEC §11 already places inside it, and the store is checked
rather than trusted on every read.

## 8. What this document does not do

It changes no runtime code. `resolveHumanActor` is untouched, `routeCallback`
still reads only the chat id, the grant still records the configured actor and
still sets no `channel`, and no `senders` key is read by anything. Issue #137
stays open until the behaviour it asks for is implemented and verified.

The one item worth extracting and doing on its own is §5 item 1: SPEC §10.3
currently claims a verification that does not happen, and that sentence should
be corrected whether or not this design is ever built.
