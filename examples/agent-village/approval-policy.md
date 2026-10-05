# Agent Village tenant policy: co-located, day one

The canonical starting policy for one Agent Village resident whose approval.md
daemon runs inside the resident's own sandbox (co-located). The control plane
and the overlay copy from this file; nothing else should carry its own version.

**This is a template, and its name says so.** At provisioning the control plane
replaces `<telegram_user_id>` with the resident's paired Telegram account id,
writes the result into the tenant store as `APPROVAL.md`, and the operator
attests it there (docs/hosted-provisioning.md). It is named
`approval-policy.md` here, and never `APPROVAL.md`, for two reasons: a file
named `APPROVAL.md` classifies `policy.core` wherever it sits, so an agent could
not maintain the template at all; and an unrendered copy must never be mistaken
for a tenant's live policy. Unrendered, it does not load (the placeholder fails
the sender pattern), and a policy that does not load resolves every class
`manual`: a store that received the template without the render is gated shut,
never open.

What it says, in one line each:

- **Record everything, block nothing on the hook path.** `defaults.autonomy:
  autonomous` is the recorder. Every hooked tool call is written to the
  hash-chained log under this attested policy; none waits for a tap.
- **The gate's own organs and the resident's credentials are never the
  agent's.** `policy.core`, `log.mutate` and `account.credential` are
  human-only. Under an autonomous default these three rows are mandatory: the
  Hermes home's `config.yaml`, `agent-hooks/` and consent allowlist classify
  `policy.core`, and `.env` and `auth.json` classify `account.credential`, so
  without them the agent could edit its own gate.
- **One live gate, on the propose path only.** `intent.publish.*` is manual and
  agent-requestable, with the two explicit day-one rows: an inferred intent (the
  agent's inference of what the resident wants published to Index) waits for
  the resident's tap; a stated intent (the resident's own words) is recorded and
  goes through. `digest.share` and `village.vote` are the same mechanism for the
  digest and the weekly question.
- **The Hermes tool classes are recorded, not gated.** `cron.manage`,
  `process.write`, `browser.exec`, `skill.manage`, `agent.delegate`,
  `message.send`, `network.call` and `read.web` are autonomous rows so that no
  later default change silently gates them.
- **72 h to answer a proposal.** Core has one global TTL. A hook-opened request
  never gets it: the hook clamps its own requests to the harness cap minus 60 s
  (240 s under the 300 s cap the village runs), so the long window costs the
  hook path nothing.
- **The channel is the control-plane relay.** `token_env` names the relay
  credential and `chat_id_env` the resident's chat, both written by the control
  plane into the daemon's environment. The daemon runs `approval up --api-base
  <control plane>/approval-relay`, so core's Telegram channel speaks Bot API to
  the relay.
- **Residents see the simple card.** `prompt.style: minimal` (APRV-489) sends
  each proposal as one short message in plain words: what the agent wants to
  do, the exact words it will post, share or vote, how long the resident has,
  and Approve and Deny, with the full technical card (the canonical rendering
  included) collapsed under "Full details". The `say` entries are the
  operator's words for the three resident-facing classes, keyed by exact class
  name, and their `quote` maps name and SHOW every key each payload carries
  (the ids under plain labels, so the "Not shown here" notice appears only when
  something is really left off), so a payload with any other key is sent as
  the technical card. `always: [ttl_remaining_ms]` keeps the one
  `ttl` row the relay's quiet-hours hold reads, inside "Full details".
  **Rollout order:** `style` and `say` need a core with APRV-489. An older
  core refuses the keys at the schema, the whole policy fails to load, and
  every class resolves `manual` (every hooked tool call then waits for a tap),
  so a tenant receives this block only after its pinned core understands it.

`agent_may_request` is the policy key PR #569 (APRV-445) adds. On a build
without it, this file fails the schema and every class resolves `manual`, which
is the fail-closed reading; the fixture is meant for a build that carries #569.

```yaml approval-policy
version: "0.1"

defaults:
  autonomy: autonomous          # layer 1: record everything, block nothing
  channel: telegram
  approval_ttl: 72h             # the proposal window; hook-opened requests still clamp to the harness cap minus 60 s (240 s under a 300 s cap)
  on_expiry: reject
  token_delivery: sealed

approvers:
  resident:
    channels: [telegram]
    senders:
      telegram: "<telegram_user_id>"   # written at provisioning from the pairing
      # edgeos: "<edgeos_human_id>"    # once APRV-455 admits the channel: the onboarding review attests

channels:
  telegram:
    token_env: APPROVAL_RELAY_TOKEN      # the relay credential, approvald-only env
    chat_id_env: APPROVAL_RESIDENT_CHAT  # the paired id; the control plane writes this variable
    prompt:
      always: [ttl_remaining_ms]         # the relay's quiet hold reads this row; on a minimal card it sits inside Full details
      style: minimal                     # APRV-489: needs a core with APRV-489; an older core fails this policy closed
      say:
        intent.publish.inferred.index:
          does: "post a wish it guessed from your chats to Index, the village matching service, in your name"
          quote: { text: "" }
          note: none
        digest.share:
          does: "share a note about you with other people"
          quote: { scope: "Shared with", expires_at: "Until", text: "Note", digest_id: "Reference" }
          note: none
        village.vote:
          does: "vote for you in this week's village question"
          quote: { answer: "Answer", question_id: "Question" }
          note: summary

classes:
  # layer 2: the live gate, propose path only
  intent.publish.*:              { autonomy: manual, agent_may_request: true }
  intent.publish.inferred.index: { autonomy: manual, agent_may_request: true }
  intent.publish.stated.index:   { autonomy: autonomous, agent_may_request: true }
  digest.share:                  { autonomy: manual, agent_may_request: true }   # DATA-96 §5, if digests ship
  village.vote:                  { autonomy: manual, agent_may_request: true }   # the weekly question, DATA-99
  # the gate's own organs and the resident's credentials: never the agent
  policy.core:                   { autonomy: human-only }
  log.mutate:                    { autonomy: human-only }
  account.credential:            { autonomy: human-only }
  # Hermes tool classes (PR #569 rules): recorded, not gated, on day one
  cron.manage:                   { autonomy: autonomous }
  process.write:                 { autonomy: autonomous }
  browser.exec:                  { autonomy: autonomous }
  skill.manage:                  { autonomy: autonomous }
  agent.delegate:                { autonomy: autonomous }
  message.send:                  { autonomy: autonomous }
  network.call:                  { autonomy: autonomous }
  read.web:                      { autonomy: autonomous }
```

One limit of the stated-intent row: it stays autonomous only for a request that
does not declare `reversible: false`. No row sets `allow_irreversible`, so an
irreversible action under any class falls to the manual floor (SPEC.md §7).
Proposals carry no `reversible` field today, so this is a note for whoever adds
one.
