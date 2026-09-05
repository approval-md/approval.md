# Approval Policy

A routing that tries to leave the `policy.edit` namespace. `protected_paths` may
widen the protected surface and name its own sub-classes under `policy.edit`; it
mints no authority over the gate's own organs or over the record of what
happened (SPEC.md §11.1 invariant 9), so this file is rejected at the schema.

```yaml approval-policy
version: "0.1"

defaults:
  autonomy: manual

protected_paths:
  - { path: design/, class: files.write.workspace }
```
