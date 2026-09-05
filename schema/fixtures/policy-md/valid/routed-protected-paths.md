# Approval Policy

This project's protected surfaces do not all deserve the same amount of a
human's attention. The specification is amended rarely and consequentially, the
release workflow is where an agent could arrange to publish something nobody
read, and the design directory is a notebook. Since APRV-266 a `protected_paths`
entry may say which of those a path is, and each one takes its own line below.

```yaml approval-policy
version: "0.1"

defaults:
  autonomy: manual
  channel: telegram
  approval_ttl: 24h
  on_expiry: reject

protected_paths:
  - SPEC.md
  - { path: design/, class: policy.edit.design }
  - { path: .github/workflows/, class: policy.edit.ci }
  - { path: docs/constitution.md, class: policy.edit.spec }

approvers:
  alice:
    channels: [telegram, cli]

classes:
  read.*: { autonomy: autonomous }
  policy.edit:
    autonomy: supervised-live
    live_rate: 0.1
    approvers: [alice]
  # Looser than the `policy.edit` line, and allowed to be: `design/` is not a
  # path the runtime protects on its own, so the routing floor does not reach it.
  policy.edit.design: { autonomy: supervised }
  # Stricter, which is always allowed. `.github/workflows/` IS a built-in
  # `policy.edit` path, so the floor requires at least the line's own strictness.
  policy.edit.ci:
    autonomy: manual
    approvers: [alice]

budgets:
  global: { daily_usd: 100, daily_actions: 200 }
```

`policy.edit.spec` has no line of its own, so it inherits the `policy.edit`
line: `docs/constitution.md` stays supervised-live at 0.1 until somebody says
otherwise, which is what adopting a routing should cost.
