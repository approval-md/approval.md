# Approval Policy

The block is fenced correctly but is not well-formed YAML: an unterminated
flow sequence plus a stray flow mapping indicator.

```yaml approval-policy
version: "0.1"
defaults:
  autonomy: manual
approvers:
  carter:
    channels: [cli, telegram
```
