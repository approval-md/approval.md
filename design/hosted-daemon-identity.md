# APRV-383 — Hosted daemon identity

**Status: shipped, and narrower than its title sounds.** Everything described in
sections 2 to 5 is wired and tested. Section 1 is the model the four properties
add up to, section 6 is what this task deliberately does NOT do, and section 7
holds the two SPEC.md hunks a human has to decide on. No SPEC sentence was edited
by this task.

The question came from Carter on 2026-09-19: how does a records advance, and the
rest of the daemon, work when one party HOSTS the daemon for another (an external
approval.md user whose repository, log and policy are their own)? The answer was
already three quarters written, which is why this document exists at all: the
missing quarter was small, and nothing stated the other three in one place.

---

## 1. The hosting model, in four properties

A hosted deployment is one daemon process per tenant, run by a host, writing into
the tenant's own log under the tenant's own policy.

**1.1 Authority comes from the tenant's attested policy.** The daemon resolves
every class against `APPROVAL.md` in the tenant's own gate root, and a manual
class reaches the tenant's phone through their own `approvers` roster and their
own `senders` mapping (APRV-324, `design/channel-sender-identity.md`). The host
operates the process and decides nothing. A policy edited by anybody, host
included, is inoperative until a human re-attests it (`core/attest.ts`), so the
host cannot widen a class by editing a file.

**1.2 Credentials come from the launch environment.** SPEC.md §11.1 invariant 7:
no verb reads configuration out of the working tree. The bot token, the sampling
secret, the sender key and the vault passphrase all reach a daemon from the
environment the host launched it with, which is what makes one process per tenant
a credential boundary rather than a naming convention. `core/instance.ts` scopes
the keystore items by instance, so two gates on one machine cannot read each
other's token (that rule exists because they once did).

**1.3 Decisions arrive only through the tenant's mapping.** A Telegram tap is
resolved against `approvers[*].senders`, and a sender the tenant's attested policy
does not name is refused `sender-unmapped` rather than attributed to whatever
actor the listener was launched as (`core/sender-identity.ts`). The host cannot
mint a decision, and the fallback that would have let them was removed before this
task.

**1.4 Identity, which is this task.** Records the daemon appends carried a generic
`system:daemon` actor and nothing else, identical on every machine that ever ran
one, so a tenant opening their own log could not tell WHICH daemon had acted on
their behalf. That is the gap APRV-383 closes.

---

## 2. What a record carries

`core/log.ts`'s `EventRecord` gains one optional top-level field, `daemon`:

```json
{"seq":61,"ts":"2026-09-20T11:04:19Z","event":"audit.sampled",
 "actor":"system:auditor","daemon":"daemon-3f2a9c11", …}
```

Four properties of that field, each of which was a choice:

**2.1 Top level, beside `actor`.** The two answer the same question about
different layers: who caused the event, and which process wrote it down. It is
therefore covered by the record's own chain hash exactly as `actor` is. A
provenance field the hash did not cover could be edited in place without breaking
anything, which is the opposite of what a provenance field is for
(`tests/daemon-identity.test.ts` asserts that changing it invalidates the
digest).

**2.2 Optional and additive.** Every record written before the change validates
and verifies unchanged, in both the write-boundary and the historical validation
modes, because the schema makes the property optional and adds no requirement
anywhere. The absence of the field means what it has always meant: nothing about
this record says a daemon wrote it. It is never read as a claim that none did,
because until this task no daemon could say.

**2.3 Not a member of `EventInput`.** The field is stamped by the writing process
from module state and can never be supplied by a caller. `buildRecord`
(`core/log.ts:663`) composes a record field by field rather than spreading the
input, so a caller that puts a `daemon` property on its input object is ignored
rather than obeyed, and a test pins exactly that.

**2.4 Never in a payload hash and never in a token.** No `payload_hash`, no
`token_sha256` and no bound payload is computed over it. The record hash covers
it; nothing that authorizes anything does.

---

## 3. Where the id comes from

`core/daemon-host.ts:89`, two sources in order:

1. **`APPROVAL_DAEMON_ID`** in the launch environment. A host running several
   tenants names their processes, and a name a person chose is the one a person
   recognises in a log, on a card and in an allowlist. It is in the environment for
   the reason every other launch fact is (invariant 7).
2. **Derived**: `daemon-` plus the eight hex digits `core/instance.ts` computes
   from the absolute path of the instance's `.approval` directory. That is the same
   id `approval doctor` prints as its `keychain-scope` suffix and `.approval/env`
   carries in the open, so an operator comparing `daemon-3f2a9c11` in a record
   against `approval-tg-token-3f2a9c11` in their env file is looking at one gate.

The derived form is what makes "stable across restarts on the same machine and
keystore" true with nothing stored: the input is a directory path, so a restart, a
rebuilt container and a second process in the same checkout all derive one id,
while a different checkout on the same machine derives a different one. Two
alternatives were rejected. A random id written to a file is an identity that
travels when the file is copied, which is the bug `core/instance.ts` documents at
length. An id regenerated per process would make the allowlist of section 4
unwritable.

A declared id that fails the grammar (`^[a-z0-9][a-z0-9._-]*$`, at most 64
characters) is a REFUSAL rather than a fall back to the derived form. The operator
meant the value they set, and a runtime that quietly substituted another would
write records under a name nobody chose and check them against a list nobody wrote
for it. The grammar itself is narrow for the reason `payload.harness_version`'s is
(APRV-227): the value comes from a launch environment and is written into an
append-only log, so a banner, a path, a newline or a shell fragment cannot arrive
through it, and two ids differing only in case would be two ids nobody can tell
apart on a phone.

---

## 4. The allowlist

An attested policy MAY declare the ids permitted to write:

```yaml
daemons:
  - village-goa-1
  - village-goa-2
```

**4.1 Absent means no restriction.** Not an empty list. A policy that never
declares the key behaves exactly as every policy written before it existed, and
the records still carry their id. An empty array is a policy that admits no daemon
at all, which is a thing an author may say and the runtime enforces.

**4.2 It is a top-level key rather than a member of the existing `daemon` block.**
The singular block (APRV-217) is how a daemon that may already write READS a log:
every key in it is a latency setting whose strictest value is the default. The
plural key decides WHICH daemons may write at all. Putting an enforcement key in a
latency block would leave a future reader holding one sentence that was true of
five keys and false of the sixth. The closest precedent for the shape is
`audit.checkpoint_keys`, which is also a list of who may do something, also read
from the attested policy, and also refuses what it does not name.

**4.3 It is read only from the attested policy.** `resolveDaemonAllowlist`
(`core/daemon-host.ts:171`) takes the caller's own verified records and its own
policy load, checks the attestation, and answers only then. The daemon calls it
once per tick immediately after the tick's opening verified read
(`daemon/daemon.ts:1408`), before any sweep that appends.

**4.4 A resolution that fails leaves the previous one standing.** The rule in one
sentence: the restriction in force is the one from the most recent SUCCESSFUL
resolution. A policy that becomes unreadable or loses its attestation under a
running daemon is not a way out of the list it carried a moment ago
(`refreshDaemonAllowlist` simply does not call the setter). The asymmetry that
falls out of this is the right one: NARROWING takes effect on the next tick, and
WIDENING past an unreadable policy takes a restart. A run whose policy was never
attested at all is unrestricted, exactly as every run before this key existed.

**4.5 The refusal is at the write boundary.** `appendEvent` asks
`daemonStampForAppend()` (`core/log.ts:824`) before it takes the append lock,
because the question reads no log state and taking a lock only to refuse would
make every other writer wait for an answer that was never going to touch the file.
Nothing is written on the refused branch: the log is byte-identical, and where the
log did not exist yet it is still not created. Two codes join the frozen
`APPEND_ERROR_CODES` union, because the repairs have nothing in common:

| code | fires when | repair |
|---|---|---|
| `daemon-id-invalid` | `APPROVAL_DAEMON_ID` held something that is not an id, so no record could be attributed to anything | the launch environment |
| `daemon-not-allowed` | the attested policy's `daemons` list does not admit this daemon's id | a line in the policy, re-attested, or a different daemon |

A daemon started with an unusable id is refused earlier still: `approval up` and
`approval daemon run` resolve the id before constructing the `Daemon` and exit 2
with the message, because a process whose whole purpose is writing should not start
in order to find out it cannot (`cli/up.ts:780`, `cli/daemon.ts:719`). The
constructor declares the identity anyway (`daemon/daemon.ts:1012`), which is what
covers a `Daemon` an embedder or a test builds directly.

---

## 5. What an operator and a tenant can see

- **`approval up` and `approval daemon run`** name the id on the `started` line,
  beside the read proof, the anchor and the draw socket, for the same reason those
  are there: which daemon this is, is not something an operator should have to ask
  a running process about. An unlisted id also earns one `daemon-identity-refused`
  warning, said ONCE per run rather than every thirty seconds, because the refusal
  itself is reported per append and a line repeated forever stops being read.
- **`approval status`** reports `daemon: {id, source, allowed}`, always present,
  which is the id a daemon started HERE would write. That is the fact an operator
  wiring up a hosted deployment needs before anything is running, and the one a
  tenant needs to look up a `daemon` field they have just read in a record.
- **`approval doctor`** gains a `daemon-identity` row, the sibling of
  `keychain-scope` one layer along: that row says whose credentials this instance
  uses, this one says whose name its daemon writes. It FAILS for an unusable
  `APPROVAL_DAEMON_ID` and SKIPS, loudly, for an id the list does not admit. The
  skip is deliberate: under the deployment this key exists for, the tenant's policy
  names a daemon on somebody else's machine, so a red row there would be red on
  every tenant's laptop forever, and a red row on every installation is one people
  learn to skip past (the reason `keychain-scope` gives for the legacy item).

---

## 6. Out of scope, and said plainly

**6.1 This is attribution, not authorization.** A hostile host process holds the
tenant's log handle and can call anything in `core/daemon-identity.ts` that the
daemon calls, exactly as it can call `markDaemonProcess()`. `core/daemon-actor.ts`
states that boundary and this task inherits it word for word: what keeps an agent
out of the daemon's process is that `approval daemon run` classifies `gate.self`,
and what keeps a HOST honest is the tenant's attested policy, the tenant's
credentials and the tenant's phone, which are properties 1.1 to 1.3 and not this
one. What the allowlist catches is the likelier failure and the one nothing caught
before: a daemon started against the wrong tenant's log, a second daemon nobody
meant to leave running, a container rebuilt with a new id.

**6.2 The allowlist governs the LOG and nothing else.** A refused daemon still
reads, still renders `QUEUE.md` and still repairs a task file's `state:` to match
the log, because none of those is an append. Observed while testing this task, and
recorded here rather than left for somebody to find: a host whose id a tenant
removed can still write in the tenant's working tree until it is stopped. Confining
the filesystem is process isolation, which is 6.3.

**6.3 Process isolation is a separate task.** One process per tenant is a
deployment property today, enforced by nothing in this repository. What a container
may read and write, where the scratch space is, and what stops one tenant's daemon
from opening another tenant's log are not addressed here at all.

**6.4 Token scoping is a separate task.** The tenant issues the host a token
scoped to their repository; nothing in this runtime checks that scope or knows
what it is.

**6.5 Billing and metering are a separate task.** Nothing here counts anything for
anybody. `payload.est_cost_usd` and the budgets contract measure the TENANT's
spend against the tenant's own caps, and they are not a host's invoice.

---

## 7. The two SPEC.md hunks, for a human to decide on

Proposed, not applied. Both are additive.

**7.1 §8, the record-fields list.** After the `provider_ref` bullet, a new bullet:

> - **The writing daemon.** A record appended by a daemon MAY carry `daemon`, the
>   id of the daemon instance that wrote it, so that a log hosted by one party for
>   another states which host process acted. The value is the id declared in that
>   process's launch environment or one derived from the instance the log belongs
>   to; it is stamped by the runtime at the write boundary and is never a caller's
>   parameter. It is OPTIONAL and additive: a record written without it validates
>   and verifies unchanged, and its absence is absence rather than a claim that no
>   daemon wrote the record. An implementation MAY let an attested policy list the
>   ids permitted to append (`daemons`, §5.2) and MUST then refuse an append from an
>   unlisted id at the write boundary with a distinct code (`daemon-not-allowed` in
>   the reference runtime), leaving the file byte-identical. The id is
>   self-reported, so §11.1 invariant 4 binds it completely: an implementation MUST
>   NOT let a listed id reduce any scrutiny, and MUST NOT read the field as an input
>   to a verdict, an autonomy, a budget, a floor, a sampling draw or a token.
>   (Amended APRV-383, pending sign-off.)

**7.2 §11.2, the `append_error_codes` table.** Two rows after `head-moved`:

> | `daemon-id-invalid` | The appending process declared a daemon id that is not a
> well-formed id, so no record it wrote could be attributed. An implementation MUST
> NOT substitute a derived id for a declared one it refused. |
> | `daemon-not-allowed` | The attested policy lists the daemon ids permitted to
> append to this log and the appending daemon's id is not among them. An ABSENT
> list is no restriction; an empty list admits none. |

A third hunk is arguable and is NOT proposed: §5.2 could gain a sentence naming
`daemons` beside `approvers`. The key is in `schema/policy.schema.json` with its
whole rationale, the README's dictionary has a row for it, and §5.2 does not
enumerate every key. A human who wants the policy vocabulary complete in SPEC.md
should ask for it rather than have this task assume it.
