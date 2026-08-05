# Approval Policy

The policy fence is never closed, so the file ends mid-block. A truncated
policy is indistinguishable from a complete one, so this fails closed
rather than being silently closed at end of file.

```yaml approval-policy
version: "0.1"
defaults:
  autonomy: manual
  channel: cli
