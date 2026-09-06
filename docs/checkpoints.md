# Human-signed log checkpoints: the design

**Status: PENDING SIGN-OFF (APRV-220, acceptance criterion #1).** This page is
the design section the task asks a human to sign off. The mechanism it
describes is built and merged (APRV-220, APRV-220.1, APRV-257), so a sign-off
here ratifies decisions that are already load-bearing, and a decision Carter
rejects is a change to the files each section names. Nothing here is a runbook:
[cli-reference](cli-reference.md#log-checkpoint) has the verbs,
[dogfood-cutover](dogfood-cutover.md) has the ceremony, and
[git-evidence](git-evidence.md#the-second-witness-human-signed-checkpoints-aprv-220-aprv-257)
compares this witness against the anchoring one.

## 0. What a checkpoint answers

The chain in `events.jsonl` is unkeyed. A party with write access to the log can
truncate it and recompute a self-consistent chain, and a cold walk from genesis
cannot tell the result from the original. That boundary is stated in the
conformance suite as `chain-verification/truncation-unanchored`, and
[docs/proposals/incremental-prefix-proof.md](proposals/incremental-prefix-proof.md)
§3 names the party it matters against: a same-user forger, which in this project
means a process running as the operator.

Two witnesses answer that forger, and they are independent by construction.
Anchoring (APRV-219) asks whether somebody else holds a copy of these bytes and
answers from git, so it is exactly as fresh as the last push and says nothing on
a machine with no remote. A checkpoint asks whether **a key no agent process
holds signed this head**, and answers from the log plus the attested policy, so
it works offline and covers the window nobody has pushed yet.

A checkpoint authorizes nothing. It spends nothing, decides no request, and
grants no class. It is a single claim, and the whole of the claim is: a key
holder saw this `(seq, hash)`.

## 1. Which key signs

**Decision: a dedicated Ed25519 keypair, not the attestation identity.**

There was no keypair to reuse. `core/attest.ts` records a config-declared
identity (`--as human:<id>`, or `APPROVAL_HUMAN`), and its documented claim is
that someone with local control signed off, never who. A checkpoint has to claim
more than that or it claims nothing at all, because the party it defends against
is a process with local control. Ed25519 comes from `node:crypto`, so the
mechanism adds no dependency.

*Where it lives:* `src/core/checkpoint.ts` (`CHECKPOINT_ALG`,
`mintCheckpointKeypair`).

## 2. Custody of the private half

**Decision: the credential vault, under the reserved name
`approval.checkpoint.key`, or a file named by `--key-file`. Nothing else.**

The vault encrypts at rest under the passphrase that `vault.passphrase_env`
names, and `core/child-env.ts` strips that variable from every child this
runtime spawns (APRV-205). Reading the vault file classifies
`account.credential`, which the reference policy holds human-only (APRV-194).
`--key-file <path>` is the alternative for a key kept outside the vault, which
is what makes the terminal verb usable before the vault ceremony has been run.

There is deliberately **no `--key` flag and no environment variable holding the
key itself**. A key on a command line is a key in the shell history, and a key
in the session environment is a key every child inherits.

`core/checkpoint.ts` takes the private key as a value and reads it from nowhere.
Custody is decided in exactly one file, `src/cli/checkpoint-tap.ts`
(`resolveCheckpointKey`), so there is one place to read to learn every way a key
can reach a signature. `tests/checkpoint-tap.test.ts` pins that: the terminal
verb, the Telegram tap and the CLI channel all resolve their key through that
function, a transitive import walk from `src/cli/hook.ts` never reaches it, and
`getCredential` has exactly the two callers `core/vault.ts`'s header names.

*For review:* this makes checkpoint signing the second sanctioned caller of
`vault.getCredential`, after `adapters/vault-provider.ts`, which that module's
header originally named as the only one. APRV-257 decided to amend the header
rather than move the key: an OS keystore has no equivalent of the passphrase
variable `child-env.ts` strips, and a file beside the log has no encryption at
all. A checkpoint key is the one secret whose entire value is that an
agent-launched process cannot reach it. The rule the caller list actually keeps
is unchanged: a credential's value travels into a use and never onto a surface,
and no verb prints one.

## 3. Where the public half lives

**Decision: `audit.checkpoint_keys` in `APPROVAL.md`, base64 DER SPKI, a list.**

This is the one key-shaped field in that file holding material rather than the
name of a variable, because a public key is not a secret and the value of
writing it there is that the file is committed and attested. An agent that
edited the list would leave a visible diff and de-attest the policy, which stops
every gate operation until a human re-attests.

A list rather than a scalar, so rotation retains retired keys.
`approval setup checkpoint --rotate` appends, and `--retire` refuses to drop a
key that signed any checkpoint in the log, naming the seqs that would stop
verifying (APRV-257).

The record carries only `key_sha256`, a fingerprint. A record that carried its
own public key would invite a reader to verify the signature against it, which
any forger could satisfy. **The policy is the authority; the fingerprint is a
hint** (SPEC §11.1 invariant 7).

## 4. The record schema

`log.checkpoint`, actor `^human:` in the schema as well as in the code, payload:

| field | shape | meaning |
| --- | --- | --- |
| `seq` | integer ≥ 1 | the seq of the record whose hash was signed |
| `hash` | 64 hex | the chain hash at that seq, as the signer read it |
| `alg` | `"ed25519"` | an enum, so a second scheme is a schema change |
| `key_sha256` | 64 hex | SHA-256 of the signing key's DER SPKI bytes |
| `signature` | base64 | Ed25519 over the message of §5 |

Gate-typed, so `ts` is stamped at the write boundary and no append entry point
accepts one (SPEC §11.1 invariant 2). That the signed seq is below the record's
own, and that the log carries that hash there, are the runtime's checks: a
schema sees one record and can only constrain the shape.

*Where it lives:* `schema/event.schema.json`, with fixtures at
`schema/fixtures/event/valid/log-checkpoint.json` and four invalid ones
(missing signature, short signed hash, unknown alg, agent actor). Delivered as
APRV-220.1, its own subtask, because CLAUDE.md makes a schema change one.

## 5. What is signed

```
"approval.md/log-checkpoint/v1\n" + JCS({alg, hash, seq})
```

Domain-separated, so a signature made here cannot be lifted into another use of
the key and one made elsewhere cannot be presented as a checkpoint. The head's
hash is a 256-bit chain digest, so the message is already specific to one chain
at one position.

The signature does not cover the rest of the record, and could not: the record's
hash covers its payload, which covers the signature. What a checkpoint asserts
is exactly what §0 says it asserts.

*Where it lives:* `checkpointMessage`, `signCheckpoint`,
`verifyCheckpointSignature` in `src/core/checkpoint.ts`.

## 6. The delivery path

Three surfaces, one signing function, one prompt text.

1. **The terminal.** `approval log checkpoint --as human:<id>` reads the log's
   current head, signs it, and appends with that head as the compare-and-append
   precondition. A concurrent append is `head-moved` and the repair is to run
   the verb again (SPEC §11.1 invariant 5).
2. **The channel tap.** When `audit.checkpoint_every` has lapsed, the listener's
   dispatch cycle puts one prompt in the chat: `CHECKPOINT DUE — sign the log
   head at seq N?`, with the `(seq, hash)` whole and first. The human taps, and
   the **listener** signs, on the machine that holds the vault passphrase. The
   button's `callback_data` carries a nonce and never the head: bytes that
   travel over the network must not name what gets acted on. The nonce is spent
   before the handler runs, so a double tap makes one record. The checkpoint
   callback vocabulary parses separately from the decision vocabulary, so
   nothing that reaches the bot can present a signature gesture as a grant.
3. **The CLI channel.** `approval channel` renders the same lines
   (`checkpointPromptLines`) and reads one keystroke. Same text on every
   surface, because the thing being consented to is identical.

**The head may move between the prompt and the tap, and what is signed is the
head the human was shown.** `appendCheckpointAt` takes a caller-named head,
refuses `checkpoint-head-unknown` when the chain no longer carries that hash at
that seq, and appends under the current head. This is why the verify rule of §8
requires only that a checkpoint signs a seq below its own, rather than its
immediate predecessor.

**Where the enqueue lives, and why.** SPEC §10.2's dispatch job is performed by
the listener's dispatch cycle rather than by the daemon process, because the
daemon holds no channel credential and no approver identity, and a network
round-trip inside a tick would couple the projection loop to Telegram's
availability. So `dispatchPending` enqueues, reading the same `checkpointDue`
the daemon's warning reads, and the daemon's tick line carries `checkpoints.due`
so its decision stays visible.

*Where it lives:* `src/cli/log-checkpoint.ts`, `src/cli/checkpoint-tap.ts`,
`src/channels/telegram.ts`, `src/channels/cli.ts`,
`src/cli/channel-telegram.ts`, `src/cli/channel.ts`.

## 7. Cadence semantics

**Decision: `audit.checkpoint_every`, a duration, absent means off, and
report-only at every layer.**

Parsed in policy loading beside `skew_tolerance`: one parse, one number, and an
unparseable value fails the whole policy rather than being quietly unread.

There is no path anywhere in this runtime from *due* to *refused*. A human who
has been away is not tampering, and a gate that refused a log for want of a tap
is a gate whose operator turns the check off. A lapsed cadence produces a
warning on the verify verdict, a `checkpoint-due` warning on the daemon's tick,
a `fix` line on `approval doctor`'s `checkpoint` row (which stays green), and
one channel prompt.

One due-ness rule, `checkpointDue()`, is read by all four, so there is no
arrangement in which the daemon says a checkpoint is owed and the listener
declines to ask for one. It offers only from a passing check: a refused range is
not a range to sign a new checkpoint on top of, and a skipped one has no key to
sign with.

**Never a nag.** At most one prompt outstanding, one question per lapse. The
listener remembers the newest checkpoint's seq at prompt time and asks again
only after a checkpoint actually lands, which is also when due-ness goes false.
A restart re-asks once, the direction all channel bookkeeping degrades in.

## 8. The verify rule

`checkLogCheckpoints({records, publicKeys, checkpointEveryMs, now})` runs over
the caller's **already-verified** records (SPEC §11.1 invariant 1). Every
`log.checkpoint` in the walked range must clear four things:

1. its payload reads as a checkpoint payload;
2. the seq it signs is below its own (a checkpoint signs the past);
3. its `key_sha256` names one of `audit.checkpoint_keys`;
4. the signature verifies under that key **and** names the hash the log carries
   at that seq.

The first failure refuses. The union is closed and conformance-pinned
(`refusal-unions`, `checkpoint_refusal_codes`): `checkpoint-key-unknown`,
`checkpoint-signature-invalid`, `checkpoint-hash-mismatch`,
`checkpoint-out-of-order`, `checkpoint-malformed`. Check (4) is the forged-chain
catch: a chain recomputed after a checkpoint cannot reproduce a signature over
the hashes it replaced.

Three outcomes are deliberately not refusals:

- **No configured key is a skip** naming why and naming how many records went
  unchecked. A check that could not look never reports a pass.
- **A signed seq below the walked range** is counted and named as `unchecked`.
- **A lapsed cadence** is a warning, per §7.

**`checkpoint-key-unknown` is a refusal rather than a shrug, and that is the
load-bearing choice.** If an unlisted fingerprint were merely skipped, a forger
could neutralise the whole mechanism by rewriting each checkpoint's `key_sha256`
to name a key nobody carries. The cost is real and is named in the refusal
message and the docs: retiring a key out of `audit.checkpoint_keys` de-verifies
every checkpoint it signed, which is why the rotation verb refuses to drop a key
that signed anything.

**Where the rule runs:** `approval log verify --checkpoints` (after the chain
verdict, on a clean log, beside `--anchor` and never in place of it), the
daemon's full re-proof (a distinct `checkpoint-invalid` outcome at
`EXIT_INTEGRITY`), and `approval doctor`'s `checkpoint` row.

## 9. Two witnesses, neither weakened

`--anchor` and `--checkpoints` are separate flags. The daemon runs both on the
same full re-proof, the checkpoint check immediately after the anchor and before
any sweep that appends, and **a skip on one never excuses the other**. Against
the §3 forger they fail in different directions, which is the point of having
both: the anchor catches a truncation whose records somebody else already holds,
and a checkpoint catches one inside the unpushed window. The comparison table is
in [git-evidence](git-evidence.md#the-second-witness-human-signed-checkpoints-aprv-220-aprv-257).

## 10. What signing this off decides

Six things, each reversible at the file named beside it:

| decision | reversal |
| --- | --- |
| a dedicated key, not the attestation identity (§1) | `core/checkpoint.ts`, `core/attest.ts` |
| the vault plus `--key-file`, and no third route (§2) | `cli/checkpoint-tap.ts` |
| the public half in the attested policy, as a list (§3) | `schema/policy.schema.json`, policy loading |
| `key_sha256` as a hint and the policy as the authority (§3, §4) | `schema/event.schema.json`, `core/checkpoint.ts` |
| an unknown key is a refusal, not a skip (§8) | `core/checkpoint.ts` |
| due is a warning everywhere and a refusal nowhere (§7) | `core/checkpoint.ts`, `daemon/daemon.ts`, `cli/doctor.ts` |

**One gap this design does not close, named rather than hidden.** A checkpoint
prompt reaches a channel from the cadence and from nothing else. There is no
verb that asks the phone for a checkpoint *now*: the terminal path signs
directly instead of requesting. Nobody has needed the on-demand request yet, and
adding one means signalling into a running listener process, which is a design
question rather than a flag. It is called out here so a sign-off is a sign-off
on what exists.

## Where the code and the proof are

| | |
| --- | --- |
| the primitive | `src/core/checkpoint.ts` |
| custody | `src/cli/checkpoint-tap.ts` |
| the verbs | `src/cli/log-checkpoint.ts`, `src/cli/setup-checkpoint.ts` |
| the channels | `src/channels/telegram.ts`, `src/channels/cli.ts` |
| the enqueue | `src/cli/channel-telegram.ts`, `src/cli/channel.ts` |
| the schema | `schema/event.schema.json`, `schema/fixtures/event/**/log-checkpoint*.json` |
| the record and verification tests | `tests/log-checkpoint.test.ts` |
| the ceremony, tap and cadence tests | `tests/checkpoint-tap.test.ts` |
| the normative sentences | SPEC.md §9 |
