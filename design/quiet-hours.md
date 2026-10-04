# APRV-450 — Quiet hours: a per-approver delivery window

**Status: design, pending human sign-off. Nothing here is wired, and this task
edited no SPEC.md sentence, no schema and no source file. Section 10 holds the
hunks a human has to decide on, each marked proposed and not applied. Every code
reference describes what the runtime does NOW.**

An agent can raise a question at 01:00. The first deployment to ask for this
(Agent Village, whose agents run a nightly pass that infers what a person wants
to publish) wants the question recorded at once and the person it goes to left
asleep until morning. Core can do the first half and has no way to say the
second. The workaround in use is a relay in front of the Bot API that holds
`sendMessage`, which works, is invisible to the log, and spends the request's
TTL without saying so. This note designs the core key.

---

## 1. What the runtime does today

**1.1 A request exists when it is appended, and its clock starts then.** The
lapse is measured from the `approval.requested` timestamp (SPEC.md §5.2, the
`approval_ttl` paragraph), judged lazily in `requestState`
(`src/core/state.ts:1447-1478`), narrowed for hook-opened requests to the
harness ceiling minus a 60 s margin (`src/core/harness-wait.ts:134-141`), and
materialised by `appendExpiry` (`src/core/gate.ts:4459-4499`), whose record
carries `requested_ts` and `ttl_ms` so a reader can check the arithmetic.

**1.2 Delivery is not an event.** Dispatch runs in the channel listener, which
re-derives the pending set from the verified log every cycle, sends what that
process has not sent yet, and appends nothing (SPEC.md §10.3, "Where dispatch
runs" and "Dispatch inside the daemon process"). What a listener has sent is
process memory whose loss degrades to a re-send.

**1.3 Pacing exists; timing does not.** `channels.telegram.delivery` is `paced`
(a summary line and the oldest request, the next once that one is settled) or
`burst` (everything not yet sent) (`schema/policy.schema.json:288-294`, SPEC.md
§10.3 "Delivery pacing"). Requests older than the harness wait collapse into one
reject-only message on restart (APRV-287). Nothing in the policy says WHEN a
person may be told.

**1.4 So the log already cannot tell "shown and ignored" from "never shown"**,
for any request, on any channel. Quiet hours does not create that gap. Section 6
says exactly what it adds and what it leaves.

---

## 2. The decision

A per-approver window, declared in the attested policy, inside which a push
channel starts no delivery to that person. The request is recorded at once and
its TTL runs unchanged. When the window ends the channel's ordinary pacing
resumes, oldest first, behind one computed line naming what was held. Only the
policy author can let a class through a window. The window is never an input to
a verdict, an autonomy, an approver's eligibility, a budget, a sampling draw, a
token or a TTL, and a decision collected inside a window is recorded exactly as
one collected outside it.

---

## 3. The key

```yaml
approvers:
  alice:
    channels: [telegram]
    delivery:
      quiet_hours:
        start: "22:30"
        end: "07:00"
        timezone: "Asia/Kolkata"

classes:
  intent.publish.*: { autonomy: manual, approvers: [alice] }
  financial.spend:
    autonomy: manual
    approvers: [alice]
    deliver_in_quiet_hours: true
```

**3.1 On the person, inside a `delivery` block.** A time zone and a sleeping
pattern are facts about a person. A person reachable on two channels would
otherwise carry two copies of one fact that can disagree. The `delivery`
sub-block keeps it apart from `channels` and `senders`, which say where a person
decides and which accounts are theirs (a `senders` entry turns enforcement on,
SPEC.md §5.2). Nothing under `delivery` authorizes or refuses anything. That is
the same split `design/hosted-daemon-identity.md` §4.2 makes between the latency
block `daemon` and the enforcement list `daemons`, and it leaves room for later
"when to tell this person" keys without mixing them into authority.

**3.2 Grammar.** `start` and `end` are local wall-clock times, `HH:MM`, 24-hour.
A `start` later than `end` wraps past midnight. `start` equal to `end` is a load
failure, because it reads equally as "never" and "always". `timezone` is
REQUIRED and is an IANA zone name (`UTC` admitted). There is no default: the
host's zone is not the person's, and a hosted daemon typically runs in UTC.

**3.3 Membership is one rule.** An instant `t` is quiet for an approver iff the
local time of day of `t` in their zone lies in `[start, end)`, wrapping. It is a
pure function of the instant, the three values and the time-zone database.
Daylight saving needs no special case. On a spring-forward night the skipped
wall times never occur, so a window starting inside the gap begins at the first
instant after it. On a fall-back night the repeated hour is inside or outside on
the same rule both times. The window is an hour shorter or longer on those two
nights, which is stated and not compensated.

**3.4 The bypass is the author's, per class.** `deliver_in_quiet_hours: true`
on a class rule. The winning rule's value alone governs, as SPEC.md §5.2's
resolution rule already says of every per-rule key, so tied rules are not
unioned. It is admitted on `manual` and `supervised-live`, the two levels that
open requests; `true` anywhere else is a schema violation and fails closed, as
`live_rate` and `retro_rate` do on the levels they do not belong to. `defaults`
cannot carry it, since a default that bypasses is simply the absence of a
window. **No field of a request can move a window.** An urgency flag a requester
could set would let the party under oversight spend the approver's sleep, which
is the attention SPEC.md §11 calls the audit budget (§11.1 invariant 4).

**3.5 Attestation.** The window lives in `APPROVAL.md`, so the existing
attestation covers it with no new rule. One sentence is needed on WHICH bytes a
listener reads: the policy in force (the bytes the latest attestation names,
recoverable since APRV-356), never an unattested edit on disk. That is the rule
§10.3 already applies to checkpoint signatures and reviews, for the same reason:
a listener acting on an edit nobody attested would let the file change what
happens before a human signed it. Where no attested bytes are recoverable the
listener applies no window.

---

## 4. The TTL keeps running

Decided. The window delays the message and never the request, and the lapse is
measured from `approval.requested` exactly as today. Pausing the clock during
the window was considered and rejected for five reasons:

1. **The expiry record stops being checkable.** `approval.expired` carries
   `requested_ts` and `ttl_ms` (`src/core/gate.ts:4468-4477`) so a reader checks
   one addition. A paused clock needs the record to carry the paused intervals,
   recomputed from a time-zone database the reader may not share: a deadline two
   conforming readers could compute differently.
2. **Whose pause?** A request two approvers in two zones may decide has two
   windows. Pausing for one extends the question for the other.
3. **It extends authority.** A token's shelf life is the parent request's TTL
   (`src/core/token.ts:34-53`), so pausing the clock lengthens how long a grant
   stays spendable in proportion to how long somebody sleeps.
4. **One arithmetic, one answer.** The lazy judgment and the daemon's sweep are
   kept equal by deriving the window in one place (`src/core/state.ts:1447-1455`).
   A pause adds a policy, a clock-to-zone conversion and a window history to
   every input of that function.
5. **Edits would move live deadlines.** A window changed while requests are
   pending would re-derive every paused interval under the new hours.

The cost is accepted and made visible: a hold spends window. An author sizes
`approval_ttl` to cover the longest window of anybody who decides a class without
the bypass, and `approval doctor` warns when it does not (section 6.4).

---

## 5. A request whose deadline falls inside the window

Decided: **the hold wins.** Such a request is not delivered and lapses. The
runtime never breaks a window on its own judgment; `deliver_in_quiet_hours` is
the only way through one.

The alternatives each wake the person on the runtime's initiative. "Deliver at
the deadline minus a margin" turns every short-TTL request at night into an
alarm, and the short-TTL request at night is precisely a hook-opened one, whose
window is four minutes (1.1). "Notify on lapse" wakes somebody to read about a
question nobody can answer any more. A lapsed request authorizes nothing, the
requester learns `expired` through its ordinary path, and asking again in the
morning is a new request with a new decision, which is how SPEC.md §6.3 already
treats a withdrawn or expired action that is still wanted. An author who needs
some class answered at night says so with the bypass.

---

## 6. What is logged

**6.1 No record per hold.** A hold is a dispatch decision and dispatch appends
nothing; it stays that way. The listener is not a writer of non-decision records,
a record per held request per cycle would grow the log with how many people
sleep, and the hold is DERIVABLE: the request's `ts` is in the log, and the
window is in the policy bytes its `policy_sha256` pins. An auditor recomputes
whether a request was inside the window when it was asked and when it lapsed,
from records they already trust, which is stronger evidence than a record a
listener asserts.

**6.2 One computed field on `approval.expired`.** `payload.quiet_hours: true`,
present only when, under the policy bytes the request pinned, every approver in
the request's audience (7.1) on every configured push channel was inside their
window for the whole interval from the request to the lapse, and the winning
rule did not set the bypass. It is written by the runtime in `appendExpiry` from
records and attested bytes, never by a caller, and it is present-or-absent,
never `false`, on the reasoning §6.3 gives `payload.sender.hashed`. Where the
pinned bytes cannot be recovered the field is omitted rather than guessed. It
lets a reader holding only the log tell **lapsed while held** from **lapsed after
it could have been shown**. It is not evidence about any delivery.

**6.3 The residual, stated plainly.** Whether a message reached a phone is still
not a log fact for any request. A listener that was down, or a credential that
was missing, leaves no record. Quiet hours does not make that worse; a delivery
receipt is a separate question (open question 2).

**6.4 Health surfaces.** `approval status` reports, per approver with a window,
whether they are inside it now and when it next changes. `approval doctor` gains
a `quiet-hours` row that warns when `approval_ttl` (or its absence) is shorter
than the longest window of an approver who decides a non-bypassed class, fails
for a zone this runtime cannot resolve (section 8), and lists each configured
channel as honouring, not applicable (pull), or unknown.

---

## 7. Channels

**7.1 The audience rule.** A push channel addresses a chat, not a person. A
request's audience on a channel is the approvers the winning rule names (every
approver, where it names none) whose `channels` list includes that channel. The
channel holds the request while EVERY audience member is inside their window, and
sends it once ANY one is outside. A channel cannot address one member of a group
chat; holding while an eligible person is awake would hide a question from
somebody able to answer it; and the single-approver chat, the common case, comes
out exactly per person. An empty audience means no window, which is today's
behaviour. Reading `approvers[id].channels` for delivery does not make it a check
on decisions, which `design/multi-approver-semantics.md` §3.3 warns must not
happen silently.

**7.2 Telegram MUST honour it**, in both receive modes. The webhook receiver is
inbound only (`src/channels/telegram-webhook.ts`), so the hold sits where every
send starts, before `sendMessage`. A relay configured as the listener's
`--api-base` therefore sees nothing during a window and needs no hold of its own;
one that keeps its own hold composes, since two holds are the later of the two.

**7.3 When the window ends** the channel runs its ordinary cycle: `paced` sends
the summary and the oldest request, `burst` sends every pending request not yet
sent, oldest `approval.requested` first in log order (`seq`, never `ts`). The
summary gains one computed line, "held during quiet hours: N waiting, M lapsed".
The APRV-287 collapse still applies to hook-opened requests older than the
harness wait. The hold is re-derived every cycle from the verified log, the clock
and the policy in force, so a restart inside a window sends nothing and a restart
after it sends what is still pending, which is the degrade-to-re-send rule §10.3
already sets.

**7.4 A human gesture inside the window is answered.** A tap on an earlier
delivery, `/queue` or `/next` is the person asking. The window governs what the
runtime starts and never what it answers.

**7.5 Pull surfaces show everything pending.** `web` builds its queue per page
view, so a person who opened it is asking; it MUST NOT hide held requests and
SHOULD mark, as a computed field, a request that arrived inside its audience's
window. **`cli` cannot hold**: it is a prompt in front of the person who started
it. It says so as a computed line when it starts ("quiet hours do not apply to
cli: it shows what is pending when you run it") and as a `not applicable` entry
in the doctor row. That is a report, not a warning or a refusal.

**7.6 A third-party channel** named under `channels` cannot be known to honour
anything, and the doctor row says "cannot tell whether <name> honours quiet
hours" rather than guessing either way.

**7.7 Reminders.** Core sends none today. Any later re-notification obeys the
window by the rule in 7.1, since it is a delivery the runtime starts.

**7.8 Multiple approvers.** First tap wins (`design/multi-approver-semantics.md`
§1.1), and the audience rule means one awake eligible approver is told. If quorum
lands, its TTL is still not extended by endorsements (§4.3 there), and its
short-TTL doctor warning should count the window too.

---

## 8. Validation, and which way it fails

| condition | outcome | why |
|---|---|---|
| bad `HH:MM`, missing key, unknown property, bypass on a level that opens no request | schema violation: the policy fails to load, every class resolves `manual`, and no window applies | the closed-schema rule of SPEC.md §5.2, unchanged |
| `start` equal to `end` | load failure, same consequence | it reads as both "never" and "always" |
| zone name well-formed but unknown to this runtime's time-zone database | the policy LOADS; that approver has no window; `quiet-hours` doctor row FAILS naming the zone | loadability would otherwise depend on the host's ICU build rather than on the attested bytes |
| policy edited and not yet attested | the listener keeps the window of the policy in force | 3.5 |

The third row fails toward telling the person, and that is the closed direction
for this key. The window is a courtesy over attention and controls nothing; the
harm a broken hold can do is a question nobody is shown. This is the shape of
SPEC.md §5.2's sampling rule (a control visibly off beats one that looks on), and
it is narrower: every other failure of this key is the ordinary fail-closed load.

---

## 9. Alternatives considered

| alternative | verdict |
|---|---|
| Pause the TTL during the window | rejected, section 4 |
| `channels.<ch>.quiet_hours` | rejected: a channel is a transport, the zone belongs to a person, and two channels would hold two copies of one fact (3.1) |
| Silent delivery (Telegram `disable_notification`) in place of a hold | not adopted: Telegram-only, buried under a day of messages by morning, and still a badge on the phone. Kept as open question 1 |
| A requester-supplied `not_before` or urgency flag | rejected: §11.1 invariant 4 (3.4) |
| A `delivery.held` record per hold | rejected: the hold is derivable (6.1) |
| Break the window for a request about to lapse | rejected: section 5 |
| Leave it to a relay | the stopgap: it works, the log cannot see it, and each deployment rebuilds it |

---

## 10. Proposed hunks, for a human to decide on

Proposed, not applied. All are additive: a policy that declares no `delivery`
block and no bypass delivers, expires and logs byte for byte as today.

**10.1 SPEC.md §5.2, a new bullet after `approvers[id].senders`.**

> - **`approvers[id].delivery.quiet_hours` delays the message and never the
>   request.** An approver record MAY carry `delivery.quiet_hours: {start, end,
>   timezone}`: two local wall-clock times written `HH:MM` and an IANA time-zone
>   name, all three required, with `start` different from `end`, and a window
>   whose `start` is later than its `end` wrapping past midnight. An instant is
>   inside the window when its local time of day in that zone falls in `[start,
>   end)`, and no other rule applies across a daylight-saving transition. The key
>   governs one thing, whether a push channel starts a delivery to that person now
>   (§10.3). It MUST NOT be read by any path that computes a verdict, an autonomy,
>   an approver's eligibility, a budget, a sampling draw, a token or a TTL: a
>   request is recorded when it is asked, its TTL runs from `approval.requested`
>   whether or not anybody could be told, and a decision collected inside a window
>   is recorded exactly as one collected outside it. A class rule MAY set
>   `deliver_in_quiet_hours: true` on `manual` or `supervised-live`, and the
>   winning rule's value alone governs; `true` on any other level is a schema
>   violation and the policy fails closed. No field of a request can move a
>   window, since a requester able to mark its own question urgent could spend the
>   approver's sleep, which is the attention §11 names as the audit budget (§11.1
>   invariant 4). A listener reads the window from the policy in force and never
>   from unattested bytes. A zone name the runtime cannot resolve leaves that
>   approver with no window and MUST be reported by the health surfaces; it MUST
>   NOT fail the policy load, because loadability would then depend on the host's
>   time-zone database rather than on the attested bytes. The block is OPTIONAL
>   and ADDITIVE. (Amended APRV-450, pending sign-off.)

**10.2 SPEC.md §10.3, a new paragraph after "Delivery pacing".**

> Quiet hours (amended APRV-450, pending sign-off). A push channel MUST NOT
> start a delivery of a pending request while every approver in that request's
> audience is inside their `delivery.quiet_hours` window (§5.2), unless the
> winning class rule sets `deliver_in_quiet_hours: true`. A request's audience on
> a channel is the approvers its winning rule names, or every approver where it
> names none, whose `channels` list includes that channel; reading that list for
> delivery makes it no check on decisions, and an empty audience is delivered as
> before. The hold is derived on every cycle from the verified log, the clock and
> the policy in force, and is never remembered, so a restart inside a window
> sends nothing and a restart after it sends what is still pending. When a window
> ends the channel delivers in its configured pacing, oldest `approval.requested`
> first in log order, after one computed line naming how many requests were held
> and how many lapsed while held. A request whose TTL ends inside the window is
> not delivered: an implementation MUST NOT break a window on its own judgment,
> and the author's `deliver_in_quiet_hours` is the only way through one. A human
> gesture inside a window, a decision on an earlier delivery or a navigation
> command, is answered, because the window governs what the runtime starts and
> not what it answers. Pull surfaces show everything pending when a person asks:
> `web` SHOULD mark a request that arrived inside its audience's window, and
> `cli`, which cannot hold, MUST say in a computed line and in the health
> surfaces that quiet hours do not apply to it. Dispatch still appends nothing.

**10.3 SPEC.md §8, one sentence in the event-types bullet.**

> `approval.expired` MAY carry `payload.quiet_hours: true`, written by the
> runtime at the write boundary and present only when, under the policy bytes the
> request pinned in `policy_sha256`, every approver in the request's audience on
> every configured push channel was inside their quiet window for the whole
> interval from the request to the lapse and the winning rule did not set
> `deliver_in_quiet_hours`; it is absent otherwise and never `false`. It
> authorizes nothing, no enforcement path reads it, and it is not evidence that a
> delivery was or was not made. (Amended APRV-450, pending sign-off.)

**10.4 `schema/policy.schema.json`.** Under the approver record's `properties`:

```json
"delivery": {
  "type": "object", "additionalProperties": false, "minProperties": 1,
  "properties": {
    "quiet_hours": {
      "type": "object", "additionalProperties": false,
      "required": ["start", "end", "timezone"],
      "properties": {
        "start": { "$ref": "#/$defs/wallClock" },
        "end": { "$ref": "#/$defs/wallClock" },
        "timezone": {
          "type": "string", "maxLength": 64,
          "pattern": "^(UTC|[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)+)$"
        }
      }
    }
  }
}
```

with `$defs.wallClock = {"type": "string", "pattern":
"^([01][0-9]|2[0-3]):[0-5][0-9]$"}`; `start` ≠ `end` is a loader check, since
JSON Schema cannot compare two properties. On `classRule`, a boolean
`deliver_in_quiet_hours` and one more `allOf` member in the `allow_irreversible`
shape: `if {deliver_in_quiet_hours: const true} then {autonomy: enum [manual,
supervised-live]}`.

**10.5 `schema/event.schema.json`.** On `approval.expired`'s payload, an optional
`quiet_hours` with `"const": true`.

---

## 11. Conformance vectors needed

Each carries a `failure_class` where it refuses.

**schema-validation**: a window missing `timezone`; `start: "24:00"`; an unknown
key under `delivery`; `deliver_in_quiet_hours: true` on `autonomous`; the same
key under `defaults`; `deliver_in_quiet_hours: false` on `autonomous` (valid).

**policy-resolution**: membership for a 22:30 to 07:00 window at 22:29, 22:30,
00:00, 06:59 and 07:00 local; a spring-forward pair (window 02:30 to 06:00 in
`America/New_York` on 2026-03-08: 06:59:59Z is outside, 07:00:00Z is 03:00 EDT and
inside); a fall-back pair (window 01:00 to 02:00 on 2026-11-01: both 01:30s are
inside); `start == end` refused at load; two tied rules disagreeing on the bypass
resolve by the winning rule alone.

**gate-verdicts**: a full manual cycle under a policy with a window and one
without, with the same clock, produces logs that differ only in the attested
digest and the `policy_sha256` that pins it (the regression that matters most); a grant inside the
window is a grant; a request lapsing inside every audience member's window
carries `quiet_hours: true`, and one where any member was outside for any
instant carries none.

Channel behaviour (held, released oldest first, gesture answered) is runtime
behaviour, not a vector, and belongs in the Telegram suite.

---

## 12. Open questions

1. **Silent mode.** Should the key admit `mode: silent` (send at once with the
   transport's no-notification flag) beside the hold? It avoids lapse entirely
   for transports that have such a flag. Leaning no until somebody asks, since
   it is Telegram-shaped.
2. **Delivery receipts.** Section 6.3's residual predates this key. Whether a
   channel should ever record that it delivered is a question about the whole of
   §10.3, and it should be asked there.
3. **More than one window a day, or weekdays.** The grammar is one daily window.
   A list of windows is an additive change later; nobody has asked.
4. **In-force or pinned window at dispatch.** This note reads the window in
   force (3.5) for dispatch and the pinned one for the expiry field (6.2). The
   split is deliberate (dispatch acts now; the expiry field describes the past),
   and a reviewer may prefer one source for both.
