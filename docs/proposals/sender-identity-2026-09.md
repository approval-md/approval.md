# Sender identity for this repository's own gate (APRV-324)

> **APPLIED, and superseded for the mapping VALUE.** This page is on the
> record: the raw id it asked for is in `APPROVAL.md` and in every Telegram
> decision since. Applying it disclosed the account in a published policy and a
> published log, which the operator raised on 2026-09-18 and ruled on a day
> later. `docs/proposals/sender-identity-hashed-2026-09.md` is the follow-up
> that rewrites that one value in the keyed form (APRV-370). Everything else on
> this page still describes what is in force. The raw id stays in git history
> and is not rewritten.

This repository's `APPROVAL.md` names one approver and maps no Telegram
account, so every tap on the phone is recorded against the actor
`approval up` was launched with. That is correct and unchanged by APRV-324: a
policy that declares no `senders` block behaves exactly as it did before the key
existed.

This proposal is what turns the new behaviour on for this gate. Applying it is
worth a minute's thought first, because the effect is not only "the log names
Carter" — it is that **an unmapped Telegram account stops being able to decide
anything here at all**, which is the point and is also the failure mode if the
id below is wrong.

## What changes when it is applied

1. Each `approval.granted` and `approval.rejected` from Telegram gains
   `payload.sender: {channel: "telegram", id: "<the id>"}` and
   `payload.sender_source: "policy"`, and its `actor` becomes `human:carter`
   because the mapping says so rather than because the listener was started
   that way. On this gate the two happen to be the same name, which is exactly
   the property that makes this safe to try: nothing about attribution moves
   until a second account appears.
2. A tap from any other Telegram account — a second device signed in as someone
   else, a person added to the chat, a bot token that leaked — records no
   decision. It records one `audit.decision_refused` with `sender-unmapped` and
   the observed id, and the chat is told that the account is not one the policy
   names.
3. `approval doctor`'s `sender-mapping` row turns from a skip into a pass.
4. Nothing else moves. Decisions typed at a terminal carry no sender and are
   unaffected, the attestation ceremony is unaffected, and removing the block
   at a later attestation returns to today with no code change and no log
   repair.

## The id, which this document does not know

**`<CARTER_TELEGRAM_USER_ID>` below is a placeholder and MUST be replaced before
this proposal is applied.** No agent session knows Carter's Telegram account id,
and guessing one would be worse than leaving the gap: a wrong id maps the
operator's own taps to nobody and refuses every decision on the phone until
somebody edits the file from a terminal. (The gate stays repairable — the CLI
channel supplies no sender — but that is a recovery, not a plan.)

Two ways to read the real id, both a minute's work:

- Tap Approve once with no mapping in place and read the grant:
  `approval log tail --json | grep sender` shows nothing today, so instead run
  the listener with `--json` and read the `decision` line, or
- add a deliberately wrong mapping, tap once, and read the observed id off the
  `audit.decision_refused` record the refusal writes. The refusal is designed
  for exactly this: it records the id it saw.

The second is the shortest honest path, and it costs one refused tap.

## The pair

The applier reads the two fenced blocks below and nothing else on this page.

### `approvers.carter`

Current:

```yaml
approvers:
  carter:
    channels: [telegram, cli]
```

Replace with:

```yaml
approvers:
  carter:
    channels: [telegram, cli]
    senders:
      telegram: "<CARTER_TELEGRAM_USER_ID>"   # numeric callback_query.from.id, NOT a @handle
```

## After applying

`approval policy apply docs/proposals/sender-identity-2026-09.md --pr` writes
the file and runs `approval policy amend`, so the edit and its attestation land
together. Then:

- `approval doctor` — the `sender-mapping` row should read as a pass naming
  `telegram`.
- One approve and one reject from the phone, then `approval log verify`. The
  grant should carry `payload.sender` with the id above and an `actor` of
  `human:carter`.

If the id is wrong, the tap is refused `sender-unmapped` and the record carries
the id that actually arrived — which is the number this proposal wanted.
