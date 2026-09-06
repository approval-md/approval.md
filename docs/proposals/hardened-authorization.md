# Hardened human authorization and externally verifiable receipts (APRV-249)

**Status: design proposal. Nothing here is implemented, and nothing here amends
SPEC.md or `APPROVAL.md`.** The task that produced it authorizes design work
only. Every specification or policy change named below is a proposal for a later
task and a later human sign-off. Ordinary approval.md workflows are unchanged by
this document and are intended to stay unchanged by anything built from it.

The question it answers: what would it take for a service that does not trust
the operator of an approval.md log to derive a real assurance claim from an
approval, and how small can the first step be.

---

## 0. The claim, stated once, and the things it is not

The target claim, the strongest one this design is willing to underwrite:

> An enrolled operator credential authorized this specific grant, through a
> verification path outside the requesting agent's control.

Everything below is measured against that sentence. Five things it deliberately
does not say, and which no phase of this proposal may be described as saying:

1. **It is not proof of humanity.** A credential is a key with custody rules. A
   key can be held by a person, by a script that person set up, or by whoever
   compromised the device holding it. Nothing in a signature distinguishes those.
2. **It is not proof the approver understood the request.** SPEC §11 already says
   this about the local path ("what remains undefended is persuasion about
   whether those bytes should be approved"), and a signature over the same bytes
   changes nothing about it. WYSIWYS (§9, APRV-119) proves which text was in
   front of somebody. It proves nothing about what happened in their head.
3. **It is not proof that subsequent agent behavior is safe.** A grant is scoped
   authorization for declared actions. An agent that holds a valid receipt for
   "send in channel X until Friday" has exactly that authority and has been
   vouched for in no other respect.
4. **It is not a substitute for the relying service's own controls.** A receipt
   is one input to that service's decision. Rate limits, content policy, and
   abuse response stay the relying service's job.
5. **It is not proof against a compromised host.** SPEC §11 lists a compromised
   host as undefended, and every phase below inherits that. What the phases move
   is the cost of forgery, from "set an environment variable" to "extract a key
   from a vault on the listener host" to "possess an enrolled authenticator and
   satisfy user verification on it".

The weaker signals stay weaker, and any documentation this proposal leads to must
say so in the same breath as the stronger one. Importing the package proves
nothing. The presence of an `APPROVAL.md` file proves nothing. Disclosed adoption
of an approval.md workflow is a self-report by the operator, which is useful to a
relying service that wants to know what an integrator intends and is not evidence
about any individual action.

---

## 1. The trust boundary as it is actually built

This section is descriptive. Each claim names the code or specification text it
comes from, so a reviewer can check it rather than take it.

### 1.1 Human identity is config-declared

`resolveHumanActor` in `src/core/attest.ts` takes `--as human:<id>` first and
`APPROVAL_HUMAN` second, and validates only the shape `^human:.+`. There is no
secret, no key, and no challenge anywhere in the path. SPEC §11 states the
consequence plainly: "Human identity in v0.1 is config-declared (an environment
variable or flag); the trust boundary is the local machine, and anyone who can
set that configuration and write to the log is inside it."

Two structural defenses stand around that, and they are worth naming because they
are what makes the boundary "the machine" rather than "the working tree":

- **Configuration is never read implicitly from the working tree** (SPEC §11.1
  invariant 7, APRV-73, `tests/cli-env.test.ts`). `approval env` prints an export
  block a human evaluates in their own shell. A file an agent can write does not
  become an identity.
- **Spawned children are scrubbed** (SPEC §10.4, APRV-205). `core/child-env.ts`
  withholds `APPROVAL_`, `TELEGRAM_`, `VAULT_`, `AGENTMAIL_` variables and the
  vault passphrase variable from every child the runtime spawns.

So an agent whose only handle on the machine is `approval run` under this runtime
does not inherit the identity variable. An agent with a shell on the same account
as the listener does.

### 1.2 Policy attestation binds rules to bytes, and to nothing else

`approval policy attest` appends `policy.updated` carrying the SHA-256 of the
policy file (SPEC §5.2). Gate operations refuse `policy-not-attested` when the
live bytes differ, and `approval.requested` and `approval.granted` carry
`policy_sha256` assigned at the write boundary, with a `policy-drift` refusal
when the hash in force at grant time differs from the hash the request pinned
(APRV-118). `gate.organ.attested` extends the same content-attestation shape to
the harness files that install the hook (APRV-272).

What this proves: the rules in force were seen, as exact bytes, by an actor with
local control. What it does not prove: which person that was. The specification
says exactly this, in §5.2's `approvers` paragraph, which ends "it does not
defend against an actor choosing whose name to wear."

### 1.3 The three channels differ in transport and agree in authentication

| channel | transport | identity of the decision | out-of-band from the agent? |
| --- | --- | --- | --- |
| `cli` | terminal prompt in the operator's own shell | `--as` / `APPROVAL_HUMAN` of that shell | only if the shell is not the agent's |
| `web` | `127.0.0.1` page, host hard-coded, no session, no CSRF token | the identity the listener process was started with | no: anything that can open a loopback socket can POST |
| `telegram` | bot API, callbacks filtered to the configured approver chat id | the identity the listener process was started with | yes for the tap, subject to §1.4 |

`src/cli/channel-telegram.ts` says it in its own refusal text: "Every decision
this listener records is recorded against it, and nothing here authenticates it."
README says the same about the web page: it proves "someone with access to this
machine approved" and never "that specific person approved".

The Telegram channel is the interesting one, because the human act genuinely
happens on a second device. What it authenticates is a chat id, against a bot
token held by the listener. That is a real second factor of a kind, and it is a
weak one to describe to a third party: the assurance rests on Telegram's account
security, on the bot token staying out of the agent's reach, and on the listener
process being honest about what it appends after a tap arrives. A remote verifier
sees none of those and has no way to check any of them.

### 1.4 What differs between deployments, and why one sentence about spoofing risk is wrong

The blanket statement "an agent can forge an approval" is true in some
deployments and false in others. Three shapes, ordered by how much the agent
controls:

- **D1, shared account.** The agent's shell runs as the same OS user as the
  listener, with the same environment. This repository's own dogfood is close to
  this shape, and the hook (`docs/claude-code-hook.md`) plus the open-window
  ceremony exist because of it. Here an agent that can read the listener's
  environment can set `APPROVAL_HUMAN`, append a grant, and never involve a
  phone. The Telegram tap is real when it happens and it is not what the log's
  authenticity rests on.
- **D2, restricted local runtime.** The agent runs in a worktree, container, or
  under a harness whose child environment is scrubbed, with no read access to the
  listener process, the vault passphrase, or the bot token. Forging a decision now
  requires a privilege escalation on the host. This is the shape the child-env
  scrub and invariant 7 are designed to produce, and it is a materially different
  risk from D1.
- **D3, remote agent.** The agent reaches the runtime over `approval mcp serve
  --http --guest`, which mints `agent:guest-<6 hex>` per session and withholds
  every human-only verb by construction. The agent has no filesystem, no
  environment, and no log write path at all. Everything it can do is a tool call
  that the runtime decides.

The honest summary for a relying service: **the local log's integrity is strong
in every shape, and the local log's authorship is only as strong as the weakest
party with write access to it.** A verifier that cannot tell D1 from D3 must
assume D1. Today a verifier cannot tell, and that is the gap this proposal
addresses.

### 1.5 What a remote verifier can independently establish today

Given a copy of `events.jsonl` and nothing else:

| the verifier can establish | the verifier cannot establish |
| --- | --- |
| the chain is internally consistent from genesis (`hash`/`prev`, `alg: sha256/jcs`) | that the chain was not recomputed after a truncation (SPEC §9; `chain-verification/truncation-unanchored`) |
| a grant names a payload hash, and an execution recomputed the same hash (§10.4, APRV-140) | that the payload bytes are what a person believed they were approving |
| the display hash the approver's channel rendered (§9, APRV-119) | that any person read it |
| which policy hash was in force at request and at grant (APRV-118) | who attested that policy |
| that a `human:` actor string is on the decision | that the string corresponds to a person, or to that person |
| that a `log.checkpoint` signature verifies under a key named in `audit.checkpoint_keys` (APRV-220) | which decisions that key's holder saw, since a checkpoint signs a head and not a decision |

Two mechanisms already push against the last column and are the natural
foundation for everything below:

- **Anchoring (APRV-219, `approval log verify --anchor`).** Compares the working
  log against a committed copy the tamperer may not control. It answers "does
  someone else hold these bytes", is exactly as fresh as the last push, and skips
  on a machine with no remote.
- **Signed checkpoints (APRV-220/257, `approval log checkpoint`).** An Ed25519
  signature over `"approval.md/log-checkpoint/v1\n" + JCS({alg, hash, seq})`,
  made by a key held in the vault or a key file, with the public half listed in
  `audit.checkpoint_keys` in the attested policy. It answers "did a key no agent
  process holds sign this head", works offline, and needs a human on a cadence.

The checkpoint is the closest thing in the repository today to an operator
credential, and §4 below proposes reusing its machinery rather than inventing a
parallel one.

### 1.6 Documentation gaps, stated without inflation

The repository's own prose is already careful. SPEC §11 states the boundary,
README states it twice (the identity doctor row and the web-queue paragraph), and
`docs/git-evidence.md` states what each witness does and does not catch. The gaps
are at the edges where a third party, rather than the operator, reads the signal:

1. **`approval instructions`, the agent-facing guide, says nothing about what a
   grant proves to somebody else.** An agent that reports "this was human
   approved" to a relying service is making a claim the runtime never authorized
   it to make, and no surface tells it so.
2. **There is no vocabulary for the assurance level of a decision.** A grant in
   D1 and a grant in D3 are byte-identical records. §7 proposes labels.
3. **`docs/integrations-considered.md` and the connector runbooks describe what an
   integration can do, and not what an integrator may claim.** A relying service
   reading those is left to infer the strength of the signal.
4. **Nothing states the deployment-shape distinction of §1.4 in one place.** It
   is derivable from `child-env.ts`, invariant 7, and the guest-mode section of
   `docs/cli-reference.md`, and it is currently derivable rather than stated.

None of these is a vulnerability. Each is a place a reader could form a stronger
impression than the code supports.

---

## 2. What "a human approved" can and cannot mean today

Putting §1 together, a grant in the log today supports this and no more:

> A party with write access to this log recorded a decision under a human
> identifier that party declared, against a policy some party with write access
> had attested, over payload bytes the record names by hash.

That statement is genuinely useful. It is the difference between an agent acting
and an agent acting under a record it cannot silently rewrite. It defends
after-the-fact disputes about what was approved, and it makes undeclared side
effects mechanically catchable at the adapter boundary. SPEC §11's "Defended"
list is accurate.

It is also, to an external relying service, entirely self-asserted. Every element
of it comes from one party's own files. A service that requires evidence needs
something the party under scrutiny could not have produced alone. That is one
sentence, and it is the whole design problem.

---

## 3. Design constraints this proposal accepts

Before options, the boundaries any option has to live inside. These come from
SPEC and from CLAUDE.md and are not negotiable within this task.

1. **The log is append-only, and projections never write back** (SPEC §3, §8).
   Receipts are derived artifacts. No mechanism here rewrites, reorders, or
   reinterprets an existing record.
2. **Every event validates against its schema before append** (SPEC §8). New
   record types are their own tasks with their own schema work.
3. **Gate-typed events take their `ts` from the runtime** (§11.1 invariant 2), and
   enforcement reads only verified records (invariant 1).
4. **Self-reported fields never reduce scrutiny** (invariant 4), and **guidance
   never reaches enforcement** (invariant 10). A receipt an agent presents is a
   self-reported field on the local side of the boundary. It may raise local
   scrutiny and may never lower it.
5. **Human-only classes are inert to agents** (invariant 9). Whatever ceremony
   enrolls or rotates an operator credential is human-only, and no verb may mint
   authority for it.
6. **Local-first, no hosted service** (SPEC §13). approval.md may not require a
   server run by this project for an ordinary workflow to function. §9.2 works
   through where this bites.
7. **Fail closed** (CLAUDE.md). An unavailable authenticator, an unreachable
   verifier, or an unparseable receipt resolves to the stricter path.
8. **Execution tokens are unchanged.** The adapter boundary stays the hard
   enforcement (§10.4). Nothing here weakens or replaces a token.

---

## 4. The options

Four candidates, evaluated on the same seven questions. They are not mutually
exclusive, and §8 recommends a path that composes three of them.

### 4.1 Option A: a device-bound operator signing key

**Shape.** The operator holds an asymmetric key whose private half is generated
on and non-exportable from a device: a platform secure element, a hardware
security key, or an OS keychain with a hardware-backed store. The decision
surface signs a per-decision message with it. The public half is enrolled with
each relying service that will consume receipts.

**What it proves.** The signature over a decision digest was produced by a key
whose private half exists in one device. Combined with the device's own user
verification, it supports "the holder of the enrolled credential, having
satisfied that device's user check, authorized this exact decision."

**What it does not prove.** That a person rather than an automation triggered the
signature, unless the device enforces user verification and the relying service
verifies that the user-verified flag was set. That the holder is the enrolled
operator rather than someone in possession of the device. That the signed digest
corresponds to text anyone read, unless the digest covers the canonical rendering
(§6.1 addresses this).

**Threat model.** Defends: an agent with the local environment, an agent with log
write access, an agent that can read files and vaults on the runtime host,
replay across audiences and across requests when the message is bound (§5.3).
Does not defend: a compromised approval device, an operator who approves
carelessly, coercion, a relying service that fails to pin the key.

**Cost to operators.** Real. A key ceremony, a second device in the loop, and a
recovery story that is itself a security-critical design (§4.5). This is the cost
that keeps the hardened path opt-in and per-class.

**Log schema delta.** One new gate-typed event, proposed name
`approval.countersigned`, carrying `granted_seq`, `key_id`, `alg`, `sig`, and the
digest that was signed. It never replaces `approval.granted`, and a grant with no
countersignature is an ordinary grant that behaves exactly as it does today.

**Verification delta.** A new verb, proposed `approval receipt verify`, plus the
`approval log verify` walk gaining an optional `--countersigned` mode that behaves
like `--checkpoints`: refuse an invalid signature, skip on an absent one, and
never turn a skip into a pass.

**How ZZZ verifies without trusting the repo owner.** ZZZ holds the enrolled
public key from its own enrollment ceremony, in its own store. It verifies the
signature over the receipt body itself. The repo's log is not in the trust path
at all. The operator cannot rotate the key silently, because rotation is an event
in ZZZ's registry and not in the operator's file.

### 4.2 Option B: WebAuthn or passkey assertion over the request digest

**Shape.** The operator opens an approval page on a separately controlled device,
sees the canonical rendering of the request, and completes a WebAuthn assertion
whose `challenge` is the digest of the exact decision. Telegram or the CLI
delivers a link. The link carries no authority: it is a notification, and the
assertion is the authorization. This is Option A with a specific, widely deployed
credential format and a standard verification contract.

**What it proves.** Everything Option A proves, plus two things a bare signature
does not: the assertion carries `clientDataJSON` naming the origin, so a
credential minted for one relying party's origin cannot be replayed at another,
and the authenticator data carries user-presence and user-verification flags a
verifier can require. The `signCount`, where an authenticator maintains one,
gives a weak cloning signal.

**What it does not prove.** That the authenticator is hardware. A software or
virtual authenticator produces assertions indistinguishable from a hardware one
unless attestation is collected at registration and the attestation statement is
checked against a trusted AAGUID set (§4.4). That the credential belongs to a
person, since a passkey can be created in a browser profile an agent drives.
That user verification means a human: a platform authenticator with a stored
credential and an automated unlock is a user-verified signature with no person
present. That a passkey synced through a cloud keychain lives on one device at
all, since sync is the point of that product category.

**Threat model.** Defends everything Option A defends, and additionally defends
credential phishing across origins by construction. Does not defend an
agent-created account with an agent-accessible authenticator (§4.4), account
recovery abuse at the identity provider that backs the credential (§4.5), or a
compromised approval device.

**Cost to operators.** Lower than a bare hardware key for the common case, since
the credential is a passkey the operator already knows how to create. Higher in
infrastructure, because WebAuthn needs an origin and an RP ID, which is the
local-first tension of §9.2.

**Log schema delta.** The same `approval.countersigned` record, with `alg` naming
a WebAuthn assertion and the payload carrying `credential_id`, `authenticator_data`,
`client_data_json`, and `signature`. The record is larger than an Ed25519 one,
which matters for a log that is kept forever (APRV-217 is already about log size),
so §5.5 keeps the assertion out of the log by default and in the receipt only.

**Verification delta.** A WebAuthn assertion verifier. This is the one place the
proposal contemplates a dependency, and CLAUDE.md requires each new dependency to
be justified in its task's notes. A minimal verifier over Ed25519 and ES256
assertions is a few hundred lines against `node:crypto` and is the preferred
route, with a vendored implementation second and a dependency third.

**How ZZZ verifies without trusting the repo owner.** ZZZ is the relying party.
It runs the registration ceremony, holds the credential public key and its
AAGUID, sets the challenge policy, and verifies the assertion itself. The
operator's log is evidence for the operator's own audit and is not part of ZZZ's
verification. This is the cleanest separation of the four options.

### 4.3 Option C: signed checkpoints extended to per-decision signatures

**Shape.** `log.checkpoint` already exists, already signs a `(seq, hash)` pair
with an Ed25519 key the runtime does not hold in agent-reachable form, already
verifies against `audit.checkpoint_keys` in the attested policy, and already has
refusal codes, conformance vectors, a cadence prompt, and a rotation rule that
refuses to drop a key that signed anything. Extending it to sign a specific
decision reuses all of that.

Two sub-shapes, and the difference matters:

- **C1, decision countersignature.** A new record signs the digest of one
  `approval.granted`. Direct, and it needs a signing act per decision.
- **C2, checkpoint as a covering witness.** No new record at all. A checkpoint at
  seq N witnesses every record below N, so a grant at seq M < N is inside a signed
  prefix. A receipt for that grant carries the grant record, the chain of hashes
  from M to N, and the checkpoint signature over N. The verifier walks the
  hashes and checks one signature.

C2 is the smaller change and the weaker claim, and the difference is worth being
exact about. It proves "a key the agent does not hold signed a chain that
contains this grant", and the signature happened after the fact, at checkpoint
cadence. It does not prove the key holder saw the grant, and it does not prove
freshness at decision time. It is closer to a countersigned audit log than to an
authorization. For a relying service that wants evidence a decision was not
inserted after the fact by a party who then recomputed the chain, C2 is real and
cheap. For the target claim in §0, C2 is insufficient on its own.

**What C1 proves.** A key held outside agent reach signed this decision digest.
Under vault custody, "outside agent reach" means the listener process holds the
passphrase from a human's shell and `child-env.ts` strips it from every spawned
child.

**What C1 does not prove.** Device binding, since a vault key is a file the
operator can copy and an attacker who owns the listener host can extract. User
presence, since nothing in the signing path requires a person at the moment of
signing. Any of the freshness properties of Option B.

**Threat model.** Defends: an agent with log write access, an agent with the
identity variable, a forger who truncates and recomputes the chain, replay across
audiences when the message is bound. Does not defend: a compromised listener host,
key exfiltration from the vault, or an operator who automates the signing.

**Cost to operators.** The lowest of the four. The key ceremony already exists
(`approval setup checkpoint`), the cadence prompt already exists (APRV-257), and
the rotation rule already exists. An operator who runs checkpoints today gets C2
for free and C1 for one policy key.

**Log schema delta.** C2: none. C1: one new event type, as in §4.1.

**Verification delta.** C2: a receipt exporter and a verifier that reuses the
existing checkpoint verification. C1: one more branch in the same verifier.

**How ZZZ verifies without trusting the repo owner.** ZZZ enrolls the checkpoint
public key at integration time and pins it. It then verifies the signature and the
hash walk offline. The weakness is that `audit.checkpoint_keys` lives in the
operator's own policy file, so a verifier that reads the key from the log's policy
is trusting the party under scrutiny. **The enrolled key must come from ZZZ's own
registry, and the policy list is a local convenience only.** This is the single
most important implementation detail of this option.

### 4.4 Option D: third-party receipts

**Shape.** A party neither the operator nor the relying service controls
witnesses the decision. Three sub-shapes, in ascending order of infrastructure:

- **D1, timestamp authority.** An RFC 3161 or Roughtime-style countersignature
  over the receipt digest, proving the receipt existed before a point in time.
  Cheap, and it proves ordering rather than authorization.
- **D2, transparency log.** The receipt digest is submitted to an append-only
  transparency log (the Certificate Transparency and Sigstore shape), which
  returns an inclusion proof. This makes an operator who issues receipts
  selectively or retroactively detectable by anyone auditing the log, and it
  makes key compromise discoverable.
- **D3, hosted verifier.** A service that runs the approval ceremony and issues
  receipts on the operator's behalf. This is what every commercial approval
  product does.

**What D1 and D2 prove.** That the receipt was published, and when, and that it
was not issued retroactively to fit a story. Combined with A, B, or C they turn
"a key signed this" into "a key signed this, and everyone can see every other
thing that key signed."

**What none of them prove.** Anything about the approver that the underlying
signature did not already prove. A transparency log witnesses receipts and does
not authenticate people.

**Threat model.** D2 defends equivocation, which is the one attack the other
options are blind to: an operator who issues one receipt to ZZZ and a different
story to their own auditors. It does not defend a compromised credential, and it
introduces an availability dependency at issuance.

**Cost to operators.** D1 is small. D2 is meaningful and mostly a privacy cost:
publishing receipt digests to a public log leaks the timing and volume of an
operator's approvals, and careless field choice would leak more. D3 is
disqualified: SPEC §13 says "no hosted service (local-first; a sync story can
come later)", and a hosted verifier is a hosted service in the plainest sense.

**Log schema delta.** An optional `inclusion_proof` field on the countersignature
record, or nothing at all if proofs live only in exported receipts.

**Verification delta.** A Merkle inclusion-proof checker and a pinned log public
key.

**How ZZZ verifies without trusting the repo owner.** ZZZ checks the inclusion
proof against a log whose key it pins independently. This is the only option that
gives ZZZ evidence about what the operator did *not* tell it.

### 4.5 Side-by-side

| | A: device key | B: WebAuthn | C1: countersign | C2: checkpoint cover | D: third-party |
| --- | --- | --- | --- | --- | --- |
| binds a specific decision | yes | yes | yes | prefix only | inherits |
| fresh at decision time | yes | yes | yes | no | inherits |
| user verification signal | device-dependent | flag, verifiable | none | none | none |
| survives host compromise | yes | yes | no | no | no |
| detects equivocation | no | no | no | no | yes (D2) |
| new dependency | maybe | likely | none | none | likely |
| operator effort | high | medium | low | lowest | medium |
| code already in repo | none | none | most | all | none |

---

## 5. The receipt: `approval-receipt/v1`

A receipt is a self-contained, signed statement about one decision, exported from
a log and verified by somebody who has never seen that log.

### 5.1 The field set

The body, canonicalized per §5.2. `MUST` fields are required for a receipt to
parse at all.

| field | req | meaning |
| --- | --- | --- |
| `v` | MUST | `"approval-receipt/v1"`. A verifier that does not know the value refuses rather than guesses. |
| `iss` | MUST | The issuing credential's stable identifier: a key fingerprint for A and C, a WebAuthn credential id for B. This is what a relying service enrolled. |
| `iss_instance` | SHOULD | An identifier for the log instance, informational, marked as a claimed field. It helps an operator's own audit and carries no trust. |
| `approver` | SHOULD | The `human:<id>` the local runtime recorded. **Always a claimed field.** A verifier may display it and may never derive assurance from it. |
| `sub` | MUST | The agent identity the grant authorizes: `agent:<id>`. |
| `sub_key` | MUST | SPKI SHA-256 of the agent's long-lived public key. Proof of possession (§5.6) is what makes this meaningful. |
| `aud` | MUST | The relying service this receipt is for, e.g. `"zzz.bot"`. A receipt is valid for exactly one audience. |
| `decision` | MUST | `"granted"` or `"rejected"`. Rejections are exportable so a relying service can be told a request was refused. |
| `grant` | MUST | `{action_key, payload_hash, display_hash, policy_sha256, seq, log_head}`. This is the exact request digest material. |
| `scope` | MUST | The permissions the grant confers, structured per §6.3. |
| `iat`, `nbf`, `exp` | MUST | Issuance, not-before, expiry, RFC 3339 UTC. `exp` is required and short by default. |
| `challenge` | MUST | A nonce chosen by the relying service, echoed here. See §5.4. |
| `jti` | MUST | A unique receipt identifier, used for single-use enforcement and revocation. |
| `binding` | MUST | The signature material: `{alg, sig}` for A and C1, `{alg, credential_id, authenticator_data, client_data_json, sig}` for B, `{alg, checkpoint_seq, checkpoint_sig, chain: [...]}` for C2. |
| `witness` | MAY | A timestamp countersignature or transparency inclusion proof (Option D). |
| `assurance` | MUST | A label from the closed set in §7. **The verifier recomputes this from what it validated and refuses a receipt whose stated label exceeds what the evidence supports.** It is present so a human reading a receipt sees the claim in words, and it is never an input to a verdict. |

Two fields are deliberately absent. There is no `human_verified` boolean, because
a boolean an issuer sets is exactly the self-report the whole mechanism exists to
replace. There is no free-text `reason` inside the signed body, because a signed
statement whose meaning depends on prose invites a verifier to parse prose.

### 5.2 Canonicalization

The signed message is:

```
"approval.md/authorization-receipt/v1\n" + JCS(body)
```

where `body` is every field above except `binding` and `witness`. RFC 8785 (JCS)
is already the repository's canonicalization for the hash chain (`alg:
sha256/jcs`, `src/core/jcs.ts`), so this reuses a tested implementation and the
existing conformance vectors for it. The domain-separation prefix is the same
device `CHECKPOINT_DOMAIN` uses, and for the same reason: a signature made for a
receipt can never be lifted into a checkpoint, and a checkpoint signature can
never be presented as a receipt.

For Option B the WebAuthn `challenge` is `SHA-256` of that same message, so the
authenticator's signature transitively covers the whole body. This matters: an
implementation that puts only the relying service's nonce in the challenge has an
assertion that proves a tap and binds nothing about what was tapped.

Money fields inside a scope follow SPEC §6.2's decimal-string rule, for the reason
that section gives: byte-identical hashing must be a property of the record rather
than of the language that serialized it.

### 5.3 Changes after review

The `grant` block names `payload_hash` and `display_hash`. A payload edited after
the approver read it produces a different `payload_hash`, and `approval run` and
every adapter already refuse `payload-mismatch` on recomputation (SPEC §10.4,
APRV-140). A rendering change produces a different `display_hash`, and the
renderer names its own version inside the text it hashes (§9, APRV-162).

For a scope that references a remote mutable object, the `adapter-agentmail`
precedent applies and should be stated as the general rule: the grant binds the
bytes fetched at request time, and the executor re-fetches and compares before
acting, refusing with a distinct code when the far side moved. A relying service
holding a receipt for such a scope should treat the receipt as authorizing the
bytes named in it and nothing the object later contains.

### 5.4 Replay

Four independent bindings, and a verifier checks all four:

1. `aud` pins the relying service. A receipt for one service is invalid at another.
2. `challenge` is chosen by the relying service and is single-use on its side. A
   receipt whose challenge the service did not issue, or already retired, is
   refused. This is the property that makes a receipt useless to anyone who
   intercepts it later.
3. `exp` bounds the window even where challenge state is lost.
4. `jti` is single-use where the service enforces one-shot authorization, and is
   the revocation handle otherwise.

The relying service owns 2 and enforces 1, 3, and 4. A receipt design that leaves
challenge selection to the issuer has no replay protection worth the name, since
the party being checked is choosing the nonce.

### 5.5 Coexistence with execution tokens and the log

These are three different artifacts and they must stay three.

- **The execution token** authorizes one local side effect through one adapter,
  once, bound to `idempotency_key` and `payload_hash`. It is secret, single-use,
  and never leaves the operator's machine except sealed to an ephemeral key
  (APRV-105). A receipt is public, is shown to a third party, and authorizes
  nothing locally. **A receipt must never be accepted where a token is required,
  and a token must never appear inside a receipt.**
- **The log** is the operator's own append-only record and stays the source of
  truth locally. A receipt is a projection of it plus a signature. It is exported
  and never imported: a receipt an agent presents to the local runtime is a
  claimed field under invariant 4, may raise local scrutiny, and may never lower
  it or satisfy a local gate.
- **The countersignature record** (§4.1) is the only new thing in the log, is
  additive, and is written after `approval.granted` rather than instead of it. A
  reader that does not know the type sees a grant that behaves exactly as grants
  behaved before, which is SPEC §8's additive-change rule.

Receipt bodies are kept out of the log by default. §11.1 invariant 3 keeps raw
secrets out, and a receipt holds none, so the reason here is different: a
WebAuthn assertion is kilobytes, a log is kept forever, and APRV-217 is already
about log size. The exported receipt is the artifact; the log holds the digest
and the signature.

### 5.6 Proof of possession

`sub_key` names an agent key. Without a possession check, a stolen receipt
authorizes whoever holds the bytes. The relying service therefore runs a
challenge-response against `sub_key` at connection time, before honoring the
receipt. A receipt plus a possession proof supports "this agent, holding this key,
was authorized"; a receipt alone supports "some agent named in this receipt was
authorized."

Two honest caveats. An agent key held in the agent's own runtime binds a runtime
instance, and a compromised runtime holds the key. And the key says nothing about
the agent's trustworthiness, only about its continuity.

### 5.7 Issuer trust and key rotation

**The enrolled key comes from the relying service's own registry.** A verifier
that reads the issuer key out of the operator's policy file, or out of the
receipt, is asking the party under scrutiny to name its own authority. The
`audit.checkpoint_keys` list in `APPROVAL.md` is a local convenience for local
verification and is not an authority for a third party.

Rotation, therefore, is a ceremony at the relying service: the operator registers
a new credential, and the service decides when the old one stops being accepted.
Three rules worth writing into the contract:

1. **Retiring a key de-verifies the receipts it signed**, unless the service
   keeps retired keys in a verify-only set. `docs/cli-reference.md` records the
   same tension for checkpoints and resolves it by refusing to drop a key that
   signed anything. A relying service should keep retired keys verifiable and
   stop accepting new receipts under them.
2. **Rotation must require the same or stronger authentication than issuance.**
   A rotation reachable through a weaker path is the whole mechanism's weakest
   link (§4.5 on recovery).
3. **A receipt names the credential it was signed with**, so a service that
   distrusts a compromised credential can identify every receipt to re-examine.

### 5.8 Revocation

Four mechanisms, in order of reliability:

1. **Expiry.** Always present, always enforced. Short `exp` is the default answer
   and the only one that works with no connectivity.
2. **Credential revocation at the relying service.** The operator tells the
   service a credential is compromised, and the service stops accepting receipts
   signed by it. Reliable, because it lives in the service's own store.
3. **Scope revocation at the relying service.** The operator revokes a standing
   grant by `jti`. This is the ZZZ case: an operator who granted send access until
   Friday wants it gone on Wednesday.
4. **`approval.revoked` in the operator's log.** Already exists for pre-execution
   revocation. It is evidence for the operator's audit and cannot reach a relying
   service on its own, since the service does not read the log. A service that
   wants log-driven revocation must poll or be pushed, which is an integration
   choice rather than a property of the receipt.

The honest statement for documentation: **a receipt with a long expiry and no
service-side revocation channel is a bearer authorization for its whole lifetime.**
Short expiry with re-issuance is the recommended default.

---

## 6. Enforcement and the operator experience

### 6.1 The trusted surface shows the exact decision

The operator must see, on the surface where they authenticate, the same material
the signature covers. approval.md already has the machinery: the canonical
renderer of §9 is a pure function from payload bytes and action class to text and
a `display_hash`, with no clock, locale, environment, randomness, or IO, and
channels must present it verbatim (§10.3, APRV-119/162). The hardened surface
inherits that requirement without amendment. Concretely:

- The page shows the canonical rendering, whole. A rendering it cannot show whole
  is refused rather than truncated, which is the rule §10.3 already states for
  attestation prompts.
- Computed and claimed fields stay visibly distinguished (§9). The agent's summary
  sits outside the canonical block and is labelled.
- The scope is shown in the same terms the receipt will carry, because a scope
  rendered one way and signed another is the failure this whole section exists to
  prevent.
- The page shows `display_hash` and `payload_hash`, so an operator who wants to
  compare against their own terminal can.

### 6.2 Fresh authentication, bound to this decision

**A prior login is not an authorization.** The assertion's challenge is the digest
of this decision (§5.2), the user-verification flag is required, and the
authenticator is exercised at the moment of the decision. A session cookie that
lets a page produce authorizations without a fresh gesture reduces the mechanism
to Option C1 with extra steps.

**Notification transport is separate from authentication strength.** Telegram, the
CLI, an email, or a push notification may deliver a link. None of them
authenticates. The link carries a request identifier and no authority, and a
recipient who is not the enrolled operator can open it and cannot authorize
through it. Stated as a rule for later implementation: **a channel's decision path
and the hardened decision path are different code paths with different evidence,
and a channel tap must never be recorded as a hardened authorization.**

### 6.3 The relying service enforces its own minimum

The service, and only the service, decides what assurance a given operation
requires. Four failure modes it must handle by refusing rather than degrading:

| situation | wrong behavior | required behavior |
| --- | --- | --- |
| operator's policy changed to make the class `autonomous` | receipt requirement lapses | the service's minimum is its own; a local policy change is invisible to it and changes nothing |
| the hardened surface is unreachable | fall back to a Telegram tap and label it hardened | the request fails, or is served at the lower tier with the lower label and the lower authority |
| the assertion fails to verify | accept with a warning | refuse, with a distinct machine-readable code |
| the receipt is absent | treat the agent's word for it | refuse |

The mirror rule locally: a downgraded path must be **visible**, and the ladder of
§7 must be recomputed from evidence rather than carried as a claim. A local
runtime that could not collect a hardened authorization records an ordinary grant
under the ordinary label, and the ordinary grant is exactly as valid as it is
today for every ordinary purpose.

An agent-supplied `human_verified` flag satisfies nothing at any tier, and neither
does a local log entry on its own. Both are §11.1 invariant 4 restated at the
relying service's boundary.

### 6.4 The ZZZ worked example

An operator wants an agent to participate in one private ZZZ channel.

**Enrollment, once, human-only.** The operator registers a credential with ZZZ
through ZZZ's own ceremony. ZZZ stores the public key, the AAGUID if attestation
was collected, and the operator's account binding. approval.md holds a local
reference to the credential and never the private half.

**The request.** The agent registers an action and requests approval. The scope in
the request is structured:

```json
{
  "service": "zzz.bot",
  "channel": "chan_7f3a…",
  "capabilities": ["read", "send"],
  "expires_at": "2026-09-12T17:00:00Z",
  "membership": {"may_invite": false, "may_leave": true},
  "delegation": {"may_delegate": false},
  "rate": {"max_messages": 200}
}
```

**The decision.** ZZZ issues a challenge. The operator opens the approval surface
on their phone, reads the canonical rendering of that scope with the agent
identity and `sub_key` shown as computed fields, and completes the assertion.
approval.md appends `approval.granted` and `approval.countersigned`, and exports
the receipt.

**The connection.** The agent presents the receipt to ZZZ and proves possession of
`sub_key`. ZZZ verifies the assertion under the key it enrolled, checks `aud`, the
challenge it issued, `exp`, and `jti`, and admits the agent to that channel with
those capabilities until that expiry.

**What this is.** A scoped grant. It authorizes a channel, two capabilities, and a
window. **It is not human review of every message**, and ZZZ's product surfaces
must not describe it as one. An operator who wants per-message review sets the
class to `manual` in their own policy and pays the attention cost, which is a
different product and a much smaller one.

**Delegation and membership are part of the scope and are enforced by ZZZ.**
`may_delegate: false` means ZZZ refuses a re-delegation attempt, and an agent
that could mint sub-grants from a receipt would have escaped the scope entirely.

**Privacy is a separate axis.** Whether ZZZ messages are end-to-end encrypted,
who holds keys, and what the transport reveals are questions about
confidentiality. Approval assurance is a question about authorization. Neither
implies the other, and a product surface that presents "hardened approval"
alongside "encrypted" as one property misleads on both.

---

## 7. Honest assurance labels

A closed set, computed by the verifier from evidence it validated, and never
carried as a claim. Names are provisional.

| label | what the verifier validated | the sentence a service may say |
| --- | --- | --- |
| `none` | nothing, or an unverifiable assertion | no evidence |
| `disclosed-workflow` | the integrator states they use approval.md | "the integrator says they gate this class." A self-report about intent. |
| `local-grant` | a chain-verified log shows a grant over these bytes | "a party with write access to that log recorded a human decision over these exact bytes." Useful for audit, self-asserted. |
| `witnessed-log` | the above, inside a signed checkpoint prefix (C2), or against an anchor | "the grant was inside a prefix signed by a key the agent does not hold, or held by a party the operator does not control." |
| `countersigned` | a per-decision signature under an enrolled key (A or C1) | "an enrolled operator credential signed this exact decision." |
| `operator-verified` | a fresh, user-verified assertion bound to the decision digest under an enrolled credential (B) | "an enrolled operator credential authorized this specific grant through a verification path outside the requesting agent's control." The §0 claim, exactly. |
| `attested-authenticator` | the above, with registration attestation checked against a trusted authenticator set | "and the credential lives on an authenticator of a known model." |

Two rules bind the whole table. **The label a receipt carries is refused when it
exceeds what the verifier validated**, so a mislabelled receipt fails rather than
downgrades quietly. And **no row licenses the sentence "a human approved this"**
without the qualifier its row carries.

Documentation changes this implies, all of them proposals for later tasks:

1. A section in `docs/integrations-considered.md`, or a page of its own, stating
   the ladder and what an integrator may claim at each rung.
2. A paragraph in `approval instructions` telling agents what a grant does and
   does not prove to a third party, which closes gap 1 of §1.6.
3. A statement of the deployment shapes of §1.4 in one place, which closes gap 4.
4. SPEC §11 gains a sentence, when and if a phase ships, saying that the
   config-declared-identity boundary is unchanged for the ordinary path and that
   an optional tier exists beside it. **This is a proposal and this task does not
   authorize the edit.**

---

## 8. The recommended path

Four phases. The first is deliberately small, uses code that already exists, adds
no dependency, and is independently useful even if nothing after it ships.

### Phase 1: exportable receipts over what the log already proves

Ship `approval receipt export` and `approval receipt verify` at `assurance:
witnessed-log`, built entirely on Option C2. No new event type, no schema change,
no new dependency, no policy key. The exporter assembles the grant record, the
hash chain up to the newest covering checkpoint, and that checkpoint's signature.
The verifier is offline, takes the issuer key as an argument rather than reading
it from the operator's policy, and refuses on every negative in §9.

Why this first. It forces the receipt format, the canonicalization, the audience
and challenge binding, the verification contract, and the label discipline
through a real implementation while the cryptography is code the repository has
already tested. It gives ZZZ something to integrate against in a week rather than
a quarter. And it produces the honest baseline sentence, which is worth having on
its own: "a key the agent does not hold signed a chain containing this grant."

Estimated shape: one new CLI verb pair, one conformance vector file, a doc page,
no `src/core` change beyond a receipt module that reads existing ones.

### Phase 2: per-decision countersignature

Add `approval.countersigned` (Option C1) and a policy key naming which classes
require one. This is the first schema change and the first new event type, so it
is its own task with its own schema work, and it lifts the label to
`countersigned`. Custody stays the vault, which means the claim stays honest
about host compromise.

### Phase 3: the hardened surface

The separately controlled approval page, WebAuthn registration and assertion
verification, user-verification required, challenge bound to the decision digest
(Option B). This is where the RP-ID question of §9.2 has to be answered, and it
is the phase that earns `operator-verified`. It is also the largest phase and
should not begin before phases 1 and 2 have a real consumer.

### Phase 4, optional and independent

Authenticator attestation and an AAGUID allowlist (`attested-authenticator`), and
a transparency witness (Option D2). Either can land without the other. A
dedicated approval app and hardware attestation stay explicitly later work, as
the task frames them.

**Recommendation in one paragraph.** Build phase 1 now, because it is small,
dependency-free, and forces every hard interface decision. Treat WebAuthn on a
separately controlled surface as the destination for the assurance tier ZZZ
should actually require, and treat everything before it as honestly labelled
lesser rungs rather than as approximations of it.

---

## 9. Compatibility, constraints, and open questions

### 9.1 Compatibility with SPEC

| section | assessment |
| --- | --- |
| §3 principles | Files stay the interface, the log stays the truth, receipts are projections. Deterministic core is unaffected: signature verification is deterministic and no model touches it. |
| §5.2 | Phase 1 adds nothing. Phase 2 proposes one policy key naming classes that require a countersignature, which is a narrowing and cannot widen autonomy. Attestation semantics are untouched. |
| §6.2–6.3 | The envelope is unchanged. `payload_hash` and `idempotency_key` semantics are relied on and not modified. The lifecycle gains no state: a countersignature is an additional record about a grant that already reached `approved`. |
| §8 | Additive event types only, each validating against its own schema before append, each gate-typed and taking `ts` from the runtime. The chain is untouched. |
| §9 | The canonical renderer is reused verbatim. The computed and claimed split is load-bearing in the receipt (`approver` is claimed, `grant` is computed). |
| §10.3–10.5 | Channels stay transport. The hardened surface is a new surface beside them, and no channel gains authority. The MCP surface gains nothing human-only. |
| §11 and §11.1 | Invariant 1: verification reads verified records. Invariant 2: new events are gate-typed. Invariant 3: no secret enters the log; a receipt holds no token. Invariant 4: an incoming receipt is a claimed field that may only raise local scrutiny. Invariant 5: any check-then-append goes through compare-and-append, exactly as `log checkpoint` already does. Invariant 6: new refusal codes are their own frozen union with conformance vectors. Invariant 9: enrollment, rotation, and revocation are human-only ceremonies and no verb mints authority for them. Invariant 10: the assurance label is computed and never read from guidance. |
| §13 | Non-goals are respected except for the tension in §9.2. A hosted verifier (Option D3) is refused on these grounds. |
| §14 | This is post-M8 work and does not reorder the milestones. |

### 9.2 The local-first tension, stated rather than resolved

WebAuthn needs a relying-party identifier, which is a domain. Four routes, none
of them free:

1. **ZZZ is the relying party.** The credential is registered to ZZZ's origin, ZZZ
   serves the approval page, and ZZZ verifies its own assertions. Cleanest
   cryptographically and it makes the approval surface a service the operator does
   not control, which contradicts "a verification path outside the requesting
   agent's control" only mildly and contradicts local-first considerably.
2. **The operator's own domain.** The operator runs the page on a domain they
   control. Correct, and it asks an operator to own a domain and a certificate,
   which is a steep cost for a personal-scale tool.
3. **Localhost RP ID.** WebAuthn permits `localhost` as a secure context, which
   works when the authenticator and the browser are on the machine running the
   runtime. It fails the "separately controlled phone" requirement precisely
   because the phone is a different device.
4. **Skip WebAuthn.** Use a plain device-bound key (Option A) with a small
   purpose-built mobile client and no browser. This preserves local-first
   completely and trades away the standard verification contract, the ecosystem of
   authenticators, and the origin binding that comes free with WebAuthn.

**This is the largest unresolved decision in the proposal and it should be settled
before phase 3 begins.** Phases 1 and 2 are unaffected by it, which is part of why
they come first.

### 9.3 Credential custody, enrollment, recovery, replacement, revocation

**Custody.** Phase 2's key lives in the vault (`approval.checkpoint.key` is the
existing precedent), encrypted under the passphrase `vault.passphrase_env` names,
in a file whose reading classifies `account.credential`, with the passphrase
stripped from every spawned child. That is meaningful custody in D2 and D3 of
§1.4 and it is not device binding. Phase 3's key is non-exportable from the
authenticator and the runtime never holds it at all.

**Enrollment.** Human-only, on a terminal or a device the operator physically
holds, with a typed confirmation in the shape of the existing gate ceremony. The
enrollment record at the relying service is what matters, and the local record is
a convenience.

**Agent-created accounts are the sharp risk.** An agent with a browser and an
email address can create an account, register a passkey, and enroll it. Every
mitigation lives at the relying service and none lives in approval.md:
enrollment gated behind an existing verified operator account, an out-of-band
confirmation, an enrollment ceremony that requires a second existing credential,
or attestation restrictions. **A relying service that accepts self-service
credential enrollment gets self-service assurance**, and the receipt format
cannot rescue it. This must be stated in whatever integration guide ZZZ writes.

**Software and virtual authenticators.** A virtual authenticator (a browser
devtools feature, a headless WebAuthn library, a CI helper) produces valid
assertions with the user-verification flag set. Without registration attestation
and an AAGUID check, a verifier cannot tell one from a hardware key. This is why
`attested-authenticator` is a separate rung, and why a service requiring real
device binding must collect attestation at registration rather than hope.

**Agent-accessible browser sessions.** If the agent can drive the operator's
browser profile, a platform authenticator in that profile is reachable, and a
platform authenticator that unlocks without a per-assertion gesture is fully
reachable. Mitigations: require user verification on every assertion, prefer a
cross-platform authenticator or a separate device, and keep the approval surface
off any profile an agent can drive. None of these is enforceable by approval.md,
and all of them belong in the operator-facing documentation.

**Recovery is the weakest link and must be designed as such.** Account recovery at
the relying service is a path to registering a new credential, and a recovery
flow weaker than the credential it restores sets the real assurance level of the
whole system. Recommended rules for a relying service: recovery requires the same
or stronger authentication than enrollment; a newly recovered credential has a
cooling-off period before it may authorize high-assurance scopes; recovery events
are visible to the operator through a channel the agent does not control; and a
recovery that adds a credential invalidates standing scoped grants rather than
inheriting them.

**Replacement and revocation** follow §5.7 and §5.8. Both are human-only
ceremonies at both ends.

### 9.4 Unresolved decisions requiring review

1. The RP-ID question of §9.2.
2. Whether the countersignature record carries the full assertion or only its
   digest, weighed against log size (APRV-217).
3. Whether `assurance` belongs in the signed body at all, given that a verifier
   recomputes it. The argument for keeping it is that a human reading a receipt
   should see the claim in words; the argument against is that any field a
   verifier ignores will eventually be trusted by someone who does not.
4. Whether rejections should be exportable as receipts. §5.1 says yes; a reviewer
   may reasonably say a rejection is the operator's business.
5. Whether a new dependency is acceptable for WebAuthn verification, per CLAUDE.md's
   justify-each-one rule.
6. Whether a transparency witness (Option D2) is worth its privacy cost for a
   personal-scale tool.

---

## 10. Negative-test plan

Every row is a test a conforming implementation must fail closed on, in the shape
`conformance/` already uses: a vector, an expected `failure_class`, and a negative
control. Refusal codes are provisional and would be frozen in their own union per
§11.1 invariant 6.

| # | attack | setup | expected |
| --- | --- | --- | --- |
| 1 | fabricated local approval | a log with a valid chain and a hand-written `approval.granted` under any `human:` id, no countersignature | verify refuses `receipt-unsigned`; the ladder resolves to `local-grant` at best and never above it |
| 2 | forged countersignature | a countersignature under a key the relying service did not enroll | `issuer-unknown`, and specifically not a downgrade to a lower rung |
| 3 | truncate and recompute | truncate the log below the grant and recompute the chain | the C2 hash walk fails, or the covering checkpoint's signed hash is absent: `chain-mismatch` |
| 4 | altered scope | flip `may_delegate` to true after signing | JCS body differs, signature fails: `signature-invalid` |
| 5 | altered audience | change `aud` from one service to another | `signature-invalid`; and even under a valid signature, `audience-mismatch` at the second service |
| 6 | replay at the same service | present a valid receipt twice | `challenge-consumed` on the second, and `jti-replayed` where single-use is enforced |
| 7 | replay after expiry | present a valid receipt after `exp` | `receipt-expired` |
| 8 | wrong agent key | a valid receipt presented by an agent that cannot answer the possession challenge for `sub_key` | `possession-failed`; the receipt itself still verifies, which is the point of separating the two checks |
| 9 | revoked grant | `jti` in the service's revocation set | `receipt-revoked` |
| 10 | retired credential | a receipt under a credential the service retired for new issuance | accepted for verification of past receipts within their `exp`, refused for new authorization: `issuer-retired` |
| 11 | untrusted issuer via the policy file | a verifier fed the issuer key from the operator's `APPROVAL.md` rather than its own registry | the verifier API must make this impossible to express; the test asserts the verifier has no code path that reads a key from receipt or policy input |
| 12 | virtual authenticator | a WebAuthn assertion from a software authenticator with UV set | verifies, and resolves to `operator-verified` and never `attested-authenticator` |
| 13 | enrollment abuse | a credential registered by an agent-driven browser | undetectable at the receipt layer by construction; the test is a documentation assertion that the integration guide states this |
| 14 | recovery bypass | a credential added through account recovery, then used immediately for a high-assurance scope | the relying service's cooling-off rule refuses: `credential-too-new` |
| 15 | downgrade by unavailability | the hardened surface is unreachable and a Telegram tap is recorded | the tap produces an ordinary grant at `local-grant`; a test asserts no code path labels a channel tap above that rung |
| 16 | downgrade by policy edit | the operator sets the class to `autonomous` locally | the relying service's minimum is unchanged; a test asserts the verifier reads no operator policy at all |
| 17 | agent-supplied flag | a receipt carrying `human_verified: true` and no binding | the field does not exist in the schema, so this is `receipt-malformed`; the test asserts the field name appears nowhere in the verifier |
| 18 | label inflation | a receipt whose `assurance` says `operator-verified` with a C2 binding | `assurance-overclaimed`, refused rather than silently downgraded |
| 19 | cross-protocol signature lift | a `log.checkpoint` signature presented as a receipt binding | domain separation makes the message differ: `signature-invalid` |
| 20 | payload change after review | the payload edited after the grant | `payload-mismatch` at execution (existing behavior), and a receipt whose `grant.payload_hash` no longer matches the executed bytes |

Rows 13 and 16 are worth reading twice. Row 13 is a real attack the mechanism
cannot detect, and saying so in the test plan is more useful than a test that
pretends otherwise. Row 16 is a property of where verification happens rather than
of any check, and the test is structural.

---

## 11. Summary of what this proposal asks for

Nothing, yet. It asks a reviewer to decide whether phase 1 is worth a task, and
to settle the RP-ID question before phase 3 is scheduled. Every schema change,
policy key, SPEC amendment, and dependency named above requires its own task and
its own human sign-off, and none of them is authorized by this document.

The one sentence to carry away: the hardened tier's value is that a relying
service can check evidence against a key it enrolled itself, and every honest
version of that sentence stops short of claiming a human was present.
