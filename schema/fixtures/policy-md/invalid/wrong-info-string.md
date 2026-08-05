# Approval Policy

The only fenced block is tagged ```yaml, not ```yaml approval-policy. A
bare yaml block is documentation, not policy, so nothing here is in force
and the load fails closed: `no-block`.

```yaml
version: "0.1"
defaults:
  autonomy: autonomous
```
