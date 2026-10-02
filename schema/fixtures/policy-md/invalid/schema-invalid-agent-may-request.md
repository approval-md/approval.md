# Approval Policy

Two invalid spellings of `agent_may_request` (APRV-445): a string where a
boolean belongs, and `true` on a `human-only` rule, which is inert to agents
and may not be opened to them. Either alone fails the whole policy closed:
`schema-invalid`.

```yaml approval-policy
version: "0.1"

defaults:
  autonomy: manual

classes:
  intent.publish.inferred.index:
    autonomy: manual
    agent_may_request: "yes"
  account.credential:
    autonomy: human-only
    agent_may_request: true
```
