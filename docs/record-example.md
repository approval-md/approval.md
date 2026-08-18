# A worked `record.*` example: adopting an LLM's category

SPEC.md §6.1 makes an outbound email the canonical `communicate.*` story, because
a sent message is the clearest case of a side effect nobody can revert. This page
is the companion for the other half of §7's taxonomy: `record.*`, where the
action is a write to a system of record, the write is usually reversible, and the
reason to gate it is stated in §11 as protecting "your mind from your agents'
writes".

Everything below is illustrative. It describes a deployment built on the spec,
not a feature of the reference runtime, and it uses only vocabulary SPEC.md
already defines. The one thing it needs and cannot get from v0.1 is flagged in
its own section at the end, as a question for the human rather than as a change.

## The setting

Notes arrive from a capture bot: the operator types or dictates a thought into a
chat bot, and later into a phone app. A classifier agent reads each note and
proposes a folder for it (`business`, `reading`, `household`, `personal`). The
operator reviews the proposals in the app, taps to adopt the category the
classifier chose, or sends the note somewhere else. Nothing here leaves the
machine, nothing costs money, and every misfiling is fixable in seconds. The
operator still wants the sign-off, for the reason §7 gives: the note collection
is an extended memory, and a wrong category is cheap to write and expensive to
stop believing once it has been relied on.

## The policy

The classes come from §7's `record.*` row. Two settings are defensible, and the
choice is about how much the operator trusts this classifier rather than about
consequence.

```yaml approval-policy
version: "0.1"

defaults:
  autonomy: manual
  channel: telegram
  approval_ttl: 7d
  on_expiry: reject

approvers:
  carter:
    channels: [telegram, cli]

classes:
  record.categorize:
    autonomy: manual
    approvers: [carter]

budgets:
  global: { daily_actions: 500 }
```

`manual` is the cognitive-ownership setting: no category enters the collection
until the operator adopts it, and the app shows unadopted notes as provisional.
The cost is one decision per note, which is what §10.3's batching rule exists to
make survivable.

A trusted classifier earns the other setting:

```yaml approval-policy
classes:
  record.categorize: { autonomy: supervised }

audit:
  supervised_sample_rate: 0.10
  sampling_secret_env: APPROVAL_SAMPLING_SECRET
```

Under `supervised` the category is written immediately and a deterministic
one-in-ten sample comes back for retrospective review (§5.2). The operator has
traded ownership of each write for coverage of the population, which is a
reasonable trade when the writes are reversible and the volume is high. Note that
§5.2 disables sampling outright when the secret is unnamed or unset, and says so
in machine-readable form: a `supervised` class with no working sampler is an
unsupervised class, and the runtime will not let that be invisible.

Two things the taxonomy settles for free. `record.categorize` is a declared
class, so §7's first invariant applies: the classifier cannot obtain a token for
a write it did not declare. And because these notes are reversible, the
irreversibility floor never fires here; the gate is the operator's choice, and
§7 says explicitly that manual is not reserved for the irreversible.

## The task envelope

Each note becomes a registered unit of work carrying the §6.1 envelope. The
declared payload is the proposal itself, hashed per §6.2.

```yaml
---
id: note-9f21
title: Categorize captured note 9f21
status: In Progress
approval:
  origin:
    app: example-notes-capture
    created_by: "agent:notes-classifier"
  route:
    assignee: "agent:notes-classifier"
    confidence: 0.71
    rationale: "invoice wording, matches business exemplars"
  state: awaiting
  actions:
    - class: record.categorize
      summary: "File note 9f21 under business"
      reversible: true
      est_cost_usd: 0
      idempotency_key: "note-9f21:categorize:1"
      payload_hash: "sha256:4c1e…"   # over {note_id, category, rationale}
  budget:
    max_latency: 7d
---

## Description
Captured 2026-08-18 08:41. Classifier proposes `business` at 0.71 confidence.
```

The payload the hash covers is the JSON object
`{"note_id":"9f21","category":"business","rationale":"invoice wording, matches
business exemplars"}`, stored in `.approval/payloads/` and displayed to the
operator whole (§9, §10.4). `route.confidence` is a monitoring signal and nothing
else: §11 forbids it from lowering scrutiny, so a 0.99 from the classifier buys
no shortcut through the gate.

## The lifecycle, as events

1. `task.registered`. The envelope validates; the class is declared.
2. `approval.requested`. `record.categorize` resolves to `manual`, so the runtime
   opens a request bound to the payload above.
3. The note is visible in the app and visibly provisional. §7 requires this: the
   write path holds the proposal in a staged state, invisible in the record
   proper or marked as unadopted, until a grant exists. A note in this state is
   findable, and it is not filed.
4. `approval.granted`, actor `human:carter`, channel the app. A single-use
   execution token is minted, bound to the request, the `idempotency_key`, and
   the `payload_hash` (§10.4).
5. The app's write path acts as the adapter. It recomputes the hash of the bytes
   it is about to commit, refuses with `payload-mismatch` if they differ from the
   ones the grant bound, and otherwise commits the category. `execution.started`
   and `execution.completed` bracket the call.
6. Or `approval.rejected`, and the note stays provisional. Nothing was written,
   no token exists, and the adapter has nothing to refuse.

## The in-app surface as a channel

The tap in the app is a channel in the §10.3 sense: transport that surfaces a
request and returns a decision. It holds no state, it owns no verdict, and the
decision it collects becomes an `approval.granted` or `approval.rejected` event
like any other. An implementation satisfies the same interface the CLI, web, and
Telegram channels satisfy, so nothing about the log or the gate changes to
accommodate it.

What it MUST render, per §9 and the identical paragraph in §10.3, is the split
between computed and claimed fields:

| Shown | Kind | Source |
| --- | --- | --- |
| the proposed category, the classifier's rationale, the summary | **claimed** | written by the agent under oversight |
| `route.confidence` | **claimed** | written by the agent under oversight |
| resolved class and autonomy, payload hash, chain position, budget state, attestation status | **computed** | derived by the runtime |

Giving the classifier's rationale the visual authority of a computed field is a
conformance failure for the channel, and it is the exact failure that matters
here: the whole decision the operator is making is whether to believe a claim.

For the morning review of forty overnight notes, §10.3's batching applies, and
for a high-volume `record.*` class it says channels SHOULD batch. One gesture may
decide a set; the log never batches, and each note gets its own
`approval.granted` or `approval.rejected` carrying the batch's
`batch_delivery_id`. Audit granularity survives the ergonomics. The bound on how
far a batch may compress is §10.4's rule that a `manual` request shows its full
payload before a decision is collected: a note whose text is hidden behind a fold
was not shown, whatever the screen said.

## Enforcement, stated plainly

In §11's voice, because a claim about enforcement is only worth as much as the
statement of what it excludes.

**The channel is never the boundary.** SPEC.md §10.4 puts hard enforcement at the
adapter, which holds the credential and refuses to act without a valid,
unexpired, single-use token bound to the payload hash. In this deployment the
adapter is the app's own write path to the note store. An agent that reaches the
write path directly, holding the store's credentials, is outside what this
defends, exactly as an agent with direct mailbox credentials is.

**A button an agent can press is a decision event, not an authorization.** An
agent driving the DOM produces at most an `approval.granted` bearing a `human:`
actor. The question is whether it can produce one truthfully. In a deployed app
the human and the agent hold different credentials: the human's decision travels
over an authenticated server-side session, and a browser-driving worker has none
of it. Forging the grant means stealing the session.

**That is a stronger boundary than v0.1's, and it is off-spec.** §11 says human
identity in v0.1 is config-declared, the trust boundary is the local machine, and
anyone who can set that configuration and write to the log is inside it.
Attestation proves that someone with local control signed off, and not who. A
session-authenticated app is precisely where §11's "cryptographic identity is
future work" would land, and a deployment that relies on it is relying on
something this version of the spec does not define. State that in the deployment,
rather than reading it into the spec.

**Not defended, unchanged from §11.** A compromised host. An agent that can read
the vault passphrase or the store's credentials. Persuasion: the operator sees
the exact bytes, and nothing here defends against a plausible wrong category
adopted by a tired human at 08:41. The gate binds bytes to decisions, and it does
not make the decision good.

## Rerouting today

The operator disagrees with `business` and wants `personal`. Under v0.1 that is
two events and no new machinery:

1. `approval.rejected`, with a note naming the correct folder.
2. The classifier re-requests with the corrected payload, a fresh
   `payload_hash`, and a distinct `idempotency_key` (`note-9f21:categorize:2`).
   The operator grants the second request, and the write path commits it.

This is honest and slightly clumsy. The log says truthfully that one proposal was
refused and a second was accepted, which is what happened. It costs the operator
two gestures for one decision they had already made at the first tap. The next
section asks whether that is worth changing.

## Open question, for human decision: grant-with-choice

**Status: unresolved. This section proposes nothing and decides nothing.**

Today a grant binds one payload hash. §6.2 defines `payload_hash` per action,
§10.4 states that a grant approves specific bytes and that changing the payload
after grant requires a new request. "Reroute to personal" is therefore reject
plus re-request, by construction. The question is whether a `record.*` gate
should be able to collect a choice among candidates in one decision, and if so,
how without weakening the binding rule.

**Option (i): keep reject and re-request.** No spec change. Two events per
reroute, the agent learns the operator's choice from the reject note, and the
binding rule stays exactly as written. This is what the worked example above
uses.

**Option (ii): candidate payloads, one chosen hash.** A request whose payload
lists candidates, each candidate hashed individually. The grant names the chosen
candidate's hash, and the token binds to that hash. §10.4 continues to hold in
its own words, since the grant still approves specific bytes; what changes is
which bytes were on the table. Concretely this would need:

- a request payload shape carrying a candidate list, with a hash per candidate;
- a `chosen_hash` field on the grant payload, required when the request offered
  candidates and forbidden otherwise;
- token binding to `chosen_hash` rather than to the request's single
  `payload_hash`, with `payload-mismatch` unchanged in meaning;
- a channel rule: every candidate is displayed whole, since §10.4's full-payload
  requirement applies to each thing the operator could be choosing;
- a decision about the envelope, which today declares one `payload_hash` per
  action.

**Option (iii): a structured reroute field on the reject.** The rejection carries
a machine-readable correction the agent MUST re-request from. No change to
binding or tokens, and the convention buys the agent a reliable signal in place
of a prose note. It remains two events.

**Recommendation.** Ship (i) as the v0.1 answer, which is what the example above
documents, and consider (ii) as a v0.2 amendment with the binding rule written
out as above. (ii) is the one that matches what the operator is actually doing at
the moment of the tap, and it is expressible without loosening the property
§10.4 exists to protect. (iii) adds vocabulary without addressing the two-gesture
cost, so it is the weakest of the three.

## The capture bot

The bot that receives the notes is the inbound half, and §12 already names it:
"Inbound adapters (post-v1): e.g. a Telegram capture bot, arbitrary apps via
`approval register --json`." It creates tasks and proposes nothing; it holds no
credential the gate cares about, and it takes no decision. Worth keeping the two
Telegram roles apart when reading this page: the capture bot is an inbound
adapter that writes tasks, and the Telegram channel of §10.3 is an outbound
transport that collects decisions. They can be the same chat and they are not the
same component.

## Where this page strains against the spec

Recorded rather than smoothed over, for whoever reviews it.

- **The envelope assumes a task file.** §6 defines the envelope as frontmatter on
  Backlog.md-style markdown. A notes deployment has notes, and a file per note
  exists only because the envelope wants one. §12's `approval register --json`
  is the hinted path, and v0.1 does not define an envelope shape that lives
  anywhere other than a markdown file.
- **Batching and the full-payload rule pull in opposite directions.** §10.3 says
  channels SHOULD batch high-volume `record.*` requests; §10.4 says a `manual`
  request shows its full payload before a decision. Forty notes obey both only by
  being forty full payloads on one screen.
- **A fourth channel type sits beside a non-goal.** §13 rules out "channel
  breadth beyond the three shipped". An app implementing the channel interface
  out of tree is consistent with §10.3's interface and reads as tension with §13
  on a first pass. The non-goal constrains what the reference runtime ships.
- **The identity boundary moves.** Covered above: session-authenticated approval
  is stronger than config-declared identity and is not something v0.1 specifies.
- **Re-request after rejection is undefined.** The example gives the second
  attempt a distinct `idempotency_key`, on the reasoning that §6.2 makes the key
  the thing adapters refuse to execute twice. SPEC.md does not say whether a
  rejected action may reuse its key, and a deployment has to pick.
