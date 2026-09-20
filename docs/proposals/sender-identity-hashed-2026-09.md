# The keyed sender mapping for this repository's own gate (APRV-370)

`docs/proposals/sender-identity-2026-09.md` was applied: this repository's
`APPROVAL.md` maps Carter's Telegram account, in the raw form, and every grant
and rejection from the phone carries that account id in
`payload.sender.id`. This repository publishes both files. So the account is
disclosed once in the policy and then on every decision, for as long as the log
exists.

The operator raised it on 2026-09-18 while applying that page, and ruled on
2026-09-19 for the keyed form. This page is the amendment.

## Why keyed, and not a plain digest

The obvious fix is `sha256:<hex of the id>`. It does not work. A Telegram
account id is a ten-digit decimal number, so the whole space is ten billion
candidates, and a laptop walks it in minutes. A digest anybody can reverse
states a privacy property it does not have, which is worse than the raw id: the
raw id is at least honest about being an identifier.

So the digest is keyed: `hmac-sha256:<hex>`, HMAC-SHA-256 of the account id
under a secret this machine holds and neither this file nor the log ever
carries.

**The key is not an authenticator.** Nothing about the gate's safety rests on
its secrecy. Somebody who learns it learns which account ids the policy names,
which is exactly what the raw form told everybody. What it buys is that a
published policy and a published log stop carrying the account.

## What changes when this is applied

1. `approvers.carter.senders.telegram` becomes `hmac-sha256:<hex>`. The account
   it names is the same account; nothing about who may decide moves.
2. Each `approval.granted` and `approval.rejected` from Telegram carries
   `payload.sender: {channel: "telegram", id: "hmac-sha256:<hex>", hashed:
   true}` instead of the number, and its `actor` is still `human:carter`.
3. A tap from any other Telegram account is still refused `sender-unmapped`,
   and the `audit.decision_refused` it writes carries that account's DIGEST
   rather than its id. That is an improvement for the operator as well as for
   the stranger: the digest is the exact string a `senders` entry would carry,
   so recognizing an account and mapping it is a copy rather than a
   transformation.
4. `approval doctor`'s `sender-mapping` row names the form in use and says
   whether the key resolves.
5. **The listener must hold the key or it decides nothing.** A keyed mapping
   with no `APPROVAL_SENDER_KEY` in the listener's environment refuses every
   decision on that channel, with `sender-key-unavailable`, and does not fall
   back to a raw comparison. This is the failure mode of this page and it is
   the one to rehearse: a listener restarted from a shell that never ran
   `eval "$(approval env)"` is a gate that cannot be answered from the phone.
   A decision typed at a terminal carries no sender and still works, which is
   the way out.
6. Git history keeps the raw id, in this file's own predecessor and in the
   policy's history. That is stated rather than rewritten: rewriting published
   history to hide an identifier that was published is a bigger lie than the
   disclosure.

## Before the pair: mint the key, then print the line

The replacement below cannot be written by an agent, because the digest depends
on a secret only this machine holds. Run these three, in order, in the PRIMARY
checkout (`/Users/carter/dev/approval-md`):

```sh
approval setup sender-key
eval "$(approval env)"
approval setup sender-key --id 7345216485
```

The first mints a 32-byte key, stores it in the keychain as
`approval-sender-key-<instance>`, and writes its source line into
`.approval/env`. It prints no value and there is no verb that prints one. The
second establishes it in this shell. The third prints the mapping value for the
account the policy names today, and the `Replace with` pair to paste below it.

Then paste the printed digest over `<PASTE_THE_PRINTED_DIGEST>` in the second
block and apply the page:

```sh
approval policy apply docs/proposals/sender-identity-hashed-2026-09.md
```

## The pair

The applier reads the two fenced blocks below and nothing else on this page.

### `approvers.carter`

Current:

```yaml
approvers:
  carter:
    channels: [telegram, cli]
    senders:
      telegram: "7345216485"   # numeric callback_query.from.id, NOT a @handle (APRV-324)
```

Replace with:

```yaml
approvers:
  carter:
    channels: [telegram, cli]
    senders:
      telegram: "hmac-sha256:86f6206b50381ab42def752accc83b1bf8afe94bf23a96ea8e0adb2ce23958fe"   # HMAC-SHA-256 of the account id under APPROVAL_SENDER_KEY (APRV-370)
```

## After applying

The amendment rides on `approval policy amend`, so the edit and its attestation
land together. The attestation tap itself is the one act this page changes the
shape of: it changes the `senders` mapping, so under SPEC.md §10.3 it must be
answered from a terminal rather than from the phone. `approval policy apply`
runs it in a terminal, which is where it is already happening.

Then, with the listener restarted so it holds the key:

- `approval doctor` — the `sender-mapping` row should pass and say `the keyed
  form (APPROVAL_SENDER_KEY)`.
- One approve and one reject from the phone, then `approval log verify`. The
  grant should carry `payload.sender.hashed: true`, the digest above, and an
  `actor` of `human:carter`.
- `approval log tail --json | grep 7345216485` should find nothing new.

If the tap is refused `sender-key-unavailable`, the listener does not hold the
key: it was started from a shell without it. Establish it and restart
`approval up`. If the tap is refused `sender-unmapped`, the digest in the file
is not the digest of that account under this key, which means the wrong id was
passed to `--id` or the key was re-minted after the file was written; the
refusal record carries the digest that actually arrived, which is the value the
file should have.

## Rolling back

Replace the keyed value with the raw id and re-attest. No code change, no log
repair, and the records already written keep their digests, which stay
correlatable to the account for as long as the key exists. Losing the key does
not break verification and does not break the gate; it makes the digests in
past records unmatchable to any account, and it makes the current mapping
unresolvable until the file is amended.
