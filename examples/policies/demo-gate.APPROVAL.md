# Approval policy — web-agent demo gate

This instance exists only to rehearse the web-agent demo. It is deliberately
separate from any repository: the log under `.approval/log/` here is the demo's
log, and nothing a rehearsal does reaches a project's own gate.

```yaml approval-policy
version: "0.1"

defaults:
  autonomy: manual
  channel: telegram
  approval_ttl: "10m"
  on_expiry: reject
  token_delivery: sealed

approvers:
  demo:
    channels: [telegram, cli]

classes:
  read.*:
    autonomy: autonomous
  exec.local:
    autonomy: manual
    approvers: [demo]
    limits:
      requests_per_hour: 3
  communicate.email.external:
    autonomy: manual
    approvers: [demo]
    limits:
      max_pending: 3
      requests_per_hour: 3
  policy.edit:
    autonomy: manual
    approvers: [demo]
    limits:
      requests_per_hour: 3

budgets:
  global:
    daily_actions: 25
    max_pending: 10

channels:
  telegram:
    token_env: APPROVAL_TG_TOKEN
    chat_id_env: APPROVAL_TG_CHAT

vault:
  passphrase_env: APPROVAL_DEMO_VAULT_PASSPHRASE
```
