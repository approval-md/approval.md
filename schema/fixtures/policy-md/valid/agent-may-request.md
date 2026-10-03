# Approval Policy

`agent_may_request` (APRV-445) opens `approval propose` to classes the operator
declares by name. The family line opens the branch; each member is still a line
of its own, and the closed member says no for itself.

```yaml approval-policy
version: "0.1"

defaults:
  autonomy: manual
  approval_ttl: 72h

classes:
  intent.publish.*:
    autonomy: manual
    agent_may_request: true
  intent.publish.inferred.index: { autonomy: manual }
  intent.publish.stated.index: { autonomy: autonomous }
  intent.publish.closed:
    autonomy: manual
    agent_may_request: false
  communicate.email.external: { autonomy: manual }
```
