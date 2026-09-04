# Approval Policy

Agents working in this project handle my life admin. Anything that leaves
the machine gets declared, and the classes below say what I sign off on.

```yaml approval-policy
version: "0.1"

defaults:
  autonomy: manual          # unknown/undeclared classes require sign-off
  channel: telegram
  approval_ttl: 24h         # pending requests expire
  on_expiry: reject

approvers:
  alice:
    channels: [telegram, cli]

classes:
  read.*:                       { autonomy: autonomous }
  files.write.workspace:        { autonomy: autonomous }
  calendar.write.own:           { autonomy: supervised }
  communicate.email.draft:      { autonomy: autonomous }
  communicate.email.external:
    autonomy: manual
    approvers: [alice]
  financial.spend:
    autonomy: manual
    approvers: [alice]
    limits: { per_action_usd: 25, daily_usd: 100 }
  public.post:                  { autonomy: manual }
  data.delete:                  { autonomy: manual }
  account.auth:                 { autonomy: manual }

budgets:
  global: { daily_usd: 100, daily_actions: 200 }

audit:
  supervised_sample_rate: 0.10   # fraction of supervised actions escalated
                                 # for retrospective human review

channels:
  telegram:
    chat_id_env: APPROVAL_TG_CHAT
    token_env: APPROVAL_TG_TOKEN
  web:
    port: 4680
```

Everything after the block is prose again and is ignored by the parser.

## What I value

The block below is not YAML: the second entry is indented into a mapping that
was never opened.

```yaml approval-values
version: 1
like:
  - success reported first
    key: value
   - small reviewable commits
```
